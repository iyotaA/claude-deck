/**
 * 会話ログの1行を、ほぼそのままの形で返す。
 *
 * 詳細ビューは「読める長さ」に切って出すので、切られた先に何が書いてあったかを
 * 確かめる手段が無い。判断の根拠を追うにはそこに戻れる必要がある。
 *
 * readAll の memo に乗るので、詳細を開いた直後ならファイルは読み直さない。
 *
 * ── この口だけ露出量が増えることについて ──────────────────────
 *
 * 守りの本体は listen が 127.0.0.1 に固定されていることだが、そこに全部を賭けない。
 * ログには業務内容が入っていて、認証情報が紛れ込んでいることもある。
 * だからここで2つ手を入れる。
 *
 *  1. 鍵らしい名前のキーと、見た目で鍵だと分かる値を伏せる
 *  2. 長い文字列と深い入れ子を切る（巨大な tool_result で画面が固まるのを防ぐ）
 *
 * ファイルパスは返さない。原文の中身だけを返す。
 */
import { indexTranscripts, readAll } from '../read/transcript.mjs';
import { uuidOf } from '../parse/entries.mjs';

/**
 * 伏せるキーの名前。
 *
 * 部分一致で見る。`authToken` `X-Api-Key` `refresh_token` のような揺れを
 * ひとつずつ数え上げるのは無理なので、含んでいたら伏せる側に倒す。
 *
 * 当たっても値が数・真偽値なら伏せない（`usage.input_tokens` などが該当する）。
 * 理由は walk() の中のコメントに書いてある
 */
const SECRET_KEY = /auth|token|secret|password|api[_-]?key|credential|cookie|bearer|private[_-]?key/i;

/**
 * 見た目で鍵だと分かる値。
 *
 * キーの名前が無害でも（`command` の中に書いてあるなど）値の形で拾えるものは伏せる。
 * 当たった部分だけを差し替える。行ごと消すと、前後の文脈まで読めなくなる
 */
const SECRET_VALUE = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /ghp_[A-Za-z0-9]{16,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /Bearer\s+[A-Za-z0-9._-]{16,}/gi,
];

/** 伏せたところに入れる文字。 */
const MASK = '（伏せました）';

/**
 * 1つの文字列の上限。
 *
 * 巨大な tool_result は1行で数MBになる。そのまま返すと画面が固まる。
 * 20,000字あれば、切られた先を確かめるという目的には足りる
 */
const MAX_STRING = 20000;

/** 入れ子の深さの上限。これより深いところは省略する。 */
const MAX_DEPTH = 12;

/**
 * 原文を出せる形に整える。
 *
 * fs を触らない純関数にしてあるのでテストできる。
 * 伏せたか・切ったかを呼び出し側へ返し、画面がそれを断り書きとして出せるようにする
 *
 * @param {*} value ログから読んだ生の値
 * @returns {{value: *, masked: boolean, truncated: boolean}}
 */
export function sanitizeEntry(value) {
  const flags = { masked: false, truncated: false };
  return { value: walk(value, 0, flags), ...flags };
}

/**
 * @param {*} value 見ている値
 * @param {number} depth いまの深さ
 * @param {object} flags 伏せた・切ったを記録する入れ物
 */
function walk(value, depth, flags) {
  if (typeof value === 'string') return maskString(value, flags);
  if (value === null || typeof value !== 'object') return value;

  if (depth >= MAX_DEPTH) {
    flags.truncated = true;
    return '（深すぎるため省略）';
  }

  if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1, flags));

  const out = {};
  for (const [key, v] of Object.entries(value)) {
    // 鍵らしい名前なら、中身を見ずに伏せる。長さも型も出さない。
    //
    // ただし数と真偽値は素通しにする。実測すると assistant の行はどれも
    // usage.input_tokens / cache_read_input_tokens を持っていて、これが token に当たる。
    // 全部伏せると「原文」の中身が消え、しかも masked がほぼ全行で立って
    // 「鍵を伏せました」の断り書きが読み流される側に回る。
    // 秘密は必ず文字列か入れ物なので、数と真偽値を通しても漏れない
    if (SECRET_KEY.test(key) && !isPlainValue(v)) {
      flags.masked = true;
      out[key] = MASK;
      continue;
    }
    out[key] = walk(v, depth + 1, flags);
  }
  return out;
}

/**
 * 秘密になりえない値か。数・真偽値・null がそれに当たる。
 *
 * 文字列と入れ物（オブジェクト・配列）は伏せる側に倒す
 * @param {*} v 見ている値
 */
function isPlainValue(v) {
  return v === null || typeof v === 'number' || typeof v === 'boolean';
}

/** @param {string} s 元の文字列 @param {object} flags 伏せた・切ったを記録する入れ物 */
function maskString(s, flags) {
  let out = s;
  for (const re of SECRET_VALUE) {
    if (!re.test(out)) continue;
    flags.masked = true;
    // test で進んだ lastIndex を戻す。g 付きの正規表現を使い回すため
    re.lastIndex = 0;
    out = out.replace(re, MASK);
  }
  if (out.length > MAX_STRING) {
    flags.truncated = true;
    out = `${out.slice(0, MAX_STRING)}…（以下省略）`;
  }
  return out;
}

/**
 * 指定した行の原文を返す。
 *
 * @param {string} sessionId セッションID
 * @param {string} uuid 開きたい行の uuid
 * @param {object} [opts]
 * @param {string|null} [opts.agentId] サブエージェントのログの行を指すとき。
 *   いまは親ログしか読まないので、渡されたら「見つからない」を返す。
 *   口の形だけ先に決めておくのは、あとから足すと画面側の呼び出しまで変わるため
 * @returns {Promise<object|null>} 見つからなければ null
 */
export async function getRawEntry(sessionId, uuid, { agentId = null } = {}) {
  if (!sessionId || !uuid) return null;
  if (agentId) return null;

  const index = await indexTranscripts();
  const transcript = index.get(sessionId) ?? null;
  if (!transcript) return null;

  const log = await readAll(transcript.file);
  const entry = log.entries.find((e) => uuidOf(e) === uuid) ?? null;
  if (!entry) return null;

  const safe = sanitizeEntry(entry);

  return {
    sessionId,
    uuid,
    // ファイルパスは返さない。中身だけを返す
    entry: safe.value,
    masked: safe.masked,
    truncated: safe.truncated,
  };
}
