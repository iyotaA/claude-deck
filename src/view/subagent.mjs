/**
 * サブエージェントの記録を、親ログの呼び出しと突き合わせて一覧にする。
 *
 * 答えたい問いは「そのサブエージェントが何を調べて、どうやってそこに至ったか」。
 * 結論（最終報告）は親ログの結果に既に入っているので、一覧は本文を持たず長さだけを出す。
 * 本文は「開く」の応答へ回す。
 *
 * ── 突き合わせの軸をディスク側に置く理由 ──────────────────────
 *
 * 入れ子は実在する（実測で深さ 1=139 / 2=7 / 3=2）。
 * 深さ2以上の toolUseId は**親ログに無い**（親サブエージェントのログの中にある）。
 * だから「呼び出しを軸にディスクを探す」形にすると、入れ子の記録が丸ごと消える。
 * ディスクにある記録が事実で、呼び出しはそこに付く情報として扱う。
 */
import { indexTranscripts } from '../read/transcript.mjs';
import { listSubagents, readSubagentLog } from '../read/subagents.mjs';
import { buildDigest } from '../parse/digest.mjs';

/**
 * 親ログの呼び出しと、ディスクの記録を突き合わせる。
 *
 * fs を触らない純関数にしてあるのでテストできる。
 *
 * @param {Array<object>} agentItems digest.agents（間引きで items から消えても残る配列）
 * @param {Array<object>} refs listSubagents が返した記録
 * @returns {{items: Array<object>, counts: object}}
 */
export function joinSubagents(agentItems = [], refs = []) {
  const byToolUse = new Map();
  const byAgentId = new Map();
  for (const a of agentItems) {
    if (a?.toolUseId && !byToolUse.has(a.toolUseId)) byToolUse.set(a.toolUseId, a);
    if (a?.agentId && !byAgentId.has(a.agentId)) byAgentId.set(a.agentId, a);
  }

  const items = [];
  const used = new Set();

  for (const ref of refs) {
    // toolUseId を先に見る。agentId は結果が返っていないと親ログに現れないため
    const item = (ref.toolUseId ? byToolUse.get(ref.toolUseId) : null) ?? byAgentId.get(ref.agentId) ?? null;
    if (item) used.add(item);
    items.push(row(ref, item));
  }

  // ログが無い呼び出し。行だけ出して「記録が見つかりません」と言えるようにする
  for (const a of agentItems) {
    if (used.has(a)) continue;
    items.push(row(null, a));
  }

  // at の昇順。at が無いものはログの更新時刻で代える（並び順が崩れるほうが読みにくい）
  items.sort((x, y) => sortKey(x) - sortKey(y));

  return { items, counts: countUp(items) };
}

/** 並べる順の鍵。どちらも取れなければ最後に回す。 */
function sortKey(item) {
  if (typeof item.at === 'number') return item.at;
  if (typeof item.log?.mtimeMs === 'number') return item.log.mtimeMs;
  return Number.MAX_SAFE_INTEGER;
}

/**
 * 一覧の1行を組む。
 *
 * ref 側（.meta.json）と item 側（親ログ）で同じ項目が取れるので、
 * **ディスクにある値を先に採る**。親ログの結果は非同期起動だと呼び出し時の情報しか入らない。
 *
 * 最終報告の本文は入れない。20件 × 最大11KB = 220KB が毎回の詳細応答に乗る。
 * log.file（絶対パス）も入れない。「開く」は agentId だけで呼べる
 *
 * @param {object|null} ref ディスクの記録。無ければ null
 * @param {object|null} item 親ログの呼び出し。無ければ null
 */
function row(ref, item) {
  return {
    agentId: ref?.agentId ?? item?.agentId ?? null,
    agentType: ref?.agentType ?? item?.agentType ?? null,
    description: ref?.description ?? item?.description ?? null,
    at: item?.at ?? null,
    status: item?.status ?? null,
    // spawnDepth と parentAgentId は .meta.json にしか無い
    spawnDepth: ref?.spawnDepth ?? null,
    parentAgentId: ref?.parentAgentId ?? null,
    model: ref?.model ?? item?.model ?? null,
    durationMs: item?.durationMs ?? null,
    tokens: item?.tokens ?? null,
    toolUseCount: item?.toolUseCount ?? null,
    reportChars: item?.reportChars ?? null,
    // 親ログの呼び出しに結びついたか。入れ子は結びつかないのが正常
    linked: item !== null,
    log: {
      exists: ref !== null,
      size: ref?.size ?? null,
      mtimeMs: ref?.mtimeMs ?? null,
    },
  };
}

/**
 * 数え上げる。
 *
 * 「実行中」は数えない。終わったセッションの記録を見ているのに走っていることになる。
 * 起動しか分かっていないものは launched のまま置く（0 と「不明」を分けるのと同じ理屈）
 *
 * @param {Array<object>} items row の並び
 */
function countUp(items) {
  const byStatus = {};
  let withLog = 0;
  let unlinked = 0;
  let missingLog = 0;

  for (const it of items) {
    if (it.log.exists) withLog += 1;
    else missingLog += 1;
    if (!it.linked) unlinked += 1;
    const key = it.status ?? 'unknown';
    byStatus[key] = (byStatus[key] ?? 0) + 1;
  }

  return { total: items.length, withLog, unlinked, missingLog, byStatus };
}

/**
 * そのセッションのサブエージェント一覧を組む。
 *
 * 呼ぶのは詳細ビューだけ。**一覧（毎秒走る経路）には絶対に載せない。**
 * 46セッション分の readdir が毎秒走ることになる
 *
 * @param {string|null} transcriptFile 親ログの実パス
 * @param {string} sessionId セッションID
 * @param {object} digest buildDigest の結果
 * @returns {Promise<{items: Array<object>, counts: object, readError: string|null}>}
 */
export async function collectSubagents(transcriptFile, sessionId, digest) {
  const { refs, readError } = await listSubagents(transcriptFile, sessionId);
  const { items, counts } = joinSubagents(digest?.agents ?? [], refs);
  return { items, counts, readError };
}

/**
 * サブエージェント1件の記録を開く。
 *
 * ── agentId をパスに連結しない ──────────────────────
 *
 * listSubagents を呼び、readdir が返した記録の中から agentId が一致するものを探す。
 * 開くファイルは常に「readdir が返した名前」であって、リクエストの文字列ではない。
 * だからパストラバーサルの検証が要らない。
 * server.mjs の正規表現は入口の粗いふるいであって、安全の根拠ではない。
 *
 * 提案9（プランの系譜）はログ由来のパスをそのまま開くので検証が必須だった。
 * こちらは開かないので検証が不要。同じ「外部入力のパス」でも扱いが違う。
 *
 * @param {string} sessionId セッションID
 * @param {string} agentId 開きたいサブエージェントの ID
 * @returns {Promise<object|null>} 見つからなければ null
 */
export async function getSubagentDetail(sessionId, agentId) {
  if (!sessionId || !agentId) return null;

  const index = await indexTranscripts();
  const transcript = index.get(sessionId) ?? null;
  if (!transcript) return null;

  const { refs } = await listSubagents(transcript.file, sessionId);
  const ref = refs.find((r) => r.agentId === agentId) ?? null;
  if (!ref) return null;

  const log = await readSubagentLog(ref);

  // サブエージェントのログは全行 isSidechain:true なので、既定の main のままだと1件も残らない。
  // agentId での絞り込みは掛けない。このファイル自体が1エージェントの記録なので、
  // agentId が書かれていない行があったときに黙って消すほうが害が大きい
  const digest = buildDigest({ entries: log.entries, scope: 'sidechain' });

  return {
    sessionId,
    agentId,
    agentType: ref.agentType,
    description: ref.description,
    spawnDepth: ref.spawnDepth,
    parentAgentId: ref.parentAgentId,
    digest,
    log: {
      // ファイルパスは返さない
      size: log.size,
      entries: log.entries.length,
      parseErrors: log.parseErrors,
      truncated: log.truncated === true,
    },
  };
}
