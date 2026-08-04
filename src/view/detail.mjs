/**
 * 1セッションの詳細を組み立てる。
 *
 * 一覧と違ってログを全文読む。開いたときだけ呼ばれるので、そこは許容する。
 */
import { readRegistry } from '../read/registry.mjs';
import { indexTranscripts, readAll } from '../read/transcript.mjs';
import { readTasks } from '../read/tasks.mjs';
import { deriveState } from '../parse/state.mjs';
import { extractMeta } from '../parse/meta.mjs';
import { buildDigest } from '../parse/digest.mjs';
import { identity, stateFields } from './shape.mjs';
import { summarize } from './summary.mjs';

/**
 * @param {string} sessionId
 * @param {number} now
 * @returns {Promise<object|null>} 見つからなければ null
 */
export async function getSessionDetail(sessionId, now = Date.now()) {
  if (!sessionId) return null;

  const [{ entries: registryEntries }, index] = await Promise.all([
    readRegistry(),
    indexTranscripts(),
  ]);

  const registry = registryEntries.find((e) => e.sessionId === sessionId) ?? null;
  const transcript = index.get(sessionId) ?? null;
  if (!registry && !transcript) return null;

  const log = transcript
    ? await readAll(transcript.file)
    : { entries: [], parseErrors: 0, size: 0, mtimeMs: 0 };

  const meta = extractMeta(log.entries);
  const state = deriveState({ registry, tail: log, now });
  const [digest, tasks] = await Promise.all([
    Promise.resolve(buildDigest({ entries: log.entries })),
    readTasks(sessionId),
  ]);

  const detail = {
    ...identity({ registry, meta, sessionId, transcript }),
    ...stateFields(state),

    digest,
    tasks,

    log: {
      file: transcript?.file ?? null,
      size: log.size,
      entries: log.entries.length,
      parseErrors: log.parseErrors,
    },
  };

  // 要約は他の項目を材料にするので最後に付ける。
  // ここで落ちても詳細そのものは返す（要約は無くても読める部分）
  try {
    detail.summary = await summarize(detail);
  } catch (err) {
    detail.summary = { source: 'error', reason: String(err?.message ?? err) };
  }

  return detail;
}
