/**
 * テスト用の会話ログを組む道具。
 *
 * 実物の ~/.claude は読まない。
 * 中身が環境によって変わるため、テストの前提にできないため。
 * JSONL の1行を模した素のオブジェクトを、ここで組んで渡す。
 *
 * 形は src/parse/entries.mjs 冒頭のコメントに書かれている実測結果に合わせている。
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

/** 基準時刻。テストの中の時刻はすべてここからの相対で考える。 */
export const T0 = Date.parse('2026-08-04T09:00:00.000Z');

/** T0 からの相対ミリ秒を ISO 文字列にする。ログの timestamp はこの形で入っている。 */
export function at(offsetMs = 0) {
  return new Date(T0 + offsetMs).toISOString();
}

let seq = 0;

/** 行を区別するための uuid。値そのものに意味は無い。 */
function nextUuid() {
  seq += 1;
  return `u${seq}`;
}

/** assistant の発言行。 */
export function say(text, { ms = 0, uuid, ...rest } = {}) {
  return {
    type: 'assistant',
    uuid: uuid ?? nextUuid(),
    timestamp: at(ms),
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    ...rest,
  };
}

/**
 * assistant のツール呼び出し行。
 *
 * @param {string} name ツール名
 * @param {object} input そのツールへの入力
 * @param {object} opts ms（T0 からの相対）/ id（tool_use_id）/ uuid / text（発言を添える）
 */
export function call(name, input = {}, { ms = 0, id = 'call-1', uuid, text, ...rest } = {}) {
  const content = [];
  if (text) content.push({ type: 'text', text });
  content.push({ type: 'tool_use', id, name, input });
  return {
    type: 'assistant',
    uuid: uuid ?? nextUuid(),
    timestamp: at(ms),
    message: { role: 'assistant', content },
    ...rest,
  };
}

/**
 * 1行で複数のツールを呼んだ assistant 行。
 *
 * Claude は独立した呼び出しを1行にまとめて出すので、実物のログでは並列呼び出しがふつうに出る。
 * 足跡（trace）が「1行につき1件」であることを確かめるのに使う
 *
 * @param {Array} uses [{ name, input, id }] の並び
 * @param {object} opts ms（T0 からの相対）/ uuid / text（発言を添える）
 */
export function multiCall(uses, { ms = 0, uuid, text, ...rest } = {}) {
  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const u of uses) {
    content.push({ type: 'tool_use', id: u.id, name: u.name, input: u.input ?? {} });
  }
  return {
    type: 'assistant',
    uuid: uuid ?? nextUuid(),
    timestamp: at(ms),
    message: { role: 'assistant', content },
    ...rest,
  };
}

/**
 * usage の指定を、実物のログに入っている形へ直す。
 *
 * 短い名前で書けるようにしつつ、組み立てるキー名は実測どおりにする。
 * cw5m / cw1h を渡したときだけ入れ子の cache_creation を作るので、
 * 「平坦しか無い古い形」と「入れ子と食い違う形」の両方をテストで作り分けられる。
 *
 * @param {object} u in / cr（キャッシュ読み）/ cw（平坦な書き）/ cw5m / cw1h / out
 * @returns {object} message.usage に入れる形
 */
function usageShape({ in: input = 0, cr = 0, cw = 0, cw5m, cw1h, out = 0 } = {}) {
  const usage = {
    input_tokens: input,
    cache_read_input_tokens: cr,
    cache_creation_input_tokens: cw,
    output_tokens: out,
  };
  if (cw5m !== undefined || cw1h !== undefined) {
    usage.cache_creation = {
      ephemeral_5m_input_tokens: cw5m ?? 0,
      ephemeral_1h_input_tokens: cw1h ?? 0,
    };
  }
  return usage;
}

/**
 * usage を持つ assistant 行。数値の集計を試すときはこれを使う。
 *
 * say() は rest をエントリ直下へ展開する作りなので message.usage を作れない。
 * requestId はエントリ直下、usage は message の下、という位置の違いをここで吸収する。
 *
 * @param {string} text 発言。空なら text ブロックを作らない
 * @param {object} opts ms / uuid / requestId / usage（短縮形）/ model / uses（tool_use の並び）
 */
export function reply(text, { ms = 0, uuid, requestId = 'req-1', usage, model, uses, ...rest } = {}) {
  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const u of uses ?? []) {
    content.push({ type: 'tool_use', id: u.id, name: u.name, input: u.input ?? {} });
  }

  const message = { role: 'assistant', content };
  if (model) message.model = model;
  if (usage) message.usage = usageShape(usage);

  const entry = {
    type: 'assistant',
    uuid: uuid ?? nextUuid(),
    timestamp: at(ms),
    message,
    ...rest,
  };
  if (requestId !== null) entry.requestId = requestId;
  return entry;
}

/**
 * API が落ちたときに差し込まれる行。
 *
 * 実測した特徴は3つで、すべて同時に成り立つ（全ログ108件で食い違い0件）。
 * requestId を持たない / model が <synthetic> / usage が全ゼロ。
 * 要求の回数に数えてはいけない行の代表なので、テスト用に形を固定しておく
 */
export function synthetic(text, { ms = 0 } = {}) {
  return {
    type: 'assistant',
    uuid: nextUuid(),
    timestamp: at(ms),
    isApiErrorMessage: true,
    message: {
      role: 'assistant',
      model: '<synthetic>',
      content: [{ type: 'text', text }],
      usage: usageShape({}),
    },
  };
}

/**
 * ツール結果の行。
 *
 * @param {string} id 対応する tool_use_id
 * @param {object} opts ms / text（本文）/ isError / denialKind / structured（toolUseResult の中身）
 */
export function result(id, { ms = 0, text = 'ok', isError = false, denialKind, structured, ...rest } = {}) {
  const entry = {
    type: 'user',
    uuid: nextUuid(),
    timestamp: at(ms),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }],
    },
    toolUseResult: structured ?? { stdout: text },
    ...rest,
  };
  if (denialKind) entry.toolDenialKind = denialKind;
  return entry;
}

/** あなたが打った指示の行。 */
export function prompt(text, { ms = 0, ...rest } = {}) {
  return {
    type: 'user',
    uuid: nextUuid(),
    timestamp: at(ms),
    message: { role: 'user', content: [{ type: 'text', text }] },
    ...rest,
  };
}

/**
 * readTail の戻りを模す。
 *
 * mtimeMs を省いたときは末尾の行の時刻に合わせる。
 * 実物でもログの更新時刻と末尾の行の時刻はほぼ一致する。
 */
export function tail(entries, { mtimeMs, parseErrors = 0 } = {}) {
  let lastAt = 0;
  for (const entry of entries) {
    const ms = Date.parse(entry?.timestamp ?? '');
    if (!Number.isNaN(ms) && ms > lastAt) lastAt = ms;
  }
  return {
    entries,
    parseErrors,
    mtimeMs: mtimeMs ?? lastAt,
    size: 0,
  };
}

/*
 * ここから下は stream-json（claude -p --output-format stream-json）の行を組む道具。
 *
 * 上の会話ログ用と**わざと分けてある**。似ているが別物で、
 * とくにセッション ID のキーが session_id（snake_case）と違う。
 * 同じ関数で両方を作れるようにすると、その違いがテストから見えなくなる。
 *
 * 名前は s から始める（sysInit / sAssistant / …）。どちらの道具か一目で分かるように。
 */

/** stream-json のテストで使うセッション ID。値そのものに意味は無い。 */
export const S_ID = 'sess-1';

/**
 * 起動できたことを伝えてくる最初の行。
 *
 * 実測（claude 2.1.228）で確かめたキーだけを組んでいる。
 * 本物はもっと多くのキーを持つ（`skills` `plugins` `capabilities` など）が、
 * 読んでいないものを並べても「読めている」の証明にはならないので足さない。
 *
 * **`permissionMode` だけキャメル**なのは実物がそうだから。ここを揃えて書き直さない。
 *
 * 最初の1回だけでなく**ターンごとに来る**（内容は同じで uuid だけ変わる）。
 */
export function sysInit({ sessionId = S_ID, model = 'claude-opus-5', cwd = 'C:\\work\\demo',
  tools = ['Read', 'Edit'], permissionMode = 'plan', ...rest } = {}) {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    cwd,
    model,
    permissionMode,
    tools,
    ...rest,
  };
}

/**
 * assistant の行。会話ログと同じ message.content を持つ。
 *
 * @param {string} text 発言。空なら text ブロックを作らない
 * @param {object} opts sessionId / uses（tool_use の並び）/ model / parentToolUseId
 */
export function sAssistant(text, { sessionId = S_ID, uses, model, parentToolUseId, ...rest } = {}) {
  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const u of uses ?? []) {
    content.push({ type: 'tool_use', id: u.id, name: u.name, input: u.input ?? {} });
  }

  const message = { role: 'assistant', content };
  if (model) message.model = model;

  const line = { type: 'assistant', message, session_id: sessionId, ...rest };
  if (parentToolUseId) line.parent_tool_use_id = parentToolUseId;
  return line;
}

/**
 * user の行。ツール結果と、--replay-user-messages で返ってくる自分の指示の両方がこの形。
 *
 * @param {object} opts sessionId / text（自分が送った指示）/ results（[{id,text,isError}]）/ parentToolUseId
 */
export function sUser({ sessionId = S_ID, text, results, parentToolUseId, ...rest } = {}) {
  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const r of results ?? []) {
    content.push({
      type: 'tool_result',
      tool_use_id: r.id,
      content: r.text ?? 'ok',
      is_error: r.isError ?? false,
    });
  }

  const line = {
    type: 'user',
    message: { role: 'user', content },
    session_id: sessionId,
    ...rest,
  };
  if (parentToolUseId) line.parent_tool_use_id = parentToolUseId;
  return line;
}

/**
 * 1往復の終わりを伝えてくる行。
 *
 * usage が message の下ではなく行の直下に付く点が会話ログと違う。
 * その形をテストから見えるようにしておきたいので、渡されたらそのまま直下に置く。
 */
export function sResult({ sessionId = S_ID, subtype = 'success', isError, durationMs = 1200,
  numTurns = 1, costUSD = 0.01, text = '終わりました', usage, ...rest } = {}) {
  const line = {
    type: 'result',
    subtype,
    session_id: sessionId,
    duration_ms: durationMs,
    num_turns: numTurns,
    total_cost_usd: costUSD,
    result: text,
    ...rest,
  };
  if (isError !== undefined) line.is_error = isError;
  if (usage) line.usage = usageShape(usage);
  return line;
}

/**
 * 許可を求めてくる行（`control_request` ＋ `can_use_tool`）。
 *
 * **これが段1の主役。** ここに答えないと、その子は1行も進めずに待ち続ける。
 *
 * @param {object} [opts] requestId / toolName / input / suggestions ほか
 * @returns {object} 1行ぶん
 */
export function sPermission({ sessionId = S_ID, requestId = 'p1', toolName = 'Bash',
  input = { command: 'ls' }, suggestions, toolUseId = 'toolu_1', ...rest } = {}) {
  const request = {
    subtype: 'can_use_tool',
    tool_name: toolName,
    input,
    tool_use_id: toolUseId,
    ...rest,
  };
  if (suggestions) request.permission_suggestions = suggestions;
  return { type: 'control_request', request_id: requestId, session_id: sessionId, request };
}

/**
 * 選択肢で聞いてくる行（`AskUserQuestion`）。
 *
 * 答えるときに `updatedInput` を組む必要があるので、**原文をそのまま持ち回る**形になる。
 * その原文が速報に載っていないことを見るテストで使う。
 *
 * @param {Array<object>} questions 質問の並び
 * @param {object} [opts] `sPermission` へ渡すぶん
 * @returns {object} 1行ぶん
 */
export function sQuestion(questions, opts = {}) {
  return sPermission({ toolName: 'AskUserQuestion', input: { questions }, ...opts });
}

/**
 * こちらが撃った要求への返事（`control_response`）。
 *
 * `request_id` が `response` の**中**に入る点が要求と違う。実物もこの形。
 *
 * @param {string} requestId どの要求への返事か
 * @param {object} [opts] ok / error / response
 * @returns {object} 1行ぶん
 */
export function sControlResponse(requestId, { ok = true, error, response } = {}) {
  const body = { subtype: ok ? 'success' : 'error', request_id: requestId };
  if (!ok) body.error = error ?? '断られました';
  if (response !== undefined) body.response = response;
  return { type: 'control_response', response: body };
}

/**
 * 行の並びを NDJSON の1本のテキストにする。
 *
 * 末尾にも改行を付ける。実物もそうなっていて、
 * 分割側が最後の空片をどう扱うかを試せるようにしておきたいため。
 *
 * @param {object[]} lines 行の並び
 * @returns {string}
 */
export function sLines(lines) {
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}

/**
 * 偽の子プロセス。
 *
 * 実物の claude.exe は叩かない。入っているかどうかが環境で変わり、テストの前提にできないため。
 * `close` を自分で起こすまで終わらないので、行の割れ方・止め方・死んだ子への書き込みを
 * 好きな順番で試せる。
 *
 * **`exitCode` と `signalCode` は動いているあいだ `null`。**
 * `stopClaude` がここを見て「もう終わっている」を判定するので、0 で初期化しない。
 *
 * @param {object} [opts] pid（既定 4242）
 * @returns {object} EventEmitter に stdin / stdout / stderr を生やしたもの
 */
export function fakeChild({ pid = 4242 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;

  /** kill に渡された signal の並び。posix 側の段の進み方を確かめるのに使う。 */
  child.signals = [];
  child.kill = (sig = 'SIGTERM') => {
    child.killed = true;
    child.signals.push(sig);
    return true;
  };

  /** 終わらせる。実物と同じく exitCode を立ててから close を出す。 */
  child.close = (code = 0) => {
    child.exitCode = code;
    child.emit('close', code);
  };

  return child;
}

/** 登録簿の1件。 */
export function reg(overrides = {}) {
  return {
    sessionId: 's1',
    pid: 4242,
    name: 'demo',
    cwd: 'C:\\work\\demo',
    alive: true,
    status: 'busy',
    ...overrides,
  };
}
