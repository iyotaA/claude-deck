/**
 * ボール状態の判定。このアプリの心臓部。
 *
 * 考え方:
 *   会話ログは「assistant がツールを呼ぶ → その結果の行が来る」の繰り返しで進む。
 *   結果の行が来ていない呼び出しが残っていて、かつ追記が止まっているなら、
 *   それは Claude があなたの承認や回答を待って固まっている状態。
 *   これを dangling（結果待ちのまま残った呼び出し）と呼ぶ。
 *
 * 誤判定を避けるための軸:
 *   長く走る Bash も dangling に見えるので、それだけでは承認待ちと断定できない。
 *   ただし AskUserQuestion と ExitPlanMode は「あなたを待つ」以外の用途を持たないツールなので、
 *   これが dangling なら確実にあなた待ち。ここを別扱いにして確実性を取る。
 *   ふつうのツールは 登録簿の status と、より長いしきい値の両方で見る。
 */
import {
  toolUses,
  toolResults,
  textOf,
  timestampOf,
  isMainline,
} from './entries.mjs';
import { describeTool } from '../shared/tools.mjs';

/** 追記が止まったと見なすまで。 */
export const QUIET_MS = 3000;
/** ふつうのツールが dangling のとき、承認待ちと見なすまで。長く走るコマンドとの区別用。 */
export const APPROVAL_MS = 15000;

/**
 * 登録簿の status のうち「動いている」を意味すると分かっている値。
 *
 * 実物で確認できたのは busy だけ。残りは名前から予想して入れてある。
 * 未知の値が来た場合はここに引っかからず、ログの中身だけで判定する。
 */
const BUSY_STATUSES = new Set(['busy', 'running', 'working']);
/** 「あなたを待っている」を意味すると分かっている値。実物で確認できたのは idle と waiting。 */
const WAITING_STATUSES = new Set(['idle', 'waiting', 'waiting_for_input', 'needs_input', 'ready']);

export const STATE_LABELS = {
  running: '実行中',
  'needs-answer': '質問待ち',
  'needs-plan-approval': 'プラン承認待ち',
  'needs-approval': '承認待ち',
  'awaiting-reply': '返信待ち',
  ended: '終了',
  unknown: '不明',
};

/** 一覧の並び順。小さいほど上（＝先に手をつけるべき）。 */
export const STATE_RANK = {
  'needs-answer': 0,
  'needs-plan-approval': 0,
  'needs-approval': 1,
  'awaiting-reply': 2,
  running: 3,
  unknown: 4,
  ended: 5,
};

/** どちらのボールか。表示の色分けに使う。 */
export function ballOf(kind) {
  if (kind === 'running') return 'claude';
  if (kind === 'ended') return 'none';
  if (kind === 'unknown') return 'none';
  return 'master';
}

/** 未解決のまま残った tool_use を探す。 */
function findDangling(entries) {
  const resolved = new Set();
  const resolvedAssistantUuids = new Set();

  for (const entry of entries) {
    const results = toolResults(entry);
    for (const r of results) {
      if (r.id) resolved.add(r.id);
    }
    // tool_result ブロックが無いのに結果だけ入っている形に備えた保険。
    // sourceToolAssistantUUID は結果の元になった assistant 行を指す。
    if (results.length === 0 && entry?.toolUseResult !== undefined && entry.sourceToolAssistantUUID) {
      resolvedAssistantUuids.add(entry.sourceToolAssistantUUID);
    }
  }

  let dangling = null;
  for (const entry of entries) {
    if (entry?.type !== 'assistant') continue;
    if (resolvedAssistantUuids.has(entry.uuid)) continue;
    for (const tu of toolUses(entry)) {
      if (resolved.has(tu.id)) continue;
      dangling = { ...tu, at: timestampOf(entry), assistantUuid: entry.uuid };
    }
  }
  return dangling;
}

/**
 * 状態を決める。
 *
 * @param {object|null} registry 登録簿の1件（無ければ null）
 * @param {object} tail readTail の結果
 * @param {number} now 現在時刻
 */
export function deriveState({ registry, tail, now = Date.now() }) {
  const entries = (tail?.entries ?? []).filter(isMainline);

  let lastEntryAt = null;
  for (const entry of entries) {
    const at = timestampOf(entry);
    if (at !== null && (lastEntryAt === null || at > lastEntryAt)) lastEntryAt = at;
  }

  const lastActivityAt = Math.max(tail?.mtimeMs ?? 0, lastEntryAt ?? 0) || null;
  const idleMs = lastActivityAt ? Math.max(0, now - lastActivityAt) : null;
  const quiet = idleMs === null ? false : idleMs >= QUIET_MS;

  const dangling = findDangling(entries);
  const statusRaw = registry?.status ?? null;
  const busy = statusRaw !== null && BUSY_STATUSES.has(statusRaw);
  const waitingByStatus = statusRaw !== null && WAITING_STATUSES.has(statusRaw);

  const base = {
    idleMs,
    lastActivityAt,
    statusRaw,
    // 判定の根拠を持たせておく。表示の説明にも、しきい値を詰めるときの手がかりにも使う
    waitingFor: dangling
      ? {
        // tool_use の id。呼び出しごとに一意なので「同じ待ちかどうか」の鍵になる。
        //
        // 通知はこの id で重複を弾く。lastActivityAt では弾けない。
        // あれは Math.max(ファイルの更新時刻, 最終エントリ時刻) なので（上の行を参照）、
        // サブエージェントが走っているあいだ親ログに追記が続いて動き続ける。
        // 質問は1つのままなのに鍵だけが変わり、同じ質問で何通も飛ぶことになる。
        //
        // 実測したログには必ず入っていたが、無い形が来ても落ちないように null に倒す
        id: dangling.id ?? null,
        tool: dangling.name,
        detail: describeTool(dangling.name, dangling.input),
      }
      : null,
  };

  // 登録簿に居ない、またはプロセスが死んでいる
  if (!registry || registry.alive !== true) {
    return { ...base, kind: 'ended', confident: true, reason: registry ? 'プロセスが終了' : '登録簿に無し' };
  }

  // AskUserQuestion と ExitPlanMode は「あなたを待つ」専用のツール。
  // 未解決ならそれ以外の解釈が無いので、しきい値も status も見ずに確定させる
  if (dangling?.name === 'AskUserQuestion') {
    return { ...base, kind: 'needs-answer', confident: true, reason: '質問を出して停止中' };
  }
  if (dangling?.name === 'ExitPlanMode') {
    return { ...base, kind: 'needs-plan-approval', confident: true, reason: 'プランの承認を待って停止中' };
  }

  // 登録簿がはっきり「待ち」と言っているなら従う
  if (waitingByStatus && quiet) {
    const kind = dangling ? 'needs-approval' : 'awaiting-reply';
    return { ...base, kind, confident: true, reason: `登録簿の status が ${statusRaw}` };
  }

  // 登録簿が busy なら、dangling でも単に長く走っているだけと見る
  if (busy && !quiet) {
    return { ...base, kind: 'running', confident: true, reason: `status=${statusRaw} で追記も直近` };
  }

  if (dangling) {
    if (idleMs !== null && idleMs >= APPROVAL_MS) {
      return {
        ...base,
        kind: 'needs-approval',
        // status の値が未知だと断定しきれない。長く止まっている事実だけが根拠
        confident: !busy,
        reason: `${dangling.name} の結果が来ないまま停止`,
      };
    }
    return { ...base, kind: 'running', confident: true, reason: `${dangling.name} を実行中` };
  }

  // dangling が無い＝ツールの往復は終わっている。末尾が assistant の発言なら返信待ち
  const last = entries[entries.length - 1];
  if (last?.type === 'assistant' && textOf(last)) {
    if (quiet) {
      return { ...base, kind: 'awaiting-reply', confident: true, reason: '応答を返し終えて停止' };
    }
    return { ...base, kind: 'running', confident: true, reason: '応答の途中' };
  }

  if (busy) {
    return { ...base, kind: 'running', confident: true, reason: `status=${statusRaw}` };
  }
  if (quiet) {
    return { ...base, kind: 'awaiting-reply', confident: false, reason: '追記が止まっている' };
  }
  return { ...base, kind: 'running', confident: false, reason: '追記が続いている' };
}
