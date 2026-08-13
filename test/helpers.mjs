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
