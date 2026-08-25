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
import { countSubagents } from '../read/subagents.mjs';
import { deriveState, STATE_RANK, STATE_LABELS, STATE_BLOCKING } from '../parse/state.mjs';
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

  // サブエージェントを使ったか。<セッションID>/ が無ければ子も無いので readdir を出さずに 0 と決める。
  // 索引を作ってからここまでの間にディレクトリができた場合は、その回だけ 0 に見える（次の更新で出る）。
  // ログそのものが無いセッション（立ち上げ直後）は 0 ではなく不明
  const subagentCount = transcript
    ? (transcript.hasSessionDir ? await countSubagents(transcript.file, sessionId) : 0)
    : null;

  return {
    // 詳細と共通の項目。ずれると同じセッションが2つの顔を持つので shape.mjs にまとめてある
    ...identity({ registry, meta, sessionId, transcript }),
    ...stateFields(state),

    // ここから下は一覧だけが使う項目
    nameSource: registry?.nameSource ?? null,
    lastPrompt: meta.lastPrompt ?? meta.lastUserPrompt ?? null,
    lastAssistantText: meta.lastAssistantText,
    // 呼んだスキルだけ。打ったスラッシュコマンド（meta.commands）はここに載せない。
    // 大半が /clear で、一覧のタグとしては読み方を変えない。
    // 毎秒返る応答なので、画面が使わない値を持たせない
    skills: meta.skills,
    // 末尾 64KB に出てきた呼び出しの記録。直近しか映らないので件数の根拠にはしない
    agents: meta.agents.slice(-3),
    // 記録ファイルの実数。上の agents とは別物で、こちらが「使ったか否か」の答え
    subagentCount,
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
 * 並び替え用に idleMs を数値へ落とす。
 *
 * null は「取れなかった」であって 0 ではない。
 * 0 に丸めると最も新しいものとして先頭に出てしまうため、末尾へ寄せる。
 *
 * @param {{idleMs: number|null}} row
 * @returns {number}
 */
function idleForSort(row) {
  return row.idleMs ?? Number.POSITIVE_INFINITY;
}

/**
 * 一覧の並び順を決める。
 *
 * **比較器をここ1箇所に置く。** `server.mjs` が実行中のセッションを重ねたあと
 * 並べ直す必要があるので、そちらへ写すと同じ規則が2箇所に生きることになる。
 *
 * 受け取った配列をその場で並べ替えて返す（`Array.prototype.sort` と同じ）。
 *
 * @param {Array<object>} rows 並べる行
 * @returns {Array<object>} 同じ配列
 */
export function sortRows(rows) {
  return rows.sort((a, b) => {
    const rank = (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9);
    if (rank !== 0) return rank;
    // 同じ状態なら動きが新しい順。放置が長いものほど下に沈む。
    // idleMs が取れないものは「不明」なので末尾に置く（0 と混ぜない）
    return idleForSort(a) - idleForSort(b);
  });
}

/**
 * 行から数を数える。
 *
 * `sortRows` と同じ理由でここに置いてある。合流のあとに数え直さないと、
 * 上のバーのまとめ（画面側の `renderSummary`）だけが合流前の数のまま残る。
 *
 * @param {Array<object>} rows 数える行
 * @returns {{live:number, needsYou:number, counts:object}}
 */
export function summarizeRows(rows) {
  const counts = {};
  for (const row of rows) counts[row.state] = (counts[row.state] ?? 0) + 1;
  return {
    live: rows.filter((r) => r.alive).length,
    // 数えるのは「答えないと1行も進まない」ものだけ。返信待ちは ball が master でも入れない。
    // `=== true` で見るのは、台帳側が項目を足し忘れた将来でも undefined を「数えない」に倒すため
    needsYou: rows.filter((r) => r.blocking === true).length,
    counts,
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

  sortRows(rows);

  return {
    rows,
    meta: {
      now,
      ...summarizeRows(rows),
      // 画面側にラベルの日本語を持たせないために毎回そのまま渡す。
      // 6件しかないので量は問題にならない
      stateLabels: STATE_LABELS,
    stateBlocking: STATE_BLOCKING,
      registryReadErrors: readErrors,
      transcriptsIndexed: index.size,
    },
  };
}
