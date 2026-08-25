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
 * **生の `type` は捨てずに残す。** 後で扱いたくなるものがあるため。
 * JSON として読めない行は `broken` にして数えるだけ（transcript.mjs の parseLines と同じ作法）。
 *
 * ## 未知の形で「詰まらない」（control 系だけの追加規則）
 *
 * `control_request` は他と性質が違う。**答えないと向こうが永久に待つ。**
 * だから未知の subtype も `other` へ落とさず `control` として拾い、
 * 呼ぶ側が `encodeControlError()` で断れるようにしてある。
 * `request_id` が読めないものだけは答えようが無いので `other` に落とす。
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
 *   「許可待ちで止まっている」と読み替えると、待っていないものを待っていることにしてしまう。
 *   ただしこれは `--permission-prompt-tool stdio` を**付けていない**ときの測り方。次を見ること
 *
 * ## 断ったときに流れるもの（claude 2.1.245・2026-08-25。フラグを付けた後）
 *
 * **`system/permission_denied` はもう流れない。** こちらが `control_response` で断ると、
 * ツール結果が普通のエラーの顔（`is_error:true`）で返り、
 * 見分ける手がかりは行の直下の `tool_result_meta[].non_execution_kind` だけになる。
 * 詳しくは `nonExecutionOf` に書いた。**`is_error` だけでは絶対に区別できない。**
 *
 * `result.permission_denials` には断ったぶんが
 * `{tool_name, tool_use_id, tool_input}` の形で入る（**空配列ではない**）。
 * こちらは件数だけ数えている（`resultInfo`）。
 *
 * ## control 系の実測（claude 2.1.243・2026-08-25）
 *
 * `--permission-prompt-tool stdio` を付けると、この2つが加わる。
 * **SDK の `initialize` ハンドシェイクは要らない**（こちらから何も撃たなくても流れてくる）。
 *
 * ```
 * ← {"type":"control_request","request_id":"<uuid>","request":{
 *      "subtype":"can_use_tool","tool_name":"Write","display_name":"Write",
 *      "input":{...},"description":"hello.txt","tool_use_id":"toolu_…",
 *      "permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]}}
 * → {"type":"control_response","response":{"subtype":"success","request_id":"<uuid>",
 *      "response":{"behavior":"allow"}}}
 * ```
 *
 * - **要求のキーは固定ではない。** `ExitPlanMode` には `description` も
 *   `permission_suggestions` も無く、代わりに `requires_user_interaction:true` が付く。
 *   `Write` にはその逆。**有無で分岐せず、無いものは null にする**（`resultInfo` と同じ作法）
 * - `{"behavior":"allow"}` だけで通る。`updatedInput` は省略でき、省くと元の入力がそのまま使われる
 * - こちらが stdin へ書いた `control_response` は**そのまま stdout に返ってくる**（自分のこだま）。
 *   本物の応答と見分ける鍵は `request_id` が誰の採番かだけなので、**その判断はここではできない。**
 *   採番した側（`run/index.mjs`）が見分ける
 * - 失敗は `{"subtype":"error","request_id":"…","error":"…"}`。`error` に人が読める理由が入る
 *   （例: `Cannot set permission mode: must be one of acceptEdits, auto, bypassPermissions,
 *   default, dontAsk, plan`）。**黙って詰まることは無い**
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
 * 文字列だけを残した配列を返す。
 *
 * @param {*} v 何か
 * @returns {string[]|null} 配列でなければ null（**空配列に丸めない**。「無い」と「空」は別）
 */
function strList(v) {
  if (!Array.isArray(v)) return null;
  return v.filter((x) => typeof x === 'string' && x);
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
 * - `capabilities` は向こうが名乗る機能の一覧。実測 2.1.245 で
 *   `['interrupt_receipt_v1','interrupt_cancel_queued_v1','msg_lifecycle_v1']`。
 *   割り込みを撃ってよいかを**手で表を書かずに**判定できる唯一の材料なので拾う
 * - `slash_commands` は使えるスラッシュコマンドの名前（実測 2.1.245 で 62 個。
 *   `compact` `context` `cost` など。**先頭の `/` は付いていない**）。
 *   `terminal_slash_commands`（実測 `['doctor','color']`）は**対話版の画面でしか働かない**もの。
 *   どちらもそのまま返し、**引き算はここでしない**（この層は行を読むだけで、
 *   「どれが使えるか」は使う側の判断。混ぜると引き算の理由がこの層に居座る）
 *
 * それでも**キーが無いことを異常にしない。** 版が上がれば形は変わる。取れなければ null で進む。
 *
 * **`capabilities` も一覧も、無ければ null。空配列に丸めない。**
 * 「名乗らない版」と「何も持たない版」は別のことで、空配列にすると前者を後者と読み違えて、
 * 使えるはずの割り込みを断ることになる。スラッシュコマンドも同じで、
 * 空配列にすると「1つも使えない」と読めてしまう。
 *
 * @param {object} line 読めた行
 * @returns {{model:string|null, cwd:string|null, permissionMode:string|null, tools:number|null,
 *   capabilities:string[]|null, slashCommands:string[]|null,
 *   terminalSlashCommands:string[]|null}}
 */
function initInfo(line) {
  const tools = Array.isArray(line.tools) ? line.tools.length : null;
  return {
    model: str(line.model),
    cwd: str(line.cwd),
    permissionMode: str(line.permissionMode ?? line.permission_mode),
    tools,
    capabilities: strList(line.capabilities),
    slashCommands: strList(line.slash_commands),
    terminalSlashCommands: strList(line.terminal_slash_commands),
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
 * `control_request` / `subtype:can_use_tool` から、人が答えるのに要るものを取り出す。
 *
 * **`input` は切らない。** `AskUserQuestion` の `updatedInput` を組むのに原文が要る。
 * 切るのはここから先（`run/event.mjs` が速報に載せるとき）で、
 * 台帳が原文を持つのは `AskUserQuestion` のときだけ、と決めてある。
 *
 * @param {string} requestId 答えを返すときの宛先。呼ぶ側で取れたものを渡す
 * @param {object} req `line.request`
 * @returns {object} 揃った形（無いキーは null / 空配列）
 */
function permissionInfo(requestId, req) {
  const input = req.input && typeof req.input === 'object' && !Array.isArray(req.input)
    ? req.input
    : null;
  return {
    requestId,
    toolName: str(req.tool_name),
    // 実測ではツール名と同じ値だったが、別物になりうるので分けて持つ
    displayName: str(req.display_name),
    // `Write` では書き込み先のファイル名が入っていた。`ExitPlanMode` には無い
    description: str(req.description),
    toolUseId: str(req.tool_use_id),
    // `ExitPlanMode` にだけ付いていた。**無いことを「対話が要らない」と読まない**
    requiresUserInteraction: req.requires_user_interaction === true,
    input,
    // 実測で入っていたのは `{type:'setMode', mode:'acceptEdits', destination:'session'}`。
    // `destination:'session'` なので、これを撃っても `~/.claude` には触らない
    suggestions: Array.isArray(req.permission_suggestions) ? req.permission_suggestions : [],
  };
}

/**
 * `control_response` から、こちらが撃った要求の結末を取り出す。
 *
 * @param {object} res `line.response`
 * @returns {{requestId:string|null, ok:boolean, error:string|null, response:object|null}}
 */
function controlResultInfo(res) {
  return {
    requestId: str(res.request_id ?? res.requestId),
    ok: str(res.subtype) === 'success',
    error: clip(res.error ?? res.message, RESULT_TEXT_MAX),
    // 中身は subtype ごとに違う（`set_permission_mode` なら `{mode}`）。
    // 解釈はここでしない。撃った側が自分の subtype に合わせて読む
    response: res.response && typeof res.response === 'object' && !Array.isArray(res.response)
      ? res.response
      : null,
  };
}

/**
 * `user` 行の `tool_result_meta` から「なぜ実行されなかったか」の印を取り出す。
 *
 * ## 実測（claude 2.1.245・2026-08-25）
 *
 * `--permission-prompt-tool stdio` を付けた状態で `control_response` に
 * `{behavior:'deny', message:'…'}` を返すと、**`system/permission_denied` は流れない。**
 * 代わりにツール結果が普通のエラーの顔で返り、行の**直下**（`message` の中ではない）に
 * これが付く。
 *
 * ```
 * "message":{"role":"user","content":[{"type":"tool_result",
 *    "content":"実測のため断りました","is_error":true,"tool_use_id":"toolu_014C…"}]},
 * "tool_use_result":"Error: 実測のため断りました",
 * "tool_result_meta":[{"id":"toolu_014C…","non_execution_kind":"permission-rule"}]
 * ```
 *
 * **これが無いと「あなたが断った」と「ツールが失敗した」が画面で同じ顔になる。**
 * どちらも `is_error:true` なので、`is_error` だけでは絶対に見分けられない。
 *
 * 観測した `non_execution_kind` は `permission-rule` の1種類だけ。
 * **他の語が来ることを前提に、値をそのまま持つ**（既知の語へ丸めない）。
 *
 * `id` はツール結果の `tool_use_id` と対応する。並列にツールを呼ぶと複数入りうるので配列のまま。
 *
 * @param {object} line 読めた行
 * @returns {Array<{id:string, kind:string}>} 印が無ければ空配列
 */
function nonExecutionOf(line) {
  if (!Array.isArray(line.tool_result_meta)) return [];

  const out = [];
  for (const m of line.tool_result_meta) {
    if (!m || typeof m !== 'object') continue;
    const id = str(m.id ?? m.tool_use_id);
    const kind = str(m.non_execution_kind ?? m.nonExecutionKind);
    // 両方揃わないと結果と結び付けられない。片方だけ持っても使い道が無い
    if (id && kind) out.push({ id, kind });
  }
  return out;
}

/**
 * `system` / `subtype:thinking_tokens` から、考えている量を取り出す。
 *
 * ## 実測（claude 2.1.245・2026-08-25）
 *
 * ```
 * {"type":"system","subtype":"thinking_tokens",
 *  "estimated_tokens":700,"estimated_tokens_delta":50,"uuid":"…","session_id":"…"}
 * ```
 *
 * **1ターンに何度も流れる**（1往復で8件を実測。50→150→200→300→400→500→650→700）。
 * `estimated_tokens` は**そのターンの累計**で、`result` の
 * `usage.output_tokens_details.thinking_tokens`（実測 754）とほぼ一致する。
 *
 * だから**これを速報の行として1件ずつ積んではいけない。**
 * 積むと1ターンで8行の「その他」が並び、本文が押し流される（段4より前は実際にそうなっていた）。
 * 畳んで「いまいくつ」の1つの数にするのは台帳の仕事。
 *
 * @param {object} line 読めた行
 * @returns {{tokens:number|null, delta:number|null}}
 */
function thinkingInfo(line) {
  return {
    tokens: num(line.estimated_tokens ?? line.estimatedTokens),
    delta: num(line.estimated_tokens_delta ?? line.estimatedTokensDelta),
  };
}

/**
 * `rate_limit_event` から、枠をどれだけ使ったかを取り出す。
 *
 * ## 実測（claude 2.1.245・2026-08-25）
 *
 * ```
 * {"type":"rate_limit_event","rate_limit_info":{
 *   "status":"allowed","resetsAt":1787667000,"rateLimitType":"five_hour",
 *   "overageStatus":"rejected","overageDisabledReason":"member_zero_credit_limit",
 *   "isUsingOverage":false,
 *   "unifiedWindows":{"five_hour":{"utilization":0.06,"resetsAt":1787667000},
 *                     "seven_day":{"utilization":0.69,"resetsAt":1787763600}}}}
 * ```
 *
 * - **`utilization` は 0〜1 の割合**（0.69 ＝ 69%）。百分率にするのは画面の仕事
 * - `resetsAt` は**秒**の unix 時刻。ミリ秒として扱うと 1970 年になる
 * - CLI が `/usage` で出すのと同じ枠。**画面にはこれまで出る道が無かった**
 *
 * `overageStatus` は「上限を超えたぶんを買うか」の設定で、枠の使用量とは別の話。
 * ここでは拾わない（出しても押せる口が無く、読む人を迷わせるだけ）。
 *
 * @param {object} line 読めた行
 * @returns {{status:string|null, fiveHour:number|null, sevenDay:number|null, resetsAt:number|null}}
 */
function rateLimitInfo(line) {
  const rl = line.rate_limit_info && typeof line.rate_limit_info === 'object'
    ? line.rate_limit_info
    : {};
  const w = rl.unifiedWindows && typeof rl.unifiedWindows === 'object' ? rl.unifiedWindows : {};
  const use = (k) => num(w[k]?.utilization);
  return {
    status: str(rl.status),
    fiveHour: use('five_hour'),
    sevenDay: use('seven_day'),
    // 直近で空くほうの時刻。5時間枠のほうが必ず先に空くので、無ければ7日枠に倒す
    resetsAt: num(w.five_hour?.resetsAt) ?? num(rl.resetsAt) ?? num(w.seven_day?.resetsAt),
  };
}

/**
 * `system` / `subtype:hook_*` から、どのフックがどうなったかを取り出す。
 *
 * ## 実測（claude 2.1.245・2026-08-25）
 *
 * ```
 * {"type":"system","subtype":"hook_response","hook_id":"4b04d449-…",
 *  "hook_name":"SessionStart:startup","hook_event":"SessionStart",
 *  "output":"# ハンドオフ運用（有効中）…","stdout":"（output と同じ 1484 文字）",
 *  "stderr":"","exit_code":0,"outcome":"success","uuid":"…","session_id":"…"}
 * ```
 *
 * **`output` と `stdout` は拾わない。** 中身はフックが吐いた文章そのもので、
 * 実測で 1484 文字あった（しかも同じものが2つのキーに入っている）。
 * 速報のリング1000件にこれが載ると、フックを何本か入れている人の手元でメモリが数MB増える。
 * フックの出力は Claude への差し込みであって、**こちらが読み返すものではない。**
 *
 * `stderr` だけは拾う。フックが壊れたときに気づける唯一の手がかりで、
 * 正常時は空文字なので普段は何も増えない。
 *
 * @param {object} line 読めた行
 * @returns {{hookId:string|null, name:string|null, event:string|null,
 *            outcome:string|null, exitCode:number|null, stderr:string|null}}
 */
function hookInfo(line) {
  return {
    hookId: str(line.hook_id),
    name: str(line.hook_name),
    event: str(line.hook_event),
    outcome: str(line.outcome),
    exitCode: num(line.exit_code),
    stderr: clip(line.stderr, RESULT_TEXT_MAX),
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
 *   kind: 'init'|'assistant'|'user'|'result'|'permission'|'control'|'control-result'
 *       |'thinking'|'rate-limit'|'hook'|'other'|'broken',
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
      // system は subtype ごとに中身がまるで違う。**知っているものだけ名前で扱う。**
      // ここに無い subtype（`compact_boundary` など）は `other` のまま
      if (subtype === 'init') {
        return { ...base, ...common, kind: 'init', info: initInfo(line) };
      }
      if (subtype === 'thinking_tokens') {
        return { ...base, ...common, kind: 'thinking', info: thinkingInfo(line) };
      }
      if (subtype === 'hook_started' || subtype === 'hook_progress' || subtype === 'hook_response') {
        return { ...base, ...common, kind: 'hook', info: hookInfo(line) };
      }
      return { ...base, ...common, kind: 'other' };

    case 'assistant':
      // ここだけ会話ログと同じ形。entries.mjs の道具をそのまま当てられる
      return { ...base, ...common, kind: type, entry: line };

    case 'user':
      // `user` にだけ `tool_result_meta` が付く（実測）。
      // **`entry` と別に持つ。** entries.mjs の道具は会話ログ用で、
      // 会話ログ側にこのキーは無いので `toolResults` は見てくれない
      return { ...base, ...common, kind: type, entry: line, info: { nonExecution: nonExecutionOf(line) } };

    case 'result':
      return { ...base, ...common, kind: 'result', info: resultInfo(line) };

    case 'control_request': {
      const req = line.request && typeof line.request === 'object' && !Array.isArray(line.request)
        ? line.request
        : {};
      const requestId = str(line.request_id ?? line.requestId);
      // 宛先が読めない要求には答えようが無い。**ここだけは `other` へ落としてよい**
      if (!requestId) return { ...base, ...common, kind: 'other' };

      // subtype は行の直下ではなく `request` の下にある。common の null を上書きする
      const sub = str(req.subtype);
      if (sub === 'can_use_tool') {
        return { ...base, ...common, subtype: sub, kind: 'permission', info: permissionInfo(requestId, req) };
      }
      // 知らない subtype も拾う。**答えないと向こうが永久に待つ**ので `other` にできない
      return { ...base, ...common, subtype: sub, kind: 'control', info: { requestId, subtype: sub } };
    }

    case 'control_response': {
      const res = line.response && typeof line.response === 'object' && !Array.isArray(line.response)
        ? line.response
        : {};
      return { ...base, ...common, subtype: str(res.subtype), kind: 'control-result', info: controlResultInfo(res) };
    }

    case 'rate_limit_event':
      return { ...base, ...common, kind: 'rate-limit', info: rateLimitInfo(line) };

    default:
      // 知らない type。生の type を残してあるので、扱う気になったときに読み直せる
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
 * 許可要求への答えを1行組む。
 *
 * **`deny` のときは `updatedInput` も `updatedPermissions` も載せない。**
 * 混ざった形を向こうの検証がどう扱うか分からず、こちらのバグが
 * 「たまに通る」形で残る。載せないと決めておけば、そこは疑わなくてよくなる。
 *
 * `request_id` は**引数で受ける。** ここで採番すると乱数が要り、この層の「純関数だけ」が崩れる。
 *
 * @param {string} requestId 来た要求の `request_id`
 * @param {object} decision `{behavior:'allow'|'deny', message?, updatedInput?, updatedPermissions?}`
 * @returns {string} 末尾に改行を含む1行
 * @throws {TypeError} 宛先が無い・behavior が語彙外のとき
 */
export function encodePermissionResponse(requestId, decision) {
  const id = str(requestId);
  if (!id) throw new TypeError('答える相手（request_id）がありません');
  if (!decision || typeof decision !== 'object') throw new TypeError('答えの形が違います');

  const behavior = decision.behavior;
  if (behavior !== 'allow' && behavior !== 'deny') {
    throw new TypeError('答えは allow か deny だけです');
  }

  const response = { behavior };
  if (behavior === 'deny') {
    // 理由は空でもよい（止めたいときに文章を考えさせない）。空なら決まり文句を入れる
    const message = typeof decision.message === 'string' ? decision.message.trim() : '';
    response.message = message || '画面から断りました';
  } else {
    // 省くと元の入力がそのまま使われる（実測）。**替えるときだけ載せる**
    if (decision.updatedInput && typeof decision.updatedInput === 'object'
      && !Array.isArray(decision.updatedInput)) {
      response.updatedInput = decision.updatedInput;
    }
    if (Array.isArray(decision.updatedPermissions) && decision.updatedPermissions.length > 0) {
      response.updatedPermissions = decision.updatedPermissions;
    }
  }

  const line = { type: 'control_response', response: { subtype: 'success', request_id: id, response } };
  return `${JSON.stringify(line)}\n`;
}

/**
 * 扱えない `control_request` を断る1行を組む。
 *
 * **未知の subtype にもこれを返す。** 返さないとその子は永久に待つ。
 * 「未知の形で落ちない」を、control 系では「未知の形で詰まらない」まで広げるための道具。
 *
 * @param {string} requestId 来た要求の `request_id`
 * @param {string} [message] 理由
 * @returns {string} 末尾に改行を含む1行
 * @throws {TypeError} 宛先が無いとき
 */
export function encodeControlError(requestId, message) {
  const id = str(requestId);
  if (!id) throw new TypeError('答える相手（request_id）がありません');
  const text = typeof message === 'string' && message.trim()
    ? message.trim()
    : 'この画面では扱えない要求です';
  const line = { type: 'control_response', response: { subtype: 'error', request_id: id, error: text } };
  return `${JSON.stringify(line)}\n`;
}

/**
 * こちらから撃つ `control_request` を1行組む。
 *
 * 子を殺さずに効くもの（実測または実バイナリで確認）:
 * `set_permission_mode` / `set_model` / `set_max_thinking_tokens` / `interrupt` / `end_session`。
 *
 * **`subtype` を最後に置く。** `params` に同じキーが紛れても上書きされない形にしておく。
 *
 * @param {string} requestId こちらで採番した ID。**こだまと本物の応答を見分ける鍵になる**
 * @param {string} subtype 何を頼むか
 * @param {object} [params] 中身
 * @returns {string} 末尾に改行を含む1行
 * @throws {TypeError} ID か subtype が無いとき
 */
export function encodeControlRequest(requestId, subtype, params) {
  const id = str(requestId);
  if (!id) throw new TypeError('要求の request_id がありません');
  const sub = str(subtype);
  if (!sub) throw new TypeError('要求の subtype がありません');
  const extra = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  const line = { type: 'control_request', request_id: id, request: { ...extra, subtype: sub } };
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
