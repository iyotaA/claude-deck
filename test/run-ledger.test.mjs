/**
 * 台帳と状態機械のテスト。
 *
 * 時刻は全部こちらから渡す。だから待たずに「2分沈黙した」を作れる。
 * `notify/watch.mjs` のテストと同じ組み方。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyStreamLine } from '../src/parse/stream.mjs';
import {
  createRunLedger, isChildDone, isRunOver, mergeRuns, quietFor,
  RUN_STATE_LABELS, RUN_MAX, STALL_MS, ASK_BODY_MAX, PENDING_MAX, PERMISSION_TIMEOUT_MS,
  buildQuestionInput, LIVE_FIELDS, LIVE_ACK_TIMEOUT_MS,
} from '../src/run/ledger.mjs';
import {
  sysInit, sAssistant, sResult, sPermission, sQuestion, sControlResponse, S_ID,
} from './helpers.mjs';

const T = 1_000_000;

/** `buildRunSpec` が返す形のうち、台帳が見るところだけ。 */
function spec(overrides = {}) {
  return {
    sessionId: S_ID,
    cwd: 'C:\\work\\demo',
    prompt: '直して',
    permissionMode: 'plan',
    model: 'claude-opus-5',
    effort: null,
    budgetUsd: 5,
    resume: false,
    args: [],
    ...overrides,
  };
}

/** 行1本を台帳へ流す。 */
function feed(led, runId, line, now) {
  return led.apply(runId, classifyStreamLine(JSON.stringify(line)), now);
}

/** 起こしてから走り出すところまで。多くのテストの前置き。 */
function started(opts = {}) {
  const led = createRunLedger(opts);
  const id = led.add(spec(), T);
  led.setPid(id, 4242);
  return { led, id };
}

test('isRunOver は終わった3つだけを真にする', () => {
  for (const s of ['stopped', 'failed', 'done']) assert.equal(isRunOver(s), true);
  // stopping と switching は終端ではない。**ここを真にすると切り替えが起こし直せなくなる**
  // budget も同じ。真にすると `detach()` が `entry.spec` を捨て、上げて続ける道が消える。
  // needs-permission も偽。**子は生きて答えを待っている**ので、畳むと答えられなくなる
  for (const s of ['starting', 'running', 'waiting', 'stalled', 'stopping', 'switching', 'budget', 'needs-permission']) {
    assert.equal(isRunOver(s), false);
  }
});

test('isChildDone は終わった3つ ＋ 予算切れ', () => {
  // 「もう動かない」（`isRunOver`）と「いま子がいない」（`isChildDone`）は別の話。
  // 混ぜると、予算切れが終端になるか、上限に当たった子が畳まれずに残るかのどちらかになる
  for (const s of ['stopped', 'failed', 'done', 'budget']) assert.equal(isChildDone(s), true);
  for (const s of ['starting', 'running', 'waiting', 'stalled', 'stopping', 'switching', 'needs-permission']) {
    assert.equal(isChildDone(s), false);
  }
});

test('状態の言い方は全部そろっている', () => {
  for (const s of ['starting', 'running', 'waiting', 'stalled', 'budget', 'needs-permission',
    'stopping', 'switching', 'stopped', 'failed', 'done']) {
    assert.equal(typeof RUN_STATE_LABELS[s], 'string');
  }
});

test('起こした直後は starting で、指示文は持たない', () => {
  const led = createRunLedger();
  const id = led.add(spec(), T);
  assert.equal(id, 'r1');

  const [row] = led.rows();
  assert.equal(row.state, 'starting');
  assert.equal(row.stateLabel, '起動中');
  assert.equal(row.sessionId, S_ID);
  assert.equal(row.pid, null);
  assert.equal(row.turns, 0);
  // stdin へ書いたら役目は終わり。台帳に残すと速報と二重に持つことになる
  assert.equal('prompt' in row, false);
  assert.equal('prompt' in led.get(id), false);
});

test('runId は連番。時刻に依らないのでテストが揺れない', () => {
  const led = createRunLedger({ minIntervalMs: 0 });
  assert.equal(led.add(spec(), T), 'r1');
  assert.equal(led.add(spec(), T), 'r2');
  assert.equal(led.add(spec(), T), 'r3');
});

test('子が起きたら running へ', () => {
  const { led, id } = started();
  const [row] = led.rows();
  assert.equal(row.state, 'running');
  assert.equal(row.pid, 4242);
});

test('同時に動かせる本数で断る', () => {
  const led = createRunLedger({ minIntervalMs: 0 });
  for (let i = 0; i < RUN_MAX; i += 1) {
    assert.equal(led.canStart(T).ok, true);
    led.add(spec(), T);
  }
  const no = led.canStart(T);
  assert.equal(no.ok, false);
  assert.match(no.reason, /3 本/);
});

test('終わった run は本数に数えない', () => {
  const led = createRunLedger({ minIntervalMs: 0 });
  const ids = [];
  for (let i = 0; i < RUN_MAX; i += 1) ids.push(led.add(spec(), T));
  assert.equal(led.canStart(T).ok, false);

  led.onExit(ids[0], { code: 0 }, T + 10);
  assert.equal(led.canStart(T + 10).ok, true);
});

test('続けざまの起動は断る', () => {
  const led = createRunLedger({ minIntervalMs: 2000 });
  led.add(spec(), T);
  assert.equal(led.canStart(T + 500).ok, false);
  assert.equal(led.canStart(T + 2000).ok, true);
});

test('時計が巻き戻っても締め出さない', () => {
  const led = createRunLedger({ minIntervalMs: 2000 });
  led.add(spec(), T);
  // 巻き戻った幅のあいだ起動できなくなるのを避ける
  assert.equal(led.canStart(T - 60000).ok, true);
});

test('行が届いたら starting から running へ', () => {
  const led = createRunLedger();
  const id = led.add(spec(), T);
  const evs = feed(led, id, sysInit(), T + 100);

  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'init');
  assert.equal(evs[0].runId, id);
  assert.equal(evs[0].seq, 1);
  assert.equal(evs[0].at, T + 100);
  assert.equal(led.rows()[0].state, 'running');
});

test('result が来たら「あなたの番」になり、往復を数える', () => {
  const { led, id } = started();
  feed(led, id, sResult({ costUSD: 0.4 }), T + 1000);

  const [row] = led.rows();
  assert.equal(row.state, 'waiting');
  assert.equal(row.stateLabel, 'あなたの番');
  assert.equal(row.turns, 1);
  assert.equal(row.reason, null);
  // `num_turns` は累積ではないので、こちらで数える
  assert.equal(led.get(id).costUSD, 0.4);
});

test('往復のたびに turns が増える', () => {
  const { led, id } = started();
  feed(led, id, sResult({ numTurns: 1 }), T + 1000);
  led.markInput(id, T + 2000);
  feed(led, id, sResult({ numTurns: 1 }), T + 3000);
  assert.equal(led.rows()[0].turns, 2);
});

/** 上限に当たった result を1本流す。 */
function exhaust(led, id, now = T + 1000, sessionId = S_ID) {
  return feed(led, id, sResult({
    sessionId,
    subtype: 'error_max_budget_usd',
    isError: true,
    text: null,
    terminal_reason: 'budget_exhausted',
    errors: ['Reached maximum budget ($0.01)'],
  }), now);
}

test('予算超過は budget。失敗にしない（何も失敗していない）', () => {
  const { led, id } = started();
  const evs = exhaust(led, id);

  const [row] = led.rows();
  assert.equal(row.state, 'budget');
  assert.equal(row.stateLabel, '予算切れ');
  // 終端にすると `detach()` が起動指定を捨て、上げて続ける道がその瞬間に消える
  assert.equal(isRunOver(row.state), false);
  // ただし子はもういない（殻の側が畳む）
  assert.equal(isChildDone(row.state), true);
  assert.equal(row.reason, 'Reached maximum budget ($0.01)');
  // 理由が速報にも出る。状態だけ変えて黙らない
  assert.equal(evs.at(-2).kind, 'note');
  assert.equal(evs.at(-2).text, row.reason);
  // 「そのまま送れば続く」を書く。実測で上限は子ごとに数え直すので、上げなくても進む
  assert.match(evs.at(-1).text, /そのまま送れば同じ上限で続きます/);
});

test('予算切れで畳んだ close を異常終了にしない', () => {
  const { led, id } = started();
  exhaust(led, id);
  // 実測で stdin を閉じると code=1 で閉じる。素で落とすと「異常終了しました（code 1）」に化ける
  assert.deepEqual(led.onExit(id, { code: 1 }, T + 1200), []);

  const [row] = led.rows();
  assert.equal(row.state, 'budget');
  assert.equal(row.reason, 'Reached maximum budget ($0.01)');
  assert.equal(row.pid, null);
});

test('予算切れのあいだに届いた行は捨てる', () => {
  const { led, id } = started();
  exhaust(led, id);
  // 実測で system/hook_response が result の後に来ることがある。
  // 通すと「予算切れ」と言った後ろに本文が並ぶ
  assert.deepEqual(feed(led, id, sAssistant('あとから来た行'), T + 1100), []);
  assert.equal(led.rows()[0].state, 'budget');
});

test('予算切れから続きを起こすと理由が落ちる', () => {
  const { led, id } = started();
  exhaust(led, id);
  led.onExit(id, { code: 1 }, T + 1200);

  // そのまま送った側（`restart()`）の経路。`setPid` が先に来る
  assert.equal(led.setPid(id, 9999), true);
  const [row] = led.rows();
  assert.equal(row.state, 'running');
  // 残すと「予算の上限に達しました」が動いている run の理由として出続ける
  assert.equal(row.reason, null);
  assert.equal(row.pid, 9999);
});

test('予算切れへ指示を送ると実行中へ戻る', () => {
  const { led, id } = started();
  exhaust(led, id);
  led.markInput(id, T + 2000);

  const [row] = led.rows();
  assert.equal(row.state, 'running');
  assert.equal(row.reason, null);
});

test('予算切れは切り替えられる。替えた額を言葉にする', () => {
  const { led, id } = started();
  exhaust(led, id);
  led.onExit(id, { code: 1 }, T + 1200);

  const evs = led.markSwitching(id, spec({ budgetUsd: 20 }), T + 2000);
  assert.equal(led.rows()[0].state, 'switching');
  assert.equal(led.rows()[0].budgetUsd, 20);
  assert.match(evs.at(-1).text, /予算を 20 に/);
});

test('外したときは「上限なし」と書く', () => {
  const { led, id } = started();
  const evs = led.markSwitching(id, spec({ budgetUsd: null }), T + 100);
  assert.match(evs.at(-1).text, /予算を上限なしに/);
  assert.equal(led.rows()[0].budgetUsd, null);
});

test('畳む子がいないなら切り替えの旗を立てない', () => {
  const { led, id } = started();
  exhaust(led, id);
  led.onExit(id, { code: 1 }, T + 1200);   // ここで pid が null になる

  led.markSwitching(id, spec({ budgetUsd: 20 }), T + 2000);
  led.setPid(id, 7777);
  // 立てっぱなしにすると、この子が自分で異常終了したときに `onExit` が切り替えと読み、
  // 終端へ落ちないまま `RUN_MAX` の枠を掴み続ける
  led.onExit(id, { code: 1 }, T + 3000);
  assert.equal(led.rows()[0].state, 'failed');
});

test('予算切れを無音にしない', () => {
  const { led, id } = started();
  exhaust(led, id);
  // `tick` が見るのは `running` と `starting` だけ。ここを広げると
  // 上限に当たって待っているものが「出力が…止まっています」に化ける
  assert.deepEqual(led.tick(T + STALL_MS * 2), { changed: [], events: [] });
  assert.equal(led.rows()[0].state, 'budget');
  assert.equal(led.rows()[0].reason, 'Reached maximum budget ($0.01)');
});

test('予算切れは本数の枠を掴んだまま数える', () => {
  const led = createRunLedger({ minIntervalMs: 0 });
  for (let i = 0; i < RUN_MAX; i += 1) {
    // 返る session_id を spec と合わせる。食い違うと台帳が `failed`（終端）にするので、
    // 数えたいものが数えられない
    const sid = `s-${i}`;
    const id = led.add(spec({ sessionId: sid }), T);
    led.setPid(id, 100 + i);
    exhaust(led, id, T + 100, sid);
  }
  // 子はいないが、続きを打てる run として残っている。空いていると数えると
  // 続きを打った瞬間に `RUN_MAX` を超える
  assert.equal(led.canStart(T + 200).ok, false);
});

test('予算超過ではない失敗では止めない。理由だけ残す', () => {
  const { led, id } = started();
  feed(led, id, sResult({
    subtype: 'error_during_execution',
    isError: true,
    text: null,
    terminal_reason: 'なんか知らない語',
    errors: ['うまくいかなかった'],
  }), T + 1000);

  const [row] = led.rows();
  // 知らない終わり方で子を殺すと、動いているセッションを壊すことになる
  assert.equal(row.state, 'waiting');
  assert.equal(row.reason, 'うまくいかなかった');
});

test('別のセッションの行が来たら止める', () => {
  const { led, id } = started();
  const evs = feed(led, id, sysInit({ sessionId: 'よその ID' }), T + 100);

  const [row] = led.rows();
  assert.equal(row.state, 'failed');
  assert.match(row.reason, /セッションID/);
  assert.equal(evs.at(-1).kind, 'note');
});

test('セッション ID は大小を無視して比べる', () => {
  const led = createRunLedger();
  const id = led.add(spec({ sessionId: 'AB-CD' }), T);
  feed(led, id, sysInit({ sessionId: 'ab-cd' }), T + 100);
  assert.equal(led.rows()[0].state, 'running');
});

test('終わった run に遅れて届いた行は捨てる', () => {
  const { led, id } = started();
  led.markStopping(id, T + 100);
  led.onExit(id, { code: 0 }, T + 200);

  const evs = feed(led, id, sAssistant('遅れてきた'), T + 300);
  assert.deepEqual(evs, []);
  assert.equal(led.rows()[0].state, 'stopped');
});

test('指示を送った印は残すが、本文は持たない', () => {
  const { led, id } = started();
  feed(led, id, sResult({}), T + 1000);

  const evs = led.markInput(id, T + 2000);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'note');
  // 本文は --replay-user-messages の戻りで出る。ここで持つと二重になる
  assert.equal(evs[0].text, '指示を送りました');
  assert.equal(led.rows()[0].state, 'running');
});

test('止めるあいだは stopping。嘘の状態を出さない', () => {
  const { led, id } = started();
  led.markStopping(id, T + 100);

  const [row] = led.rows();
  assert.equal(row.state, 'stopping');
  assert.equal(isRunOver(row.state), false);

  led.onExit(id, { code: 1 }, T + 3000);
  // 自分で止めたので、終了コードが 0 でなくても失敗ではない
  assert.equal(led.rows()[0].state, 'stopped');
});

/*
 * ------------------------------------------------------------ 切り替え
 *
 * 畳んでから同じ `sessionId` で起こし直すので、途中の状態が終端に落ちると
 * **二度と起こし直せない。** stopping と分けてあるのはそのため。
 */

test('切り替えのあいだは switching。終端にしない', () => {
  const { led, id } = started();
  const evs = led.markSwitching(id, spec({ model: 'claude-sonnet-5' }), T + 100);

  const [row] = led.rows();
  assert.equal(row.state, 'switching');
  assert.equal(isRunOver(row.state), false);
  assert.equal(row.model, 'claude-sonnet-5');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'note');
});

test('何を替えたかを1行に書く。外したものは「指定なし」', () => {
  const { led, id } = started();
  // 起こしたときは model: 'claude-opus-5' / effort: null（spec() の既定）
  const [ev] = led.markSwitching(id, spec({ model: null, effort: 'high' }), T + 100);
  assert.equal(ev.text, 'モデルを 指定なし に、思考量を high に切り替えています');
});

test('切り替えた先は必ず続き（resume）になる', () => {
  const { led, id } = started();
  assert.equal(led.rows()[0].resume, false);

  led.markSwitching(id, spec({ model: 'claude-sonnet-5', resume: true }), T + 100);
  // 画面の「続き」の印もここで合わせる。spec の resume を写すのではなく必ず真
  assert.equal(led.rows()[0].resume, true);
});

test('切り替えのために畳んだ close は終端にしない', () => {
  const { led, id } = started();
  led.markSwitching(id, spec({ model: 'claude-sonnet-5' }), T + 100);
  led.onExit(id, { code: 1 }, T + 200);

  const [row] = led.rows();
  // ここで stopped や failed に落ちると、新しい子を起こしても setPid が効かない
  assert.equal(row.state, 'switching');
  assert.equal(row.pid, null);
});

test('切り替えのあと setPid で running へ戻る', () => {
  const { led, id } = started();
  led.markSwitching(id, spec({ model: 'claude-sonnet-5' }), T + 100);
  led.onExit(id, { code: 0 }, T + 200);

  assert.equal(led.setPid(id, 7777), true);
  const [row] = led.rows();
  assert.equal(row.state, 'running');
  assert.equal(row.pid, 7777);
});

test('切り替えの旗は1回で下ろす。次の close は普通に読む', () => {
  const { led, id } = started();
  led.markSwitching(id, spec({ model: 'claude-sonnet-5' }), T + 100);
  led.onExit(id, { code: 0 }, T + 200);
  led.setPid(id, 7777);

  // 起こし直した子が閉じたぶん。ここをまた切り替えと読むと永久に終われない
  led.onExit(id, { code: 0 }, T + 9000);
  assert.equal(led.rows()[0].state, 'done');
});

test('切り替えの最中に止めろと言われたら、止めるほうが勝つ', () => {
  const { led, id } = started();
  led.markSwitching(id, spec({ model: 'claude-sonnet-5' }), T + 100);
  led.markStopping(id, T + 150);
  led.onExit(id, { code: 1 }, T + 200);

  // onExit が switchRequested を先に見ると、止めろと言われたのに切り替え中へ戻る
  assert.equal(led.rows()[0].state, 'stopped');
});

test('終わった run は切り替えられない', () => {
  const { led, id } = started();
  led.onExit(id, { code: 0 }, T + 1000);

  assert.deepEqual(led.markSwitching(id, spec({ model: 'claude-sonnet-5' }), T + 2000), []);
  const [row] = led.rows();
  assert.equal(row.state, 'done');
  assert.equal(row.model, 'claude-opus-5', '終わった run の中身は書き換えない');
});

test('知らない runId の切り替えでも落ちない', () => {
  const led = createRunLedger();
  assert.deepEqual(led.markSwitching('r99', spec(), T), []);
});

test('waiting のまま 0 で閉じたら終わりにせず perTurn を覚える', () => {
  const { led, id } = started();
  feed(led, id, sResult({}), T + 1000);
  led.onExit(id, { code: 0 }, T + 1100);

  const [row] = led.rows();
  // 1往復ごとに閉じる作りに変わっても、続きを打てる形を保つ
  assert.equal(row.state, 'waiting');
  assert.equal(row.perTurn, true);
  assert.equal(row.pid, null);
  assert.equal(row.exitCode, 0);
});

test('perTurn の run は起こし直せる', () => {
  const { led, id } = started();
  feed(led, id, sResult({}), T + 1000);
  led.onExit(id, { code: 0 }, T + 1100);

  led.markInput(id, T + 5000);
  led.setPid(id, 5151);
  const [row] = led.rows();
  assert.equal(row.state, 'running');
  assert.equal(row.pid, 5151);
});

test('走っている途中で 0 で閉じたら done', () => {
  const { led, id } = started();
  led.onExit(id, { code: 0 }, T + 1000);
  assert.equal(led.rows()[0].state, 'done');
});

test('0 以外で閉じたら failed。理由に終了コードを書く', () => {
  const { led, id } = started();
  led.onExit(id, { code: 3 }, T + 1000);

  const [row] = led.rows();
  assert.equal(row.state, 'failed');
  assert.match(row.reason, /code 3/);
  assert.equal(row.exitCode, 3);
  assert.equal(row.pid, null);
});

test('signal で落ちたときは signal を書く', () => {
  const { led, id } = started();
  led.onExit(id, { code: null, signal: 'SIGKILL' }, T + 1000);
  assert.match(led.rows()[0].reason, /SIGKILL/);
  assert.equal(led.rows()[0].exitCode, null);
});

test('既に終わっている run の状態は上書きしない', () => {
  const { led, id } = started();
  led.fail(id, '起こせませんでした', T + 100);
  led.onExit(id, { code: 0 }, T + 200);

  const [row] = led.rows();
  assert.equal(row.state, 'failed');
  assert.equal(row.reason, '起こせませんでした');
  // 状態は動かさないが、終了コードは記録する
  assert.equal(row.exitCode, 0);
});

test('起こせなかったときは failed', () => {
  const led = createRunLedger();
  const id = led.add(spec(), T);
  const evs = led.fail(id, 'claude.exe が見つかりません', T + 10);

  assert.equal(led.rows()[0].state, 'failed');
  assert.equal(evs[0].text, 'claude.exe が見つかりません');
});

test('沈黙が続いたら stalled にする', () => {
  const { led, id } = started();
  feed(led, id, sAssistant('うん'), T + 1000);

  assert.deepEqual(led.tick(T + 1000 + STALL_MS - 1).changed, []);

  const out = led.tick(T + 1000 + STALL_MS);
  assert.deepEqual(out.changed, [id]);
  assert.equal(out.events[0].kind, 'note');
  assert.equal(led.rows()[0].state, 'stalled');
});

test('1行も来ていない run は起こした時刻から測る', () => {
  const { led, id } = started();
  assert.deepEqual(led.tick(T + STALL_MS).changed, [id]);
});

test('「あなたの番」は沈黙が正常なので stalled にしない', () => {
  const { led, id } = started();
  feed(led, id, sResult({}), T + 1000);
  assert.deepEqual(led.tick(T + 1000 + STALL_MS * 10).changed, []);
  assert.equal(led.rows()[0].state, 'waiting');
});

test('stalled でも行が届けば running へ戻る', () => {
  const { led, id } = started();
  led.tick(T + STALL_MS);
  assert.equal(led.rows()[0].state, 'stalled');

  feed(led, id, sAssistant('戻ってきた'), T + STALL_MS + 10);
  assert.equal(led.rows()[0].state, 'running');
});

test('指示を送ると沈黙の時計を仕切り直す', () => {
  const { led, id } = started();
  feed(led, id, sResult({}), T + 1000);
  led.markInput(id, T + 100000);
  // 待たせていた時間ぶんで即 stalled にならないこと
  assert.deepEqual(led.tick(T + 100000 + STALL_MS - 1).changed, []);
});

test('無音の速報は測ったことだけを言う', () => {
  const { led, id } = started();
  feed(led, id, sAssistant('うん'), T + 1000);

  const out = led.tick(T + 1000 + STALL_MS);
  assert.equal(out.events[0].text, '出力が2分止まっています。圧縮や長いコマンドの最中かもしれません');
  // 「応答なし」は診断。実測（2026-08-23）で5回とも圧縮の最中の、正常な無音だった
  assert.ok(!out.events[0].text.includes('応答'));
  // 一覧の理由にも同じ文が乗る（既定の「この画面から起こしたセッション」では何も分からない）
  assert.equal(led.rows()[0].reason, '出力が2分止まっています。圧縮や長いコマンドの最中かもしれません');
});

test('短い stallMs でも「0分」と書かない', () => {
  const { led } = started({ stallMs: 5000 });
  const out = led.tick(T + 5000);
  assert.equal(out.events[0].text, '出力が5秒止まっています。圧縮や長いコマンドの最中かもしれません');
});

test('行が届けば無音の理由も落ちる', () => {
  const { led, id } = started();
  led.tick(T + STALL_MS);
  assert.equal(led.rows()[0].reason, '出力が2分止まっています。圧縮や長いコマンドの最中かもしれません');

  feed(led, id, sAssistant('戻ってきた'), T + STALL_MS + 10);
  // 動いているのに理由が「止まっています」のままだと、直したことにならない
  assert.equal(led.rows()[0].reason, null);
});

test('指示を送れば無音の理由も落ちる', () => {
  const { led, id } = started();
  led.tick(T + STALL_MS);
  led.markInput(id, T + STALL_MS + 10);

  assert.equal(led.rows()[0].state, 'running');
  assert.equal(led.rows()[0].reason, null);
});

test('無音のまま止めた理由を、止まった理由として残さない', () => {
  const { led, id } = started();
  led.tick(T + STALL_MS);
  led.markStopping(id, T + STALL_MS + 10);

  // 実行パネルは `理由` の行をそのまま出すので、残すと「止めた結果」に見える
  assert.equal(led.rows()[0].reason, null);
});

test('無音のまま切り替えても理由を持ち越さない', () => {
  const { led, id } = started();
  led.tick(T + STALL_MS);
  led.markSwitching(id, spec({ model: 'claude-sonnet-5' }), T + STALL_MS + 10);

  assert.equal(led.rows()[0].reason, null);
});

test('「あなたの番」の理由は無音の後始末で消さない', () => {
  const { led, id } = started();
  feed(led, id, sResult({
    subtype: 'error_during_execution',
    isError: true,
    text: null,
    errors: ['うまくいかなかった'],
  }), T + 1000);
  assert.equal(led.rows()[0].reason, 'うまくいかなかった');

  // 遅れて届いた行では消さない。落とすのは `stalled` のときだけ
  feed(led, id, sAssistant('あとがき'), T + 2000);
  assert.equal(led.rows()[0].reason, 'うまくいかなかった');
});

test('無音の長さは分で言い、1分未満だけ秒で言う', () => {
  assert.equal(quietFor(STALL_MS), '2分');
  assert.equal(quietFor(121000), '2分');
  assert.equal(quietFor(60000), '1分');
  // 切り上げると 59.9秒が「60秒」になり、すぐ上の「1分」と2つの言い方が並ぶ
  assert.equal(quietFor(59999), '59秒');
  assert.equal(quietFor(3000), '3秒');
  // 0 でも「0秒」とは書かない（測れた以上、何かは経っている）
  assert.equal(quietFor(0), '1秒');
  // 数でないものが来たら数を書かない（0 と不明を分けるのと同じ扱い）
  for (const bad of [NaN, Infinity, -1, null, undefined, '2分']) {
    assert.equal(quietFor(bad), 'しばらく');
  }
});

test('一覧の行に毎秒動く値を載せない', () => {
  const { led, id } = started();
  feed(led, id, sAssistant('うん'), T + 1000);
  feed(led, id, sResult({ costUSD: 0.4 }), T + 2000);

  const [row] = led.rows();
  // ここに載せると refresh() の差分判定を素通りして毎秒 push になる
  for (const key of ['lastLineAt', 'counts', 'costUSD', 'idleMs', 'events']) {
    assert.equal(key in row, false, `${key} を rows() に載せてはいけない`);
  }
  // 予算は毎秒動かない（切り替えたときだけ変わる）ので載せてよい。
  // ここに無いと実行パネルの「替えて続ける」が欄を埋められない
  assert.equal(row.budgetUsd, 5);
  // 詳しい値は詳細を開いたときだけ引く側にある
  const d = led.get(id);
  assert.equal(d.lastLineAt, T + 2000);
  assert.equal(d.costUSD, 0.4);
  assert.equal(d.counts.lines, 2);
});

test('読めなかった行も数える', () => {
  const { led, id } = started();
  led.apply(id, classifyStreamLine('{壊れてる'), T + 100);
  const d = led.get(id);
  assert.equal(d.counts.lines, 1);
  assert.equal(d.counts.broken, 1);
});

test('速報は seq が増える一本の並びになる', () => {
  const led = createRunLedger({ minIntervalMs: 0 });
  const a = led.add(spec({ sessionId: 'a' }), T);
  const b = led.add(spec({ sessionId: 'b' }), T);
  led.setPid(a, 1);
  led.setPid(b, 2);

  feed(led, a, sysInit({ sessionId: 'a' }), T + 10);
  feed(led, b, sysInit({ sessionId: 'b' }), T + 20);
  feed(led, a, sAssistant('あ', { sessionId: 'a' }), T + 30);

  const all = led.events();
  assert.deepEqual(all.events.map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(all.events.map((e) => e.runId), [a, b, a]);
  assert.equal(all.nextSeq, 3);
  assert.equal(all.missed, 0);
});

test('続きだけを取り直せる', () => {
  const { led, id } = started();
  feed(led, id, sysInit(), T + 10);
  feed(led, id, sAssistant('あ'), T + 20);
  feed(led, id, sAssistant('い'), T + 30);

  const out = led.events(2);
  assert.deepEqual(out.events.map((e) => e.seq), [3]);
  assert.equal(out.missed, 0);
});

test('溢れて渡せなかったぶんは正直に数える', () => {
  const { led, id } = started({ eventMax: 3 });
  for (let i = 0; i < 5; i += 1) led.markInput(id, T + i);

  const all = led.events();
  assert.equal(all.events.length, 3);
  assert.deepEqual(all.events.map((e) => e.seq), [3, 4, 5]);
  assert.equal(led.stats().dropped, 2);

  // seq 2 は落ちている。黙って詰めない
  assert.equal(led.events(1).missed, 1);
  assert.equal(led.events(3).missed, 0);
});

test('終わった run は消せる。動いているものは消せない', () => {
  const { led, id } = started();
  assert.equal(led.remove(id), false);

  led.onExit(id, { code: 0 }, T + 100);
  assert.equal(led.remove(id), true);
  assert.equal(led.rows().length, 0);
});

test('終わった run が溜まりすぎたら古いものから落とす', () => {
  const led = createRunLedger({ minIntervalMs: 0, historyMax: 2 });
  for (let i = 0; i < 4; i += 1) {
    const id = led.add(spec(), T + i);
    led.onExit(id, { code: 0 }, T + i);
  }
  led.add(spec(), T + 100);

  const ids = led.rows().map((r) => r.runId);
  assert.deepEqual(ids, ['r3', 'r4', 'r5']);
});

test('様子をまとめて出せる', () => {
  const led = createRunLedger({ minIntervalMs: 0 });
  const a = led.add(spec(), T);
  led.add(spec(), T);
  led.onExit(a, { code: 0 }, T + 10);

  assert.deepEqual(led.stats(), { active: 1, total: 2, seq: 1, dropped: 0 });
});

test('知らない runId を渡しても落ちない', () => {
  const led = createRunLedger();
  assert.equal(led.setPid('r99', 1), false);
  assert.deepEqual(led.apply('r99', classifyStreamLine('{}'), T), []);
  assert.deepEqual(led.markInput('r99', T), []);
  assert.deepEqual(led.markStopping('r99', T), []);
  assert.deepEqual(led.fail('r99', 'だめ', T), []);
  assert.deepEqual(led.onExit('r99', { code: 0 }, T), []);
  assert.equal(led.get('r99'), null);
  assert.equal(led.remove('r99'), false);
});

/* ------------------------------------------------------------ 一覧への合流 */

/**
 * 一覧の行のうち、`mergeRuns` が触るところだけ。
 *
 * `deriveState` が headless のセッションに付けがちな姿を初期値にしてある
 * （登録簿に `status` のキーが無いので、走っている最中でも「返信待ち」に見える）。
 */
function listRow(overrides = {}) {
  return {
    sessionId: S_ID,
    state: 'awaiting-reply',
    stateLabel: '返信待ち',
    ball: 'master',
    alive: false,
    pid: null,
    idleMs: 5000,
    lastActivityAt: T,
    waitingFor: { tool: 'Bash', detail: null },
    stateReason: '応答を返し終えて停止',
    stateConfident: true,
    statusRaw: null,
    anchorId: 'u-9',
    byStatus: false,
    title: 'ログから読んだ見出し',
    ...overrides,
  };
}

test('動いている run を重ねると、一覧でも実行中になる', () => {
  const { led, id } = started();
  feed(led, id, sAssistant('やってる'), T + 1000);

  const [row] = mergeRuns([listRow()], led.rows(), T + 2000);
  assert.equal(row.state, 'running');
  assert.equal(row.ball, 'claude');
  assert.equal(row.alive, true);
  assert.equal(row.pid, 4242);
  assert.equal(row.origin, 'deck');
  assert.equal(row.run.runId, id);
  // 画面に出すのは run の実態のほう。写しは並び順と色のためだけのもの
  assert.equal(row.stateLabel, '実行中');
  // 台帳が正なので、ログの末尾から読んだ dangling は伏せる
  assert.equal(row.waitingFor, null);
  assert.equal(row.stateConfident, true);
  // ログから読めているものは消さない
  assert.equal(row.title, 'ログから読んだ見出し');
});

test('切り替え中も一覧では実行中の位置に置く', () => {
  const { led, id } = started();
  led.markSwitching(id, spec({ model: 'claude-sonnet-5' }), T + 100);
  // 古い子を畳んだ直後。新しい子はまだ起きていないので pid が無い
  led.onExit(id, { code: 0 }, T + 200);

  const [row] = mergeRuns([listRow()], led.rows(), T + 300);
  // switching を写さずに素で入れると STATE_RANK に無く、一覧の末尾へ沈む
  assert.equal(row.state, 'running');
  assert.equal(row.ball, 'claude');
  assert.equal(row.alive, true);
  // 画面に出す言い方は run の実態のまま
  assert.equal(row.stateLabel, '切り替え中');
});

test('あなたの番は返信待ちへ写す。ラベルは run の言い方のまま', () => {
  const { led, id } = started();
  feed(led, id, sResult({}), T + 1000);

  const [row] = mergeRuns([listRow({ state: 'running' })], led.rows(), T + 2000);
  assert.equal(row.state, 'awaiting-reply');
  assert.equal(row.ball, 'master');
  assert.equal(row.stateLabel, 'あなたの番');
});

test('無音を不明の位置へ沈めない', () => {
  const { led } = started();
  led.tick(T + STALL_MS);

  const [row] = mergeRuns([listRow()], led.rows(), T + STALL_MS);
  // unknown（rank 4）にすると一覧の下に埋もれる。人が見に行くべきものなので上に出す
  assert.equal(row.state, 'awaiting-reply');
  assert.equal(row.ball, 'master');
  assert.equal(row.stateLabel, '無音');
});

test('予算切れも一覧では「あなたの番」の位置', () => {
  const { led, id } = started();
  exhaust(led, id);

  const [row] = mergeRuns([listRow({ state: 'running' })], led.rows(), T + 2000);
  // unknown（rank 4）に沈めると、上げるか止めるかを決める人が気づけない
  assert.equal(row.state, 'awaiting-reply');
  assert.equal(row.ball, 'master');
  assert.equal(row.stateLabel, '予算切れ');
  // 終端ではないので生きている側に置く。続きは実行パネルから打つ
  assert.equal(row.alive, true);
});

test('終わった run は状態を上書きしない', () => {
  const { led, id } = started();
  led.onExit(id, { code: 0 }, T + 100);

  const [row] = mergeRuns([listRow()], led.rows(), T + 200);
  // 終わっていれば会話ログのほうが正しい。載せるのは「この画面から起こした」事実だけ
  assert.equal(row.state, 'awaiting-reply');
  assert.equal(row.stateLabel, '返信待ち');
  assert.equal(row.alive, false);
  assert.deepEqual(row.waitingFor, { tool: 'Bash', detail: null });
  assert.equal(row.origin, 'deck');
  assert.equal(row.run.runId, id);
});

test('会話ログがまだ無い run は行を合成して足す', () => {
  const { led, id } = started();

  const rows = mergeRuns([listRow({ sessionId: 'ほかの人' })], led.rows(), T + 3000);
  assert.equal(rows.length, 2);

  const row = rows[1];
  assert.equal(row.sessionId, S_ID);
  assert.equal(row.state, 'running');
  assert.equal(row.alive, true);
  assert.equal(row.origin, 'deck');
  assert.equal(row.project, 'demo');
  assert.equal(row.idleMs, 3000);
  assert.equal(row.lastActivityAt, T);
  // 通知の鍵に混ざる値。null だと鍵が生涯1つになり、2回目以降が黙って落ちる
  assert.equal(row.anchorId, id);
  // 稼働中は中身が薄くても出す、と listSessions が決めている
  assert.equal(row.substantive, true);
});

test('会話ログが無いまま終わった run は足さない', () => {
  const { led, id } = started();
  led.fail(id, 'claude.exe が見つかりません', T + 10);

  // 足すと、書庫にも詳細にも出せない幽霊行が履歴の数だけ一覧に残る
  assert.deepEqual(mergeRuns([], led.rows(), T + 20), []);
});

test('同じセッションで2本あるなら、後から起こしたほうを採る', () => {
  const led = createRunLedger({ minIntervalMs: 0 });
  const a = led.add(spec(), T);
  led.onExit(a, { code: 0 }, T + 10);
  const b = led.add(spec({ resume: true }), T + 20);
  led.setPid(b, 7);

  const [row] = mergeRuns([listRow()], led.rows(), T + 30);
  assert.equal(row.run.runId, b);
  assert.equal(row.alive, true);
});

test('合流した行に毎秒動く値を載せない', () => {
  const led = createRunLedger({ minIntervalMs: 0 });
  const a = led.add(spec(), T);                          // 一覧に行がある側（重ねる）
  const b = led.add(spec({ sessionId: 'まだログ無し' }), T); // 行が無い側（合成する）
  led.setPid(a, 1);
  led.setPid(b, 2);
  feed(led, a, sAssistant('うん'), T + 1000);
  feed(led, a, sResult({ costUSD: 0.4 }), T + 2000);

  // `refresh()` の差分判定と同じ形で比べる。ここが動くと内容が同じでも毎秒 push になる
  const at = (now) => JSON.stringify(
    mergeRuns([listRow()], led.rows(), now)
      .map((r) => ({ ...r, idleMs: undefined, lastActivityAt: undefined })),
  );
  assert.equal(at(T + 3000), at(T + 600000));
});

test('台帳が空でも壊さない', () => {
  const rows = [listRow()];
  assert.equal(mergeRuns(rows, [], T), rows);
  assert.equal(mergeRuns(rows, null, T), rows);
  assert.deepEqual(mergeRuns(null, [], T), []);
});

/*
 * 許可要求（段1）。
 *
 * ここが台帳の新しい分岐の全部。**答えられないまま止まったプロセスを残さない**ことが
 * この節の目的なので、逃げ道（時間切れ・子の死・止めると決めたあと）を厚めに見る。
 */

/** 起こして、許可要求を1件受けたところまで。 */
function asked(opts = {}) {
  const { led, id } = started(opts);
  feed(led, id, sPermission({ requestId: 'p1' }), T + 1000);
  return { led, id };
}

test('要求が来たら許可待ちになる。ただし1件も送らない', () => {
  const { led, id } = asked();

  const [row] = led.rows();
  assert.equal(row.state, 'needs-permission');
  assert.equal(row.stateLabel, '許可待ち');
  assert.equal(row.asks.length, 1);
  assert.equal(row.asks[0].id, 'p1');
  assert.equal(row.asks[0].kind, 'tool');
  assert.equal(row.asks[0].tool, 'Bash');
  assert.equal(row.asks[0].at, T + 1000);
  assert.equal(row.asks[0].detail, 'ls');
  // **自動で許可しないことの番人。** 人が答えるまで意図は1つも積まれない
  assert.deepEqual(led.takeOutbox(), []);
  assert.equal(led.get(id).counts.lines, 1, '行が届いたことは数える');
});

test('聞かれ方は3つに分かれて行に載る', () => {
  const { led, id } = started();
  feed(led, id, sPermission({ requestId: 'a', toolName: 'ExitPlanMode', input: { plan: '# やること' } }), T + 10);
  feed(led, id, sQuestion([{ question: 'どっち？', options: [{ label: 'あ' }] }], { requestId: 'b' }), T + 20);
  feed(led, id, sPermission({ requestId: 'c', toolName: 'Write', input: { file_path: 'a.txt' } }), T + 30);

  // 状態は1つ（needs-permission）だけ。違いはここに持たせて、画面が見出しを変える
  assert.deepEqual(led.rows()[0].asks.map((a) => a.kind), ['plan', 'question', 'tool']);
  assert.equal(led.rows()[0].state, 'needs-permission');
});

test('行に載る要求は原文を持たない', () => {
  const { led, id } = started();
  const content = 'x'.repeat(200_000);
  feed(led, id, sPermission({ toolName: 'Write', input: { file_path: 'a.txt', content } }), T + 10);

  const [ask] = led.rows()[0].asks;
  // 行は押し出しのたびに JSON へ焼かれる。原文を載せると毎回そのぶんを文字列化することになる
  assert.equal('input' in ask, false);
  // 読める形には畳んである（画面がそのまま出す）。1つの値に枠を使い切らせない
  assert.ok(ask.body.includes('file_path: a.txt'));
  assert.ok(ask.body.length < ASK_BODY_MAX + 100);
  assert.ok(ask.body.endsWith('…（以下省略）'));
});

test('プランの本文は Markdown のまま持つ', () => {
  const { led, id } = started();
  feed(led, id, sPermission({ toolName: 'ExitPlanMode', input: { plan: '# やること\n\n- 直す' } }), T + 10);
  // 画面が mdView で描くので、改行も見出しの記号もそのまま渡す
  assert.equal(led.rows()[0].asks[0].body, '# やること\n\n- 直す');
});

test('質問は選択肢を機械が読める形で持つ', () => {
  const { led, id } = started();
  feed(led, id, sQuestion([{
    question: 'どっちで進める？',
    header: '進め方',
    options: [{ label: 'いますぐ', description: '雑でよい' }, { label: 'あとで' }],
  }]), T + 10);

  const ask = led.rows()[0].asks[0];
  // **`body` と `questions` はどちらか片方だけ。** 同じ中身を2回載せない
  assert.equal(ask.body, null);
  assert.deepEqual(ask.questions, [{
    key: 0,
    question: 'どっちで進める？',
    header: '進め方',
    multiSelect: false,
    // 説明が無いものは null のまま持つ（空文字に丸めない）
    options: [
      { label: 'いますぐ', description: '雑でよい' },
      { label: 'あとで', description: null },
    ],
  }]);
});

test('質問でないものは questions を持たない', () => {
  const { led, id } = started();
  feed(led, id, sPermission({ toolName: 'Bash', input: { command: 'ls' } }), T + 10);
  const ask = led.rows()[0].asks[0];
  assert.equal(ask.questions, null);
  assert.equal(typeof ask.body, 'string');
});

test('選択肢の形が読めない質問は本文に落ちる', () => {
  // 版が上がって questions の形が変わっても、段1と同じ「本文＋断る」のカードにはなる
  const { led, id } = started();
  feed(led, id, sPermission({ toolName: 'AskUserQuestion', input: { prompt: 'どうする？' } }), T + 10);
  const ask = led.rows()[0].asks[0];
  assert.equal(ask.questions, null);
  assert.equal(typeof ask.body, 'string');
});

test('答えたら消えて走り出す', () => {
  const { led, id } = asked();
  const res = led.answer(id, 'p1', { behavior: 'allow' }, T + 2000);
  assert.equal(res.ok, true);
  assert.equal(res.events.length, 1);
  assert.equal(res.events[0].kind, 'note');

  const [row] = led.rows();
  assert.equal(row.state, 'running');
  assert.deepEqual(row.asks, []);

  assert.deepEqual(led.takeOutbox(), [{
    runId: id, kind: 'permission-response', requestId: 'p1', decision: { behavior: 'allow' },
  }]);
});

test('1件でも残っていれば許可待ちのまま', () => {
  // 並列のツール呼び出しではまとめて来る。1件答えただけで走り出したことにしない
  const { led, id } = started();
  feed(led, id, sPermission({ requestId: 'a' }), T + 10);
  feed(led, id, sPermission({ requestId: 'b' }), T + 20);

  led.answer(id, 'a', { behavior: 'allow' }, T + 30);
  assert.equal(led.rows()[0].state, 'needs-permission');
  led.answer(id, 'b', { behavior: 'allow' }, T + 40);
  assert.equal(led.rows()[0].state, 'running');
});

test('答えたら沈黙の時計を戻す', () => {
  // 戻さないと、待たせたぶんがそのまま無音として数えられて、答えた直後に stalled へ落ちる
  const { led, id } = asked();
  led.answer(id, 'p1', { behavior: 'allow' }, T + 10 * STALL_MS);
  assert.deepEqual(led.tick(T + 10 * STALL_MS + 1000).changed, []);
  assert.equal(led.rows()[0].state, 'running');
});

test('取り出したら空になる', () => {
  // 二重に渡すと、同じ要求へ2回答えることになる。向こうがどう転ぶか分からない
  const { led, id } = asked();
  led.answer(id, 'p1', { behavior: 'allow' }, T + 2000);
  assert.equal(led.takeOutbox().length, 1);
  assert.deepEqual(led.takeOutbox(), [], '2回目は空');
});

test('同じ要求に2回答えたら断る（別の窓で答えられた）', () => {
  // 2つのタブから同時に押したとき、片方に「別の窓で答えられました」と出すため
  const { led, id } = asked();
  assert.equal(led.answer(id, 'p1', { behavior: 'allow' }, T + 10).ok, true);
  const again = led.answer(id, 'p1', { behavior: 'deny' }, T + 20);
  assert.equal(again.ok, false);
  assert.equal(again.code, 'answered');
  assert.equal(led.takeOutbox().length, 1, '2通目は積まれない');
});

test('断り方の分かれ目', () => {
  const { led, id } = asked();
  assert.equal(led.answer('しらない', 'p1', { behavior: 'allow' }, T).code, 'no-run');
  assert.equal(led.answer(id, '', { behavior: 'allow' }, T).code, 'no-request');
  // 番号はあるが、その要求がもう無い。run 不明とは分けて返す（2つのタブで同時に押したとき）
  assert.equal(led.answer(id, 'しらない', { behavior: 'allow' }, T).code, 'answered');
  assert.equal(led.answer(id, 'p1', { behavior: 'たぶん' }, T).code, 'bad');
  assert.equal(led.answer(id, 'p1', null, T).code, 'bad');
});

test('子がいなくなった run には答えられない', () => {
  const { led, id } = asked();
  led.onExit(id, { code: 0 }, T + 2000);
  const res = led.answer(id, 'p1', { behavior: 'allow' }, T + 3000);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'over');
});

test('子が死んだら要求ごと捨てる。書く先が無いので積まない', () => {
  const { led, id } = asked();
  led.onExit(id, { code: 1 }, T + 2000);
  assert.deepEqual(led.rows()[0].asks, []);
  assert.deepEqual(led.takeOutbox(), []);
});

test('起こせなかったときも要求を抱えたままにしない', () => {
  const { led, id } = asked();
  led.fail(id, '書き込みに失敗しました', T + 2000);
  assert.deepEqual(led.rows()[0].asks, []);
  assert.deepEqual(led.takeOutbox(), []);
});

test('止めると決めたあとに来た要求は、その場で断る', () => {
  // 抱えると「止めたのに許可待ちが出ている」になる。答えても意味が無い
  const { led, id } = started();
  led.markStopping(id, T + 10);
  feed(led, id, sPermission({ requestId: 'p1' }), T + 20);

  assert.deepEqual(led.rows()[0].asks, []);
  const [out] = led.takeOutbox();
  assert.equal(out.kind, 'permission-response');
  assert.equal(out.requestId, 'p1');
  assert.equal(out.decision.behavior, 'deny');
});

test('抱えられる数を超えたら即座に断る', () => {
  // 放っておくと詰まる。断れば CLI 側が次の手を探せる
  const { led, id } = started();
  for (let i = 0; i < PENDING_MAX + 2; i += 1) {
    feed(led, id, sPermission({ requestId: `p${i}` }), T + 10 + i);
  }
  assert.equal(led.rows()[0].asks.length, PENDING_MAX);

  const out = led.takeOutbox();
  assert.equal(out.length, 2);
  assert.ok(out.every((o) => o.decision.behavior === 'deny'));
});

test('抱えられる数の既定は 8', () => {
  assert.equal(PENDING_MAX, 8);
});

test('同じ要求が二度来ても上書きしない', () => {
  // 上書きすると at が動いて、時間切れの時計が伸び続ける
  const { led, id } = started();
  feed(led, id, sPermission({ requestId: 'p1' }), T + 10);
  feed(led, id, sPermission({ requestId: 'p1' }), T + 5000);

  assert.equal(led.rows()[0].asks.length, 1);
  assert.equal(led.rows()[0].asks[0].at, T + 10);
});

test('答えが無いまま時間切れになったら断って、あなたの番へ落とす', () => {
  const { led, id } = asked();
  const late = T + 1000 + PERMISSION_TIMEOUT_MS + 1;
  const { changed, events } = led.tick(late);

  assert.deepEqual(changed, [id]);
  assert.equal(led.rows()[0].state, 'waiting');
  assert.deepEqual(led.rows()[0].asks, []);

  const [out] = led.takeOutbox();
  assert.equal(out.decision.behavior, 'deny');
  assert.ok(out.decision.message.includes('答え'), `理由が測ったことになっていない: ${out.decision.message}`);
  assert.ok(events.some((e) => e.kind === 'note'));
});

test('時間切れのあとすぐ無音に落とさない', () => {
  // lastLineAt を戻さないと、待たせたぶんがそのまま無音として数えられる
  const { led, id } = asked();
  const late = T + 1000 + PERMISSION_TIMEOUT_MS + 1;
  led.tick(late);
  assert.deepEqual(led.tick(late + 1000).changed, []);
  assert.equal(led.rows()[0].state, 'waiting');
});

test('時間切れは要求ごとに測る', () => {
  const { led, id } = started();
  feed(led, id, sPermission({ requestId: 'a' }), T + 1000);
  feed(led, id, sPermission({ requestId: 'b' }), T + 1000 + PERMISSION_TIMEOUT_MS);

  led.tick(T + 1000 + PERMISSION_TIMEOUT_MS + 1);
  assert.deepEqual(led.rows()[0].asks.map((x) => x.id), ['b'], '新しいほうは残る');
  assert.equal(led.rows()[0].state, 'needs-permission');
});

test('待つ長さの既定は10分', () => {
  // STALL_MS（2分）より十分長く、Slack で気づいて戻ってこられる長さ
  assert.equal(PERMISSION_TIMEOUT_MS, 600000);
  assert.ok(PERMISSION_TIMEOUT_MS > STALL_MS);
});

test('許可待ちの無音は無音にしない', () => {
  // 人を待っているだけなので正常。stalled にすると通知が鳴りっぱなしになる
  const { led, id } = asked();
  const { changed } = led.tick(T + 1000 + STALL_MS + 1);
  assert.deepEqual(changed, []);
  assert.equal(led.rows()[0].state, 'needs-permission');
});

test('扱えない要求にもエラーで答える', () => {
  // 返さないとその子は永久に待つ。「未知の形で落ちない」を「詰まらない」まで広げる
  const { led, id } = started();
  feed(led, id, { type: 'control_request', request_id: 'z9', request: { subtype: 'なにこれ' } }, T + 10);

  const [out] = led.takeOutbox();
  assert.equal(out.kind, 'control-error');
  assert.equal(out.requestId, 'z9');
  assert.ok(out.message.includes('なにこれ'));
  assert.equal(led.rows()[0].state, 'running', '状態は変えない');
});

test('宛先が読めない要求には手を出さない', () => {
  // request_id が無ければ答えようが無い。stream.mjs が other へ落とす
  const { led, id } = started();
  feed(led, id, { type: 'control_request', request: { subtype: 'can_use_tool' } }, T + 10);
  assert.deepEqual(led.takeOutbox(), []);
  assert.deepEqual(led.rows()[0].asks, []);
});

test('許可のあとに権限モードを撃つ。この順でなければいけない', () => {
  // 先にモードを替えると、CLI が plan の検査を通している最中に足元が変わる
  const { led, id } = started();
  feed(led, id, sPermission({ requestId: 'p1', toolName: 'ExitPlanMode', input: { plan: '# やる' } }), T + 10);
  led.answer(id, 'p1', { behavior: 'allow', then: 'auto', thenRequestId: 'r1' }, T + 20);

  const out = led.takeOutbox();
  assert.deepEqual(out.map((o) => o.kind), ['permission-response', 'control-request']);
  assert.equal(out[1].requestId, 'r1');
  assert.equal(out[1].subtype, 'set_permission_mode');
  assert.deepEqual(out[1].params, { mode: 'auto' });
});

test('断ったときはモードを替えない', () => {
  const { led, id } = asked();
  led.answer(id, 'p1', { behavior: 'deny', then: 'auto', thenRequestId: 'r1' }, T + 20);
  assert.deepEqual(led.takeOutbox().map((o) => o.kind), ['permission-response']);
});

test('断る理由は載るが、長ければ切る', () => {
  const { led, id } = asked();
  led.answer(id, 'p1', { behavior: 'deny', message: 'あ'.repeat(1000) }, T + 20);
  const [out] = led.takeOutbox();
  assert.ok(out.decision.message.length <= 200);
  assert.ok(out.decision.message.endsWith('…'));
});

test('知らないキーは通さない', () => {
  // 混ざった形は向こうの検証がどう転ぶか分からず、こちらのバグが「たまに通る」形で残る
  const { led, id } = asked();
  led.answer(id, 'p1', { behavior: 'allow', すきなもの: 'プリン' }, T + 20);
  assert.deepEqual(Object.keys(led.takeOutbox()[0].decision), ['behavior']);
});

test('受理されるまで権限モードを書き換えない', () => {
  // 「plan のつもりが auto で走っている」は最も高くつく誤表示
  const { led, id } = asked();
  led.answer(id, 'p1', { behavior: 'allow', then: 'auto', thenRequestId: 'r1' }, T + 20);
  assert.equal(led.rows()[0].permissionMode, 'plan', '撃った直後はまだ plan');

  feed(led, id, sControlResponse('r1'), T + 30);
  assert.equal(led.rows()[0].permissionMode, 'auto');
});

test('替えられなかったら書き換えず、そう言う', () => {
  const { led, id } = asked();
  led.answer(id, 'p1', { behavior: 'allow', then: 'auto', thenRequestId: 'r1' }, T + 20);
  const events = feed(led, id, sControlResponse('r1', { ok: false, error: '知らないモードです' }), T + 30);

  assert.equal(led.rows()[0].permissionMode, 'plan');
  assert.ok(events.some((e) => e.kind === 'note'));
});

test('自分のこだまを受理と読まない', () => {
  // 撃った番号と違うものは、こちらのモード変更の返事ではない
  const { led, id } = asked();
  led.answer(id, 'p1', { behavior: 'allow', then: 'auto', thenRequestId: 'r1' }, T + 20);
  feed(led, id, sControlResponse('よその番号'), T + 30);
  assert.equal(led.rows()[0].permissionMode, 'plan');
});

test('撃っていないのに来た応答は黙って捨てる', () => {
  const { led, id } = started();
  const events = feed(led, id, sControlResponse('r9'), T + 10);
  assert.deepEqual(events.filter((e) => e.kind === 'note'), []);
  assert.equal(led.rows()[0].permissionMode, 'plan');
});

test('「今後も許可」で撃つモードは、session 行きの助言だけ拾う', () => {
  // ~/.claude へ書かせない。読み取り専用が前提のアプリなので、そこだけは絶対に触らない
  const { led, id } = started();
  feed(led, id, sPermission({
    requestId: 'a',
    suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
  }), T + 10);
  feed(led, id, sPermission({
    requestId: 'b',
    suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'userSettings' }],
  }), T + 20);
  feed(led, id, sPermission({ requestId: 'c', suggestions: [{ type: 'addRules', rules: [] }] }), T + 30);

  const asks = led.rows()[0].asks;
  assert.equal(asks[0].suggestMode, 'acceptEdits');
  assert.equal(asks[1].suggestMode, null, 'ファイルに書く助言は拾わない');
  assert.equal(asks[2].suggestMode, null, 'モードの話でなければ拾わない');
});

test('許可待ちは一覧で「あなたの番」に並ぶ', () => {
  const { led, id } = asked();
  const [merged] = mergeRuns([listRow()], led.rows(), T + 2000);
  assert.equal(merged.state, 'awaiting-reply');
});

/* --------------------------------------------------- 質問に選択肢で答える（段2） */

/** 台帳が持つ pending と同じ形を手で組む。`buildQuestionInput` だけを単体で試すため。 */
function pending(questions, keys = null) {
  return {
    kind: 'question',
    input: { questions, extra: '知らないキー' },
    questions: (keys ?? questions.map((_, i) => i)).map((key) => ({
      key,
      question: questions[key].question,
      header: null,
      multiSelect: questions[key].multiSelect === true,
      options: (questions[key].options ?? []).map((o) => ({ label: o.label, description: null })),
    })),
  };
}

const Q2 = [
  { question: 'どっちで進める？', options: [{ label: 'いますぐ' }, { label: 'あとで' }] },
  { question: '誰に見せる？', multiSelect: true, options: [{ label: '自分' }, { label: 'チーム' }] },
];

test('選んだ札から updatedInput を組む。鍵は原文の質問文', () => {
  const res = buildQuestionInput(pending(Q2), { 0: 'いますぐ', 1: ['自分', 'チーム'] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.updatedInput.answers, {
    'どっちで進める？': 'いますぐ',
    // 実測で multiSelect の答えは「, 」連結の文字列だった（src/parse/digest/answers.mjs）。
    // 読む側と同じ形で書く
    '誰に見せる？': '自分, チーム',
  });
  // 知らないキーは足さない。**原文をそのまま広げる**ので、項目が増えた版でも落とさずに返せる
  assert.equal(res.updatedInput.extra, '知らないキー');
  assert.deepEqual(res.updatedInput.questions, Q2);
});

test('答えていない質問があれば断る', () => {
  const res = buildQuestionInput(pending(Q2), { 0: 'いますぐ' });
  assert.equal(res.ok, false);
  assert.match(res.reason, /答えていない質問/);
});

test('1つだけ選ぶ質問に複数渡したら断る', () => {
  const res = buildQuestionInput(pending(Q2), { 0: ['いますぐ', 'あとで'], 1: '自分' });
  assert.equal(res.ok, false);
  assert.match(res.reason, /1つだけ選ぶ/);
});

test('選択肢に無い言葉も通す（その他＝自分で書く）', () => {
  // **照合しない。** 「その他（自分で書く）」を残すためで、
  // 読む側（pickAnswers）も自由記述を一人前の答えとして扱っている
  const res = buildQuestionInput(pending(Q2), { 0: '来週まとめて', 1: '自分' });
  assert.equal(res.ok, true);
  assert.equal(res.updatedInput.answers['どっちで進める？'], '来週まとめて');
});

test('長すぎる答えは切らずに断る', () => {
  // 切ると、人が書いた自由記述が黙って途中で終わった形で Claude へ渡る
  const res = buildQuestionInput(pending(Q2), { 0: 'あ'.repeat(2001), 1: '自分' });
  assert.equal(res.ok, false);
  assert.match(res.reason, /長すぎます/);
});

test('質問の形が無いものは選択肢で答えられない', () => {
  assert.equal(buildQuestionInput({ kind: 'tool', input: { command: 'ls' } }, { 0: 'はい' }).ok, false);
  assert.equal(buildQuestionInput(pending(Q2), null).ok, false);
  assert.equal(buildQuestionInput(pending(Q2), ['いますぐ']).ok, false);
});

test('答えたら outbox に updatedInput が乗る', () => {
  const { led, id } = started();
  feed(led, id, sQuestion([Q2[0]]), T + 10);
  const res = led.answer(id, 'p1', { behavior: 'allow', choices: { 0: 'あとで' } }, T + 20);
  assert.equal(res.ok, true);
  // **選んだ札を速報にも1行残す。** 「何を判断したか」を出すのがこのアプリの目的の半分
  assert.match(res.events[0].text, /あとで/);

  assert.deepEqual(led.takeOutbox(), [{
    runId: id,
    kind: 'permission-response',
    requestId: 'p1',
    decision: {
      behavior: 'allow',
      updatedInput: { questions: [Q2[0]], answers: { 'どっちで進める？': 'あとで' } },
    },
  }]);
});

test('画面から来た updatedInput は素通ししない', () => {
  // 素通しにすると、カードに出したコマンドと実際に走るコマンドを別にできてしまう
  const { led, id } = asked();
  led.answer(id, 'p1', { behavior: 'allow', updatedInput: { command: 'rm -rf /' } }, T + 2000);
  assert.deepEqual(led.takeOutbox(), [{
    runId: id, kind: 'permission-response', requestId: 'p1', decision: { behavior: 'allow' },
  }]);
});

test('選び方が足りないときは要求を消さない', () => {
  // 消すと、押し直す先が消えたまま「答えていない質問があります」だけが残る
  const { led, id } = started();
  feed(led, id, sQuestion(Q2), T + 10);
  const res = led.answer(id, 'p1', { behavior: 'allow', choices: { 0: 'いますぐ' } }, T + 20);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'bad-choices');
  assert.equal(led.rows()[0].asks.length, 1);
  assert.equal(led.rows()[0].state, 'needs-permission');
  assert.deepEqual(led.takeOutbox(), []);
});

test('質問でない要求に choices を付けたら断る', () => {
  // ツールの引数を画面から差し替える道は作らない
  const { led, id } = asked();
  const res = led.answer(id, 'p1', { behavior: 'allow', choices: { 0: 'はい' } }, T + 2000);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'bad');
});

/*
 * 子を殺さずに替える（setLive）
 */

test('替えたいぶんだけ control-request を積む', () => {
  const { led, id } = started();
  const res = led.setLive(id, [
    { field: 'permissionMode', value: 'acceptEdits', requestId: 'm1' },
    { field: 'model', value: 'claude-sonnet-5', requestId: 'm2' },
  ], T + 10);

  assert.equal(res.ok, true);
  const out = led.takeOutbox();
  assert.deepEqual(out.map((o) => o.subtype), ['set_permission_mode', 'set_model']);
  // パラメタのキーは向こうの都合で項目名と揃っていない（実測）
  assert.deepEqual(out[0].params, { mode: 'acceptEdits' });
  assert.deepEqual(out[1].params, { model: 'claude-sonnet-5' });
});

test('受理されるまで書き換えず、切り替え中だと行に出す', () => {
  const { led, id } = started();
  led.setLive(id, [{ field: 'permissionMode', value: 'auto', requestId: 'm1' }], T + 10);

  assert.equal(led.rows()[0].permissionMode, 'plan', '撃った直後はまだ plan');
  assert.deepEqual(led.rows()[0].switching, [{ field: 'permissionMode', value: 'auto' }]);

  feed(led, id, sControlResponse('m1'), T + 20);
  assert.equal(led.rows()[0].permissionMode, 'auto');
  assert.deepEqual(led.rows()[0].switching, [], '落ち着いたら消える');
});

test('モデルも同じ道で替わる', () => {
  const { led, id } = started();
  led.setLive(id, [{ field: 'model', value: 'claude-sonnet-5', requestId: 'm1' }], T + 10);
  feed(led, id, sControlResponse('m1'), T + 20);
  assert.equal(led.rows()[0].model, 'claude-sonnet-5');
});

test('断られたら書き換えず、そう言う', () => {
  const { led, id } = started();
  led.setLive(id, [{ field: 'permissionMode', value: 'auto', requestId: 'm1' }], T + 10);
  const events = feed(led, id, sControlResponse('m1', { ok: false, error: '知らないモード' }), T + 20);

  assert.equal(led.rows()[0].permissionMode, 'plan');
  assert.deepEqual(led.rows()[0].switching, []);
  assert.ok(events.some((e) => e.kind === 'note'));
});

test('返事が来なければ控えを捨てるが、値も状態も変えない', () => {
  // 撃ったのに返事が無いなら、いまどちらで走っているかは分からない。
  // 片方に倒して表示すると、推測を事実として出したことになる
  const { led, id } = started({ liveAckTimeoutMs: 1000 });
  led.setLive(id, [{ field: 'permissionMode', value: 'auto', requestId: 'm1' }], T + 10);

  assert.deepEqual(led.tick(T + 500).events.filter((e) => e.kind === 'note'), [], 'まだ待つ');

  const { changed, events } = led.tick(T + 1100);
  assert.deepEqual(changed, [id], '行が変わるので押し出す');
  assert.ok(events.some((e) => e.kind === 'note' && e.text.includes('分かりません')));
  assert.equal(led.rows()[0].permissionMode, 'plan', 'どちらとも言えないので据え置く');
  assert.equal(led.rows()[0].state, 'running', '状態は変えない');
  assert.deepEqual(led.rows()[0].switching, []);
});

test('時間切れの既定は10秒。人を待つ時間ではない', () => {
  assert.equal(LIVE_ACK_TIMEOUT_MS, 10000);
  assert.ok(LIVE_ACK_TIMEOUT_MS < STALL_MS);
});

test('いまと同じ値は撃たない', () => {
  const { led, id } = started();
  const res = led.setLive(id, [{ field: 'permissionMode', value: 'plan', requestId: 'm1' }], T + 10);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'same');
  assert.ok(res.reason.includes('権限モード'), '何がと同じかを言う');
  assert.deepEqual(led.takeOutbox(), []);
});

test('同じ項目を二重に撃たせない', () => {
  // 二重に撃つと、返ってきた答えのどちらが後なのか決められない
  const { led, id } = started();
  led.setLive(id, [{ field: 'permissionMode', value: 'auto', requestId: 'm1' }], T + 10);
  led.takeOutbox();

  const res = led.setLive(id, [{ field: 'permissionMode', value: 'acceptEdits', requestId: 'm2' }], T + 20);
  assert.equal(res.code, 'switching');
  assert.deepEqual(led.takeOutbox(), []);

  // 別の項目なら通る
  assert.equal(led.setLive(id, [{ field: 'model', value: 'x', requestId: 'm3' }], T + 30).ok, true);
});

test('子がいなければ撃たない。終わったものとは分けて返す', () => {
  const { led, id } = started();
  exhaust(led, id, T + 10);
  assert.equal(led.rows()[0].state, 'budget');
  assert.equal(led.setLive(id, [{ field: 'model', value: 'x', requestId: 'm1' }], T + 20).code, 'no-child');

  // 予算切れは `onExit` でも `budget` のまま（上げて続ける道を残すため）なので、
  // 終端は別の run で確かめる
  const b = started();
  b.led.onExit(b.id, 0, null, T + 30);
  assert.equal(b.led.setLive(b.id, [{ field: 'model', value: 'y', requestId: 'm2' }], T + 40).code, 'over');
  assert.equal(b.led.setLive('よその id', [{ field: 'model', value: 'y', requestId: 'm3' }], T + 40).code, 'no-run');
});

test('形が違うものは1本も積まずに断る', () => {
  const { led, id } = started();
  const bad = [
    [],
    [{ field: 'effort', value: 'high', requestId: 'm1' }],
    [{ field: 'model', value: '', requestId: 'm1' }],
    [{ field: 'model', value: 'x' }],
    [{ field: 'model', value: 'x', requestId: 'm1' }, { field: 'model', value: 'y', requestId: 'm2' }],
  ];
  for (const wants of bad) {
    assert.equal(led.setLive(id, wants, T + 10).code, 'bad', JSON.stringify(wants));
  }
  assert.deepEqual(led.takeOutbox(), [], '1本も積まない');
});

test('先に確かめてから積む。片方だけ撃たれる形を作らない', () => {
  // 途中で断ると、呼んだ側には「400 だった」としか見えないのに片方は替わっている
  const { led, id } = started();
  const res = led.setLive(id, [
    { field: 'model', value: 'claude-sonnet-5', requestId: 'm1' },
    { field: 'permissionMode', value: 'plan', requestId: 'm2' },
  ], T + 10);
  assert.equal(res.code, 'same', '2つ目がいまと同じ');
  assert.deepEqual(led.takeOutbox(), [], '1つ目も積まれていない');
});

test('止めると決めたら切り替えの控えも捨てる', () => {
  const { led, id } = started();
  led.setLive(id, [{ field: 'permissionMode', value: 'auto', requestId: 'm1' }], T + 10);
  led.takeOutbox();
  led.markStopping(id, T + 20);
  assert.deepEqual(led.rows()[0].switching, []);

  // 捨てたあとに答えが来ても書き換えない
  feed(led, id, sControlResponse('m1'), T + 30);
  assert.equal(led.rows()[0].permissionMode, 'plan');
});

test('替えられる項目の表は、要求の名前とパラメタ名を1箇所に持つ', () => {
  // 3つの表に割ると、項目を足すときに必ずどれかが漏れる
  assert.deepEqual(Object.keys(LIVE_FIELDS), ['permissionMode', 'model']);
  for (const [key, f] of Object.entries(LIVE_FIELDS)) {
    assert.ok(f.subtype && f.key && f.label, key);
  }
  // 思考量は入れない（`--effort` の語とトークン数の対応が測れていない）
  assert.equal(LIVE_FIELDS.effort, undefined);
});

/*
 * 数えて畳むもの（考えた量・枠の使用率）と、診断のための2つ
 */

/** 考えている量の行。1往復に何度も刻んで届く。 */
const sThinking = (tokens) => ({
  type: 'system', subtype: 'thinking_tokens', session_id: S_ID, estimated_tokens: tokens,
});

/** 枠の使用率の行。 */
const sRate = (five, seven) => ({
  type: 'rate_limit_event', session_id: S_ID,
  rate_limit_info: {
    unifiedWindows: {
      five_hour: { utilization: five, resetsAt: 1787667000 },
      seven_day: { utilization: seven },
    },
  },
});

test('考えた量は速報に積まず、ターンの終わりの1件に載せる', () => {
  const { led, id } = started();
  assert.deepEqual(feed(led, id, sThinking(50), T + 10), [], '1行も積まない');
  feed(led, id, sThinking(700), T + 20);

  const res = feed(led, id, sResult(), T + 30).find((e) => e.kind === 'result');
  assert.equal(res.thinkingTokens, 700, '最新の累計が載る');
});

test('考えた量は行に載せない', () => {
  // 行は状態が変わったときにしか描き直されない。8件刻みで動く値を置くと古い数が残り続ける
  const { led, id } = started();
  feed(led, id, sThinking(700), T + 10);
  assert.equal(led.rows()[0].thinkingTokens, undefined);
});

test('考えた量は次のターンへ持ち越さない', () => {
  const { led, id } = started();
  feed(led, id, sThinking(700), T + 10);
  feed(led, id, sResult(), T + 20);

  const res = feed(led, id, sResult(), T + 30).find((e) => e.kind === 'result');
  assert.equal(res.thinkingTokens, null, '考えなかったターンを 700 と言わない');
});

test('考えた量が読めない行では前の値を潰さない', () => {
  const { led, id } = started();
  feed(led, id, sThinking(700), T + 10);
  feed(led, id, { type: 'system', subtype: 'thinking_tokens', session_id: S_ID }, T + 20);

  const res = feed(led, id, sResult(), T + 30).find((e) => e.kind === 'result');
  assert.equal(res.thinkingTokens, 700);
});

test('枠の使用率は行に出る。速報は積まない', () => {
  const { led, id } = started();
  assert.deepEqual(feed(led, id, sRate(0.06, 0.69), T + 10), []);
  assert.deepEqual(led.rows()[0].rateLimit, { fiveHour: 0.06, sevenDay: 0.69, resetsAt: 1787667000 });
});

test('どちらの枠も読めない行では上書きしない', () => {
  // 版が上がって形が変わった日に、一度は取れていた値が「取れていない」に見えるのを防ぐ
  const { led, id } = started();
  feed(led, id, sRate(0.06, 0.69), T + 10);
  feed(led, id, { type: 'rate_limit_event', session_id: S_ID, rate_limit_info: {} }, T + 20);
  assert.equal(led.rows()[0].rateLimit.fiveHour, 0.06);
});

test('枠の使用率は最初は「不明」。0 ではない', () => {
  const { led, id } = started();
  assert.equal(led.rows()[0].rateLimit, null);
});

test('捨てた行が増えたときだけ1行積む', () => {
  // 4MB を超える許可要求が捨てられると、誰も答えず向こうは待ち続ける。
  // `counts` は画面が引いていないので、増えたときは目に触れる形で出す
  const { led, id } = started();
  assert.deepEqual(led.noteDropped(id, 0, T + 10), []);

  const first = led.noteDropped(id, 2, T + 20);
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, 'note');
  assert.ok(first[0].text.includes('2 件'));

  assert.deepEqual(led.noteDropped(id, 2, T + 30), [], '同じ数なら黙る');

  const more = led.noteDropped(id, 5, T + 40);
  assert.ok(more[0].text.includes('3 件'), '増えたぶんを言う');
  assert.ok(more[0].text.includes('累計 5 件'));
  assert.equal(led.get(id).counts.droppedLines, 5, '累計をそのまま持つ。足し込まない');
});

test('捨てた行の数が壊れていても落ちない', () => {
  const { led, id } = started();
  for (const n of [null, undefined, NaN, Infinity, -1, '3']) {
    assert.deepEqual(led.noteDropped(id, n, T + 10), [], String(n));
  }
  assert.equal(led.get(id).counts.droppedLines, 0);
});

test('標準エラーは終了コード 0 でも残す。空では上書きしない', () => {
  // `Malformed updatedPermissions` のようなこちらの配線の間違いは、
  // 終了コード 0 のまま stderr にだけ出る
  const { led, id } = started();
  assert.equal(led.noteStderr(id, 'Malformed updatedPermissions'), true);
  assert.equal(led.rows()[0].lastStderr, 'Malformed updatedPermissions');

  assert.equal(led.noteStderr(id, ''), false);
  assert.equal(led.noteStderr(id, null), false);
  assert.equal(led.rows()[0].lastStderr, 'Malformed updatedPermissions', '前の警告を消さない');
});

test('居ない実行へ言っても落ちない', () => {
  const { led } = started();
  assert.deepEqual(led.noteDropped('nope', 3, T), []);
  assert.equal(led.noteStderr('nope', 'x'), false);
});
