/**
 * 1セッションの数値を組み立てる。
 *
 * 詳細（detail.mjs）と同じくログを全文読むが、**詳細の応答には足さない。**
 * `/api/sessions/:id` はセッションを開くたび毎回走るので、
 * そこに集計を足すと、数値を見ない人まで詳細を開く速度が落ちる。
 *
 * この経路は一覧（毎秒走る）には**原理的に載らない。**
 * 一覧は readTail（尾 64KB）しか読まないが、usage は先頭から積む必要がある。
 * 「重いから載せない」ではなく「載せられない」ので、
 * うっかり毎秒経路に混ざる事故が構造的に起きない。
 */
import { readRegistry } from '../read/registry.mjs';
import { indexTranscripts, readAll } from '../read/transcript.mjs';
import { buildUsage } from '../parse/usage.mjs';

/**
 * 集計結果だけを持つ専用の memo。
 *
 * **read/cache.mjs は使わない。** あちらは 240件の LRU で、
 * 全文（1本で最大 42MB）を載せると一覧の tail: memo が全部追い出される。
 * ここに入るのは数百バイトの数値の塊だけなので、300件持っても数MBに収まる。
 *
 * 印は既存と同じ `size:mtimeMs`。会話ログは追記しか起きないので、
 * 印が同じなら中身も同じと言い切れる。
 */
const CACHE_MAX = 300;
const cache = new Map();

/**
 * memo から取る。取れたものは末尾へ動かして「最近使った」印にする。
 *
 * @param {string} key
 * @returns {object|undefined}
 */
function memoGet(key) {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

/**
 * memo へ入れる。溢れたら、いちばん長く触っていないものから捨てる。
 *
 * @param {string} key
 * @param {object} value
 */
function memoSet(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_MAX) {
    // Map は挿入順を保つので、先頭がいちばん古く触ったもの
    cache.delete(cache.keys().next().value);
  }
}

/**
 * セッション1本の数値。
 *
 * ログがまだ書かれていないセッション（起こした直後など）でも null にはしない。
 * 「まだ何も使っていない」は測れた事実なので、0 件の集計をそのまま返す。
 * null を返すのは、登録簿にもログにも居ないときだけ。
 *
 * @param {string} sessionId
 * @returns {Promise<object|null>} 見つからなければ null
 */
export async function getSessionUsage(sessionId) {
  if (!sessionId) return null;

  const [{ entries: registryEntries }, index] = await Promise.all([
    readRegistry(),
    indexTranscripts(),
  ]);

  const registry = registryEntries.find((e) => e.sessionId === sessionId) ?? null;
  const transcript = index.get(sessionId) ?? null;
  if (!registry && !transcript) return null;

  if (!transcript) {
    return { id: sessionId, logSize: 0, ...buildUsage([]) };
  }

  const log = await readAll(transcript.file);

  // logSize が 0 は「読めなかった＝不明」なので、印にせず毎回組み直す。
  // 0 と不明を分ける原則を、キャッシュの印にも同じように当てる
  const key = log.size > 0 ? `${sessionId}:${log.size}:${log.mtimeMs}` : null;
  if (key) {
    const hit = memoGet(key);
    if (hit) return hit;
  }

  const usage = { id: sessionId, logSize: log.size, ...buildUsage(log.entries) };
  if (key) memoSet(key, usage);
  return usage;
}
