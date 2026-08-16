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
 *
 * ## 実測した行の並び（claude 2.1.228・2026-08-15 と 08-16）
 *
 * 観測した種類はこの9つ。`system/hook_*` はフックを入れている環境でだけ流れる。
 *
 * ```
 * system/hook_started   system/hook_progress   system/hook_response   system/permission_denied
 * system/init   user   assistant   rate_limit_event   result
 * ```
 *
 * 並びで気をつけるところが4つある。どれも扱いを間違えると壊れ方が分かりにくい。
 *
 * - **`system/init` はターンごとに来る。** 起動時の1回だけではない（中身は同じで uuid だけ変わる）。
 *   「もう init は来た」と決め打って2回目を捨てると、`session_id` の照合の機会を失う
 * - **`result` は最後の行ではない。** 実測で `system/hook_response` が result の11ms 後に届いた。
 *   result を見たら「あなたの番」に移してよいが、**そこで読むのをやめてはいけない**
 * - **`user` 行には `isReplay: true` が付く**（`--replay-user-messages` の戻り）。
 *   これが無いと「自分が送った行」と「ツール結果の行」が同じ顔で並ぶ
 * - **`system/permission_denied` は止まった印ではない。** `acceptEdits` で Bash を投げると
 *   これが流れ、そのツールの結果が `isError:true`（`This command requires approval`）になり、
 *   **向こうは止まらずに次の手へ移る**（件数は `result` の `permission_denials` に載る）。
 *   「許可待ちで止まっている」と読み替えると、待っていないものを待っていることにしてしまう
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
 * 実測で載っていたキー（claude 2.1.228）。ここに無いものは仮定しない。
 *
 * ```
 * type subtype cwd session_id tools mcp_servers model permissionMode slash_commands
 * apiKeySource claude_code_version output_style agents skills plugins capabilities
 * analytics_disabled product_feedback_disabled uuid memory_paths
 * fast_mode_state fast_mode_disabled_reason
 * ```
 *
 * - `permissionMode` は**キャメル**。この行だけ他と綴りが違う（`session_id` は snake）。
 *   `permission_mode` も見るのは、向こうが揃えてきた日に黙って null になるのを防ぐ保険
 * - `model` は `claude-opus-5[1m]` のように**角括弧が付くことがある**。
 *   `run/spec.mjs` の `MODEL_RE` は角括弧を通さないが、あれは**こちらから指定する側**の話。
 *   受け取る側で弾かない（表示するだけなので害が無い）
 * - `capabilities` に `interrupt_receipt_v1` などが載る。中断の口が公開されている手がかりだが、
 *   いまは使っていないので拾わない
 *
 * それでも**キーが無いことを異常にしない。** 版が上がれば形は変わる。取れなければ null で進む。
 *
 * @param {object} line 読めた行
 * @returns {{model:string|null, cwd:string|null, permissionMode:string|null, tools:number|null}}
 */
function initInfo(line) {
  const tools = Array.isArray(line.tools) ? line.tools.length : null;
  return {
    model: str(line.model),
    cwd: str(line.cwd),
    permissionMode: str(line.permissionMode ?? line.permission_mode),
    tools,
  };
}

/**
 * `errors` を1本の文字列に畳む。
 *
 * 実測（予算超過）で `["Reached maximum budget ($0.01)"]` の形だった。
 * **人が読める理由はここにしか無い。** これを拾わないと、画面に出せるのが
 * `error_max_budget_usd` という機械の語だけになる。
 *
 * 複数入る形は見ていないので、配列のまま持たずに畳んでおく。
 * 台帳に積むものは短く保つ（大きな行が1つあるだけで一覧が重くなる）。
 *
 * @param {*} v `errors` の値（配列でないことも想定する）
 * @returns {string|null} 空なら null
 */
function errorText(v) {
  if (!Array.isArray(v)) return null;

  const parts = [];
  for (const e of v) {
    // null を JSON.stringify に通すと文字列の "null" になる。理由として出したくないので先に落とす
    if (e === null || e === undefined) continue;
    // 文字列以外が入る形は見ていない。来たときに読み捨てず、形のまま見せる
    const s = typeof e === 'string' ? e : JSON.stringify(e);
    if (typeof s === 'string' && s.trim()) parts.push(s);
  }

  return parts.length ? clip(parts.join(' / '), RESULT_TEXT_MAX) : null;
}

/**
 * `result` から、1往復が終わったことと、その結末を取り出す。
 *
 * 実測（claude 2.1.228）で、成功と予算超過で**載るキーが違った**。
 *
 * | キー | 成功 | 予算超過 |
 * |---|---|---|
 * | `subtype` | `success` | `error_max_budget_usd` |
 * | `is_error` | false | true |
 * | `terminal_reason` | `completed` | `budget_exhausted` |
 * | `result` | 応答の本文 | **無い** |
 * | `errors` | 無い | `["Reached maximum budget ($0.01)"]` |
 * | `api_error_status` | null | **無い** |
 *
 * だから**キーの有無で分岐しない。** 無いものは null にして、呼ぶ側が揃った形だけ見られるようにする。
 *
 * 数え方で間違えやすいのが2つある。どちらも実測。
 *
 * - **`num_turns` は累積ではない。** 2往復目も 1 に戻る。往復数は台帳側で数えること
 * - **`total_cost_usd` は累積**（0.801395 → 0.8419855）。予算の残りを見るには最新の値を使う
 *
 * `total_cost_usd` は `--max-budget-usd` の効き目を見るために拾う。
 * 画面に金額として出すためではない（USD は既定で出さない方針のまま）。
 *
 * `permission_denials` には断られた回数ぶん入る（`acceptEdits` で Bash を投げて 1 件を実測）。
 * **中の形は見ていないので仮定せず、件数だけ持つ。**
 * 0 件でも 0 を返す（キーごと無いときだけ null）。断られても向こうは止まらないので、
 * これは「止まった理由」ではなく「思ったとおりに動かなかった回数」として読む。
 *
 * @param {object} line 読めた行
 * @returns {{
 *   isError:boolean, durationMs:number|null, numTurns:number|null, costUSD:number|null,
 *   text:string|null, errors:string|null, terminalReason:string|null, denials:number|null,
 * }}
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
    errors: errorText(line.errors),
    // 止まり方の機械可読な分類。`completed` / `budget_exhausted` を実測
    terminalReason: str(line.terminal_reason),
    denials: Array.isArray(line.permission_denials) ? line.permission_denials.length : null,
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
 *   isReplay: boolean,
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
    isReplay: false,
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
    // `--replay-user-messages` で返ってくる自分の行に付く（実測。camelCase）。
    // これが無いと「自分が送った行」と「ツール結果の行」がどちらも user 型で並び、区別できない。
    //
    // 印が無いことは「自分の行ではない」と読んでよい（向こうが明示的に付ける側なので）。
    // ここだけ null を使わず false に倒すのはそのため
    isReplay: line.isReplay === true || line.is_replay === true,
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
      // 実測では `rate_limit_event`（トップレベルの type。`rate_limit_info` を持つ）がここへ落ちた。
      // control_request / control_response のような、いま扱わないものも同じ扱い。
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
