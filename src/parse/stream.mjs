/**
 * stream-json の1行を読む・書く。
 *
 * 相手は `claude -p --input-format stream-json --output-format stream-json`。
 * 1行に1つの JSON が乗る（NDJSON）。会話ログの JSONL と同じ形式だが、**中身は別物**。
 *
 * ここは純関数だけにする。spawn も fs も触らない。
 * 実際に読み書きするのは os/claude.mjs（薄い殻）で、あちらは node:child_process だけに依存する。
 * だから**行を組む側（encodeUserLine）もここに置いてある**。
 * プロトコルの解釈と組み立ては表と裏なので、離すと片方だけ直して食い違う。
 *
 * ## 会話ログとの違い（読み間違えやすい所）
 *
 * - セッション ID のキーが `session_id`（snake_case）。会話ログは `sessionId`（camelCase）
 * - `result` 行の `usage` は `message` の下ではなく**行の直下**にある。
 *   だから entries.mjs の `usageOf` はそのままでは効かない。
 *   そもそも数値の正本は `~/.claude/projects/` の会話ログなので、ここでは usage を読まない
 * - `assistant` / `user` 行の `message.content` だけは会話ログと同じ形。
 *   なので entries.mjs の道具（contentBlocks / textOf / toolUses / toolResults）がそのまま効く
 *
 * ## 未知の形で落ちない
 *
 * stream-json も公開仕様ではない。知っている `type` だけを名前で拾い、残りは `other` にする。
 * **生の `type` は捨てずに残す。** `control_request`（許可を求めてくる行）のように、
 * いまは扱わないが後で扱いたくなるものがあるため。
 * JSON として読めない行は `broken` にして数えるだけ（transcript.mjs の parseLines と同じ作法）。
 */
import { clip } from '../shared/text.mjs';

/** broken のときに残す原文の見本の長さ。原因が分かればよいので短くてよい。 */
const SAMPLE_MAX = 200;

/** `result` 行の本文の長さ。応答をまるごと持つと台帳が太る。 */
const RESULT_TEXT_MAX = 2000;

/**
 * `session_id` を取り出す。
 *
 * stream-json は snake_case だが、会話ログ由来の行を間違えて渡されても読めるように
 * camelCase も見る。読めるものは読む（未知の形で落ちない）。
 *
 * @param {object} line 読めた行
 * @returns {string|null} 空文字は null に倒す
 */
function sessionIdOf(line) {
  const id = line.session_id ?? line.sessionId;
  return typeof id === 'string' && id ? id : null;
}

/**
 * 文字列をそのまま返す。空文字と文字列でないものは null。
 *
 * 「取れなかった」を空文字ではなく null で表すため。0 と不明を分ける原則と同じ。
 *
 * @param {*} v 何か
 * @returns {string|null}
 */
function str(v) {
  return typeof v === 'string' && v ? v : null;
}

/**
 * 有限の数値だけ返す。
 *
 * @param {*} v 何か
 * @returns {number|null} 数値でなければ null（0 は 0 のまま通す）
 */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * `system` / `subtype:init` から、起動できたことを確かめるための値を取り出す。
 *
 * 形は実測していない（段3 #3 で受信行を丸ごと落として棚卸しする）。
 * だから**キーが無いことを異常にしない。** 取れなければ null にして進む。
 *
 * @param {object} line 読めた行
 * @returns {{model:string|null, cwd:string|null, permissionMode:string|null, tools:number|null}}
 */
function initInfo(line) {
  const tools = Array.isArray(line.tools) ? line.tools.length : null;
  return {
    model: str(line.model),
    cwd: str(line.cwd),
    // 綴りが camel か snake かを確かめていないので両方見る
    permissionMode: str(line.permissionMode ?? line.permission_mode),
    tools,
  };
}

/**
 * `result` から、1往復が終わったことと、その結末を取り出す。
 *
 * `total_cost_usd` は `--max-budget-usd` の効き目を見るために拾う。
 * 画面に金額として出すためではない（USD は既定で出さない方針のまま）。
 *
 * @param {object} line 読めた行
 * @returns {{isError:boolean, durationMs:number|null, numTurns:number|null, costUSD:number|null, text:string|null}}
 */
function resultInfo(line) {
  return {
    // is_error が無いときは subtype で見る。success 以外は失敗として扱う
    isError: typeof line.is_error === 'boolean'
      ? line.is_error
      : (str(line.subtype) !== null && line.subtype !== 'success'),
    durationMs: num(line.duration_ms),
    numTurns: num(line.num_turns),
    costUSD: num(line.total_cost_usd),
    text: clip(line.result, RESULT_TEXT_MAX),
  };
}

/**
 * stream-json の1行を読み解く。
 *
 * **`entry` を台帳へそのまま積まないこと。** 大きな `tool_result` は1行が数MBになる。
 * 呼ぶ側で entries.mjs の道具にかけ、必要なところだけ切り出してから持つ。
 * ここが `entry` を返すのは、会話ログ用の道具をそのまま使えるようにするため。
 *
 * @param {string} text 行1本（末尾の改行は付いていても付いていなくてもよい）
 * @returns {{
 *   kind: 'init'|'assistant'|'user'|'result'|'other'|'broken',
 *   type: string|null,
 *   subtype: string|null,
 *   sessionId: string|null,
 *   parentToolUseId: string|null,
 *   entry: object|null,
 *   info: object|null,
 *   sample: string|null,
 * }}
 */
export function classifyStreamLine(text) {
  const base = {
    kind: 'broken',
    type: null,
    subtype: null,
    sessionId: null,
    parentToolUseId: null,
    entry: null,
    info: null,
    sample: null,
  };

  if (typeof text !== 'string' || !text.trim()) {
    // 空行は呼ぶ側で落としてから渡すこと（transcript.mjs の parseLines と同じ）。
    // ここまで来たら数え漏らすより数えたほうがましなので broken に倒す。見本は出しようがない
    return { ...base, kind: 'broken' };
  }

  let line;
  try {
    line = JSON.parse(text);
  } catch {
    return { ...base, sample: clip(text.trim(), SAMPLE_MAX) };
  }

  // 配列やリテラルが来ることは想定していないが、来たときに落ちない側へ倒す
  if (!line || typeof line !== 'object' || Array.isArray(line)) {
    return { ...base, sample: clip(text.trim(), SAMPLE_MAX) };
  }

  const type = str(line.type);
  const subtype = str(line.subtype);
  const common = {
    type,
    subtype,
    sessionId: sessionIdOf(line),
    // サブエージェント（Task）の出力にはこれが付く。会話ログの isSidechain にあたる印
    parentToolUseId: str(line.parent_tool_use_id ?? line.parentToolUseId),
  };

  switch (type) {
    case 'system':
      // system は init 以外も来る（compact_boundary など）。init だけを名前で扱う
      if (subtype === 'init') {
        return { ...base, ...common, kind: 'init', info: initInfo(line) };
      }
      return { ...base, ...common, kind: 'other' };

    case 'assistant':
    case 'user':
      // ここだけ会話ログと同じ形。entries.mjs の道具をそのまま当てられる
      return { ...base, ...common, kind: type, entry: line };

    case 'result':
      return { ...base, ...common, kind: 'result', info: resultInfo(line) };

    default:
      // control_request / control_response など、いま扱わないものがここへ落ちる。
      // 生の type を残してあるので、扱う気になったときに読み直せる
      return { ...base, ...common, kind: 'other' };
  }
}

/**
 * こちらから送る1行を組む。
 *
 * `content` は**常に配列で書く**。文字列でも通るかもしれないが、受け取り側の解釈の幅に賭けない。
 *
 * 戻り値には末尾の改行を含める。NDJSON の1行は改行までで1つなので、
 * 「改行を足すのは呼ぶ側の仕事」にすると足し忘れが**沈黙する**（相手が行を確定できず、ただ待つ）。
 *
 * JSON.stringify は本文中の改行を必ずエスケープするので、複数行の指示でも1行に収まる。
 *
 * @param {string} text 送る本文
 * @returns {string} 末尾に改行を含む1行
 * @throws {TypeError} 空や文字列以外を渡したとき。外から来た値は窓口で弾いてから渡すこと
 */
export function encodeUserLine(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new TypeError('送る本文が空です');
  }
  const line = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
  return `${JSON.stringify(line)}\n`;
}

/**
 * セッション ID が同じものを指しているか。
 *
 * `system/init` が返してきた ID が、こちらが `--session-id` で渡したものと一致するかを見る。
 * 違えば別のセッションに書き込んでいることになるので、呼ぶ側は止めて理由を出す。
 *
 * 大小を無視するのは、UUID の英字の大小はただの表記揺れで、別物を指す差ではないため。
 * ここで厳密に比べると、表記が変わっただけで「別のセッションです」と嘘の理由を出すことになる。
 *
 * @param {string|null} a 片方
 * @param {string|null} b もう片方
 * @returns {boolean} どちらかが無いときは false（不明を一致と読み替えない）
 */
export function sameSessionId(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}
