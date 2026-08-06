/**
 * 通知の状態機械のテスト。ここが本丸。
 *
 * 通知でいちばん怖いのは「同じ質問で何通も鳴る」と「鳴ってほしいのに黙る」の2つ。
 * どちらも判断の間違いなので、I/O を持たない watch.mjs に全部の分岐を集めて
 * ここで通す。時刻は引数で渡すので、待たずに時間を進められる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotifyWatch, keyOf, NOTIFY_STATES } from '../src/notify/watch.mjs';

/** 基準時刻。ここから相対で組む。 */
const T0 = 1_700_000_000_000;

/** 種まき期間を抜けた時刻。ここから観測すれば本当の通知になる。 */
const AFTER_BOOT = T0 + 20_000;

/**
 * listSessions が返す行のうち、通知が見るところだけを組む。
 *
 * @param {object} [over] 上書きしたい項目
 * @returns {object}
 */
function row(over = {}) {
  const { id = 'toolu_1', tool = 'AskUserQuestion', detail = 'どっちにする？', ...rest } = over;
  return {
    sessionId: 'sess-a',
    name: 'sandbox-9c',
    project: 'claude-deck',
    state: 'needs-answer',
    stateLabel: '質問待ち',
    idleMs: 1000,
    waitingFor: id === null ? null : { id, tool, detail },
    ...rest,
  };
}

/** 落ち着き待ちも種まきも無い、いちばん素直な設定。 */
const bare = (over = {}) => createNotifyWatch({ settleMs: 0, graceMs: 0, bootAt: T0, ...over });

test('通知するのは待ち系の4つだけ', () => {
  assert.deepEqual([...NOTIFY_STATES].sort(), [
    'awaiting-reply', 'needs-answer', 'needs-approval', 'needs-plan-approval',
  ]);
  // 実行中と終了は通知しない
  assert.ok(!NOTIFY_STATES.has('running'));
  assert.ok(!NOTIFY_STATES.has('ended'));
});

test('鍵は sessionId と tool_use.id を並べたもの', () => {
  assert.equal(keyOf(row({ id: 'toolu_abc' })), 'sess-a::toolu_abc');
});

test('id が無くても鍵は作れる', () => {
  // 実測したログには必ず入っていたが、読んでいるのは公開仕様ではない
  const k = keyOf({ sessionId: 'sess-a', state: 'needs-answer', waitingFor: { tool: 'X' } });
  assert.equal(typeof k, 'string');
  assert.ok(k.startsWith('sess-a::'));
});

test('sessionId が無い行は鍵を持たない', () => {
  assert.equal(keyOf({ state: 'needs-answer' }), null);
  assert.equal(keyOf(null), null);
});

test('落ち着き待ちの間は取り出せない', () => {
  const w = createNotifyWatch({ settleMs: 6000, graceMs: 0, bootAt: T0 });
  w.observe([row()], AFTER_BOOT);
  assert.deepEqual(w.takeReady(AFTER_BOOT + 5999), []);
  assert.equal(w.stats().pending, 1);
});

test('落ち着き待ちを抜けたら取り出せる', () => {
  const w = createNotifyWatch({ settleMs: 6000, graceMs: 0, bootAt: T0 });
  w.observe([row()], AFTER_BOOT);
  w.observe([row()], AFTER_BOOT + 6000);

  const got = w.takeReady(AFTER_BOOT + 6000);
  assert.equal(got.length, 1);
  assert.equal(got[0].name, 'sandbox-9c');
  assert.equal(got[0].tool, 'AskUserQuestion');
  assert.equal(w.stats().pending, 0);
});

test('落ち着き待ちの途中で答えたら送らない', () => {
  // 目の前にいて即答した分がここで落ちる。これが SETTLE_MS の存在理由
  const w = createNotifyWatch({ settleMs: 6000, graceMs: 0, bootAt: T0 });
  w.observe([row()], AFTER_BOOT);
  w.observe([], AFTER_BOOT + 2000);

  assert.deepEqual(w.takeReady(AFTER_BOOT + 9000), []);
  assert.equal(w.stats().vanished, 1);
});

test('同じ鍵は生涯1通', () => {
  const w = bare();
  for (let i = 0; i < 5; i += 1) {
    w.observe([row()], AFTER_BOOT + i * 1000);
    w.takeReady(AFTER_BOOT + i * 1000);
  }
  assert.equal(w.stats().taken, 1);
});

test('状態が往復しても1通のまま', () => {
  // registry.mjs は書き込み途中の壊れた JSON を黙って飛ばす。
  // 飛ばされると ended に落ち、次の走査で戻る。この往復は日常的に起きる
  const w = bare();
  w.observe([row()], AFTER_BOOT);
  assert.equal(w.takeReady(AFTER_BOOT).length, 1);

  w.observe([], AFTER_BOOT + 1000);
  w.observe([row()], AFTER_BOOT + 2000);
  assert.deepEqual(w.takeReady(AFTER_BOOT + 2000), []);
});

test('id が変われば別の待ちとして数える', () => {
  // Q1 に答えてすぐ Q2 が出る場面。鍵が変わるので正しく2通になる
  const w = bare();
  w.observe([row({ id: 'q1' })], AFTER_BOOT);
  assert.equal(w.takeReady(AFTER_BOOT).length, 1);

  w.observe([row({ id: 'q2' })], AFTER_BOOT + 1000);
  assert.equal(w.takeReady(AFTER_BOOT + 1000).length, 1);
});

test('通知しない状態は見ない', () => {
  const w = bare();
  w.observe([
    row({ state: 'running' }),
    row({ state: 'ended', id: 'x3' }),
    // 待ち系でも、条件を満たしていないものは見ない。
    // 承認待ちは登録簿の裏づけ（byStatus）が要る。返信待ちは自信が要る
    row({ state: 'needs-approval', id: 'x1' }),
    row({ state: 'awaiting-reply', id: null, anchorId: 'x2' }),
  ], AFTER_BOOT);
  assert.deepEqual(w.takeReady(AFTER_BOOT), []);
});

test('プラン承認待ちも通知する', () => {
  const w = bare();
  w.observe([row({ state: 'needs-plan-approval', stateLabel: 'プラン承認待ち', tool: 'ExitPlanMode' })], AFTER_BOOT);
  const got = w.takeReady(AFTER_BOOT);
  assert.equal(got.length, 1);
  assert.equal(got[0].stateLabel, 'プラン承認待ち');
});

test('起動直後に見えていた待ちは送らず、既通知として覚える', () => {
  // 朝ログオンするたびに昨夜からの待ちが全部飛ぶのを防ぐ
  const w = createNotifyWatch({ settleMs: 0, graceMs: 10_000, bootAt: T0 });
  w.observe([row()], T0 + 500);
  assert.deepEqual(w.takeReady(T0 + 500), []);
  assert.equal(w.stats().seeded, 1);

  // 種まきしたものは、あとで何度見ても送らない
  w.observe([row()], T0 + 60_000);
  assert.deepEqual(w.takeReady(T0 + 60_000), []);
});

test('種まき期間のあとに始まった待ちは送る', () => {
  // 単に「30秒黙る」より優れている点。鍵が別なので取りこぼさない
  const w = createNotifyWatch({ settleMs: 0, graceMs: 10_000, bootAt: T0 });
  w.observe([row({ id: 'old' })], T0 + 500);
  w.observe([row({ id: 'old' }), row({ id: 'new' })], T0 + 11_000);

  const got = w.takeReady(T0 + 11_000);
  assert.equal(got.length, 1);
  assert.equal(got[0].key, 'sess-a::new');
});

test('取り出す直前に消えていたら送らない', () => {
  // 確定から送信までの数秒で答えられていることがある。
  // これが無いと「答えた4秒後に Slack が鳴る」が起きる
  const w = bare();
  w.observe([row()], AFTER_BOOT);
  w.observe([], AFTER_BOOT + 500);
  assert.deepEqual(w.takeReady(AFTER_BOOT + 500), []);
});

test('同時に確定した複数件はまとめて取り出せる', () => {
  const w = bare();
  w.observe([
    row({ id: 'a' }),
    { ...row({ id: 'b' }), sessionId: 'sess-b', name: 'deck-b7' },
  ], AFTER_BOOT);

  const got = w.takeReady(AFTER_BOOT);
  assert.equal(got.length, 2);
});

test('失敗したら再送に回り、待ち時間の前は取り出せない', () => {
  const w = bare();
  w.observe([row()], AFTER_BOOT);
  const got = w.takeReady(AFTER_BOOT);

  w.giveBack(got, AFTER_BOOT, { retryMs: 4000 });
  assert.deepEqual(w.takeReady(AFTER_BOOT + 3999), []);
  assert.equal(w.takeReady(AFTER_BOOT + 4000).length, 1);
});

test('再送も失敗したらあきらめて捨てる', () => {
  const w = bare();
  w.observe([row()], AFTER_BOOT);

  const first = w.takeReady(AFTER_BOOT);
  w.giveBack(first, AFTER_BOOT, { retryMs: 4000 });
  const second = w.takeReady(AFTER_BOOT + 4000);
  w.giveBack(second, AFTER_BOOT + 4000, { retryMs: 4000 });

  assert.deepEqual(w.takeReady(AFTER_BOOT + 20_000), []);
  assert.equal(w.stats().dropped, 1);
});

test('送信待ちが溢れたら古いほうから捨てて、捨てた数を覚える', () => {
  const w = createNotifyWatch({ settleMs: 0, graceMs: 0, queueMax: 2, bootAt: T0 });
  w.observe([row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })], AFTER_BOOT);

  assert.equal(w.stats().dropped, 1);
  const got = w.takeReady(AFTER_BOOT);
  assert.equal(got.length, 2);
  // 捨てるのは古いほう。新しい待ちのほうが役に立つ
  assert.deepEqual(got.map((i) => i.key), ['sess-a::b', 'sess-a::c']);
});

test('1時間の上限に達したら止まる', () => {
  const w = createNotifyWatch({ settleMs: 0, graceMs: 0, maxPerHour: 2, bootAt: T0 });

  for (const id of ['a', 'b']) {
    w.observe([row({ id })], AFTER_BOOT);
    assert.equal(w.takeReady(AFTER_BOOT).length, 1);
  }

  w.observe([row({ id: 'c' })], AFTER_BOOT);
  assert.deepEqual(w.takeReady(AFTER_BOOT), []);
  assert.equal(w.stats().overLimit, true);
});

test('1時間たてば上限の数えは戻る', () => {
  const w = createNotifyWatch({ settleMs: 0, graceMs: 0, maxPerHour: 1, bootAt: T0 });
  w.observe([row({ id: 'a' })], AFTER_BOOT);
  w.takeReady(AFTER_BOOT);

  w.observe([row({ id: 'b' })], AFTER_BOOT + 3_600_001);
  assert.equal(w.takeReady(AFTER_BOOT + 3_600_001).length, 1);
});

test('リマインドは既定で出ない', () => {
  const w = bare();
  w.observe([row()], AFTER_BOOT);
  w.takeReady(AFTER_BOOT);

  w.observe([row({ idleMs: 60 * 60 * 1000 })], AFTER_BOOT + 1000);
  assert.deepEqual(w.takeReady(AFTER_BOOT + 1000), []);
});

test('リマインドを有効にすると、放置された待ちを1回だけ出し直す', () => {
  const w = createNotifyWatch({ settleMs: 0, graceMs: 0, remindMs: 30 * 60 * 1000, bootAt: T0 });
  w.observe([row({ idleMs: 1000 })], AFTER_BOOT);
  assert.equal(w.takeReady(AFTER_BOOT).length, 1);

  // まだ 30 分たっていない
  w.observe([row({ idleMs: 29 * 60 * 1000 })], AFTER_BOOT + 1000);
  assert.deepEqual(w.takeReady(AFTER_BOOT + 1000), []);

  const t = AFTER_BOOT + 2000;
  w.observe([row({ idleMs: 30 * 60 * 1000 })], t);
  const again = w.takeReady(t);
  assert.equal(again.length, 1);
  assert.equal(again[0].kind, 'remind');

  // 何度見ても2回目は出ない
  w.observe([row({ idleMs: 90 * 60 * 1000 })], t + 1000);
  assert.deepEqual(w.takeReady(t + 1000), []);
});

test('sessionId を持たない行は黙って飛ばす', () => {
  const w = bare();
  w.observe([{ state: 'needs-answer' }, row()], AFTER_BOOT);
  assert.equal(w.takeReady(AFTER_BOOT).length, 1);
});

test('waitingFor が無い形でも落ちない', () => {
  const w = bare();
  w.observe([row({ id: null })], AFTER_BOOT);

  const got = w.takeReady(AFTER_BOOT);
  assert.equal(got.length, 1);
  assert.equal(got[0].tool, null);
  assert.equal(got[0].detail, null);
});

test('rows が無くても落ちない', () => {
  const w = bare();
  w.observe(undefined, AFTER_BOOT);
  w.observe(null, AFTER_BOOT);
  assert.deepEqual(w.takeReady(AFTER_BOOT), []);
});

test('通知に載る項目は cwd や logFile を持ち回さない', () => {
  // 写し取る時点で落としておけば、本文を組むところで載せようがない
  const w = bare();
  w.observe([{
    ...row(),
    cwd: 'C:\\work\\secret-client',
    logFile: 'C:\\Users\\me\\.claude\\projects\\x\\y.jsonl',
    gitBranch: 'feature/内部案件',
    title: '見せてはいけない指示',
    lastPrompt: 'これも見せてはいけない',
  }], AFTER_BOOT);

  const got = w.takeReady(AFTER_BOOT)[0];
  for (const k of ['cwd', 'logFile', 'gitBranch', 'title', 'lastPrompt']) {
    assert.ok(!(k in got), `${k} が通知の項目に残っている`);
  }
  // 載ってよいのはフォルダ名まで
  assert.equal(got.project, 'claude-deck');
});

// --- 返信待ち（awaiting-reply）と承認待ちの選別 ---
//
// 実測（2026-08-06）で、質問を出しているあいだ tool_use(AskUserQuestion) の行が
// ディスクに書かれないことが分かった。2分8秒の待ちがまるごと awaiting-reply に
// 見えていた。実際に鳴るのはこの経路なので、ここを厚く見る。

/** 返信待ちの行。待っているツールが無いので錨で数える。 */
function idleRow(over = {}) {
  return {
    sessionId: 'sess-a',
    name: 'sandbox-9c',
    project: 'claude-deck',
    state: 'awaiting-reply',
    stateLabel: '返信待ち',
    stateConfident: true,
    idleMs: 130_000,
    waitingFor: null,
    anchorId: 'uuid-turn-1',
    ...over,
  };
}

const IDLE_MS = 120_000;
/** 返信待ちを2分で見る設定。落ち着き待ち（速いほう）は 0 のまま。 */
const slow = (over = {}) =>
  createNotifyWatch({ settleMs: 0, idleSettleMs: IDLE_MS, graceMs: 0, bootAt: T0, ...over });

test('返信待ちの鍵はターンごとの錨から作る', () => {
  assert.equal(keyOf(idleRow()), 'sess-a::turn:uuid-turn-1');
  // ツールの id があるときはそちらが勝つ
  assert.equal(keyOf(row({ id: 'toolu_x', anchorId: 'uuid-turn-1' })), 'sess-a::toolu_x');
});

test('返信待ちは短い落ち着き待ちでは鳴らない', () => {
  const w = slow();
  w.observe([idleRow()], AFTER_BOOT);
  // 速いほう（0ms）で抜けてしまうと、少し考えているだけで鳴る
  w.observe([idleRow()], AFTER_BOOT + 6000);
  assert.deepEqual(w.takeReady(AFTER_BOOT + 6000), []);
  assert.equal(w.stats().pending, 1);
});

test('返信待ちは長い落ち着き待ちを抜けたら鳴る', () => {
  const w = slow();
  w.observe([idleRow()], AFTER_BOOT);
  w.observe([idleRow()], AFTER_BOOT + IDLE_MS);
  const got = w.takeReady(AFTER_BOOT + IDLE_MS);
  assert.equal(got.length, 1);
  assert.equal(got[0].stateLabel, '返信待ち');
  assert.equal(got[0].tool, null);
});

test('返信待ちの途中で返事をしたら鳴らない', () => {
  const w = slow();
  w.observe([idleRow()], AFTER_BOOT);
  // 次のターンに進んだ＝返事をした
  w.observe([{ ...idleRow(), state: 'running' }], AFTER_BOOT + 60_000);
  assert.deepEqual(w.takeReady(AFTER_BOOT + IDLE_MS), []);
  assert.equal(w.stats().vanished, 1);
});

test('返信待ちは 0 分の設定で丸ごと切れる', () => {
  const w = createNotifyWatch({ settleMs: 0, idleSettleMs: 0, graceMs: 0, bootAt: T0 });
  w.observe([idleRow()], AFTER_BOOT);
  w.observe([idleRow()], AFTER_BOOT + 3_600_000);
  assert.deepEqual(w.takeReady(AFTER_BOOT + 3_600_000), []);
});

test('自信の無い返信待ちは鳴らない', () => {
  // 「追記が止まっている」だけが根拠のもの。落ちたセッションと区別がつかない
  const w = slow();
  w.observe([idleRow({ stateConfident: false })], AFTER_BOOT);
  w.observe([idleRow({ stateConfident: false })], AFTER_BOOT + IDLE_MS);
  assert.deepEqual(w.takeReady(AFTER_BOOT + IDLE_MS), []);
});

test('ターンが変われば別の待ちとして数える', () => {
  // 錨を使わずセッション ID だけで鍵を作ると、鍵が生涯1つになって
  // 2回目以降の返信待ちが黙って落ちる
  const w = slow();
  w.observe([idleRow()], AFTER_BOOT);
  w.observe([idleRow()], AFTER_BOOT + IDLE_MS);
  assert.equal(w.takeReady(AFTER_BOOT + IDLE_MS).length, 1);

  const T2 = AFTER_BOOT + 600_000;
  const next = idleRow({ anchorId: 'uuid-turn-2' });
  w.observe([next], T2);
  w.observe([next], T2 + IDLE_MS);
  assert.equal(w.takeReady(T2 + IDLE_MS).length, 1);
});

test('同じターンなら何度見ても1通', () => {
  const w = slow();
  for (let i = 0; i <= 10; i += 1) w.observe([idleRow()], AFTER_BOOT + i * 30_000);
  assert.equal(w.takeReady(AFTER_BOOT + 300_000).length, 1);
  w.observe([idleRow()], AFTER_BOOT + 330_000);
  assert.deepEqual(w.takeReady(AFTER_BOOT + 330_000), []);
});

test('待っている長さは送るときの値になる', () => {
  // 最初に見た瞬間の値のままだと「0分待っています」と嘘を書く
  const w = slow();
  w.observe([idleRow({ idleMs: 1000 })], AFTER_BOOT);
  w.observe([idleRow({ idleMs: 121_000 })], AFTER_BOOT + IDLE_MS);
  assert.equal(w.takeReady(AFTER_BOOT + IDLE_MS)[0].idleMs, 121_000);
});

/** 承認待ちの行。 */
function approvalRow(over = {}) {
  return {
    sessionId: 'sess-b',
    name: 'deck-b7',
    project: 'claude-deck',
    state: 'needs-approval',
    stateLabel: '承認待ち',
    stateConfident: true,
    idleMs: 20_000,
    waitingFor: { id: 'toolu_bash', tool: 'Bash', detail: 'npm run build' },
    byStatus: true,
    ...over,
  };
}

test('承認待ちは登録簿が待ちと言っているときだけ鳴る', () => {
  const w = bare();
  w.observe([approvalRow()], AFTER_BOOT);
  const got = w.takeReady(AFTER_BOOT);
  assert.equal(got.length, 1);
  assert.equal(got[0].tool, 'Bash');
});

test('しきい値だけが根拠の承認待ちは鳴らない', () => {
  // 50秒走る Bash が実測でこの形になった。auto mode で Claude が自分で
  // 承認した分はそもそも止まらないので、こちらを送ると誤報にしかならない
  const w = bare();
  w.observe([approvalRow({ byStatus: false })], AFTER_BOOT);
  w.observe([approvalRow({ byStatus: false })], AFTER_BOOT + 600_000);
  assert.deepEqual(w.takeReady(AFTER_BOOT + 600_000), []);
});

test('byStatus が無い形が来ても鳴らさない', () => {
  // 未知の形で誤報を出すより黙るほうを選ぶ
  const w = bare();
  w.observe([approvalRow({ byStatus: undefined })], AFTER_BOOT);
  assert.deepEqual(w.takeReady(AFTER_BOOT), []);
});
