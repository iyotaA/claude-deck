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
import { buildPlanLineage } from './plans.mjs';
import { collectSubagents } from './subagent.mjs';

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

  // ディスクを1回だけ読む。落ちても詳細そのものは返す（プランの系譜が消えるだけ）
  let planLineage = null;
  try {
    planLineage = await buildPlanLineage(digest);
  } catch {
    planLineage = null;
  }

  // サブエージェントの記録。readdir 1回 ＋ stat 数回。詳細を開いたときだけ走る。
  // 落ちても詳細そのものは返す（パネルが空になるだけ）
  let subagents = { items: [], counts: null, readError: null };
  try {
    subagents = await collectSubagents(transcript?.file ?? null, sessionId, digest);
  } catch (err) {
    subagents = { items: [], counts: null, readError: String(err?.message ?? err) };
  }

  const detail = {
    ...identity({ registry, meta, sessionId, transcript }),
    ...stateFields(state),

    // Claude が最後に書いた中間報告。自己申告なので、機械的に抽出した項目とは別のキーに置く。
    // 無ければ null。機能が1つ消えるだけで、他の表示には影響させない
    recap: meta.recap ? { text: meta.recap, at: meta.recapAt } : null,

    digest,
    tasks,

    // 承認したプランが、いまディスクにあるものと同じか。
    // 材料が無ければ null。新しいデータ源は「無ければ機能が1つ消えるだけ」に閉じる
    planLineage,

    // サブエージェントの記録。最終報告の本文は入れない（長さだけ）。
    // digest の下に置かないのは、間引きの影響を受けないようにするため
    subagents,

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
