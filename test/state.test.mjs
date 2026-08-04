/**
 * 状態判定のテスト。
 *
 * このアプリの心臓部なので、deriveState の分岐は全部通す。
 * しきい値を触ったときに、どの分岐が動かなくなるかがここで分かるようにしておく。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveState,
  ballOf,
  STATE_LABELS,
  STATE_RANK,
  QUIET_MS,
  APPROVAL_MS,
} from '../src/parse/state.mjs';
import { T0, at, say, call, result, prompt, tail, reg } from './helpers.mjs';

/** T0 から指定ミリ秒たった時点を「いま」とする。 */
const nowAfter = (ms) => T0 + ms;

test('登録簿に無ければ終了扱い', () => {
  const s = deriveState({
    registry: null,
    tail: tail([say('おわり')]),
    now: nowAfter(1000),
  });
  assert.equal(s.kind, 'ended');
  assert.equal(s.confident, true);
  assert.match(s.reason, /登録簿に無し/);
});

test('登録簿にあってもプロセスが死んでいれば終了扱い', () => {
  const s = deriveState({
    registry: reg({ alive: false }),
    tail: tail([say('おわり')]),
    now: nowAfter(1000),
  });
  assert.equal(s.kind, 'ended');
  assert.match(s.reason, /プロセスが終了/);
});

test('AskUserQuestion が結果待ちなら、status が busy で追記が直近でも質問待ち', () => {
  // このツールは「あなたを待つ」以外の用途を持たないので、しきい値も status も見ずに確定させる
  const s = deriveState({
    registry: reg({ status: 'busy' }),
    tail: tail([call('AskUserQuestion', { questions: [{ question: 'どっちにする？' }] }, { id: 'q1' })]),
    now: nowAfter(200),
  });
  assert.equal(s.kind, 'needs-answer');
  assert.equal(s.confident, true);
  assert.deepEqual(s.waitingFor, { tool: 'AskUserQuestion', detail: 'どっちにする？' });
});

test('ExitPlanMode が結果待ちならプラン承認待ち', () => {
  const s = deriveState({
    registry: reg({ status: 'busy' }),
    tail: tail([call('ExitPlanMode', { plan: '# 手順' }, { id: 'p1' })]),
    now: nowAfter(200),
  });
  assert.equal(s.kind, 'needs-plan-approval');
  assert.equal(s.confident, true);
});

test('登録簿が待ち系 ＋ 追記停止 ＋ 結果待ちあり → 承認待ち', () => {
  const s = deriveState({
    registry: reg({ status: 'idle' }),
    tail: tail([call('Bash', { command: 'npm test', description: 'テストを走らせる' }, { id: 't1' })]),
    now: nowAfter(5000),
  });
  assert.equal(s.kind, 'needs-approval');
  assert.equal(s.confident, true);
  assert.match(s.reason, /status が idle/);
  // 待っている中身は description を優先して出す。command より人が読んで分かりやすいため
  assert.deepEqual(s.waitingFor, { tool: 'Bash', detail: 'テストを走らせる' });
});

test('登録簿が待ち系 ＋ 追記停止 ＋ 結果待ちなし → 返信待ち', () => {
  const s = deriveState({
    registry: reg({ status: 'waiting' }),
    tail: tail([prompt('やって'), say('やったよ', { ms: 100 })]),
    now: nowAfter(5000),
  });
  assert.equal(s.kind, 'awaiting-reply');
  assert.equal(s.waitingFor, null);
});

test('登録簿が busy ＋ 追記が直近 → 実行中', () => {
  const s = deriveState({
    registry: reg({ status: 'busy' }),
    tail: tail([say('考えてる')]),
    now: nowAfter(QUIET_MS - 1),
  });
  assert.equal(s.kind, 'running');
  assert.equal(s.confident, true);
});

test('結果待ちのまま APPROVAL_MS を超えたら承認待ち', () => {
  const s = deriveState({
    // status が未知の値でも、長く止まっている事実だけで判定できる
    registry: reg({ status: 'thinking' }),
    tail: tail([call('Edit', { file_path: 'C:\\work\\a.mjs' }, { id: 't1' })]),
    now: nowAfter(APPROVAL_MS),
  });
  assert.equal(s.kind, 'needs-approval');
  assert.equal(s.confident, true);
  assert.deepEqual(s.waitingFor, { tool: 'Edit', detail: 'C:\\work\\a.mjs' });
});

test('結果待ちでも APPROVAL_MS 未満なら実行中（長く走る Bash と区別する）', () => {
  const s = deriveState({
    registry: reg({ status: 'thinking' }),
    tail: tail([call('Bash', { command: 'npm install' }, { id: 't1' })]),
    now: nowAfter(APPROVAL_MS - 1),
  });
  assert.equal(s.kind, 'running');
  assert.match(s.reason, /Bash を実行中/);
});

test('busy のまま止まって承認待ちになった場合は自信なしにする', () => {
  // status が busy だと「単に長いコマンド」の可能性が残るので断定しない
  const s = deriveState({
    registry: reg({ status: 'busy' }),
    tail: tail([call('Bash', { command: 'npm run build' }, { id: 't1' })]),
    now: nowAfter(APPROVAL_MS + 1000),
  });
  assert.equal(s.kind, 'needs-approval');
  assert.equal(s.confident, false);
});

test('結果待ちなし ＋ 末尾が assistant の発言 ＋ 追記停止 → 返信待ち', () => {
  const s = deriveState({
    registry: reg({ status: 'thinking' }),
    tail: tail([prompt('やって'), say('やったよ', { ms: 100 })]),
    now: nowAfter(QUIET_MS + 100),
  });
  assert.equal(s.kind, 'awaiting-reply');
  assert.equal(s.confident, true);
  assert.match(s.reason, /応答を返し終えて/);
});

test('結果待ちなし ＋ 末尾が assistant の発言 ＋ 追記が直近 → 応答の途中', () => {
  const s = deriveState({
    registry: reg({ status: 'thinking' }),
    tail: tail([say('えーっと')]),
    now: nowAfter(100),
  });
  assert.equal(s.kind, 'running');
  assert.match(s.reason, /応答の途中/);
});

test('結果が返ってきている呼び出しは結果待ちに数えない', () => {
  const s = deriveState({
    registry: reg({ status: 'idle' }),
    tail: tail([
      call('Bash', { command: 'ls' }, { id: 't1' }),
      result('t1', { ms: 100 }),
      say('できた', { ms: 200 }),
    ]),
    now: nowAfter(5000),
  });
  // 結果待ちが残っていれば needs-approval になる。返信待ちなら解決できている
  assert.equal(s.kind, 'awaiting-reply');
  assert.equal(s.waitingFor, null);
});

test('tool_result ブロックが無く toolUseResult だけの形でも解決と見なす', () => {
  const s = deriveState({
    registry: reg({ status: 'idle' }),
    tail: tail([
      call('Bash', { command: 'ls' }, { id: 't1', uuid: 'a1' }),
      {
        type: 'user',
        uuid: 'r1',
        timestamp: at(100),
        message: { role: 'user', content: [] },
        toolUseResult: { stdout: 'ok' },
        sourceToolAssistantUUID: 'a1',
      },
    ]),
    now: nowAfter(5000),
  });
  assert.equal(s.kind, 'awaiting-reply');
  assert.equal(s.waitingFor, null);
});

test('サブエージェントの呼び出しは結果待ちに数えない', () => {
  const s = deriveState({
    registry: reg({ status: 'thinking' }),
    tail: tail([
      say('進めるね'),
      { ...call('Bash', { command: 'sleep 100' }, { id: 't1', ms: 100 }), isSidechain: true },
    ]),
    now: nowAfter(APPROVAL_MS + 1000),
  });
  // 本流に結果待ちが無いので返信待ち。拾ってしまうと承認待ちになる
  assert.equal(s.kind, 'awaiting-reply');
  assert.equal(s.waitingFor, null);
});

test('ログが空でも落ちない', () => {
  const s = deriveState({
    registry: reg({ status: 'なんかの新しい値' }),
    tail: tail([]),
    now: nowAfter(0),
  });
  assert.ok(STATE_LABELS[s.kind], `未知の状態が返っている: ${s.kind}`);
  assert.equal(s.idleMs, null);
  assert.equal(s.lastActivityAt, null);
});

test('idleMs と lastActivityAt はログの末尾から数える', () => {
  const s = deriveState({
    registry: reg({ status: 'busy' }),
    tail: tail([say('あ'), say('い', { ms: 2000 })]),
    now: nowAfter(2500),
  });
  assert.equal(s.lastActivityAt, T0 + 2000);
  assert.equal(s.idleMs, 500);
});

test('statusRaw はそのまま持ち回す', () => {
  const s = deriveState({
    registry: reg({ status: 'まだ知らない値' }),
    tail: tail([say('あ')]),
    now: nowAfter(100),
  });
  assert.equal(s.statusRaw, 'まだ知らない値');
});

test('Skill の結果待ちは スキル名と引数を出す', () => {
  const s = deriveState({
    registry: reg({ status: 'idle' }),
    tail: tail([call('Skill', { skill: 'pr-review', args: '1234' }, { id: 't1' })]),
    now: nowAfter(5000),
  });
  assert.deepEqual(s.waitingFor, { tool: 'Skill', detail: 'pr-review (1234)' });
});

test('返しうる状態はすべてラベルと並び順を持っている', () => {
  for (const kind of Object.keys(STATE_LABELS)) {
    assert.equal(typeof STATE_LABELS[kind], 'string', `${kind} のラベルが無い`);
    assert.equal(typeof STATE_RANK[kind], 'number', `${kind} の並び順が無い`);
  }
});

test('ボールの持ち主の割り当て', () => {
  assert.equal(ballOf('running'), 'claude');
  assert.equal(ballOf('ended'), 'none');
  assert.equal(ballOf('unknown'), 'none');
  assert.equal(ballOf('needs-answer'), 'master');
  assert.equal(ballOf('needs-plan-approval'), 'master');
  assert.equal(ballOf('needs-approval'), 'master');
  assert.equal(ballOf('awaiting-reply'), 'master');
});
