/**
 * 一覧の組み立て。
 *
 * 登録簿（稼働中）と会話ログの索引（終了済みを含む）を突き合わせる。
 *
 * 終了セッションを拾うのに history.jsonl は使わない。
 * 「登録簿に無い ＋ ログの mtime が直近」で十分に判別でき、
 * cwd もタイトルもログ自体から取れるため。
 */
import { readRegistry } from '../read/registry.mjs';
import { indexTranscripts, readTail } from '../read/transcript.mjs';
import { deriveState, STATE_RANK, STATE_LABELS } from '../parse/state.mjs';
import { extractMeta } from '../parse/meta.mjs';
import { identity, stateFields } from './shape.mjs';

/** 終了セッションを一覧に残す期間。 */
export const RECENT_MS = 24 * 60 * 60 * 1000;
/** 一覧に載せる最大件数。 */
const MAX_ROWS = 60;

/** 一覧の1行を作る。 */
async function buildRow({ registry, transcript, now }) {
  const tail = transcript ? await readTail(transcript.file) : { entries: [], parseErrors: 0, mtimeMs: 0, size: 0 };
  const entries = tail.entries ?? [];
  const meta = extractMeta(entries);
  const state = deriveState({ registry, tail, now });
  const sessionId = registry?.sessionId ?? transcript?.sessionId ?? null;

  return {
    // 詳細と共通の項目。ずれると同じセッションが2つの顔を持つので shape.mjs にまとめてある
    ...identity({ registry, meta, sessionId, transcript }),
    ...stateFields(state),

    // ここから下は一覧だけが使う項目
    nameSource: registry?.nameSource ?? null,
    lastPrompt: meta.lastPrompt ?? meta.lastUserPrompt ?? null,
    lastAssistantText: meta.lastAssistantText,
    skills: meta.skills,
    agents: meta.agents.slice(-3),
    parseErrors: tail.parseErrors ?? 0,
    logFile: transcript?.file ?? null,
    logSize: transcript?.size ?? null,
    hasLog: Boolean(transcript),
    // /clear した直後の残骸ログを一覧から外すための目印。
    // 中身が「/clear の1行だけ」というファイルが projects 配下に残るため
    substantive: Boolean(meta.model || meta.lastUserPrompt || meta.title),
  };
}

/**
 * 一覧を作る。
 *
 * @param {number} now
 * @returns {Promise<{rows: Array, meta: object}>}
 */
export async function listSessions(now = Date.now()) {
  const [{ entries: registryEntries, readErrors }, index] = await Promise.all([
    readRegistry(),
    indexTranscripts(),
  ]);

  for (const [sessionId, rec] of index) rec.sessionId = sessionId;

  const jobs = [];
  const claimed = new Set();

  for (const registry of registryEntries) {
    claimed.add(registry.sessionId);
    jobs.push({ registry, transcript: index.get(registry.sessionId) ?? null });
  }

  // 登録簿に無く、直近で動いていたログ＝終了済みセッション
  const ended = [];
  for (const [sessionId, rec] of index) {
    if (claimed.has(sessionId)) continue;
    if (now - rec.mtimeMs > RECENT_MS) continue;
    ended.push(rec);
  }
  ended.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const rec of ended.slice(0, MAX_ROWS)) {
    jobs.push({ registry: null, transcript: rec });
  }

  const built = await Promise.all(jobs.map((job) => buildRow({ ...job, now })));
  // 稼働中は中身が薄くても必ず出す（立ち上げ直後がこれに当たる）。
  // 終了済みで中身が無いものは /clear の残骸なので落とす
  const rows = built.filter((row) => row.alive || row.substantive);

  rows.sort((a, b) => {
    const rank = (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9);
    if (rank !== 0) return rank;
    // 同じ状態なら待たされている時間が長い順。放置が長いものを上に出す
    if (a.state === 'running') return (a.idleMs ?? 0) - (b.idleMs ?? 0);
    return (b.idleMs ?? 0) - (a.idleMs ?? 0);
  });

  const counts = {};
  for (const row of rows) counts[row.state] = (counts[row.state] ?? 0) + 1;

  return {
    rows,
    meta: {
      now,
      live: rows.filter((r) => r.alive).length,
      needsYou: rows.filter((r) => r.ball === 'master').length,
      counts,
      // 画面側にラベルの日本語を持たせないために毎回そのまま渡す。
      // 6件しかないので量は問題にならない
      stateLabels: STATE_LABELS,
      registryReadErrors: readErrors,
      transcriptsIndexed: index.size,
    },
  };
}
