/**
 * 一覧と詳細で共通の項目を組む。
 *
 * もとは buildRow（一覧）と getSessionDetail（詳細）が同じ 9 項目以上を
 * 別々に組んでいた。片方だけ直すと一覧と詳細でずれるので、共通部分をここへ寄せた。
 *
 * 実際にずれていた例:
 *  - name の「不明」フォールバックが一覧にしか無かった
 *  - project の projectDir フォールバックが一覧にしか無かった
 */
import { STATE_LABELS, ballOf, isBlocking } from '../parse/state.mjs';

/**
 * そのセッションの身元にあたる項目を組む。
 *
 * @param {object} args
 * @param {object|null} args.registry 登録簿の1件。終了済みセッションでは null
 * @param {object} args.meta extractMeta の戻り
 * @param {string|null} args.sessionId
 * @param {object|null} args.transcript 会話ログの索引の1件
 */
export function identity({ registry, meta, sessionId, transcript }) {
  // 稼働中は登録簿が正。終了済みはログから拾ったものしか無い
  const cwd = registry?.cwd ?? meta.cwd ?? null;

  return {
    sessionId,
    pid: registry?.pid ?? null,
    name: registry?.name ?? meta.slug ?? (sessionId ? sessionId.slice(0, 8) : '不明'),
    cwd,
    // cwd が取れないときは、ログの置き場所のフォルダ名で代える。
    // slugifyCwd は不可逆なのでパスには戻せないが、見出しには使える
    project: cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : transcript?.projectDir ?? null,
    title: meta.title ?? meta.lastPrompt ?? meta.lastUserPrompt ?? null,
    permissionMode: meta.permissionMode,
    mode: meta.mode,
    model: meta.model,
    effort: meta.effort,
    version: registry?.version ?? meta.version ?? null,
    gitBranch: meta.gitBranch,
    contextTokens: meta.contextTokens,
    startedAt: registry?.startedAt ?? null,
    alive: registry?.alive === true,
  };
}

/**
 * deriveState の結果を API 応答に載せる形へ直す。
 *
 * 内側は kind、外側は state という名前で通している。
 * 画面側は state を見ているので、ここで名前を付け替える。
 *
 * @param {object} state deriveState の戻り
 */
export function stateFields(state) {
  return {
    state: state.kind,
    stateLabel: STATE_LABELS[state.kind] ?? state.kind,
    ball: ballOf(state.kind),
    // ball とは別の問い（答えないと1行も進まないか）。判断は日本語と同じくサーバーが配る
    blocking: isBlocking(state.kind),
    idleMs: state.idleMs,
    lastActivityAt: state.lastActivityAt,
    waitingFor: state.waitingFor,
    stateReason: state.reason,
    stateConfident: state.confident,
    statusRaw: state.statusRaw,
    // 通知が「同じ待ちかどうか」と「人に聞きに来ているか」を判断するのに使う。
    // 意味は parse/state.mjs の base のコメントを見ること
    anchorId: state.anchorId,
    byStatus: state.byStatus,
  };
}
