/**
 * 会話ログから、そのセッションが何にトークンを使ったかを数える。
 *
 * 目的は「合計を知る」ことではなく **「次にどう変えるか」を出す** こと。
 * だから主役は totals ではなく tools（ツール別の文脈消費）に置いてある。
 * 「Read 1回で 68k 食った」が分かれば、次から範囲や limit を絞る動機になる。
 *
 * ここは純関数。fs も時刻も触らない。読むのは呼ぶ側の仕事。
 *
 * ## 合計の前に必ず通す前処理
 *
 * 1. **requestId で重複を潰す。** 1回の API 応答が thinking / text / tool_use の
 *    複数行に分かれて書かれ、そのすべてが同じ usage を持つ（実測）。
 *    上位25ファイルで assistant 行 12,346 に対し一意な requestId は 5,928。
 *    素で足すと約2倍になる。この事実を知らずに書いた集計はすべて間違う
 * 2. **<synthetic> を除く。** requestId を持たず usage が全ゼロの行。
 *    回数の分母に入れると要求あたりの平均が薄まる
 * 3. **cache_creation は入れ子を優先。** 判断は entries.mjs の usageOf に置いてある
 *
 * digest.mjs の stats.turns（assistant 行数）は往復数ではない（約1.85倍）。
 * ここでは使わず requests.length を使う。
 */

import {
  attributionSkillOf,
  isMainline,
  requestIdOf,
  timestampOf,
  toolResults,
  toolUses,
  usageOf,
  uuidOf,
} from './entries.mjs';

/**
 * 実消費（ITE ＝ 入力トークン換算）の重み。
 *
 * キャッシュ読み 0.1倍、書き 1.25倍（5分）/ 2倍（1時間）、出力は入力の5倍。
 * Fable 5 / Opus 5・4.8・4.7・4.6 / Sonnet 5・4.6 / Haiku 4.5 の
 * **全モデルで例外なく同じ比率**だったので、モデルによって変えない。
 *
 * つまりモデル差は「基本入力単価」1つのスカラーに畳める。
 * USD に直したければ最後に単価を掛けるだけでよく、比率が変わらないぶん
 * 単価表が古くなっても ITE そのものは嘘にならない。
 */
export const ITE_WEIGHTS = {
  in: 1,
  cacheRead: 0.1,
  cacheWrite5m: 1.25,
  cacheWrite1h: 2.0,
  out: 5.0,
};

/** ツール別の集計で、上位いくつまで返すか。残りは「その他」にまとめない（切るだけ）。 */
const TOOLS_MAX = 24;

/**
 * スキル別の集計で、上位いくつまで返すか。
 *
 * **帰属ラベルで数え直した実測（429 ファイル）で、1本あたりの種類数は
 * 最大 4・p90 が 2・中央が 1。** 12 なら実質切れないが、上限そのものは残す
 * （1本で何十種も使う形を禁じてはいない）。切ったぶんは skillsOmitted で返す。
 */
const SKILLS_MAX = 12;

/**
 * スキルの区間を、畳まずに1件ずつ何件まで返すか。
 *
 * 上の SKILLS_MAX が「何種類まで」なら、こちらは「何回ぶんまで」。
 * 同じスキルを前回とどう比べるかを見るには、平均へ畳む前の1回ごとが要る。
 *
 * **帰属ラベルでは、1本での同一スキルの区間数は実測で最大 1 だった**
 * （429 ファイル。ラベルが途切れて再開する例が0件なので当然そうなる）。
 * 種類を跨いでも1本あたり 4 区間までなので 60 は実質切れないが、
 * 上限そのものは要る。切るときは**新しいほうを残す**。推移で見たいのは直近だから。
 */
const SKILL_RUNS_MAX = 60;

/**
 * 文脈保有量の系列を、いくつの点まで返すか。
 *
 * 画面のスパークラインを描くためだけの値。700要求のセッションで 700 個返しても
 * 幅 320px の絵に 700 点は乗らないので、応答を太らせるだけになる。
 */
const SERIES_MAX = 120;

/**
 * 1要求ぶんの ITE。
 *
 * @param {{in: number, cacheRead: number, cacheWrite5m: number, cacheWrite1h: number, out: number}} u
 * @returns {number}
 */
function iteOf(u) {
  return (
    u.in * ITE_WEIGHTS.in +
    u.cacheRead * ITE_WEIGHTS.cacheRead +
    u.cacheWrite5m * ITE_WEIGHTS.cacheWrite5m +
    u.cacheWrite1h * ITE_WEIGHTS.cacheWrite1h +
    u.out * ITE_WEIGHTS.out
  );
}

/**
 * その要求が抱えていた文脈の量。
 *
 * input_tokens は「キャッシュされなかった残り」だけなので、
 * 3つ足して初めてプロンプト全長になる。
 *
 * **これを要求ごとに合計してはいけない。** 足した瞬間に意味を失う指標なので、
 * 呼ぶ側が間違えないよう、合計する経路をこのファイルにも作っていない。
 *
 * @param {{in: number, cacheRead: number, cacheWrite5m: number, cacheWrite1h: number}} u
 * @returns {number}
 */
function contextOf(u) {
  return u.in + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
}

/**
 * 会話ログから要求の列を組む。
 *
 * requestId でまとめるが、**usage は最初の1行、tool_use は全行から集める。**
 * 1回の応答が複数行に分かれる以上、tool_use だけ別の行にいることが普通にある。
 * 最初の行だけを見ると、ツール呼び出しをまるごと取りこぼす。
 *
 * @param {object[]} entries 会話ログの行（本流・サブエージェントの別は呼ぶ側が渡す前に絞ってもよい）
 * @param {boolean} sidechain true ならサブエージェントの行だけを見る
 * @returns {{requests: object[], duplicateLines: number, syntheticSkipped: number}}
 */
function collectRequests(entries, sidechain) {
  /** @type {Map<string, object>} */
  const byId = new Map();
  let duplicateLines = 0;
  let syntheticSkipped = 0;

  for (const entry of entries) {
    if (entry?.type !== 'assistant') continue;
    if (isMainline(entry) === sidechain) continue;

    const id = requestIdOf(entry);
    if (!id) {
      // requestId を持たないのは <synthetic> の行だけだった（実測108件が完全一致）。
      // usage も全ゼロなので、数えても足されないが、回数の分母からは外す
      syntheticSkipped += 1;
      continue;
    }

    const uses = toolUses(entry);
    const seen = byId.get(id);
    if (seen) {
      duplicateLines += 1;
      // 同じ requestId で usage が食い違う例は0件だったので、後から来た usage は見ない。
      // **帰属ラベルも同じ扱い。** 実測（複数行の requestId 16,341 件）で、
      // 値の食い違いも「ある行と無い行の混在」も0件だったので、最初の1行だけ見れば足りる。
      // ここに「非 null を優先」を足すと、実データで一度も効かない分岐が
      // テストのためだけに生き残る。拾うのは tool_use だけ
      for (const u of uses) seen.uses.push(u);
      continue;
    }

    const usage = usageOf(entry);
    if (!usage) {
      // usage を持たない assistant 行。実データでは見ていないが、
      // 公開仕様ではないので落ちずに飛ばす
      continue;
    }

    byId.set(id, {
      requestId: id,
      uuid: uuidOf(entry),
      at: timestampOf(entry),
      model: typeof entry.message?.model === 'string' ? entry.message.model : null,
      usage,
      context: contextOf(usage),
      ite: iteOf(usage),
      uses,
      // その要求のあいだ効いていたスキル。Claude Code が要求ごとに書いている
      skill: attributionSkillOf(entry),
    });
  }

  return { requests: [...byId.values()], duplicateLines, syntheticSkipped };
}

/**
 * ツール結果の大きさを tool_use_id ごとに集める。
 *
 * 1つの要求に tool_use が複数並んでいたとき、文脈の伸びをどう配るかの重みになる。
 * 見るのは tool_result の本文と toolUseResult の JSON 長さの両方。
 * 片方しか無い形があるので、取れたものを足す。
 *
 * @param {object[]} entries 会話ログの行
 * @param {boolean} sidechain true ならサブエージェントの行だけを見る
 * @returns {Map<string, number>} tool_use_id → おおよその文字数
 */
function collectResultSizes(entries, sidechain) {
  const sizes = new Map();

  for (const entry of entries) {
    if (entry?.type !== 'user') continue;
    if (isMainline(entry) === sidechain) continue;

    const results = toolResults(entry);
    if (!results.length) continue;

    // toolUseResult は行に1つしか無いので、同じ行に tool_result が複数あれば等分する
    let structured = 0;
    if (entry.toolUseResult !== undefined) {
      try {
        structured = JSON.stringify(entry.toolUseResult)?.length ?? 0;
      } catch {
        // 循環参照など。重みが取れないだけなので 0 のまま進む
        structured = 0;
      }
    }
    const share = structured / results.length;

    for (const r of results) {
      if (!r.id) continue;
      sizes.set(r.id, (sizes.get(r.id) ?? 0) + r.text.length + share);
    }
  }

  return sizes;
}

/**
 * ツール別の文脈消費を出す（このアプリの数値画面の主役）。
 *
 *   材料(r) = Δ(r) − out(r−1)        Δ(r) = context(r) − context(r−1)
 *
 * Δ から前回の出力ぶんを引いた残りが、そのあいだに差し込まれたもの
 * （ツール結果とユーザ発言）になる。**トークナイザ無しで引き算だけで厳密に出る。**
 * これを1つ前の要求の tool_use に帰属させる。
 *
 * Δ が負になるのは、文脈が縮んだとき。**実測で調べたところ、正体はほぼ全部が圧縮だった。**
 * 縮んだ回の usage は例外なく「cacheRead が毎回まったく同じ値（実測 30,461。
 * システムプロンプトとツール定義のぶん）に戻り、残りが丸ごと cacheWrite に乗る」形をしている。
 * 圧縮で会話が作り直され、キャッシュを取り直したところなので当然そうなる。
 * 実測した1本では、圧縮の目印 88件（`compact_boundary` と `isCompactSummary` の対で約44回）に対して
 * 負が 43回で、ほぼ1対1に対応していた。
 *
 * **なので割合はセッションの長さではなく圧縮の回数で決まる。**
 * 実測でも 0%（短いもの3本）・1.8%（434要求）・6.2%（706要求）とばらついた。
 * 「1.8% 程度に収まるはず」を前提にした判定を足さないこと。
 *
 * 0 に丸めたうえで**「測れなかった回数」として別に数える。**
 * 黙って捨てると、合計が小さいのが「使っていない」のか「測れていない」のか分からなくなる。
 *
 * @param {object[]} requests 時系列に並んだ要求
 * @param {Map<string, number>} sizes tool_use_id → 結果の大きさ
 * @returns {{tools: object[], unattributed: {negativeCount: number, noToolTokens: number}}}
 */
function attributeTools(requests, sizes) {
  /** @type {Map<string, {tool: string, calls: number, tokens: number, max: number}>} */
  const byTool = new Map();
  let negativeCount = 0;
  let noToolTokens = 0;

  for (let i = 1; i < requests.length; i += 1) {
    const prev = requests[i - 1];
    const cur = requests[i];

    const material = cur.context - prev.context - prev.usage.out;
    if (material < 0) {
      // 縮んだ。0 に丸めるが、丸めたこと自体は数える
      negativeCount += 1;
      continue;
    }
    if (material === 0) continue;

    const uses = prev.uses;
    if (!uses.length) {
      // 前の要求がツールを呼んでいないのに伸びた ＝ ユーザの発言などが入った
      noToolTokens += material;
      continue;
    }

    // 複数並んでいたら結果の大きさで按分する。重みが取れなければ均等割り
    const weights = uses.map((u) => sizes.get(u.id) ?? 0);
    const total = weights.reduce((a, b) => a + b, 0);

    for (let k = 0; k < uses.length; k += 1) {
      const name = uses[k].name || '(不明)';
      const share = total > 0 ? weights[k] / total : 1 / uses.length;
      const tokens = material * share;

      const rec = byTool.get(name) ?? { tool: name, calls: 0, tokens: 0, max: 0 };
      rec.tokens += tokens;
      if (tokens > rec.max) rec.max = tokens;
      byTool.set(name, rec);
    }
  }

  // 呼び出し回数は「材料が帰属したか」と無関係に数える。
  // 最後の要求のツール（結果がまだ返っていない）も1回として出したい
  for (const r of requests) {
    for (const u of r.uses) {
      const name = u.name || '(不明)';
      const rec = byTool.get(name) ?? { tool: name, calls: 0, tokens: 0, max: 0 };
      rec.calls += 1;
      byTool.set(name, rec);
    }
  }

  const tools = [...byTool.values()]
    .map((r) => ({
      tool: r.tool,
      calls: r.calls,
      tokens: Math.round(r.tokens),
      avg: r.calls > 0 ? Math.round(r.tokens / r.calls) : null,
      max: Math.round(r.max),
    }))
    .sort((a, b) => b.tokens - a.tokens || a.tool.localeCompare(b.tool))
    .slice(0, TOOLS_MAX);

  return { tools, unattributed: { negativeCount, noToolTokens: Math.round(noToolTokens) } };
}

/**
 * 要求ごとの帰属ラベルから、スキル別の消費を数える。
 *
 * **区間の推定はしない。** Claude Code が要求ごとに `attributionSkill` を
 * 書いているので、それを足すだけで正解になる。
 *
 * 前は「`Skill` の `tool_use` から次の障壁（あなたの発言 / スラッシュコマンド /
 * 中断 / `compact_boundary`）まで」を積んでいたが、実測でラベルの **40%** しか
 * 拾えていなかった（96 ファイルで 50,824,164 対 126,266,831）。外れた原因は3つ。
 *
 * - **あなたの発言で切っていた。** スキルが効いている最中に発言が入った 132 回のうち、
 *   **94 回（71%）は Claude Code 側の帰属が同じスキルのまま続いていた**
 * - **圧縮で切っていた。** 呼んだ直後に `compact_boundary` が来ると区間ゼロになるが、
 *   実際は圧縮を跨いで 19 要求ぶん（636,122 ITE）が同じスキルに帰属していた
 * - **スラッシュコマンド起動が構造上見えなかった。** `/handoff` のような起動は
 *   `<command-name>` の user 行から始まり、`Skill` の `tool_use` がどこにも出てこない。
 *   実測 130 区間のうち **29 区間（22%）** がこの形（`pr-impact:analyze` 13 など）
 *
 * ## 「1回」の数え方
 *
 * **ラベルが連続している最大の区間を1回と数える。** 1要求でも別のラベル
 * （または無ラベル）を挟んだら、そこで閉じる。
 *
 * 実測（426 ファイル・130 区間）で「同じスキルのラベルが途切れて再開する」例は
 * **0 件**だったので、跨がせる規則は持たない。「無ラベルを N 件までは跨いで
 * 同じ回とみなす」を入れると、N に実データ上の根拠が1件も無い調整つまみが残る。
 *
 * その結果、**1セッションでは同じスキルの区間がほぼ必ず1つになる**
 * （実測で1ファイルあたり 1〜4 区間、同じスキルが2度出た例は 101 組中 0 件）。
 * つまり1本ぶんの `runs` は実データでは常に 1 で、`avg === ite` になる。
 * 横断側（`view/usage.mjs`）で束ねると `runs` が「そのスキルを使ったセッション数」に一致する。
 *
 * `at` は区間の先頭要求の時刻。呼んだ要求自身はラベルを持たない
 * （実測：同じスキル 0 件 / null 91 / 前のスキル 10）ので、
 * 「呼んだ次から始まる」という前の判断はそのまま生きている。
 *
 * **`requests` はソート済みで渡す。** 時刻を持たない要求は末尾へ寄るので、
 * 理屈の上では無関係な2区間がつながりうる（実データでは0件）。
 *
 * ## 因果は取れない（ラベルでも変わらない）
 *
 * `attributionSkill` は「どのスキルの文脈下で走った要求か」の記録であって、
 * 「そのスキルのせいで増えた」ではない。だから画面側の但し書きは**外せない。**
 * ただし「呼び出した直後の一続き」という説明はもう事実と違う（発言も圧縮も跨ぐ）ので、
 * 文言のほうを帰属ラベルの話に直す。
 *
 * @param {object[]} requests 時系列に並んだ要求（`skill` を持つ）
 * @returns {{skills: object[], runs: object[],
 *            unattributed: {requests: number, ite: number},
 *            omitted: {count: number, ite: number}}}
 *          skills は ite の降順、runs は時刻の昇順
 */
function attributeSkills(requests) {
  /** @type {Map<string, {skill: string, runs: number, requests: number, ite: number}>} */
  const byName = new Map();
  /** @type {{skill: string, at: number|null, ite: number, requests: number}[]} 畳む前の1回ごと */
  const runsList = [];
  let unattributedRequests = 0;
  let unattributedIte = 0;

  /** いま開いている区間。ラベルが変わったら閉じて runsList へ積む */
  let open = null;
  const close = () => {
    if (!open) return;
    runsList.push({
      skill: open.skill,
      at: open.at,
      ite: Math.round(open.ite),
      requests: open.requests,
    });
    const rec = byName.get(open.skill) ?? { skill: open.skill, runs: 0, requests: 0, ite: 0 };
    rec.runs += 1;
    rec.requests += open.requests;
    rec.ite += open.ite;
    byName.set(open.skill, rec);
    open = null;
  };

  for (const r of requests) {
    const name = r.skill;
    if (!name) {
      // どのスキルにも紐づかない要求。**黙って捨てない。**
      // 実測で本流 ITE の 65% がここに落ちるので、返さないと
      // 「スキルを全部足しても合計に届かない」が説明できなくなる
      close();
      unattributedRequests += 1;
      unattributedIte += r.ite;
      continue;
    }
    if (open && open.skill !== name) close();
    if (!open) open = { skill: name, at: r.at, ite: 0, requests: 0 };
    open.ite += r.ite;
    open.requests += 1;
  }
  close();

  const all = [...byName.values()]
    .map((r) => ({
      skill: r.skill,
      runs: r.runs,
      requests: r.requests,
      ite: Math.round(r.ite),
      // runs は必ず1以上（区間があるから記録がある）ので、ここは 0 で割らない
      avg: Math.round(r.ite / r.runs),
    }))
    .sort((a, b) => b.ite - a.ite || a.skill.localeCompare(b.skill));

  // 切ったぶんも黙って落とさず、件数と量で返す
  // （画面に出る割合の合計が 100% に届かない理由の一部になる）
  const cut = all.slice(SKILLS_MAX);

  return {
    skills: all.slice(0, SKILLS_MAX),
    // runsList は requests の並び（時刻の昇順）のまま。切るのは古いほうから
    runs: runsList.slice(-SKILL_RUNS_MAX),
    unattributed: { requests: unattributedRequests, ite: Math.round(unattributedIte) },
    omitted: { count: cut.length, ite: cut.reduce((n, r) => n + r.ite, 0) },
  };
}

/**
 * 文脈の圧縮を数える。
 *
 * **`cumulativeDroppedTokens` は累積なので、足してはいけない。**
 * 実測（大きい順に40ログ・圧縮 475 件）で、そのログの最後の値が
 * `Σ(preTokens - postTokens)` と1トークンの狂いもなく一致した。
 * 素で合計すると、圧縮が64回あるログでは 60 倍近くに膨れる。
 *
 * 最後ではなく最大を採るのは、行が時刻順に並んでいなくても壊れないため。
 * 実データは追記順なので普通は最後 ＝ 最大になる。
 *
 * `trigger` は 475 件すべてが `"auto"` だった（手動の /compact は1件も無い）。
 * 分けて出す意味が無いので拾わない。
 *
 * @param {object[]} entries 会話ログの行
 * @param {boolean} sidechain true ならサブエージェントの行だけを見る
 * @returns {{count: number, dropped: number|null}} dropped は測れなければ null（0 とは分ける）
 */
function collectCompactions(entries, sidechain) {
  let count = 0;
  let dropped = null;

  for (const entry of entries) {
    if (isMainline(entry) === sidechain) continue;
    if (entry?.type !== 'system' || entry.subtype !== 'compact_boundary') continue;
    count += 1;

    const n = entry.compactMetadata?.cumulativeDroppedTokens;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) continue;
    if (dropped === null || n > dropped) dropped = n;
  }

  return { count, dropped };
}

/**
 * 昇順に並んだ配列から百分位を取る。
 *
 * 空なら null。**0 を返さない**（「実際に0だった」と「取れなかった」を混ぜないため）。
 *
 * 横断側（`view/usage.mjs`）の中央値もこれを使う。
 * 「真ん中の取り方」が2箇所に生きると、必ず片方だけが直される。
 *
 * @param {number[]} sorted 昇順の配列
 * @param {number} p 0〜1
 * @returns {number|null}
 */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.round((sorted.length - 1) * p);
  return sorted[Math.min(sorted.length - 1, Math.max(0, idx))];
}

/**
 * 長い配列を等間隔に間引く。先頭と末尾は必ず残す。
 *
 * **形を見るためだけのもので、ここから最大値や合計を出さない。**
 * 間引いた点は落ちるので、山や谷をまたぐことがある
 * （最大値は peak、伸び方の分布は growth を別に持っている）。
 *
 * @param {number[]} values
 * @param {number} max 返す点の数の上限（2以上）
 * @returns {number[]}
 */
function downsample(values, max) {
  if (values.length <= max) return values;
  const out = [];
  for (let i = 0; i < max; i += 1) {
    out.push(values[Math.round((i * (values.length - 1)) / (max - 1))]);
  }
  return out;
}

/**
 * 使ったモデルの内訳。最頻のものを代表として返す。
 *
 * 実ログには7種類が混在する。命中率のようにモデルまたぎで比べてはいけない指標があるので、
 * 「どれを主に使ったか」と「混ざっているか」の両方を出せるようにしておく。
 *
 * @param {object[]} requests
 * @returns {{model: string|null, models: {model: string, requests: number}[]}}
 */
function modelBreakdown(requests) {
  const counts = new Map();
  for (const r of requests) {
    if (!r.model) continue;
    counts.set(r.model, (counts.get(r.model) ?? 0) + 1);
  }
  const models = [...counts.entries()]
    .map(([model, n]) => ({ model, requests: n }))
    .sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model));
  return { model: models[0]?.model ?? null, models };
}

/**
 * 会話ログから数値をまとめる。
 *
 * 取れなかった値は null にする。**0 は「実際に0だった」の意味だけに使う。**
 * 要求が1件も無いセッション（起こしただけ、など）では
 * totals は 0（実際に0）、context と cache は null（測りようがない）になる。
 *
 * @param {object[]} entries 会話ログの行
 * @param {{sidechain?: boolean}} [options] sidechain: true ならサブエージェントの行だけを見る
 * @returns {object} 集計結果。数百バイトの数値の塊なので、そのまま memo に載せてよい
 */
export function buildUsage(entries, { sidechain = false } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const { requests, duplicateLines, syntheticSkipped } = collectRequests(list, sidechain);

  // 時刻で並べ直す。ログは追記順なので普通は既に並んでいるが、
  // 時刻を持たない行を混ぜたときに順序が崩れないよう、取れないものは末尾へ寄せる
  requests.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));

  const totals = { in: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, out: 0, ite: 0 };
  for (const r of requests) {
    totals.in += r.usage.in;
    totals.cacheRead += r.usage.cacheRead;
    totals.cacheWrite5m += r.usage.cacheWrite5m;
    totals.cacheWrite1h += r.usage.cacheWrite1h;
    totals.out += r.usage.out;
    totals.ite += r.ite;
  }
  totals.ite = Math.round(totals.ite);

  // 文脈保有量。合計はしない。最後の値と最大値、伸び方の分布、それと形だけを出す
  let peak = null;
  const growth = [];
  const contexts = [];
  for (let i = 0; i < requests.length; i += 1) {
    const c = requests[i].context;
    contexts.push(c);
    if (peak === null || c > peak) peak = c;
    if (i > 0) growth.push(c - requests[i - 1].context);
  }
  const sortedGrowth = [...growth].sort((a, b) => a - b);

  // キャッシュ命中率。**同一モデル内でしか比べてはいけない。**
  // プロンプトキャッシュの最小長がモデル別（Opus5=512 / Opus4.7=2048 / Opus4.6・Haiku4.5=4096）で、
  // 未満だとエラーも出さずに黙ってキャッシュされない。古いモデルが低く見えるのは行動の差だけではない
  const cacheBase = totals.cacheRead + totals.in + totals.cacheWrite5m + totals.cacheWrite1h;

  const sizes = collectResultSizes(list, sidechain);
  const { tools, unattributed } = attributeTools(requests, sizes);
  const { model, models } = modelBreakdown(requests);
  // ラベルは requests に載っているので、entries をもう1周する必要がなくなった
  // （前は障壁の時刻を拾うために list を舐めていた。4周 → 3周）
  const {
    skills,
    runs: skillRuns,
    unattributed: skillsUnattributed,
    omitted: skillsOmitted,
  } = attributeSkills(requests);
  const compact = collectCompactions(list, sidechain);

  return {
    model,
    models,
    requests: requests.length,
    duplicateLines,
    syntheticSkipped,
    totals,
    // 重みも一緒に返す。画面が内訳の表を出すのに要る値で、
    // ここで渡さないと同じ比率が画面側にもう1本生きることになる（必ず片方が古くなる）
    iteWeights: { ...ITE_WEIGHTS },
    context: {
      last: requests.length ? requests[requests.length - 1].context : null,
      peak,
      // 絵にするための系列。要求が1件も無ければ [] ではなく null
      // （「測って0件だった」ではなく「測りようがない」ため）
      series: contexts.length ? downsample(contexts, SERIES_MAX) : null,
      growth: growth.length
        ? {
            median: percentile(sortedGrowth, 0.5),
            p90: percentile(sortedGrowth, 0.9),
            max: sortedGrowth[sortedGrowth.length - 1],
          }
        : null,
    },
    cache: { hitRate: cacheBase > 0 ? totals.cacheRead / cacheBase : null },
    tools,
    toolsUnattributed: unattributed,
    // **因果は取れない。** 帰属ラベルは「どのスキルの文脈下で走ったか」であって
    // 「そのスキルのせいで増えた」ではないことを、画面側が必ず併記する
    skills,
    // 畳む前の1回ごと。横断側が同じスキルの推移を並べるのに使う。
    // 但し書きは skills と同じものが効く（推移が下がっても、楽な仕事だっただけかもしれない）
    skillRuns,
    // どのスキルにも紐づかなかったぶん。**実測で本流 ITE の 65% がここに落ちる。**
    // 返さないと「スキルを全部足しても合計に届かない」が説明できない。
    // tools の隣に toolsUnattributed があるのと同じ形で、skills には混ぜない
    // （混ぜると必ず1位になって棒の枠を1つ食い、横断側の sessions や推移も意味を失う）
    skillsUnattributed,
    // SKILLS_MAX で切ったぶん。1本では実測4種が最大なので当たらないが、
    // 横断側は 24 種に対して上限があるので実際に切れる
    skillsOmitted,
    compact,
  };
}
