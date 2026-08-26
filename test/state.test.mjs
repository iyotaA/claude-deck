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
  STATE_BLOCKING,
  isBlocking,
  QUIET_MS,
  APPROVAL_MS,
  LONG_APPROVAL_MS,
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
  assert.deepEqual(s.waitingFor, { id: 'q1', tool: 'AskUserQuestion', detail: 'どっちにする？' });
});

test('ExitPlanMode が結果待ちならプラン承認待ち', () => {
  const s = deriveState({
    registry: reg({ status: 'busy' }),
    tail: tail([call('ExitPlanMode', { plan: '# 手順\n1. やる' }, { id: 'p1' })]),
    now: nowAfter(200),
  });
  assert.equal(s.kind, 'needs-plan-approval');
  assert.equal(s.confident, true);
  // 入力は {plan} だけ。既定の枝では拾えず、ここが長らく null になっていた
  assert.deepEqual(s.waitingFor, { id: 'p1', tool: 'ExitPlanMode', detail: '# 手順 1. やる' });
});

test('プラン本文が無くてもプラン承認待ちは成り立つ', () => {
  // 本文は結果側にしか無い形が実物にある（digest はそちらから拾っている）。
  // 一覧は tool_use しか見ないので、説明が取れないことがある
  const s = deriveState({
    registry: reg({ status: 'busy' }),
    tail: tail([call('ExitPlanMode', {}, { id: 'p1' })]),
    now: nowAfter(200),
  });
  assert.equal(s.kind, 'needs-plan-approval');
  assert.deepEqual(s.waitingFor, { id: 'p1', tool: 'ExitPlanMode', detail: null });
});

test('waitingFor は tool_use の id を持ち回す', () => {
  // 同じ待ちを二重に数えないための鍵。呼び出しごとに一意
  const s = deriveState({
    registry: reg({ status: 'busy' }),
    tail: tail([call('AskUserQuestion', { questions: [{ question: 'どれ？' }] }, { id: 'toolu_abc123' })]),
    now: nowAfter(200),
  });
  assert.equal(s.waitingFor.id, 'toolu_abc123');
});

test('id を持たない呼び出しでも落ちず、id は不明として null を返す', () => {
  // 実測したログには必ず入っていたが、読んでいるのは公開仕様ではない。
  // 無い形が来ても判定そのものは成り立たせる（call ヘルパーは既定の id を入れるので生で組む）
  const s = deriveState({
    registry: reg({ status: 'busy' }),
    tail: tail([{
      type: 'assistant',
      uuid: 'a1',
      timestamp: at(0),
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'どれ？' }] } }],
      },
    }]),
    now: nowAfter(200),
  });
  assert.equal(s.kind, 'needs-answer');
  assert.equal(s.waitingFor.id, null);
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
  assert.deepEqual(s.waitingFor, { id: 't1', tool: 'Bash', detail: 'テストを走らせる' });
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
  assert.deepEqual(s.waitingFor, { id: 't1', tool: 'Edit', detail: 'C:\\work\\a.mjs' });
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
  // status が busy だと「単に長いコマンド」の可能性が残るので断定しない。
  // 主題は confident の規則なので、しきい値の短い側（Edit）で組んである
  const s = deriveState({
    registry: reg({ status: 'busy' }),
    tail: tail([call('Edit', { file_path: 'C:\work\a.mjs' }, { id: 't1' })]),
    now: nowAfter(APPROVAL_MS + 1000),
  });
  assert.equal(s.kind, 'needs-approval');
  assert.equal(s.confident, false);
});

/* ------------------------------------------------------ ツール別のしきい値 */
//
// 長さがツール自身では決まらないもの（外のコマンド・ネットワーク・別のエージェント）は
// 60秒まで待つ。実測で短い側 3,608件の60秒超は0件なので、短いほうの判定は変わらない。

test('長く走るツールは 15秒では承認待ちにしない', () => {
  const s = deriveState({
    registry: reg({ status: 'thinking' }),
    tail: tail([call('Bash', { command: 'npm run build' }, { id: 't1' })]),
    now: nowAfter(APPROVAL_MS + 1000),
  });
  assert.equal(s.kind, 'running');
});

test('長く走るツールでも 60秒を超えたら承認待ち', () => {
  const s = deriveState({
    registry: reg({ status: 'thinking' }),
    tail: tail([call('Bash', { command: 'npm run build' }, { id: 't1' })]),
    now: nowAfter(LONG_APPROVAL_MS),
  });
  assert.equal(s.kind, 'needs-approval');
  assert.match(s.reason, /60 秒来ないまま停止/);
});

test('短いツールのしきい値は 15秒のまま', () => {
  const s = deriveState({
    registry: reg({ status: 'thinking' }),
    tail: tail([call('Read', { file_path: 'C:\work\a.mjs' }, { id: 't1' })]),
    now: nowAfter(APPROVAL_MS),
  });
  assert.equal(s.kind, 'needs-approval');
  assert.match(s.reason, /15 秒来ないまま停止/);
});

test('mcp__ で始まるツールは名前を知らなくても長い側', () => {
  const s = deriveState({
    registry: reg({ status: 'thinking' }),
    tail: tail([call('mcp__まだ知らないサーバ__なにか', {}, { id: 't1' })]),
    now: nowAfter(APPROVAL_MS + 1000),
  });
  assert.equal(s.kind, 'running');
});

test('人待ち専用のツールはしきい値を待たずに確定する', () => {
  // 長い側にも短い側にも属さない。1の段で抜けるので、しきい値の変更に影響されない
  const s = deriveState({
    registry: reg({ status: 'thinking' }),
    tail: tail([call('AskUserQuestion', {}, { id: 't1' })]),
    now: nowAfter(1000),
  });
  assert.equal(s.kind, 'needs-answer');
});

/* ------------------------------------------------ 権限モードで承認待ちを抑える */
//
// auto 系では Claude が自分で許可して進むので、しきい値だけを根拠に「承認待ち」と
// 決めてはいけない。抑えるのは B5a（しきい値の段）だけで、登録簿の証言は抑えない。

test('auto では、しきい値を超えても承認待ちにしない', () => {
  const s = deriveState({
    registry: reg({ status: 'thinking' }),
    tail: tail([call('Bash', { command: 'npm run build' }, { id: 't1' })]),
    now: nowAfter(LONG_APPROVAL_MS + 1000),
    permissionMode: 'auto',
  });
  assert.equal(s.kind, 'running');
  assert.match(s.reason, /auto なので承認待ちと決めない/);
});

test('人に聞くモードなら、これまでどおり承認待ちになる', () => {
  for (const mode of ['plan', 'default', 'manual']) {
    const s = deriveState({
      registry: reg({ status: 'thinking' }),
      tail: tail([call('Edit', { file_path: 'C:\work\a.mjs' }, { id: 't1' })]),
      now: nowAfter(APPROVAL_MS + 1000),
      permissionMode: mode,
    });
    assert.equal(s.kind, 'needs-approval', `${mode} で承認待ちにならなかった`);
  }
});

test('権限モードが読めなければ、抑えずに今までの判定を出す', () => {
  // 取れなかったものを auto 扱いにすると、いちばん危ない側（見落とし）へ倒れる
  for (const mode of [null, undefined, '', 'まだ知らないモード']) {
    const s = deriveState({
      registry: reg({ status: 'thinking' }),
      tail: tail([call('Edit', { file_path: 'C:\work\a.mjs' }, { id: 't1' })]),
      now: nowAfter(APPROVAL_MS + 1000),
      permissionMode: mode,
    });
    assert.equal(s.kind, 'needs-approval', `${mode} で抑えてしまった`);
  }
});

test('auto でも、登録簿が待ちと言っているなら承認待ちにする', () => {
  // auto での唯一の受け皿。ここを抑えると本物の許可プロンプトが拾えなくなる
  const s = deriveState({
    registry: reg({ status: 'idle' }),
    tail: tail([call('Bash', { command: 'rm -rf tmp' }, { id: 't1' })]),
    now: nowAfter(QUIET_MS + 1000),
    permissionMode: 'auto',
  });
  assert.equal(s.kind, 'needs-approval');
  assert.equal(s.byStatus, true);
});

test('auto でも、質問とプランの承認は確定させる', () => {
  const q = deriveState({
    registry: reg({ status: 'busy' }),
    tail: tail([call('AskUserQuestion', {}, { id: 't1' })]),
    now: nowAfter(1000),
    permissionMode: 'auto',
  });
  assert.equal(q.kind, 'needs-answer');

  const p = deriveState({
    registry: reg({ status: 'busy' }),
    tail: tail([call('ExitPlanMode', {}, { id: 't2' })]),
    now: nowAfter(1000),
    permissionMode: 'auto',
  });
  assert.equal(p.kind, 'needs-plan-approval');
});

test('抑えた理由に経過秒を入れない', () => {
  // 毎秒動く値を reason に置くと refresh() の差分に載って詳細ペインが毎秒作り直される
  const at = (ms) => deriveState({
    registry: reg({ status: 'thinking' }),
    tail: tail([call('Bash', { command: 'npm run build' }, { id: 't1' })]),
    now: nowAfter(ms),
    permissionMode: 'auto',
  }).reason;
  assert.equal(at(LONG_APPROVAL_MS + 1000), at(LONG_APPROVAL_MS + 90_000));
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
  assert.deepEqual(s.waitingFor, { id: 't1', tool: 'Skill', detail: 'pr-review (1234)' });
});

test('返しうる状態はすべてラベルと並び順と急ぎの区別を持っている', () => {
  for (const kind of Object.keys(STATE_LABELS)) {
    assert.equal(typeof STATE_LABELS[kind], 'string', `${kind} のラベルが無い`);
    assert.equal(typeof STATE_RANK[kind], 'number', `${kind} の並び順が無い`);
    assert.equal(typeof STATE_BLOCKING[kind], 'boolean', `${kind} の blocking が無い`);
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

test('答えないと進まないのはどれか', () => {
  assert.equal(isBlocking('needs-answer'), true);
  assert.equal(isBlocking('needs-plan-approval'), true);
  assert.equal(isBlocking('needs-approval'), true);
  assert.equal(isBlocking('running'), false);
  assert.equal(isBlocking('ended'), false);
  assert.equal(isBlocking('unknown'), false);
});

test('ボールの所在と「進まないか」は別の問い', () => {
  // 返信待ちは確かにあなたのコートにある（ball）が、黙っていても Claude は困らない（blocking）。
  // ここが同じ答えになったら、どちらかの軸が要らなくなったということ
  assert.equal(ballOf('awaiting-reply'), 'master');
  assert.equal(isBlocking('awaiting-reply'), false);
});

test('知らない状態は急かさない側に倒す', () => {
  // 断定できないものを赤にしない。未知の status が来る前提のアプリなので、
  // 表に無い語が出たときの倒し方をここで固定しておく
  assert.equal(isBlocking('まだ知らない状態'), false);
  assert.equal(isBlocking(undefined), false);
  assert.equal(isBlocking(null), false);
});

// --- 通知が使う2つの手がかり ---
//
// anchorId … 待っているツールが無い状態でも「同じ待ちかどうか」を数えるための錨
// byStatus … 承認待ちの2つの経路（登録簿の裏づけ / しきい値だけ）の見分け

test('錨はログの最後の行の uuid', () => {
  const s = deriveState({
    registry: reg({ status: 'idle' }),
    tail: tail([say('はじめ', { uuid: 'u-1' }), say('おわり', { ms: 1000, uuid: 'u-2' })]),
    now: nowAfter(60_000),
  });
  assert.equal(s.kind, 'awaiting-reply');
  assert.equal(s.anchorId, 'u-2');
});

test('ターンが進めば錨も変わる', () => {
  // ここが変わらないと、通知の鍵がセッションに1つきりになって
  // 2回目以降の返信待ちが黙って落ちる
  const first = [say('1ターン目', { uuid: 'u-1' })];
  const a = deriveState({ registry: reg({ status: 'idle' }), tail: tail(first), now: nowAfter(60_000) });

  const second = [...first, prompt('つぎ', { ms: 1000 }), say('2ターン目', { ms: 2000, uuid: 'u-3' })];
  const b = deriveState({ registry: reg({ status: 'idle' }), tail: tail(second), now: nowAfter(60_000) });

  assert.equal(a.anchorId, 'u-1');
  assert.equal(b.anchorId, 'u-3');
});

test('待っているあいだ錨は動かない', () => {
  // 追記が止まっているのが返信待ちの条件なので、時刻を進めても錨は同じ
  const entries = [say('おわり', { uuid: 'u-9' })];
  const early = deriveState({ registry: reg({ status: 'idle' }), tail: tail(entries), now: nowAfter(5000) });
  const late = deriveState({ registry: reg({ status: 'idle' }), tail: tail(entries), now: nowAfter(600_000) });
  assert.equal(early.anchorId, late.anchorId);
});

test('登録簿が待ちと言っている承認待ちには裏づけが付く', () => {
  const s = deriveState({
    registry: reg({ status: 'idle' }),
    tail: tail([call('Bash', { command: 'npm run build' })]),
    now: nowAfter(QUIET_MS + 1000),
  });
  assert.equal(s.kind, 'needs-approval');
  assert.equal(s.byStatus, true);
});

test('しきい値だけが根拠の承認待ちには裏づけが付かない', () => {
  // 長く走る Bash がこの形になる。通知はこちらを送らない
  const s = deriveState({
    registry: reg({ status: 'busy' }),
    tail: tail([call('Bash', { command: 'npm run build' })]),
    now: nowAfter(LONG_APPROVAL_MS + 1000),
  });
  assert.equal(s.kind, 'needs-approval');
  assert.equal(s.byStatus, false);
});

test('実行中には裏づけを立てない', () => {
  const s = deriveState({
    registry: reg({ status: 'busy' }),
    tail: tail([call('Bash', { command: 'sleep 50' })]),
    now: nowAfter(1000),
  });
  assert.equal(s.kind, 'running');
  assert.equal(s.byStatus, false);
});

test('錨が取れない形でも落ちない', () => {
  const s = deriveState({
    registry: reg({ status: 'idle' }),
    tail: tail([{ type: 'assistant', timestamp: at(0), message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } }]),
    now: nowAfter(60_000),
  });
  // 取れなかったものを空文字などで埋めない。無いものは null
  assert.equal(s.anchorId, null);
});
