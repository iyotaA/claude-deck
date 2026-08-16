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
  createRunLedger, isRunOver, RUN_STATE_LABELS, RUN_MAX, STALL_MS,
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
  for (const s of ['starting', 'running', 'waiting', 'stalled', 'stopping']) {
    assert.equal(isRunOver(s), false);
  }
});

test('状態の言い方は全部そろっている', () => {
  for (const s of ['starting', 'running', 'waiting', 'stalled', 'stopping', 'stopped', 'failed', 'done']) {
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

test('予算超過は台帳の側から終わらせる（実測でプロセスは死なない）', () => {
  const { led, id } = started();
  const evs = feed(led, id, sResult({
    subtype: 'error_max_budget_usd',
    isError: true,
    text: null,
    terminal_reason: 'budget_exhausted',
    errors: ['Reached maximum budget ($0.01)'],
  }), T + 1000);

  const [row] = led.rows();
  assert.equal(row.state, 'failed');
  assert.equal(row.reason, 'Reached maximum budget ($0.01)');
  // 理由が速報にも出る。状態だけ変えて黙らない
  assert.equal(evs.at(-1).kind, 'note');
  assert.equal(evs.at(-1).text, row.reason);
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

test('一覧の行に毎秒動く値を載せない', () => {
  const { led, id } = started();
  feed(led, id, sAssistant('うん'), T + 1000);
  feed(led, id, sResult({ costUSD: 0.4 }), T + 2000);

  const [row] = led.rows();
  // ここに載せると refresh() の差分判定を素通りして毎秒 push になる
  for (const key of ['lastLineAt', 'counts', 'costUSD', 'idleMs', 'events']) {
    assert.equal(key in row, false, `${key} を rows() に載せてはいけない`);
  }
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
