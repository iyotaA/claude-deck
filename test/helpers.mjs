/**
 * テスト用の会話ログを組む道具。
 *
 * 実物の ~/.claude は読まない。
 * 中身が環境によって変わるため、テストの前提にできないため。
 * JSONL の1行を模した素のオブジェクトを、ここで組んで渡す。
 *
 * 形は src/parse/entries.mjs 冒頭のコメントに書かれている実測結果に合わせている。
 */

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
