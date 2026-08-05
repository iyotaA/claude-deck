/**
 * 詳細ビューの中身を作る。
 *
 * 目的は「そのセッションで自分が何を判断したか」と「なぜそう進めているか」を、
 * ログから決定論的に抜いて時系列に並べること。要約はしない。
 *
 * 決定論であることは性能の前提でもある。
 * read/cache.mjs の memo と画面側の detailCache が「同じログなら同じ結果」に依存している。
 * だから現在時刻は受け取らない。進行中の待ちは state.mjs の idleMs が持っているので、
 * ここでは終わった待ちだけを扱う。
 *
 * 実測で分かった大事な形（公開仕様が無いので、このコメントが唯一の記録になる）:
 *
 *  AskUserQuestion の「選んだ答え」の出どころは2つあり、どちらも実在する。
 *
 *   1. toolUseResult.answers … {質問文: 選んだラベル} の辞書。素直に引ける
 *   2. tool_result の本文 … 次の形で埋まっている
 *
 *      Your questions have been answered: "質問"="選んだラベル" selected preview:
 *      …（選択肢のプレビュー本文）…
 *      , "質問2"="選んだラベル2". You can now continue with these answers in mind.
 *
 *  手元のログで数えると 1 は 65 回、2 は 134 回。
 *  つまり半分近くは answers を持たない古い版なので、本文からの抽出は
 *  「念のため」ではなく必須の経路になる。1 を優先し、無ければ 2 に落とす。
 *
 *  2 の経路は質問文を鍵に該当位置だけを読む（本文はプレビューが挟まって崩れているので
 *  全体をパースできない）。この鍵の作り方には弱点があり、質問文に " が含まれると引けない。
 *  1 を先に見る理由がこれ。
 *
 *  引けたラベルを options[].label と照合すれば、その選択肢の description まで出せる。
 *  description は「その選択が何を意味していたか」の説明なので、
 *  あとから読み返したときに判断の理由がそのまま残る。
 *
 *  複数選択（multiSelect: true）の値も数えた。実測3本すべて ", " 連結の文字列で、
 *  配列は0件。将来配列に変わっても読めるように normalizeAnswer で吸収する。
 */
import {
  textOf,
  toolUses,
  toolResults,
  timestampOf,
  uuidOf,
  agentIdOf,
  recapOf,
  taskNotificationOf,
  isUserPrompt,
  isInterrupt,
  isMainline,
  isSidechain,
  isToolResultEntry,
  slashCommandOf,
  DENIAL_KINDS,
} from './entries.mjs';
import { clip, oneLine } from '../shared/text.mjs';
import { describeTool, MAX_DETAIL } from '../shared/tools.mjs';

/** 1件あたりの上限。判断の記録になるものは長めに残し、説明文は短くする。 */
const LIMIT = {
  prompt: 6000,
  say: 1200,
  plan: 24000,
  // 中間報告は Claude が自分で畳んだ文なので、もともと長くない。発言より少しだけ広く取る
  recap: 2000,
  // ツールの一行説明と同じ長さ。並べて出るものなので揃える
  detail: MAX_DETAIL,
  feedback: 2000,
};

/** 時系列に並べる項目の上限。超えたら古い説明文から落とす。 */
const MAX_ITEMS = 400;

/**
 * 足跡（trace）だけの独立枠。
 *
 * 足跡は件数の桁が他と違うので、本編と同じ枠で取り合わせると
 * 足跡が残って Claude の説明が消える、という一番いやな壊れ方が起きる。
 * 既定では隠れている項目なので、本編を圧迫させない
 */
const MAX_TRACES = 200;

/**
 * 足跡に残す結果の先頭の長さ。
 *
 * 本文は積まない。足跡が答えるのは「どこを見に行ったか」で、
 * 結果の中身が要るときは原文（/api/sessions/:id/entry/:uuid）に戻ればよい。
 * 200件ぶんの全文を載せると詳細の応答が桁で膨らむ
 */
const TRACE_HEAD = 160;

/**
 * 上限を超えたときに落とす順。前のほうから使い切る。
 *
 * ここに無い種類は落とさない。指示・選択・プラン・却下・圧縮などの判断の記録がそれで、
 * 将来ここに知らない種類が増えても既定で残る側に倒れる
 */
const DROP_ORDER = [
  ['error'],           // 件数は stats.errors に残る
  ['skill', 'agent'],  // skills / agents 配列と同じ参照なので、そちらに残る
  ['say'],             // ここまで来たら諦める
];

/** ファイルを書き換えるツール。「触ったファイル」の判定に使う。 */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

/**
 * 4時間。これより長い待ちは「考えていた時間」ではなく席を外していた時間と見る。
 *
 * 境目に根拠があるわけではない。ただ、昼をまたいだ空白を「回答までの間」として
 * 合計に混ぜると集計が意味を失うので、別枠に寄せる線をどこかに引く必要がある
 */
const AWAY_MS = 4 * 60 * 60 * 1000;

/**
 * 却下されたときに機械的に入る英文。
 *
 * 中身は毎回同じで読む価値がないのに長いため、時系列を埋めてしまう。
 * 取り除いて、あとに何か残ればそれだけを出す（自分が添えたコメントがそこに来る）。
 */
const DENIAL_NOISE = [
  /The user doesn't want to proceed with this tool use\./g,
  /The tool use was rejected \([^)]*\)\./g,
  /STOP what you are doing and wait for the user to tell you how to proceed\./g,
  /Note: The user's next message may contain a correction or preference\.[\s\S]*?future sessions\./g,
  /The user doesn't want to take this action right now\./g,
  /Permission (?:for this action was denied|to use \S+ was denied)[^.]*\./g,
  /Tool use was rejected[^.]*\./g,
];

/**
 * 却下に添えたコメントだけを取り出す。
 *
 * oneLine ではなく clip を使う。ここは「なぜ止めたか」を自分の言葉で書いた場所なので、
 * 箇条書きや行分けに意味がある。受け側は white-space: pre-wrap で出す
 */
function denialNote(text) {
  let t = typeof text === 'string' ? text : '';
  for (const re of DENIAL_NOISE) t = t.replace(re, '');
  return clip(t, LIMIT.feedback);
}

/**
 * 選んだ答えを1つの文字列に寄せる。
 *
 * 実測では複数選択でも ", " 連結の文字列で来る（配列は0件）。
 * 将来配列に変わっても読めるように、ここで配列を吸収しておく。
 * 逆に文字列は分割しない。ラベル自体に ", " が入っていると壊れるため
 *
 * @param {unknown} raw ログから読んだ生の値
 * @returns {string|null} 空なら null
 */
function normalizeAnswer(raw) {
  if (typeof raw === 'string') return raw.trim() || null;
  if (Array.isArray(raw)) {
    const parts = raw.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  }
  return null;
}

/**
 * tool_result の本文から、その質問の答えを引く（古い版のログ用の経路）。
 *
 * @param {string} question 質問文。これが鍵になる
 * @param {string} text tool_result の本文
 * @returns {string|null} 引けなければ null
 */
function chosenFromText(question, text) {
  if (!question || typeof text !== 'string') return null;
  const needle = `"${question}"="`;
  const at = text.indexOf(needle);
  if (at === -1) return null;
  const rest = text.slice(at + needle.length);
  const end = rest.indexOf('"');
  return normalizeAnswer(end === -1 ? rest.slice(0, 300) : rest.slice(0, end));
}

/**
 * 質問ごとに「何を選んだか」と「その選択肢の説明」を組む。
 *
 * @param {object} input AskUserQuestion への入力（質問と選択肢の控え）
 * @param {object|null} result 対応する tool_result（未回答なら null）
 * @returns {Array} 質問と同じ順の配列
 */
function pickAnswers(input, result) {
  const text = typeof result?.text === 'string' ? result.text : '';
  const dict = result?.structured?.answers;
  const hasDict = Boolean(dict) && typeof dict === 'object' && !Array.isArray(dict);
  const out = [];

  for (const q of input?.questions ?? []) {
    const question = typeof q?.question === 'string' ? q.question : '';
    const options = Array.isArray(q?.options) ? q.options : [];

    // 辞書が第一候補。質問文に " が入っていても引ける
    const chosen = (hasDict ? normalizeAnswer(dict[question]) : null)
      ?? chosenFromText(question, text);

    // 選択肢のラベルと突き合わせる。合えばその description が判断の根拠になる。
    // 「Other」で自由入力した場合はどれにも合わないので、そのまま文字列として残す。
    // 含有判定にしているのは複数選択のため。", " 連結の文字列でも複数件が自然に当たる
    const picked = options.filter((o) => chosen && typeof o?.label === 'string'
      && (chosen === o.label || chosen.includes(o.label)));

    out.push({
      question,
      header: typeof q?.header === 'string' ? q.header : null,
      multiSelect: q?.multiSelect === true,
      chosen,
      // preview は大きいので落とす。label と description だけ持つ。
      // description は切らない。選んだ理由そのものなので改行ごと残す
      chosenOptions: picked.map((o) => ({ label: o.label, description: o.description ?? null })),
      freeText: Boolean(chosen) && picked.length === 0,
      otherOptions: options
        .filter((o) => !picked.includes(o))
        .map((o) => ({ label: o.label ?? '', description: oneLine(o.description, 200) })),
    });
  }

  return out;
}

/**
 * サブエージェントの終わりの記録を agentId から引ける表にする。
 *
 * 非同期で起動したエージェントは、呼び出しの結果には「起動した」までしか入らない。
 * 終わりは別の行として差し込まれるので、そこを拾って結び直す。
 * これがあるので「走っているかどうか」を mtime や推測で当てなくて済む
 *
 * @param {Array} scoped 対象の行
 * @returns {Map<string, {status: string|null, at: number|null}>}
 */
function indexNotifications(scoped) {
  const byAgent = new Map();
  for (const entry of scoped) {
    const note = taskNotificationOf(entry);
    if (!note) continue;
    // 同じエージェントが何度も止まると通知も複数出る（差し込みの note 自身がそう書いている）。
    // あとから来たほうが最後の状態なので上書きする
    byAgent.set(note.taskId, { status: note.status, at: timestampOf(entry) });
  }
  return byAgent;
}

/**
 * サブエージェントの状態を決める。
 *
 * 言い切れないものを言い切らないための関数。上から順に見る。
 *
 *  1. 終わりの記録があればそれが最終（completed / killed / failed）
 *  2. 呼び出しの結果が completed なら、同期で走って報告まで返っている
 *  3. async_launched のまま終わりの記録が無ければ launched。
 *     **「走っている」とは言わない。** セッションがもう終わっていれば走ってもいない。
 *     この記録から言えるのは「起動したところまでは分かる」だけ
 *  4. 結果そのものが無ければ pending（呼んだ直後で、まだ返ってきていない）
 *
 * 知らない値が来たらそのまま返す。黙って既知の値に丸めない
 *
 * @param {object|null} result 呼び出しに対応する結果
 * @param {object|null} done 終わりの記録
 * @returns {string|null}
 */
function agentStatus(result, done) {
  if (done?.status) return done.status;
  const raw = result?.structured?.status;
  if (raw === 'completed') return 'completed';
  if (raw === 'async_launched') return 'launched';
  if (!result) return 'pending';
  return typeof raw === 'string' ? raw : null;
}

/** tool_use_id から結果を引ける表を作る。承認・却下の判定に必要。 */
function indexResults(entries) {
  const byId = new Map();
  for (const entry of entries) {
    const denialKind = typeof entry?.toolDenialKind === 'string' ? entry.toolDenialKind : null;
    for (const r of toolResults(entry)) {
      if (!r.id) continue;
      byId.set(r.id, {
        text: r.text ?? '',
        isError: r.isError,
        denialKind,
        structured: entry?.toolUseResult,
        at: timestampOf(entry),
        // 原文に戻るとき、呼び出した行ではなく結果の行を開きたい場面がある
        uuid: uuidOf(entry),
      });
    }
  }
  return byId;
}

/**
 * 待ちを跨いだら「連続した1つの待ち」ではなくなる地点の時刻。
 *
 * 文脈の圧縮・スラッシュコマンド（とくに /clear）・中断のあとは、
 * 前の呼び出しの続きとして数えると別の作業だった時間まで足してしまう
 *
 * @param {Array} scoped 対象の行
 * @returns {number[]} 昇順の時刻
 */
function collectBarriers(scoped) {
  const out = [];
  for (const entry of scoped) {
    const at = timestampOf(entry);
    if (at === null) continue;
    if (entry?.type === 'system' && entry.subtype === 'compact_boundary') {
      out.push(at);
      continue;
    }
    if (entry?.type !== 'user') continue;
    if (slashCommandOf(entry) || isInterrupt(entry)) out.push(at);
  }
  return out.sort((a, b) => a - b);
}

/**
 * 待ち時間を組む。
 *
 * 取れないときは null を返す。0 と書いてはいけない。
 * 「測れなかった」と「待たせていない」は別のことなので、混ぜると集計が嘘になる
 *
 * @param {string} kind 何を待っていたか（answer / plan / denial / reply / tool）
 * @param {number|null} fromAt 待ち始めた時刻
 * @param {number|null} toAt 待ちが終わった時刻
 * @param {number[]} barriers 跨いだら別の待ちになる地点
 * @returns {object|null} 測れないときは null
 */
function waitOf(kind, fromAt, toAt, barriers) {
  if (typeof fromAt !== 'number' || typeof toAt !== 'number') return null;
  const ms = toAt - fromAt;
  if (ms < 0) return null;
  for (const b of barriers) {
    if (b > fromAt && b < toAt) return null;
  }
  return { kind, fromAt, toAt, ms, away: ms >= AWAY_MS };
}

/** 待ちの集計の初期値。種類ごとに件数・合計・最長を持つ。 */
function emptyWaitStats() {
  const bucket = () => ({ count: 0, totalMs: 0, maxMs: 0, away: 0 });
  return {
    answer: bucket(),
    plan: bucket(),
    denial: bucket(),
    reply: bucket(),
    // ふつうのツールの往復。許可待ちと実行時間が混ざるので、上の4つとは足し合わせない
    tool: bucket(),
  };
}

/**
 * 待ちを集計に足す。
 *
 * 4時間超は合計に混ぜず away の件数だけ増やす。
 * 昼をまたいだ空白を混ぜると「回答までの間 合計 9時間」のような無意味な数になる
 *
 * @param {object} waits emptyWaitStats() の結果
 * @param {object|null} wait waitOf() の結果
 */
function addWait(waits, wait) {
  if (!wait) return;
  const b = waits[wait.kind];
  if (!b) return;
  if (wait.away) {
    b.away += 1;
    return;
  }
  b.count += 1;
  b.totalMs += wait.ms;
  if (wait.ms > b.maxMs) b.maxMs = wait.ms;
}

/**
 * 上限を超えた分を落とし、落とした位置に省略の印（elided）を残す。
 *
 * 枠は2つ。足跡は MAX_TRACES の独立枠で、本編は MAX_ITEMS。
 * elided は**どちらの枠の外**に置く。枠の中だと、印を作るために本体をもう1件落とす循環になる
 *
 * @param {Array} items 組み終わった時系列
 * @returns {{items: Array, dropped: number}}
 */
function trimItems(items) {
  const traces = items.filter((it) => it.kind === 'trace');
  const rest = items.length - traces.length;
  const drop = new Set();

  // 足跡は古いものから落とす。新しい足跡のほうが今の作業に近い
  for (let k = 0; k < traces.length - MAX_TRACES; k += 1) drop.add(traces[k]);

  let budget = rest - MAX_ITEMS;
  for (const kinds of DROP_ORDER) {
    if (budget <= 0) break;
    for (const item of items) {
      if (budget <= 0) break;
      if (drop.has(item) || !kinds.includes(item.kind)) continue;
      drop.add(item);
      budget -= 1;
    }
  }

  if (drop.size === 0) return { items, dropped: 0 };

  const out = [];
  let run = null;
  for (const item of items) {
    if (drop.has(item)) {
      // 連続して落ちた区間は1つの印にまとめる。1件ずつ印を出すと本体より数が増える
      if (!run) {
        // i は落ちた先頭の位置をそのまま使う。生き残った項目とはぶつからない
        run = { i: item.i, kind: 'elided', uuid: null, count: 0, fromAt: null, toAt: null, byKind: {} };
      }
      run.count += 1;
      run.byKind[item.kind] = (run.byKind[item.kind] ?? 0) + 1;
      if (typeof item.at === 'number') {
        if (run.fromAt === null) run.fromAt = item.at;
        run.toAt = item.at;
      }
      continue;
    }
    if (run) {
      out.push(run);
      run = null;
    }
    out.push(item);
  }
  if (run) out.push(run);

  return { items: out, dropped: drop.size };
}

/**
 * @param {object} params
 * @param {Array} params.entries readAll で読んだ全行
 * @param {'main'|'sidechain'} [params.scope] どちらの流れを組むか。既定は本流。
 *   サブエージェントのログは全行が isSidechain:true なので、main のままだと1件も残らない
 * @param {string|null} [params.agentId] sidechain のとき、この agentId の行だけに絞る。
 *   1エージェント1ファイルなので通常は要らないが、混ざったログを渡されても正しく組めるようにしておく
 * @returns {object} 詳細ビュー用のデータ
 */
export function buildDigest({ entries = [], scope = 'main', agentId = null } = {}) {
  const scoped = scope === 'sidechain'
    ? entries.filter((e) => isSidechain(e) && (agentId === null || agentIdOf(e) === agentId))
    : entries.filter(isMainline);
  const results = indexResults(scoped);
  const barriers = collectBarriers(scoped);
  const notifications = indexNotifications(scoped);

  const items = [];
  const files = new Map();
  const skills = [];
  const agents = [];
  const compactions = [];
  const stats = {
    prompts: 0,
    answers: 0,
    plans: 0,
    denials: 0,
    interrupts: 0,
    errors: 0,
    toolCalls: 0,
    says: 0,
    turns: 0,
    firstAt: null,
    lastAt: null,
    waits: emptyWaitStats(),
  };

  let index = 0;
  /**
   * 返信待ちの起点。Claude が発言して止まった時刻。
   *
   * ここのリセット条件に罠がある。{"type":"system","subtype":"turn_duration"} が
   * 毎ターンの直後に必ず入る（実測405件）ので、「assistant 以外なら全部リセット」に
   * すると返信待ちが1件も測れない。リセットするのはツール結果・圧縮・中断・
   * スラッシュコマンドのときだけにする
   */
  let replyFrom = null;

  for (const entry of scoped) {
    const at = timestampOf(entry);
    const uuid = uuidOf(entry);
    if (at !== null) {
      if (stats.firstAt === null || at < stats.firstAt) stats.firstAt = at;
      if (stats.lastAt === null || at > stats.lastAt) stats.lastAt = at;
    }

    // 文脈が圧縮された地点。ここより前の細部は Claude 側も覚えていない
    if (entry?.type === 'system' && entry.subtype === 'compact_boundary') {
      const m = entry.compactMetadata ?? {};
      const item = {
        i: index++,
        kind: 'compact',
        at,
        uuid,
        trigger: m.trigger ?? null,
        preTokens: m.preTokens ?? null,
        postTokens: m.postTokens ?? null,
        droppedTokens: m.cumulativeDroppedTokens ?? null,
      };
      items.push(item);
      compactions.push(item);
      replyFrom = null;
      continue;
    }

    // Claude 自身が書いた中間報告。
    // これは自己申告であって、機械的に抽出した記録ではない。
    // 間引きでは落とさない（数が少なく、抜けると「報告があった事実」まで消える）
    const recap = recapOf(entry);
    if (recap) {
      items.push({
        i: index++,
        kind: 'recap',
        at,
        uuid,
        text: clip(recap, LIMIT.recap),
        fullLength: recap.length,
      });
      continue;
    }

    if (entry?.type === 'user') {
      const slash = slashCommandOf(entry);
      if (slash) {
        items.push({ i: index++, kind: 'slash', at, uuid, command: slash.command, args: slash.args || null });
        replyFrom = null;
        continue;
      }
      if (isInterrupt(entry)) {
        stats.interrupts += 1;
        items.push({ i: index++, kind: 'interrupt', at, uuid });
        replyFrom = null;
        continue;
      }
      if (isUserPrompt(entry)) {
        stats.prompts += 1;
        // Claude が発言して止まってから、この指示を打つまでの間
        const wait = waitOf('reply', replyFrom, at, barriers);
        addWait(stats.waits, wait);
        items.push({ i: index++, kind: 'prompt', at, uuid, text: clip(textOf(entry), LIMIT.prompt), wait });
        replyFrom = null;
        continue;
      }
      // ツール結果が来たなら Claude は動いている。返信を待っていたわけではない
      if (isToolResultEntry(entry)) replyFrom = null;
      continue;
    }

    if (entry?.type !== 'assistant') continue;

    const say = textOf(entry);
    if (say) {
      stats.says += 1;
      items.push({
        i: index++,
        kind: 'say',
        at,
        uuid,
        text: clip(say, LIMIT.say),
        // 切る前の長さ。切られた本文から長さを計ると「全文」の字数が嘘になる
        fullLength: say.length,
      });
      if (at !== null) replyFrom = at;
    }

    /**
     * この行ぶんのふつうの呼び出し（足跡の材料）。
     *
     * assistant の1行につき1件の足跡にまとめる。1呼び出し1件にすると、
     * 並列で6本呼んだ行が6件になって、判断の記録が水増しの中に埋もれる。
     * 却下・質問・プラン・スキル・エージェント・失敗は自分の項目を持つので、ここには入れない
     */
    const calls = [];

    for (const tu of toolUses(entry)) {
      stats.toolCalls += 1;
      const result = results.get(tu.id) ?? null;

      if (WRITE_TOOLS.has(tu.name) && tu.input?.file_path) {
        const path = String(tu.input.file_path);
        const rec = files.get(path) ?? { path, count: 0, tools: new Set() };
        rec.count += 1;
        rec.tools.add(tu.name);
        files.set(path, rec);
      }

      // あなたが却下した、または権限で止められた呼び出し
      if (result?.denialKind) {
        stats.denials += 1;
        const wait = waitOf('denial', at, result.at, barriers);
        addWait(stats.waits, wait);
        items.push({
          i: index++,
          kind: 'denial',
          at,
          uuid,
          resultUuid: result.uuid,
          tool: tu.name,
          detail: describeTool(tu.name, tu.input),
          denialKind: result.denialKind,
          denialLabel: DENIAL_KINDS[result.denialKind] ?? result.denialKind,
          // 却下時に添えたコメントがあれば、それが一番知りたい情報になる
          note: denialNote(result.text),
          wait,
        });
        continue;
      }

      if (tu.name === 'AskUserQuestion') {
        const answers = pickAnswers(tu.input, result);
        stats.answers += answers.length;
        const wait = waitOf('answer', at, result?.at ?? null, barriers);
        addWait(stats.waits, wait);
        items.push({
          i: index++,
          kind: 'answer',
          at,
          uuid,
          resultUuid: result?.uuid ?? null,
          answers,
          unanswered: !result,
          wait,
        });
        continue;
      }

      if (tu.name === 'ExitPlanMode') {
        const text = result?.text ?? '';
        const approved = /approved your plan/i.test(text);
        const saved = /saved to:\s*(.+)/.exec(text);
        stats.plans += 1;
        const wait = waitOf('plan', at, result?.at ?? null, barriers);
        addWait(stats.waits, wait);
        const body = tu.input?.plan ?? result?.structured?.plan;
        // 承認された結果には filePath が必ず入っていた（実測46件すべて）。
        // 本文から拾う正規表現は、その形が無い古い版のための控え
        const filePath = typeof result?.structured?.filePath === 'string'
          ? result.structured.filePath
          : saved ? saved[1].trim() : null;
        items.push({
          i: index++,
          kind: 'plan',
          at,
          uuid,
          resultUuid: result?.uuid ?? null,
          plan: clip(body, LIMIT.plan),
          // 切る前の長さ。ディスクの本文と突き合わせるとき、切られた本文で比べると必ず不一致になる
          planChars: typeof body === 'string' ? body.length : null,
          // 実測では true のときだけ書かれ、false は一度も出ない。
          // キーが無いことを「編集なし」と読み替えられないよう、無いときは null で渡す
          edited: result?.structured?.planWasEdited === true ? true : null,
          approved,
          pending: !result,
          planFile: filePath,
          // 却下・修正指示のときは本文にその内容が入る。次に何をするかの指示なので改行ごと残す
          feedback: approved ? null : clip(text, LIMIT.feedback),
          wait,
        });
        continue;
      }

      addWait(stats.waits, waitOf('tool', at, result?.at ?? null, barriers));

      if (tu.name === 'Skill') {
        const rec = {
          i: index++,
          kind: 'skill',
          at,
          uuid,
          skill: tu.input?.skill ?? '?',
          args: tu.input?.args || null,
        };
        items.push(rec);
        skills.push(rec);
        continue;
      }

      if (tu.name === 'Agent' || tu.name === 'Task') {
        // 結果には2つの形がある（実測140件）。
        //   同期  59件 … status:"completed"。content に報告本文、totalDurationMs / totalTokens /
        //                 totalToolUseCount / toolStats / usage が付く
        //   非同期 81件 … status:"async_launched"。起動したことしか入らない。
        //                 終わりは別の <task-notification> の行に出る（indexNotifications で拾う）
        const s = result?.structured ?? null;
        const agentId = typeof s?.agentId === 'string' ? s.agentId : null;
        const done = agentId ? notifications.get(agentId) ?? null : null;
        // items と agents で同じオブジェクトを共有している。間引きで items から
        // 消えても agents には残る形にしたいので、ここをコピーに変えてはいけない
        // （提案10 の subagents.items がこの参照に依存している）
        const rec = {
          i: index++,
          kind: 'agent',
          at,
          uuid,
          resultUuid: result?.uuid ?? null,
          // サブエージェントの記録と突き合わせる鍵。呼び出し側の id と、結果に入る agentId
          toolUseId: tu.id ?? null,
          agentId,
          // 呼び出しに subagent_type が無い形もあるので、結果側の agentType にも落とす
          agentType: tu.input?.subagent_type ?? (typeof s?.agentType === 'string' ? s.agentType : null),
          description: oneLine(tu.input?.description, LIMIT.detail),
          model: typeof s?.resolvedModel === 'string' ? s.resolvedModel : null,
          status: agentStatus(result, done),
          // 同期完了のときだけ入る。取れなければ null（0 と混ぜない）
          durationMs: typeof s?.totalDurationMs === 'number' ? s.totalDurationMs : null,
          tokens: typeof s?.totalTokens === 'number' ? s.totalTokens : null,
          toolUseCount: typeof s?.totalToolUseCount === 'number' ? s.totalToolUseCount : null,
          // 報告本文そのものは積まない。長さだけ出して、中身は「開く」の応答へ回す
          reportChars: typeof s?.content === 'string' ? s.content.length : null,
          doneAt: done?.at ?? null,
        };
        items.push(rec);
        agents.push(rec);
        continue;
      }

      // 失敗した呼び出し。却下とは別に数える
      if (result?.isError) {
        stats.errors += 1;
        items.push({
          i: index++,
          kind: 'error',
          at,
          uuid,
          resultUuid: result.uuid,
          tool: tu.name,
          detail: describeTool(tu.name, tu.input),
          message: oneLine(result.text, LIMIT.detail),
        });
        continue;
      }

      calls.push({
        tool: tu.name,
        detail: describeTool(tu.name, tu.input),
        // 呼んでから結果が返るまで。承認待ちの時間も含む（分けられない）
        durationMs: typeof at === 'number' && typeof result?.at === 'number' ? result.at - at : null,
        // 結果がまだ来ていない。いま止まっているのがここだと分かる
        pending: !result,
        // 0 と「取れなかった」を分ける。結果が無い行は null にする
        resultChars: typeof result?.text === 'string' ? result.text.length : null,
        head: oneLine(result?.text, TRACE_HEAD),
        resultUuid: result?.uuid ?? null,
      });
    }

    if (calls.length) {
      // 一番遅い結果まで。1本も測れなければ null。取れた分があればその最長を出す
      const durations = calls.map((c) => c.durationMs).filter((v) => typeof v === 'number');
      items.push({
        i: index++,
        kind: 'trace',
        at,
        uuid,
        count: calls.length,
        // 畳んだ見出しに出す。同じツールを並列で呼んだ行を「Read ×4」と読めるようにする
        tools: [...new Set(calls.map((c) => c.tool))],
        durationMs: durations.length ? Math.max(...durations) : null,
        calls,
      });
    }
  }

  stats.turns = scoped.filter((e) => e?.type === 'assistant').length;

  const trimmed = trimItems(items);

  return {
    items: trimmed.items,
    files: [...files.values()]
      .map((f) => ({ path: f.path, count: f.count, tools: [...f.tools] }))
      .sort((a, b) => b.count - a.count),
    skills,
    agents,
    compactions,
    stats: {
      ...stats,
      elapsedMs: stats.firstAt !== null && stats.lastAt !== null ? stats.lastAt - stats.firstAt : null,
      droppedItems: trimmed.dropped,
    },
  };
}
