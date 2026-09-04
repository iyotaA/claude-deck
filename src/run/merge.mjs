/**
 * 画面から起こした実行を、一覧へ混ぜる。
 *
 * **データの向きが台帳と逆。** `ledger.mjs` は「外へ出す行」を作る器だが、
 * ここは `listSessions()` が返した行を受け取って加工する側。
 * 寿命も違う（台帳はサーバーが生きているあいだ、こちらは1回の応答のあいだ）。
 * もとは `ledger.mjs` の末尾に同居していたが、読む向きが変わる場所なので分けた。
 *
 * ## `view/` を import しない
 *
 * 行の形（15項目）を知っているのに、あちらを見に行かない。
 * `view/` ↔ `run/` の相互不参照を守るため、`synthRow()` は
 * `view/shape.mjs` の `identity()` と `stateFields()` を**手で書き写している。**
 *
 * 写し忘れると起こしたばかりの行に項目が欠ける。`stateFields()` に項目が増えたら
 * `overlay()` と `synthRow()` の両方に足すこと（この手動同期が分離の対価）。
 *
 * 呼ぶのは `server.mjs` の `refresh()` だけ。合成の場所はそこ1箇所と決めてある。
 */
import { ballOf, isBlocking } from '../parse/state.mjs';
import { projectNameOf } from '../shared/text.mjs';
import { HISTORY_MAX, isRunOver, RUN_STATE_LABELS } from './ledger.mjs';

/**
 * 実行の状態を、一覧の語彙へ写す。
 *
 * 語彙が2つあるのは、見ているものが違うから。
 * `RUN_STATE_LABELS` は「この子プロセスがどうなっているか」、
 * `parse/state.mjs` の `STATE_LABELS` は「誰がボールを持っているか」を言っている。
 *
 * **写さずに run の語をそのまま `state` へ入れてはいけない。**
 * `STATE_RANK` にその語が無いので `?? 9` で一覧の末尾に沈み、
 * いま動いているセッションが最下部に並ぶ。
 *
 * `stalled`（無音）を `unknown`（rank 4）ではなく `awaiting-reply`（rank 2）へ
 * 写しているのは、あれが**人が見に行くべきもの**だから。不明の位置に沈めると気づけない。
 */
const RUN_TO_LIST_STATE = Object.freeze({
  starting: 'running',
  running: 'running',
  stopping: 'running',
  switching: 'running',
  waiting: 'awaiting-reply',
  stalled: 'awaiting-reply',
  // 許可待ちは承認待ちの位置（rank 1）。押さないと1行も進まないので、
  // 返信待ち（rank 2・放っておいても壊れない）と同じ高さに並べてはいけない。
  //
  // **写し先を変えるなら byStatus も一緒に立てる。** 下の overlay() / synthRow() を見ること。
  // 立てないと `notify/watch.mjs` の `requireByStatus` に当たって、
  // いちばん急ぐ状態だけが永久に鳴らなくなる（写す前は awaiting-reply の
  // `{slow:true, requireConfident:true}` で2分後に鳴っていた）
  'needs-permission': 'needs-approval',
  // 予算切れも「あなたの番」の位置。上げて続けるか止めるかを決めるのは人なので、
  // 待たせているものとして同じ高さに並べる
  budget: 'awaiting-reply',
  stopped: 'ended',
  failed: 'ended',
  done: 'ended',
});

/**
 * 台帳の行を、一覧の行に重ねる。
 *
 * **終わった run は状態を上書きしない。** 終わっていれば会話ログのほうが正しく、
 * `deriveState` が普通に判定できる。載せるのは「この画面から起こした」という事実だけ。
 *
 * @param {object} row 一覧の行
 * @param {object} run 台帳の行（`rows()` が返す粗い形）
 * @returns {object} 新しい行
 */
function overlay(row, run) {
  const badge = { ...run };
  if (isRunOver(run.state)) return { ...row, origin: 'deck', run: badge };

  const state = RUN_TO_LIST_STATE[run.state] ?? row.state;
  return {
    ...row,
    // headless の登録簿には `status` のキーが無く、`deriveState` の2段目・3段目が効かない。
    // 実測（2026-08-16）で、走っている最中の1本が `awaiting-reply` に見えていた
    alive: true,
    pid: run.pid ?? row.pid,
    state,
    // 画面には run の実態を出す（「あなたの番」「無音」など）。
    // 上の写しは並び順と色のためだけのもの
    stateLabel: run.stateLabel,
    ball: ballOf(state),
    // `state` を上書きするので、blocking も一緒に写す。片方だけだと1行の中で
    // `state:'needs-approval'` と `blocking:false` が矛盾し、`needsYou` が数え落とす
    blocking: isBlocking(state),
    // 台帳が正なので、ログの末尾から読んだ「待っているツール」は伏せる。
    // 残すと、実際には次の手へ進んでいるのに古い dangling が出続ける
    waitingFor: null,
    stateReason: run.reason ?? 'この画面から起こしたセッション',
    stateConfident: true,
    statusRaw: null,
    // 「登録簿の status が待ち系」ではなく「**止まっている裏づけがある**
    // （＝しきい値だけの推測ではない）」の意味で立てる。台帳は未応答の
    // `control_request` を実際に握っているので、登録簿より強い証人。
    // `statusRaw` は null のまま（あちらは別の問いに答えるフィールド）
    byStatus: run.state === 'needs-permission',
    origin: 'deck',
    run: badge,
  };
}

/**
 * 会話ログがまだ無い run から、一覧の行を組む。
 *
 * `view/shape.mjs` の `identity()` / `stateFields()` と同じキーを手で並べてある。
 * **あちらを import しない。** `run/` は末端の層で `view/` を見ないと決めてあるため。
 * 向きを崩すくらいなら、キーが2箇所に並ぶほうがまだ直しやすい。
 *
 * @param {object} run 台帳の行
 * @param {number} now 時刻
 * @returns {object} 一覧の行
 */
function synthRow(run, now) {
  const state = RUN_TO_LIST_STATE[run.state] ?? 'running';
  const cwd = run.cwd ?? null;
  const startedAt = Number.isFinite(run.startedAt) ? run.startedAt : null;

  return {
    // identity() と同じ並び
    sessionId: run.sessionId,
    pid: run.pid ?? null,
    name: run.sessionId ? run.sessionId.slice(0, 8) : '不明',
    cwd,
    project: projectNameOf(cwd),
    // 指示文は台帳が持っていない（`rows()` に載せていない）。
    // 会話ログが出れば次の走査で本物の見出しに入れ替わる
    title: null,
    permissionMode: run.permissionMode ?? null,
    mode: null,
    model: run.model ?? null,
    effort: run.effort ?? null,
    version: null,
    gitBranch: null,
    contextTokens: null,
    startedAt,
    alive: true,

    // stateFields() と同じ並び
    state,
    stateLabel: run.stateLabel,
    ball: ballOf(state),
    blocking: isBlocking(state),
    // **ここだけは動いてよい。** `refresh()` の差分判定が除外している2つなので、
    // 毎秒変わっても押し出しは起きない（それ以外の値は動かさない）
    idleMs: Number.isFinite(now) && startedAt !== null ? Math.max(0, now - startedAt) : null,
    lastActivityAt: startedAt,
    waitingFor: null,
    stateReason: 'この画面から起こしたセッション（会話ログはまだありません）',
    stateConfident: true,
    statusRaw: null,
    // 通知の鍵に混ざる値。**null にしない。**
    // `notify/watch.mjs` は返信待ちの鍵を `sessionId` ＋ `anchorId` で作るので、
    // ここが空だと鍵が生涯1つになり、2回目以降が黙って落ちる。
    // 会話ログが出れば overlay 側（ログ末尾の uuid）に入れ替わる
    anchorId: run.runId ?? null,
    // overlay() と同じ理由（「止まっている裏づけがある」）で立てる
    byStatus: run.state === 'needs-permission',

    // 一覧だけが使う項目
    nameSource: null,
    lastPrompt: null,
    lastAssistantText: null,
    skills: [],
    agents: [],
    subagentCount: null,
    parseErrors: 0,
    logFile: null,
    logSize: null,
    hasLog: false,
    // 稼働中は中身が薄くても必ず出す、と listSessions が決めている。それに合わせる
    substantive: true,

    origin: 'deck',
    run: { ...run },
  };
}

/**
 * 一覧に、この画面から起こしたぶんを重ねる。
 *
 * ## なぜ合流が要るか
 *
 * headless で立てても `sessions/<PID>.json` は書かれるが、**`status` のキーが無い**（実測）。
 * だから `deriveState` は末尾の行だけで状態を決めることになり、
 * 走っている最中でも「返信待ち」に見える。`parse/state.mjs` の規則は**1行も変えず**、
 * 台帳が知っている本当の状態をここで重ねて直す。
 *
 * ## 呼ぶ場所
 *
 * `server.mjs` の `refresh()`。**`view/` の中でやらない。**
 * `view/` と `run/` はお互いを import しない決まりなので、合成の場所はサーバーだけ。
 * 並べ直しは `view/sessions.mjs` の `sortRows` を使う（比較器を2箇所に書かない）。
 *
 * ## 足すのは生きているぶんだけ
 *
 * 終わった run でログが無いものは、行を合成しない。
 * 足すと、書庫にも詳細にも出せない幽霊行が `HISTORY_MAX` 件ぶん一覧に残る。
 * 起こしてすぐ失敗したものは実行パネルとフォームの帯に出るので、そちらで足りる。
 *
 * @param {Array<object>} rows 一覧の行（`listSessions` が返したもの）
 * @param {Array<object>} runRows 台帳の行（`runner.rows()`）
 * @param {number} [now] 時刻。合成行の `idleMs` にだけ使う
 * @returns {Array<object>} 重ねた新しい配列（並べ替えはしない）
 */
export function mergeRuns(rows, runRows, now = 0) {
  const base = Array.isArray(rows) ? rows : [];
  if (!Array.isArray(runRows) || runRows.length === 0) return base;

  // 同じ sessionId で2本あるなら、後から起こしたほうを採る。
  // `--resume` で起こし直すと、前の run が終端のまま履歴に残っているため
  const bySession = new Map();
  for (const run of runRows) {
    if (run?.sessionId) bySession.set(run.sessionId, run);
  }

  const merged = base.map((row) => {
    const run = row?.sessionId ? bySession.get(row.sessionId) : null;
    if (!run) return row;
    bySession.delete(row.sessionId);
    return overlay(row, run);
  });

  for (const run of bySession.values()) {
    if (isRunOver(run.state)) continue;
    merged.push(synthRow(run, now));
  }
  return merged;
}
