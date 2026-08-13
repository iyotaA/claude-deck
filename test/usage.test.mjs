/**
 * 数値の集計。
 *
 * ここが間違うと、画面に出る数字が静かに嘘になる。
 * とくに重複排除は、知らずに書くと約2倍になるうえ、
 * 出た数字がそれらしく見えるので目視では気づけない。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildUsage, ITE_WEIGHTS } from '../src/parse/usage.mjs';
import { prompt, reply, result, synthetic } from './helpers.mjs';

test('同じ requestId の3行を1回として数える', () => {
  // 1回の応答が thinking / text / tool_use の複数行に分かれ、全行が同じ usage を持つ（実測）
  const usage = { in: 10, cr: 100, cw: 50, out: 20 };
  const u = buildUsage([
    reply('考えている', { ms: 0, requestId: 'r1', usage }),
    reply('答えです', { ms: 1, requestId: 'r1', usage }),
    reply('', { ms: 2, requestId: 'r1', usage, uses: [{ id: 't1', name: 'Read' }] }),
  ]);

  assert.equal(u.requests, 1);
  assert.equal(u.duplicateLines, 2);
  assert.equal(u.totals.in, 10);
  assert.equal(u.totals.cacheRead, 100);
  assert.equal(u.totals.out, 20);
  // 10 + 100*0.1 + 50*1.25 + 20*5 = 182.5
  assert.equal(u.totals.ite, 183);
});

test('重複した行にしか無い tool_use も拾う', () => {
  // usage は最初の行から採るが、tool_use は全行から集める。
  // 最初の行だけを見ると、ツール呼び出しをまるごと取りこぼす
  const usage = { in: 10, out: 5 };
  const u = buildUsage([
    reply('まず調べる', { ms: 0, requestId: 'r1', usage }),
    reply('', { ms: 1, requestId: 'r1', usage, uses: [{ id: 't1', name: 'Read' }] }),
  ]);

  assert.equal(u.requests, 1);
  assert.deepEqual(u.tools.map((t) => [t.tool, t.calls]), [['Read', 1]]);
});

test('<synthetic> の行を要求の数に入れない', () => {
  const u = buildUsage([
    reply('答え', { requestId: 'r1', usage: { in: 10, out: 5 } }),
    synthetic('API Error: 500'),
  ]);

  assert.equal(u.requests, 1);
  assert.equal(u.syntheticSkipped, 1);
  assert.equal(u.totals.in, 10);
});

test('入れ子の cache_creation が平坦な値と食い違うとき、大きいほうを採る', () => {
  // 実データに cache_creation_input_tokens: 0 なのに ephemeral_1h が 132,640 という行がある
  const u = buildUsage([
    reply('', { requestId: 'r1', usage: { cw: 0, cw1h: 132640 } }),
  ]);

  assert.equal(u.totals.cacheWrite1h, 132640);
  assert.equal(u.totals.cacheWrite5m, 0);
  assert.equal(u.totals.ite, 132640 * ITE_WEIGHTS.cacheWrite1h);
});

test('入れ子が無ければ、平坦な書き込みは5分ぶんとして数える', () => {
  // 内訳が分からないときに1時間ぶんと見なすと、重みが 1.25 から 2.0 に変わって過大になる
  const u = buildUsage([
    reply('', { requestId: 'r1', usage: { cw: 5000 } }),
  ]);

  assert.equal(u.totals.cacheWrite5m, 5000);
  assert.equal(u.totals.cacheWrite1h, 0);
  assert.equal(u.totals.ite, 6250);
});

test('文脈保有量は合計せず、最後・最大・伸び方を出す', () => {
  const u = buildUsage([
    reply('', { ms: 0, requestId: 'r1', usage: { in: 100 } }),
    reply('', { ms: 1, requestId: 'r2', usage: { in: 300 } }),
    reply('', { ms: 2, requestId: 'r3', usage: { in: 250 } }),
  ]);

  assert.equal(u.context.last, 250);
  assert.equal(u.context.peak, 300);
  assert.equal(u.context.growth.max, 200);
  // 縮んだぶん（-50）も伸び方の分布には含める。丸めて隠すと圧縮が見えなくなる
  assert.equal(u.context.growth.median, 200);
});

test('キャッシュ命中率は読み ÷（読み＋入力＋書き）', () => {
  const u = buildUsage([
    reply('', { requestId: 'r1', usage: { in: 100, cr: 900 } }),
  ]);

  assert.equal(u.cache.hitRate, 0.9);
});

test('ツールが1つなら、伸びたぶんをまるごと帰属させる', () => {
  const u = buildUsage([
    reply('', { ms: 0, requestId: 'r1', usage: { in: 10, cr: 1000, out: 100 }, uses: [{ id: 't1', name: 'Read' }] }),
    result('t1', { ms: 1 }),
    reply('', { ms: 2, requestId: 'r2', usage: { in: 10, cr: 1910, out: 50 } }),
  ]);

  // Δ = 1920 - 1010 = 910、材料 = 910 - 100（前回の出力）= 810
  const read = u.tools.find((t) => t.tool === 'Read');
  assert.equal(read.tokens, 810);
  assert.equal(read.calls, 1);
  assert.equal(read.avg, 810);
  assert.equal(read.max, 810);
});

test('ツールが複数で重みが取れなければ均等に割る', () => {
  const u = buildUsage([
    reply('', {
      ms: 0,
      requestId: 'r1',
      usage: { in: 10, cr: 1000, out: 100 },
      uses: [{ id: 't1', name: 'Read' }, { id: 't2', name: 'Edit' }],
    }),
    reply('', { ms: 2, requestId: 'r2', usage: { in: 10, cr: 1910, out: 50 } }),
  ]);

  assert.equal(u.tools.find((t) => t.tool === 'Read').tokens, 405);
  assert.equal(u.tools.find((t) => t.tool === 'Edit').tokens, 405);
});

test('ツールが複数なら、結果の大きさで按分する', () => {
  const u = buildUsage([
    reply('', {
      ms: 0,
      requestId: 'r1',
      usage: { in: 10, cr: 1000, out: 100 },
      uses: [{ id: 't1', name: 'Read' }, { id: 't2', name: 'Edit' }],
    }),
    result('t1', { ms: 1, text: 'x'.repeat(3000) }),
    result('t2', { ms: 1, text: 'ok' }),
    reply('', { ms: 2, requestId: 'r2', usage: { in: 10, cr: 1910, out: 50 } }),
  ]);

  const read = u.tools.find((t) => t.tool === 'Read');
  const edit = u.tools.find((t) => t.tool === 'Edit');
  assert.ok(read.tokens > edit.tokens, `Read=${read.tokens} Edit=${edit.tokens}`);
  assert.ok(edit.tokens > 0, '小さいほうも 0 にはしない');
  // 丸めの誤差ぶんだけ材料（810）とずれる。ずれは1トークン以内に収める
  assert.ok(Math.abs(read.tokens + edit.tokens - 810) <= 1);
});

test('文脈が縮んだ回は 0 に丸め、丸めたことを数える', () => {
  const u = buildUsage([
    reply('', { ms: 0, requestId: 'r1', usage: { in: 10, cr: 1000, out: 100 }, uses: [{ id: 't1', name: 'Read' }] }),
    reply('', { ms: 2, requestId: 'r2', usage: { in: 10, cr: 200, out: 50 } }),
  ]);

  assert.equal(u.toolsUnattributed.negativeCount, 1);
  assert.equal(u.tools.find((t) => t.tool === 'Read').tokens, 0);
  // 呼んだ事実は残す。「使っていない」と「測れなかった」を混ぜない
  assert.equal(u.tools.find((t) => t.tool === 'Read').calls, 1);
});

test('ツールを呼んでいないのに伸びたぶんは別枠にする', () => {
  const u = buildUsage([
    reply('答え', { ms: 0, requestId: 'r1', usage: { in: 10, cr: 1000, out: 100 } }),
    prompt('つづきをお願い', { ms: 1 }),
    reply('答え', { ms: 2, requestId: 'r2', usage: { in: 10, cr: 1500, out: 50 } }),
  ]);

  assert.equal(u.toolsUnattributed.noToolTokens, 400);
  assert.deepEqual(u.tools, []);
});

test('サブエージェントの行は既定で見ない', () => {
  const entries = [
    reply('親', { ms: 0, requestId: 'r1', usage: { in: 10 } }),
    { ...reply('子', { ms: 1, requestId: 'r2', usage: { in: 20 } }), isSidechain: true },
  ];

  assert.equal(buildUsage(entries).totals.in, 10);
  assert.equal(buildUsage(entries, { sidechain: true }).totals.in, 20);
});

test('使ったモデルは最頻のものを代表にし、内訳も返す', () => {
  const u = buildUsage([
    reply('', { ms: 0, requestId: 'r1', usage: { in: 1 }, model: 'claude-opus-5' }),
    reply('', { ms: 1, requestId: 'r2', usage: { in: 1 }, model: 'claude-opus-5' }),
    reply('', { ms: 2, requestId: 'r3', usage: { in: 1 }, model: 'claude-opus-4-8' }),
  ]);

  assert.equal(u.model, 'claude-opus-5');
  assert.deepEqual(u.models, [
    { model: 'claude-opus-5', requests: 2 },
    { model: 'claude-opus-4-8', requests: 1 },
  ]);
});

test('要求が1件も無ければ、合計は 0 で、測れない値は null', () => {
  const u = buildUsage([]);

  assert.equal(u.requests, 0);
  assert.equal(u.totals.in, 0);
  assert.equal(u.totals.ite, 0);
  assert.equal(u.context.last, null);
  assert.equal(u.context.peak, null);
  assert.equal(u.context.growth, null);
  assert.equal(u.cache.hitRate, null);
  assert.equal(u.model, null);
  assert.deepEqual(u.tools, []);
});

test('要求が1件だけなら、伸び方は測れないので null', () => {
  const u = buildUsage([reply('', { requestId: 'r1', usage: { in: 100 } })]);

  assert.equal(u.context.last, 100);
  assert.equal(u.context.peak, 100);
  assert.equal(u.context.growth, null);
});

test('未知の形が来ても落ちない', () => {
  const u = buildUsage([
    null,
    'ただの文字列',
    { type: 'assistant' },
    { type: 'assistant', requestId: 'r1' },
    { type: 'assistant', requestId: 'r2', message: { usage: 'こわれている' } },
    { type: 'assistant', requestId: 'r3', message: { usage: { input_tokens: -5, output_tokens: 'x' } } },
  ]);

  // usage を読めたのは r3 だけ。負値と文字列は 0 として扱う
  assert.equal(u.requests, 1);
  assert.equal(u.totals.in, 0);
  assert.equal(u.totals.out, 0);
  // requestId を持たない行（{type:'assistant'} だけの行）も、数えられない側へ寄せる。
  // 実データでは <synthetic> しか該当しないが、壊れた行も同じ扱いでよい
  assert.equal(u.syntheticSkipped, 1);
});

test('ログの順が乱れていても時刻で並べ直す', () => {
  const u = buildUsage([
    reply('', { ms: 200, requestId: 'r2', usage: { in: 300 } }),
    reply('', { ms: 100, requestId: 'r1', usage: { in: 100 } }),
  ]);

  assert.equal(u.context.last, 300);
  assert.equal(u.context.growth.max, 200);
});
