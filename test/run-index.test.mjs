/**
 * 実行の配線のテスト。
 *
 * 実物の CLI は叩かない。`spawn` を差し替えて偽の子（`fakeChild`）を返し、
 * こちらから stdout へ書き込んで「届いた」を作る。
 *
 * ここで見たいのは判断ではなく**手の動かし方**。
 * 判断そのものは `run-spec.test.mjs` と `run-ledger.test.mjs` が見ている。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRunner } from '../src/run/index.mjs';
import { createRunLedger } from '../src/run/ledger.mjs';
import { fakeChild, sAssistant, sResult, sysInit } from './helpers.mjs';

const T = 1_000_000;
const BIN = 'C:\\fake\\claude.exe';
const CWD = 'C:\\work\\demo';
const ALLOW = ['C:\\work'];

/** PassThrough の 'data' は次の tick に出るので、1回だけ待つ。 */
const settle = () => new Promise((r) => setImmediate(r));

/** 画面から来る形。 */
function req(overrides = {}) {
  return { cwd: CWD, prompt: '直して', permissionMode: 'plan', budgetUsd: 5, ...overrides };
}

/**
 * 配線を1つ組む。
 *
 * @param {object} [opts] `createRunner` への上書き
 * @returns {object} runner と、外から見たい記録
 */
function harness(opts = {}) {
  const calls = [];
  const children = [];
  const stops = [];
  let now = T;

  const runner = createRunner({
    claude: () => ({ ok: true, state: 'ok', path: BIN, version: '2.1.228', reason: null }),
    env: {},
    platform: 'win32',
    clock: () => now,
    spawnFn: (bin, args, options) => {
      calls.push({ bin, args, options });
      const child = fakeChild({ pid: 1000 + children.length });
      children.push(child);
      return child;
    },
    // 3段階の止め方そのものは claude-cli.test.mjs が見ている。ここでは結果だけ差し替える
    stopFn: async (child) => {
      stops.push(child);
      child.close(0);
      return { closed: true, stage: 'stdin', reason: null };
    },
    ...opts,
  });

  return {
    runner, calls, children, stops,
    setNow: (v) => { now = v; },
    start: (input = req()) => runner.start(input, { allowedDirs: ALLOW }),
  };
}

/** stdout へ1行流す。 */
function feed(child, line) {
  child.stdout.write(`${JSON.stringify(line)}\n`);
}

/** stdin に溜まったものを読み出す。 */
async function stdinText(child) {
  await settle();
  const chunks = [];
  let c = child.stdin.read();
  while (c !== null) {
    chunks.push(String(c));
    c = child.stdin.read();
  }
  return chunks.join('');
}

test('起こすと組んだ argv がそのまま spawn へ渡る', () => {
  const h = harness();
  const res = h.start();

  assert.equal(res.ok, true);
  assert.equal(res.status, 202);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].bin, BIN);
  assert.equal(h.calls[0].options.cwd, CWD);
  // 付け忘れると「起こしたのに無言で死ぬ」（実測）
  assert.ok(h.calls[0].args.includes('--verbose'));
  assert.ok(h.calls[0].args.includes('--session-id'));
  assert.equal(res.row.state, 'running');
  assert.equal(res.row.pid, 1000);
});

test('指示文は stdin へ書き、argv には載せない', async () => {
  const h = harness();
  const res = h.start(req({ prompt: '秘密の指示' }));

  assert.equal(h.calls[0].args.includes('秘密の指示'), false);

  const written = await stdinText(h.children[0]);
  assert.ok(written.endsWith('\n'));
  const sent = JSON.parse(written.trim());
  assert.equal(sent.type, 'user');
  assert.deepEqual(sent.message.content, [{ type: 'text', text: '秘密の指示' }]);
  assert.equal(res.row.state, 'running');
});

test('stdout と stderr の両方をその場で読み始める', () => {
  const h = harness();
  h.start();
  // 片方でも読まないとパイプが詰まって相手が終われなくなる
  assert.ok(h.children[0].stdout.listenerCount('data') > 0);
  assert.ok(h.children[0].stderr.listenerCount('data') > 0);
});

test('チャンクの境目で行が割れても畳める', async () => {
  const h = harness();
  const res = h.start();
  const child = h.children[0];

  const line = `${JSON.stringify(sAssistant('やってみる', { sessionId: res.row.sessionId }))}\n`;
  child.stdout.write(line.slice(0, 20));
  child.stdout.write(line.slice(20));
  await settle();

  const texts = h.runner.events(0).events.filter((e) => e.kind === 'text');
  assert.equal(texts.length, 1);
  assert.equal(texts[0].text, 'やってみる');
});

test('マルチバイトがチャンクの境目で割れても壊れない', async () => {
  const h = harness();
  const res = h.start();
  const child = h.children[0];

  const buf = Buffer.from(
    `${JSON.stringify(sAssistant('こんにちは', { sessionId: res.row.sessionId }))}\n`,
    'utf8',
  );
  // 「こ」は3バイト。その2バイト目で割る
  const cut = buf.indexOf(Buffer.from('こ', 'utf8')) + 1;
  child.stdout.write(buf.subarray(0, cut));
  child.stdout.write(buf.subarray(cut));
  await settle();

  const texts = h.runner.events(0).events.filter((e) => e.kind === 'text');
  assert.equal(texts.length, 1);
  assert.equal(texts[0].text, 'こんにちは');
});

test('上限を超えた行は捨てて、次の行から読み直す', async () => {
  const h = harness({ lineMax: 300 });
  const res = h.start();
  const child = h.children[0];

  child.stdout.write(`${'x'.repeat(600)}\n`);
  feed(child, sAssistant('ここは読める', { sessionId: res.row.sessionId }));
  await settle();

  const all = h.runner.events(0).events;
  // 捨てた行は broken にもしない（読めなかったのではなく、読まなかった）
  assert.equal(all.some((e) => e.kind === 'broken'), false);
  assert.equal(all.filter((e) => e.kind === 'text').length, 1);
  assert.equal(all.find((e) => e.kind === 'text').text, 'ここは読める');
});

test('改行の付いていない最後の1行も、閉じるときに拾う', async () => {
  const h = harness();
  const res = h.start();
  const child = h.children[0];

  child.stdout.write(JSON.stringify(sAssistant('最後', { sessionId: res.row.sessionId })));
  await settle();
  assert.equal(h.runner.events(0).events.some((e) => e.kind === 'text'), false);

  child.close(0);
  await settle();
  assert.equal(h.runner.events(0).events.some((e) => e.kind === 'text'), true);
});

test('速報は購読者へ届く', async () => {
  const h = harness();
  const got = [];
  h.runner.subscribe((evs) => got.push(...evs));

  const res = h.start();
  feed(h.children[0], sysInit({ sessionId: res.row.sessionId }));
  await settle();

  assert.ok(got.length >= 1);
  assert.ok(got.some((e) => e.kind === 'init'));
  // seq は単調増加。再送の起点になるので飛ばさない
  const seqs = got.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
});

test('購読をやめられる', async () => {
  const h = harness();
  const got = [];
  const off = h.runner.subscribe((evs) => got.push(...evs));
  const res = h.start();
  off();

  feed(h.children[0], sAssistant('あとの分', { sessionId: res.row.sessionId }));
  await settle();

  assert.equal(got.some((e) => e.kind === 'text'), false);
});

test('購読者が投げても読み取りは止まらない', async () => {
  const h = harness();
  h.runner.subscribe(() => { throw new Error('届け先の都合'); });
  const res = h.start();

  feed(h.children[0], sAssistant('平気', { sessionId: res.row.sessionId }));
  await settle();

  assert.equal(h.runner.events(0).events.some((e) => e.kind === 'text'), true);
});

test('claude を掴めていなければ 503 で、台帳に足さない', () => {
  const h = harness({
    claude: () => ({ ok: false, state: 'missing', path: null, reason: '見つかりません' }),
  });
  const res = h.start();

  assert.equal(res.ok, false);
  assert.equal(res.status, 503);
  assert.equal(res.reason, '見つかりません');
  assert.equal(h.calls.length, 0);
  assert.equal(h.runner.rows().length, 0);
});

test('許可していないフォルダは 400 で、spawn まで行かない', () => {
  const h = harness();
  const res = h.runner.start(req({ cwd: 'C:\\other' }), { allowedDirs: ALLOW });

  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.equal(h.calls.length, 0);
  assert.equal(h.runner.rows().length, 0);
});

test('本数の上限を超えたら 429。spawn を1回も増やさない', () => {
  const h = harness({ ledger: createRunLedger({ max: 1, minIntervalMs: 0 }) });
  assert.equal(h.start().ok, true);

  const res = h.start();
  assert.equal(res.ok, false);
  assert.equal(res.status, 429);
  assert.equal(h.calls.length, 1);
});

test('連打は 429 で止まる（時計を進めていない）', () => {
  const h = harness();
  assert.equal(h.start().ok, true);
  assert.equal(h.start().status, 429);
});

test('spawn に失敗したら 500 で、その run は failed', () => {
  const h = harness({
    spawnFn: () => { throw new Error('ENOENT'); },
  });
  const res = h.start();

  assert.equal(res.ok, false);
  assert.equal(res.status, 500);
  assert.equal(res.row.state, 'failed');
  assert.ok(res.row.reason.includes('ENOENT'));
});

test('error と close が両方来ても二重に確定しない', async () => {
  const h = harness();
  const res = h.start();
  const child = h.children[0];

  child.emit('error', new Error('起こせませんでした'));
  child.close(1);
  await settle();

  const row = h.runner.get(res.runId);
  assert.equal(row.state, 'failed');
  // 先に立った理由が残る。後から来た close で言い換えない
  assert.equal(row.reason, '起こせませんでした');
  assert.equal(row.exitCode, 1);
});

test('異常終了したら標準エラーの最後の行を理由にする', async () => {
  const h = harness();
  const res = h.start();
  const child = h.children[0];

  // --verbose を外したときの実測。これが拾えないと code 1 しか残らない
  child.stderr.write('Error: When using --print, --output-format=stream-json requires --verbose\n');
  await settle();
  child.close(1);
  await settle();

  const row = h.runner.get(res.runId);
  assert.equal(row.state, 'failed');
  assert.ok(row.reason.includes('requires --verbose'));
});

test('自分で止めたときは標準エラーを理由にしない', async () => {
  const h = harness();
  const res = h.start();
  h.children[0].stderr.write('Warning: なんとか\n');
  await settle();

  await h.runner.stop(res.runId);
  await settle();

  const row = h.runner.get(res.runId);
  assert.equal(row.state, 'stopped');
  assert.equal(row.reason, null);
});

test('予算超過の result が来たら子を落としにいく', async () => {
  const h = harness();
  const res = h.start();

  feed(h.children[0], sResult({
    sessionId: res.row.sessionId,
    subtype: 'error_max_budget_usd',
    isError: true,
    terminal_reason: 'budget_exhausted',
    errors: ['Reached maximum budget ($0.01)'],
  }));
  await settle();

  // 実測でプロセスは死なない。台帳が終わりと決めたら殻が落とす
  assert.equal(h.stops.length, 1);
  assert.equal(h.runner.get(res.runId).state, 'failed');
});

test('別のセッションの行が来たら止めにいく', async () => {
  const h = harness();
  const res = h.start();

  feed(h.children[0], sAssistant('よそのログ', { sessionId: 'まったく別の id' }));
  await settle();

  assert.equal(h.stops.length, 1);
  const row = h.runner.get(res.runId);
  assert.equal(row.state, 'failed');
  assert.ok(row.reason.includes('セッションIDが一致しません'));
});

test('終端に落ちた後に届いた行は捨てる', async () => {
  const h = harness();
  const res = h.start();
  const child = h.children[0];

  child.close(1);
  await settle();
  feed(child, sAssistant('遅れて届いた', { sessionId: res.row.sessionId }));
  await settle();

  assert.equal(h.runner.events(0).events.some((e) => e.kind === 'text'), false);
});

test('閉じた子への入力は 409 で、run は failed になる', async () => {
  const h = harness();
  const res = h.start();
  const child = h.children[0];

  await stdinText(child);
  child.stdin.destroy();

  const sent = h.runner.input(res.runId, '続けて');
  assert.equal(sent.ok, false);
  assert.equal(sent.status, 409);
  assert.equal(h.runner.get(res.runId).state, 'failed');
});

test('1往復で閉じた run は --resume で起こし直す', async () => {
  const h = harness();
  const res = h.start();
  const sid = res.row.sessionId;
  const child = h.children[0];

  feed(child, sResult({ sessionId: sid }));
  await settle();
  assert.equal(h.runner.get(res.runId).state, 'waiting');

  child.close(0);
  await settle();
  const after = h.runner.get(res.runId);
  assert.equal(after.state, 'waiting');
  assert.equal(after.perTurn, true);

  const sent = h.runner.input(res.runId, '続けて');
  assert.equal(sent.ok, true);
  assert.equal(sent.status, 202);
  assert.equal(h.calls.length, 2);
  // ID は変えない。変えると一覧・詳細・?session= が全部切れる
  assert.deepEqual(h.calls[1].args.slice(-2), ['--resume', sid]);
  assert.equal(h.runner.get(res.runId).sessionId, sid);

  const written = await stdinText(h.children[1]);
  assert.equal(JSON.parse(written.trim()).message.content[0].text, '続けて');
});

test('動いている run への入力はそのまま stdin へ流す', async () => {
  const h = harness();
  const res = h.start();
  await stdinText(h.children[0]);

  const sent = h.runner.input(res.runId, 'つづき');
  assert.equal(sent.ok, true);
  assert.equal(h.calls.length, 1);

  const written = await stdinText(h.children[0]);
  assert.equal(JSON.parse(written.trim()).message.content[0].text, 'つづき');
});

test('空の指示・長すぎる指示・知らない run は断る', () => {
  const h = harness();
  const res = h.start();

  assert.equal(h.runner.input(res.runId, '   ').status, 400);
  assert.equal(h.runner.input(res.runId, 'あ'.repeat(64001)).status, 400);
  assert.equal(h.runner.input('r99', 'やあ').status, 404);
});

test('終わった run への入力は 409', async () => {
  const h = harness();
  const res = h.start();
  h.children[0].close(1);
  await settle();

  const sent = h.runner.input(res.runId, 'まだいける？');
  assert.equal(sent.ok, false);
  assert.equal(sent.status, 409);
});

test('止めると stopped になる', async () => {
  const h = harness();
  const res = h.start();

  const out = await h.runner.stop(res.runId);
  assert.equal(out.ok, true);
  assert.equal(out.row.state, 'stopped');
  assert.equal(h.stops.length, 1);
});

test('もう終わっている run を止めても失敗にしない', async () => {
  const h = harness();
  const res = h.start();
  h.children[0].close(0);
  await settle();

  const out = await h.runner.stop(res.runId);
  assert.equal(out.ok, true);
  assert.equal(out.status, 200);
  // 既に閉じているので、止めにはいかない
  assert.equal(h.stops.length, 0);
});

test('止めきれなかったら failed にして、残っていることを理由に書く', async () => {
  const h = harness({
    stopFn: async () => ({ closed: false, stage: 'force', reason: '止めきれませんでした（残っている可能性があります）' }),
  });
  const res = h.start();

  const out = await h.runner.stop(res.runId);
  assert.equal(out.closed, false);
  assert.equal(out.row.state, 'failed');
  assert.ok(out.row.reason.includes('残っている'));
});

test('知らない run を止めたら 404', async () => {
  const h = harness();
  const out = await h.runner.stop('r99');
  assert.equal(out.ok, false);
  assert.equal(out.status, 404);
});

/*
 * ------------------------------------------------------------ 替えて続ける
 *
 * 畳んでから起こし直す。順が逆になると、同じ会話ログへ2つのプロセスが書きうる。
 * だから**断る判断はすべて畳む前**に済ませる。
 * 下のテストが `h.stops.length` と `h.calls.length` を見張っているのはそのため。
 */

test('替えて続けると、畳んでから --resume で起こし直す', async () => {
  const h = harness();
  const res = h.start();
  const sid = res.row.sessionId;
  await stdinText(h.children[0]);

  const out = await h.runner.switch(res.runId, { model: 'claude-sonnet-5' }, 'つづき');

  assert.equal(out.ok, true);
  assert.equal(out.status, 202);
  assert.deepEqual(out.changed, ['model']);
  // 前の子を畳んでから、新しい子を1つだけ起こす
  assert.equal(h.stops.length, 1);
  assert.equal(h.calls.length, 2);
  // ID は変えない（--fork-session を使わない）
  const at = h.calls[1].args.indexOf('--resume');
  assert.ok(at >= 0, '--resume が付いていない');
  assert.equal(h.calls[1].args[at + 1], sid);
  assert.ok(h.calls[1].args.includes('claude-sonnet-5'));

  const row = h.runner.get(res.runId);
  assert.equal(row.state, 'running');
  assert.equal(row.model, 'claude-sonnet-5');
  assert.equal(row.sessionId, sid);
  assert.equal(row.resume, true);

  // 指示文は argv ではなく、新しい子の stdin へ
  const written = await stdinText(h.children[1]);
  assert.equal(JSON.parse(written.trim()).message.content[0].text, 'つづき');
});

test('1往復で閉じている run は、畳む工程を飛ばして起こし直す', async () => {
  const h = harness();
  const res = h.start();
  const child = h.children[0];

  feed(child, sResult({ sessionId: res.row.sessionId }));
  await settle();
  child.close(0);
  await settle();
  assert.equal(h.runner.get(res.runId).state, 'waiting');

  const out = await h.runner.switch(res.runId, { effort: 'high' }, 'つづき');

  assert.equal(out.ok, true);
  assert.deepEqual(out.changed, ['effort']);
  // もう閉じている相手を止めにいかない
  assert.equal(h.stops.length, 0);
  assert.equal(h.calls.length, 2);
  assert.equal(h.runner.get(res.runId).state, 'running');
  assert.equal(h.runner.get(res.runId).effort, 'high');
});

test('断るだけのときは子を畳まない', async () => {
  const h = harness();
  const res = h.start();
  const patch = { model: 'claude-sonnet-5' };

  const cases = [
    ['知らない run', h.runner.switch('r99', patch, 'つづき'), 404],
    ['替える中身が無い', h.runner.switch(res.runId, {}, 'つづき'), 400],
    ['patch が object ではない', h.runner.switch(res.runId, 'claude-sonnet-5', 'つづき'), 400],
    ['同じ指定', h.runner.switch(res.runId, { permissionMode: 'plan' }, 'つづき'), 400],
    ['権限モードを外そうとした', h.runner.switch(res.runId, { permissionMode: '' }, 'つづき'), 400],
    ['文字列でない指定', h.runner.switch(res.runId, { model: 5 }, 'つづき'), 400],
    ['CLI が読めない名前', h.runner.switch(res.runId, { model: '-rf' }, 'つづき'), 400],
    ['指示が空', h.runner.switch(res.runId, patch, '   '), 400],
    ['指示が長すぎる', h.runner.switch(res.runId, patch, 'あ'.repeat(64001)), 400],
  ];

  for (const [label, promise, status] of cases) {
    const out = await promise;
    assert.equal(out.ok, false, label);
    assert.equal(out.status, status, label);
    assert.ok(out.reason, `${label}: 理由を付けずに断らない`);
  }

  assert.equal(h.stops.length, 0, '断るだけのときに子を殺してはいけない');
  assert.equal(h.calls.length, 1);
  assert.equal(h.runner.get(res.runId).state, 'running');
});

test('終わった run は替えられない', async () => {
  const h = harness();
  const res = h.start();
  h.children[0].close(1);
  await settle();

  const out = await h.runner.switch(res.runId, { model: 'claude-sonnet-5' }, 'つづき');
  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  assert.equal(h.calls.length, 1);
});

test('claude を掴めていなければ 503。前の子はそのまま', async () => {
  let found = { ok: true, state: 'ok', path: BIN, version: '2.1.228', reason: null };
  const h = harness({ claude: () => found });
  const res = h.start();

  // 起こした後に消えた形（更新で入れ替わった・PATH が変わった）
  found = { ok: false, state: 'missing', path: null, version: null, reason: '見つかりません' };
  const out = await h.runner.switch(res.runId, { model: 'claude-sonnet-5' }, 'つづき');

  assert.equal(out.ok, false);
  assert.equal(out.status, 503);
  assert.equal(out.reason, '見つかりません');
  assert.equal(h.stops.length, 0);
  assert.equal(h.runner.get(res.runId).state, 'running');
});

test('畳んでいるあいだに止められたら、起こし直さない', async () => {
  const ledger = createRunLedger({ minIntervalMs: 0 });
  let target = null;
  const h = harness({
    ledger,
    stopFn: async (child) => {
      // 畳んでいる最中に「止めて」が届いた形。`switching` から外れる
      if (target) ledger.markStopping(target, T);
      child.close(0);
      return { closed: true, stage: 'stdin', reason: null };
    },
  });
  const res = h.start();
  target = res.runId;

  const out = await h.runner.switch(res.runId, { model: 'claude-sonnet-5' }, 'つづき');

  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  // isRunOver だけを見ていると stopping を素通りして、ここで新しい子が立つ
  assert.equal(h.calls.length, 1);
});

test('前の子を止めきれなければ 500。起こし直さない', async () => {
  const h = harness({
    stopFn: async () => ({ closed: false, stage: 'force', reason: '止めきれませんでした（残っている可能性があります）' }),
  });
  const res = h.start();

  const out = await h.runner.switch(res.runId, { model: 'claude-sonnet-5' }, 'つづき');

  assert.equal(out.ok, false);
  assert.equal(out.status, 500);
  assert.equal(h.calls.length, 1);
  assert.equal(h.runner.get(res.runId).state, 'failed');
});

test('livePids は生きている子の PID だけ返す', async () => {
  const h = harness({ ledger: createRunLedger({ minIntervalMs: 0 }) });
  const a = h.start();
  h.start();

  assert.deepEqual([...h.runner.livePids()].sort(), [1000, 1001]);

  await h.runner.stop(a.runId);
  await settle();
  // 畳んだぶんは配らない（process.on('exit') から二重に殺しにいかない）
  assert.deepEqual(h.runner.livePids(), [1001]);
});

test('shutdown で動いているものを全部止める', async () => {
  const h = harness({ ledger: createRunLedger({ minIntervalMs: 0 }) });
  const a = h.start();
  const b = h.start();

  await h.runner.shutdown();

  assert.equal(h.stops.length, 2);
  assert.equal(h.runner.get(a.runId).state, 'stopped');
  assert.equal(h.runner.get(b.runId).state, 'stopped');
});

test('tick が沈黙を拾う', () => {
  const h = harness({ ledger: createRunLedger({ stallMs: 1000 }) });
  const res = h.start();

  h.setNow(T + 5000);
  const changed = h.runner.tick();

  assert.deepEqual(changed, [res.runId]);
  assert.equal(h.runner.get(res.runId).state, 'stalled');
});

test('rows と stats は台帳をそのまま見せる', () => {
  const h = harness();
  const res = h.start();

  const [row] = h.runner.rows();
  assert.equal(row.runId, res.runId);
  assert.equal(row.cwd, CWD);
  // 毎秒動く値を混ぜない（refresh() の差分判定を素通りして毎秒 push になる）
  for (const key of ['lastLineAt', 'counts', 'costUSD', 'idleMs']) {
    assert.equal(key in row, false, `${key} を rows() に載せてはいけない`);
  }
  assert.equal(h.runner.stats().active, 1);
});
