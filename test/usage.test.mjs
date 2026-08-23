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
import { at, prompt, reply, result, synthetic } from './helpers.mjs';

/** スキルを呼んだ要求を1つ作る小道具。長い uses の綴りをテストの本文から追い出す。 */
function callSkill(name, { ms, requestId, id, usage = { in: 1 } }) {
  return reply('', { ms, requestId, usage, uses: [{ id, name: 'Skill', input: { skill: name } }] });
}

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
  // 絵にする系列も、空配列ではなく null。「測って0件」と「測りようがない」を分ける
  assert.equal(u.context.series, null);
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

test('要求が少ないうちは、文脈の系列をそのまま返す', () => {
  const u = buildUsage([
    reply('', { ms: 0, requestId: 'r1', usage: { in: 100 } }),
    reply('', { ms: 1, requestId: 'r2', usage: { in: 300 } }),
    reply('', { ms: 2, requestId: 'r3', usage: { in: 250 } }),
  ]);

  assert.deepEqual(u.context.series, [100, 300, 250]);
});

test('要求が多いときは間引くが、先頭と末尾は必ず残す', () => {
  // 画面のスパークラインを描くためだけの値。300 要求あっても 300 点は返さない
  const entries = [];
  for (let i = 0; i < 300; i += 1) {
    entries.push(reply('', { ms: i, requestId: `r${i}`, usage: { in: i + 1 } }));
  }
  const u = buildUsage(entries);

  assert.equal(u.context.series.length, 120);
  // 間引きは形を見るためのもの。両端がずれると、絵の左右が実際の値と食い違う
  assert.equal(u.context.series[0], 1);
  assert.equal(u.context.series[119], 300);
  // 最大値は間引きの結果からではなく peak から出す（山をまたぐことがあるため）
  assert.equal(u.context.peak, 300);
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

test('スキル区間は呼んだ次の要求から、次のあなたの番まで', () => {
  const u = buildUsage([
    callSkill('pr-review', { ms: 0, requestId: 'r1', id: 's1', usage: { in: 1000, out: 100 } }),
    result('s1', { ms: 1 }),
    reply('', { ms: 2, requestId: 'r2', usage: { in: 2000, out: 200 } }),
    reply('', { ms: 3, requestId: 'r3', usage: { in: 3000, out: 300 } }),
    prompt('ありがと', { ms: 4 }),
    reply('', { ms: 5, requestId: 'r4', usage: { in: 4000, out: 400 } }),
  ]);

  const s = u.skills.find((x) => x.skill === 'pr-review');
  assert.equal(s.runs, 1);
  // 数えるのは r2 と r3 だけ。
  // 呼んだ要求（r1）にはスキルの本文がまだ積まれていないので入れない。
  // あなたが発言したあと（r4）は、もうスキルの続きではない
  assert.equal(s.requests, 2);
  // (2000 + 200×5) + (3000 + 300×5) = 3000 + 4500
  assert.equal(s.ite, 7500);
  assert.equal(s.avg, 7500);
});

test('スキル区間は4つの障壁のどれでも切れる', () => {
  const barriers = {
    あなたの発言: prompt('つぎこれやって', { ms: 3 }),
    スラッシュコマンド: prompt('<command-name>/clear</command-name>', { ms: 3 }),
    中断: prompt('[Request interrupted by user]', { ms: 3 }),
    圧縮の境目: { type: 'system', subtype: 'compact_boundary', timestamp: at(3) },
  };

  for (const [name, barrier] of Object.entries(barriers)) {
    const u = buildUsage([
      callSkill('test-review', { ms: 0, requestId: 'r1', id: 's1' }),
      reply('', { ms: 2, requestId: 'r2', usage: { in: 100 } }),
      barrier,
      reply('', { ms: 4, requestId: 'r3', usage: { in: 1000 } }),
    ]);

    assert.equal(u.skills[0].requests, 1, `${name} で切れていない`);
    assert.equal(u.skills[0].ite, 100, `${name} で切れていない`);
  }
});

test('次のスキルを呼んだ要求は、前のスキルの区間の最後として数える', () => {
  const u = buildUsage([
    callSkill('a', { ms: 0, requestId: 'r1', id: 's1' }),
    reply('', { ms: 1, requestId: 'r2', usage: { in: 100 } }),
    callSkill('b', { ms: 2, requestId: 'r3', id: 's2', usage: { in: 200 } }),
    reply('', { ms: 3, requestId: 'r4', usage: { in: 400 } }),
  ]);

  // a は r2 と r3。r3 は「a のもとで働いた最後の1回」なので含める
  const a = u.skills.find((x) => x.skill === 'a');
  assert.equal(a.requests, 2);
  assert.equal(a.ite, 300);

  const b = u.skills.find((x) => x.skill === 'b');
  assert.equal(b.requests, 1);
  assert.equal(b.ite, 400);
});

test('同じスキルを2回呼んだら、回数を足して合算する', () => {
  const u = buildUsage([
    callSkill('pr-review', { ms: 0, requestId: 'r1', id: 's1' }),
    reply('', { ms: 1, requestId: 'r2', usage: { in: 100 } }),
    prompt('つぎ', { ms: 2 }),
    callSkill('pr-review', { ms: 3, requestId: 'r3', id: 's2' }),
    reply('', { ms: 4, requestId: 'r4', usage: { in: 300 } }),
  ]);

  assert.deepEqual(u.skills, [{ skill: 'pr-review', runs: 2, requests: 2, ite: 400, avg: 200 }]);

  // **畳む前も返す。** 実データで document-writing-style は5回・平均 213k だったが、
  // 中身は 214k → 101k → 619k → 118k → 13k と桁が動いていた。
  // 平均だけでは「前回より軽くなったか」が読めない
  assert.deepEqual(u.skillRuns.map((r) => [r.skill, r.ite, r.requests]), [
    ['pr-review', 100, 1],
    ['pr-review', 300, 1],
  ]);
  // 並べるための時刻。呼んだ順（昇順）で、絵も左から右へこの順に描く
  assert.ok(u.skillRuns[0].at < u.skillRuns[1].at, '時刻の昇順で並ぶ');
});

test('1回の要求で2つ呼んだら、区間のぶんを等分する', () => {
  const u = buildUsage([
    reply('', {
      ms: 0,
      requestId: 'r1',
      usage: { in: 1 },
      uses: [
        { id: 's1', name: 'Skill', input: { skill: 'a' } },
        { id: 's2', name: 'Skill', input: { skill: 'b' } },
      ],
    }),
    reply('', { ms: 1, requestId: 'r2', usage: { in: 100 } }),
  ]);

  // どちらのぶんかは分けられない。片方へ寄せずに半分ずつ持たせる
  assert.deepEqual(u.skills.map((s) => [s.skill, s.runs, s.ite]), [['a', 1, 50], ['b', 1, 50]]);

  // 畳む前も同じ等分にする。**丸めるのは1件ごと。** 足してから丸めると
  // 端数が積もって skills 側の合計と食い違う
  assert.deepEqual(u.skillRuns.map((r) => [r.skill, r.ite]), [['a', 50], ['b', 50]]);
  // 同じ要求から出た2件なので時刻も同じ。どちらが先ということは無い
  assert.equal(u.skillRuns[0].at, u.skillRuns[1].at);
});

test('スキルを呼んでいなければ、スキルの集計は空', () => {
  const u = buildUsage([reply('', { requestId: 'r1', usage: { in: 100 } })]);

  assert.deepEqual(u.skills, []);
  // 畳む前も空。[] を返す（「呼んでいない」は測れているので null ではない）
  assert.deepEqual(u.skillRuns, []);
});

test('ログの順が乱れていても時刻で並べ直す', () => {
  const u = buildUsage([
    reply('', { ms: 200, requestId: 'r2', usage: { in: 300 } }),
    reply('', { ms: 100, requestId: 'r1', usage: { in: 100 } }),
  ]);

  assert.equal(u.context.last, 300);
  assert.equal(u.context.growth.max, 200);
});

// --- 文脈の圧縮 ------------------------------------------------------------

/**
 * 圧縮の境目を1つ作る。
 *
 * @param {number} ms 時刻
 * @param {object|null} meta compactMetadata。null なら付けない
 * @param {object} [rest] isSidechain など
 */
const boundary = (ms, meta, rest = {}) => ({
  type: 'system',
  subtype: 'compact_boundary',
  timestamp: at(ms),
  ...(meta ? { compactMetadata: meta } : {}),
  ...rest,
});

test('圧縮が無ければ 0 回。捨てた量は「不明」で 0 ではない', () => {
  const u = buildUsage([reply('', { requestId: 'r1', usage: { in: 100 } })]);

  assert.equal(u.compact.count, 0);
  // 一度も圧縮していないのだから「捨てた量」は測れていない。0 と書くと測ったように見える
  assert.equal(u.compact.dropped, null);
});

test('cumulativeDroppedTokens は累積なので足さずに大きいほうを採る', () => {
  const u = buildUsage([
    boundary(1, { trigger: 'auto', preTokens: 170000, postTokens: 8000, cumulativeDroppedTokens: 162000 }),
    boundary(2, { trigger: 'auto', preTokens: 175000, postTokens: 9000, cumulativeDroppedTokens: 328000 }),
    boundary(3, { trigger: 'auto', preTokens: 172000, postTokens: 8500, cumulativeDroppedTokens: 491500 }),
  ]);

  assert.equal(u.compact.count, 3);
  // 実測（40ログ・475件）で、最後の値が Σ(pre-post) と完全に一致した。
  // 素で足すと 981,500 になり、実際の 2 倍になる
  assert.equal(u.compact.dropped, 491500);
});

test('順が乱れていても、圧縮の捨てた量は最大値で決まる', () => {
  const u = buildUsage([
    boundary(3, { cumulativeDroppedTokens: 491500 }),
    boundary(1, { cumulativeDroppedTokens: 162000 }),
  ]);

  assert.equal(u.compact.dropped, 491500);
});

test('compactMetadata が無い圧縮は、数には入るが量には入らない', () => {
  const noMeta = buildUsage([boundary(1, null), boundary(2, null)]);
  assert.equal(noMeta.compact.count, 2);
  assert.equal(noMeta.compact.dropped, null);

  // 片方だけ取れているときは、取れたぶんを出す。「一部しか測れていない」を 0 で塗り潰さない
  const half = buildUsage([boundary(1, null), boundary(2, { cumulativeDroppedTokens: 162000 })]);
  assert.equal(half.compact.count, 2);
  assert.equal(half.compact.dropped, 162000);
});

test('壊れた cumulativeDroppedTokens は無視する', () => {
  const u = buildUsage([
    boundary(1, { cumulativeDroppedTokens: '162000' }),
    boundary(2, { cumulativeDroppedTokens: -5 }),
    boundary(3, { cumulativeDroppedTokens: Number.NaN }),
  ]);

  assert.equal(u.compact.count, 3);
  assert.equal(u.compact.dropped, null);
});

test('親の圧縮はサブエージェント側の集計に混ざらない', () => {
  const entries = [
    boundary(1, { cumulativeDroppedTokens: 162000 }),
    boundary(2, { cumulativeDroppedTokens: 5000 }, { isSidechain: true }),
  ];

  assert.deepEqual(buildUsage(entries).compact, { count: 1, dropped: 162000 });
  assert.deepEqual(buildUsage(entries, { sidechain: true }).compact, { count: 1, dropped: 5000 });
});
