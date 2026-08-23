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
  isInterrupt,
  isMainline,
  isUserPrompt,
  requestIdOf,
  slashCommandOf,
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
 * 全ログを走査してもスキルは 12種・82件しか無かった（実測）。
 * 1セッションに何種類も出るものではないので、ツールより小さくてよい。
 */
const SKILLS_MAX = 12;

/**
 * スキルの区間を、畳まずに1件ずつ何件まで返すか。
 *
 * 上の SKILLS_MAX が「何種類まで」なら、こちらは「何回ぶんまで」。
 * 同じスキルを前回とどう比べるかを見るには、平均へ畳む前の1回ごとが要る。
 *
 * 実測では全ログ273本を走ってもスキルの呼び出しは82件しか無く、
 * 1本あたりでは十数件が上限だった。60 なら実質切れないが、
 * 上限そのものは要る（1本のログに何十回も呼ぶ使い方を禁じてはいない）。
 * 切るときは**新しいほうを残す**。推移で見たいのは直近だから。
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
      // 拾うのは tool_use だけ
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
 * スキル区間の切れ目になる時刻を集める。
 *
 * 区間は「Skill を呼んでから、次にあなたの番が来るまで」。
 * スキルは指示を読み込ませるものなので、効き目は呼んだ**後**の作業に現れる。
 * 打ち切るのは次の4つで、どれかが先に来た時点で終わり。
 *
 * - あなたの発言 … 区間の本来の終わり
 * - スラッシュコマンド … `/clear` など。話がまるごと切り替わる
 * - 中断 … Esc で止めた
 * - 圧縮の境目 … それより前のやり取りは要約に置き換わっている
 *
 * 障壁はもう1つ「次の Skill」があるが、これはここに入れない。
 * assistant 行なので時刻ではなく **requests の並びの位置**で切れるため
 * （attributeSkills の側で見ている）。
 *
 * `digest/waits.mjs` の collectBarriers と同じ形をしている。
 * あちらは「待ち時間を跨いでよいか」を見るためのもので、こちらは「スキルの効き目が続いているか」。
 * 見る行の種類が違う（あちらはあなたの発言を障壁にしない）ので、まとめずに別に持つ。
 *
 * @param {object[]} entries 会話ログの行
 * @param {boolean} sidechain true ならサブエージェントの行だけを見る
 * @returns {number[]} 時刻の昇順
 */
function collectSkillBarriers(entries, sidechain) {
  const out = [];

  for (const entry of entries) {
    if (isMainline(entry) === sidechain) continue;
    const at = timestampOf(entry);
    if (at === null) continue;

    if (entry?.type === 'system' && entry.subtype === 'compact_boundary') {
      out.push(at);
      continue;
    }
    if (entry?.type !== 'user') continue;
    if (isUserPrompt(entry) || slashCommandOf(entry) || isInterrupt(entry)) out.push(at);
  }

  return out.sort((a, b) => a - b);
}

/**
 * スキルを呼んだ直後の一続きを、スキルごとに数える。
 *
 * **因果は取れない。** ここで出るのは
 * 「そのスキルを呼んだあと、次にあなたの番が来るまでに何を使ったか」であって、
 * その消費がスキルのせいなのか、たまたま重い作業だったのかは分けられない。
 * だから画面側は、この但し書きを**折りたたまずに常時**出す約束にしてある。
 * その表示を外すなら、この数字も一緒に外すこと。
 *
 * 区間は Skill を呼んだ要求の**次**から始める。
 * その要求自身の usage は「Skill を呼ぶと決めるまで」の文脈で、
 * スキルの本文はまだ積まれていない（積まれるのは結果が返る次の要求から）。
 *
 * 返すのは2つ。**畳んだもの（skills）と、畳む前の1回ごと（runs）。**
 * 平均だけを返していたころ、同じスキルを5回呼んだ記録が1つの数へ溶けていて、
 * 1回目より速くなったのか遅くなったのかが読めなかった。
 * 畳む前の値はここで既に計算しているので、配列で持つだけで済む。
 *
 * @param {object[]} requests 時系列に並んだ要求
 * @param {number[]} barriers 区間を打ち切る時刻（昇順）
 * @returns {{skills: object[], runs: object[]}} skills は ite の降順、runs は時刻の昇順
 */
function attributeSkills(requests, barriers) {
  // Skill を呼んだ位置を先に拾う。区間の終わりを決めるのに「次はどこか」が要る
  const starts = [];
  for (let i = 0; i < requests.length; i += 1) {
    const names = [];
    for (const u of requests[i].uses) {
      if (u.name === 'Skill' && typeof u.input?.skill === 'string' && u.input.skill) names.push(u.input.skill);
    }
    if (names.length) starts.push({ index: i, names });
  }
  if (!starts.length) return { skills: [], runs: [] };

  /** @type {Map<string, {skill: string, runs: number, requests: number, ite: number}>} */
  const byName = new Map();
  /** @type {{skill: string, at: number|null, ite: number, requests: number}[]} 畳む前の1回ごと。時刻の昇順 */
  const runsList = [];

  for (let s = 0; s < starts.length; s += 1) {
    const { index, names } = starts[s];
    // 次に Skill を呼んだ要求までを見る。その要求自身は
    // 「前のスキルのもとで働いた最後の1回」なので、区間に含める
    const stop = starts[s + 1]?.index ?? requests.length - 1;

    // 開始より後に来る最初の障壁。時刻を持たない要求からは判定できないので、
    // そのときは次の Skill までを区間にする（実データでは時刻の無い assistant 行は見ていない）
    const startAt = requests[index].at;
    let endAt = Infinity;
    if (startAt !== null) {
      for (const b of barriers) {
        if (b > startAt) {
          endAt = b;
          break;
        }
      }
    }

    let ite = 0;
    let count = 0;
    for (let i = index + 1; i <= stop; i += 1) {
      const at = requests[i].at;
      if (at !== null && at >= endAt) break;
      ite += requests[i].ite;
      count += 1;
    }

    // 1回の要求で2つのスキルを呼ぶことがある。どちらのぶんかは分けられないので等分する
    // （ツール別の按分と同じ考え方。分けられないものを片方へ寄せない）。
    // 呼んだ回数だけは、どちらも1回として数える
    const share = 1 / names.length;
    for (const name of names) {
      // 畳む前の1件。**ここでだけ丸める。** 足してから丸めると、
      // 等分した端数が積もって skills 側の合計と食い違う
      runsList.push({
        skill: name,
        at: startAt,
        ite: Math.round(ite * share),
        requests: Math.round(count * share),
      });

      const rec = byName.get(name) ?? { skill: name, runs: 0, requests: 0, ite: 0 };
      rec.runs += 1;
      rec.requests += count * share;
      rec.ite += ite * share;
      byName.set(name, rec);
    }
  }

  const skills = [...byName.values()]
    .map((r) => ({
      skill: r.skill,
      runs: r.runs,
      requests: Math.round(r.requests),
      ite: Math.round(r.ite),
      // runs は必ず1以上（呼んだから記録がある）ので、ここは 0 で割らない
      avg: Math.round(r.ite / r.runs),
    }))
    .sort((a, b) => b.ite - a.ite || a.skill.localeCompare(b.skill))
    .slice(0, SKILLS_MAX);

  // starts は index の昇順なので runsList も時刻の昇順。切るのは古いほうから
  return { skills, runs: runsList.slice(-SKILL_RUNS_MAX) };
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
  // 区間の切れ目は entries 側にしかない（あなたの発言も compact_boundary も assistant 行ではない）ので、
  // requests ではなく list を渡して時刻で拾う
  const { skills, runs: skillRuns } = attributeSkills(
    requests,
    collectSkillBarriers(list, sidechain)
  );
  // entries を1周増やすが、既に3周しているので誤差。
  // collectSkillBarriers も compact_boundary を見ているが、そこへ相乗りさせない。
  // 「区切りを集める」関数に「圧縮を数える」を混ぜると、どちらのテストも読みにくくなる
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
    // **因果は取れない。** 「呼んだ直後の一続き」でしかないことを、画面側が必ず併記する
    skills,
    // 畳む前の1回ごと。横断側が同じスキルの推移を並べるのに使う。
    // 但し書きは skills と同じものが効く（推移が下がっても、楽な仕事だっただけかもしれない）
    skillRuns,
    compact,
  };
}
