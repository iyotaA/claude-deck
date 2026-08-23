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
  RUN_STATE_LABELS, RUN_MAX, STALL_MS,
} from '../src/run/ledger.mjs';
import { sysInit, sAssistant, sResult, S_ID } from './helpers.mjs';

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
  // budget も同じ。真にすると `detach()` が `entry.spec` を捨て、上げて続ける道が消える
  for (const s of ['starting', 'running', 'waiting', 'stalled', 'stopping', 'switching', 'budget']) {
    assert.equal(isRunOver(s), false);
  }
});

test('isChildDone は終わった3つ ＋ 予算切れ', () => {
  // 「もう動かない」（`isRunOver`）と「いま子がいない」（`isChildDone`）は別の話。
  // 混ぜると、予算切れが終端になるか、上限に当たった子が畳まれずに残るかのどちらかになる
  for (const s of ['stopped', 'failed', 'done', 'budget']) assert.equal(isChildDone(s), true);
  for (const s of ['starting', 'running', 'waiting', 'stalled', 'stopping', 'switching']) {
    assert.equal(isChildDone(s), false);
  }
});

test('状態の言い方は全部そろっている', () => {
  for (const s of ['starting', 'running', 'waiting', 'stalled', 'budget', 'stopping', 'switching', 'stopped', 'failed', 'done']) {
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
