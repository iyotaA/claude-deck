/**
 * 横断集計（/api/usage）のテスト。
 *
 * ディスクを読む listUsage は触らない（read 層にテストを置かない方針）。
 * 代わりに、判断だけを切り出した2つを見る。
 *
 * - parseUsageQuery … 変な値でも 400 を返さず範囲へ丸めること
 * - aggregateUsage  … 束ねかたと、モデルが混ざったときに命中率を出さないこと
 *
 * 材料の usage は buildUsage が実際に返したものを使う。
 * 手で書いた形を渡すと、集計側のキー名が変わっても気づけない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUsageQuery, aggregateUsage, baselineFrom, USAGE_SCAN_MAX } from '../src/view/usage.mjs';
import { buildUsage } from '../src/parse/usage.mjs';
import { reply, prompt, call, result, at } from './helpers.mjs';

/** クエリ文字列から指定を作る。 */
const parse = (search) => parseUsageQuery(new URLSearchParams(search));

/**
 * 集計に渡す1セッションぶんを作る。
 *
 * @param {string} id
 * @param {Array} entries ログの行
 * @param {object} [over] 見出しの上書き
 */
function rec(id, entries, over = {}) {
  return {
    id,
    logSize: 1000,
    mtimeMs: 0,
    projectDir: 'C--work-deck',
    project: 'deck',
    title: null,
    usage: buildUsage(entries),
    ...over,
  };
}

/** 命中率を確かめるための、キャッシュを読んだ1往復。 */
const cached = (model, { ms = 0, requestId = 'r1' } = {}) => [
  reply('うん', { ms, requestId, model, usage: { in: 100, cr: 900, out: 10 } }),
];

test('何も指定しなければ既定になる', () => {
  const q = parse('');
  assert.equal(q.limit, 30);
  // 既定では期間で絞らない。新しい順に limit 件を見るので、期間は追加の絞り込みでしかない
  assert.equal(q.days, null);
  assert.equal(q.model, null);
});

test('件数は範囲に丸める', () => {
  assert.equal(parse('limit=10').limit, 10);
  assert.equal(parse('limit=0').limit, 1);
  assert.equal(parse('limit=-5').limit, 1);
  // 上限を超えた指定は 400 ではなく切り詰める
  assert.equal(parse('limit=999').limit, USAGE_SCAN_MAX);
  assert.equal(parse('limit=abc').limit, 30);
});

test('走査上限は書庫より小さくしてある', () => {
  // 書庫（120）は行の頭だけを読むが、こちらは全文を JSON.parse するので
  // 1件あたりの重さが2桁違う。同じ値にしてはいけない
  assert.equal(USAGE_SCAN_MAX, 60);
});

test('期間は指定があったときだけ効く', () => {
  assert.equal(parse('days=7').days, 7);
  assert.equal(parse('days=0').days, 1);
  assert.equal(parse('days=99999').days, 3650);
  assert.equal(parse('limit=5').days, null);
});

test('モデルは前後の空白を落とし、空なら絞らない', () => {
  assert.equal(parse('model=%20claude-opus-5%20').model, 'claude-opus-5');
  assert.equal(parse('model=%20%20').model, null);
  assert.equal(parse('model=').model, null);
  assert.equal(parse(`model=${'a'.repeat(500)}`).model.length, 200);
});

test('1件も無ければ、形だけ揃った空の集計を返す', () => {
  const agg = aggregateUsage([]);
  assert.equal(agg.sessions, 0);
  assert.equal(agg.requests, 0);
  assert.equal(agg.totals.ite, 0);
  assert.equal(agg.model, null);
  assert.deepEqual(agg.models, []);
  assert.deepEqual(agg.rows, []);
  // 材料が無いので「出せない」。0 とは書かない
  assert.equal(agg.cache.hitRate, null);
});

test('合計はセッションを跨いで足す', () => {
  const agg = aggregateUsage([
    rec('a', [reply('x', { requestId: 'a1', model: 'claude-opus-5', usage: { in: 100, out: 10 } })]),
    rec('b', [reply('y', { requestId: 'b1', model: 'claude-opus-5', usage: { in: 200, out: 20 } })]),
  ]);
  assert.equal(agg.sessions, 2);
  assert.equal(agg.requests, 2);
  assert.equal(agg.totals.in, 300);
  assert.equal(agg.totals.out, 30);
  // 実消費も足した結果になる（出力は入力の5倍）
  assert.equal(agg.totals.ite, 300 + 30 * 5);
});

test('モデルが1種類なら命中率を出す', () => {
  const agg = aggregateUsage([
    rec('a', cached('claude-opus-5')),
    rec('b', cached('claude-opus-5', { requestId: 'r2' })),
  ]);
  assert.equal(agg.models.length, 1);
  // 2セッションぶんを足してから割る。セッションごとの率を平均しない
  assert.equal(agg.cache.hitRate, 1800 / 2000);
});

test('モデルが混ざったら命中率を出さない', () => {
  const agg = aggregateUsage([
    rec('a', cached('claude-opus-5')),
    rec('b', cached('claude-opus-4-7', { requestId: 'r2' })),
  ]);
  // 集計そのものは返す。止めるのは命中率だけ。
  // キャッシュの最小長がモデル別（Opus5=512 / Opus4.7=2048）で、
  // 未満だと黙ってキャッシュされない。混ぜて割ると行動の差と構造の差が分けられなくなる
  assert.equal(agg.requests, 2);
  assert.equal(agg.totals.cacheRead, 1800);
  assert.equal(agg.cache.hitRate, null);
  // 何が混ざっていたかは返す。画面はこれを使って理由を書く
  assert.deepEqual(agg.models.map((m) => m.model), ['claude-opus-4-7', 'claude-opus-5']);
});

test('1本の中でモデルが混ざっていても命中率を出さない', () => {
  const agg = aggregateUsage([
    rec('a', [...cached('claude-opus-5'), ...cached('claude-haiku-4-5', { ms: 100, requestId: 'r2' })]),
  ]);
  assert.equal(agg.cache.hitRate, null);
  // 行のほうにも印を付ける。表の命中率の列をそのまま読ませない
  assert.equal(agg.rows[0].mixed, true);
});

test('ツールはセッションを跨いで足す。最大は足さずに大きいほうを採る', () => {
  // 「Read の結果が 500 積まれた」を2セッションぶん作る。
  // 材料は Δ（次の要求の文脈 − いまの文脈）から前回の出力を引いて出す
  const readRun = (tokens, { requestId }) => [
    prompt('やって'),
    reply('読むわ', {
      ms: 10,
      requestId: `${requestId}-1`,
      model: 'claude-opus-5',
      usage: { in: 1000, out: 0 },
      uses: [{ id: `${requestId}-t`, name: 'Read', input: {} }],
    }),
    result(`${requestId}-t`, 'ファイルの中身', { ms: 20 }),
    reply('読んだ', { ms: 30, requestId: `${requestId}-2`, model: 'claude-opus-5', usage: { in: 1000 + tokens, out: 0 } }),
  ];

  const agg = aggregateUsage([
    rec('a', readRun(500, { requestId: 'a' })),
    rec('b', readRun(900, { requestId: 'b' })),
  ]);

  const read = agg.tools.find((t) => t.tool === 'Read');
  assert.equal(read.calls, 2);
  assert.equal(read.tokens, 1400);
  // 平均は足した合計から出し直す（セッションごとの平均を平均しない）
  assert.equal(read.avg, 700);
  // 最大は「1回で最大どれだけ積まれたか」なので足さない
  assert.equal(read.max, 900);
});

test('スキルは区間の数と、使ったセッション数を両方持つ', () => {
  // 帰属ラベルが連続しているあいだを1区間として数える。
  // **呼んだ要求そのものにはラベルが付かない**（実測どおり、次の要求から立つ）
  const skillRun = (name, { requestId }) => [
    prompt('やって'),
    reply('呼ぶわ', {
      ms: 10,
      requestId: `${requestId}-1`,
      model: 'claude-opus-5',
      usage: { in: 100, out: 10 },
      uses: [{ id: `${requestId}-s`, name: 'Skill', input: { skill: name } }],
    }),
    result(`${requestId}-s`, 'スキルを読み込みました', { ms: 20 }),
    reply('やった', {
      ms: 30,
      requestId: `${requestId}-2`,
      model: 'claude-opus-5',
      usage: { in: 200, out: 20 },
      attributionSkill: name,
    }),
  ];

  const agg = aggregateUsage([
    rec('a', skillRun('pr-review', { requestId: 'a' })),
    rec('b', skillRun('pr-review', { requestId: 'b' })),
  ]);

  const skill = agg.skills.find((s) => s.skill === 'pr-review');
  assert.equal(skill.runs, 2);
  // **標本の小ささを隠さない。** 全ログでスキルは12種82件・うち6種が n=1 なので、
  // 順位から外すかどうかを画面側が決められるよう、母数を必ず一緒に返す
  assert.equal(skill.sessions, 2);
});

/**
 * スキルを1回呼んで1往復するだけのセッション。
 *
 * 区間に入るのは帰属ラベルの立った**次**の要求だけなので、ite は 5×out になる。
 *
 * @param {string} id
 * @param {{ms: number, out: number, skill?: string}} opt
 */
const skillOnce = (id, { ms, out, skill = 'review' }) =>
  rec(id, [
    reply('やる', {
      ms,
      requestId: id,
      model: 'claude-opus-5',
      usage: { in: 10, out: 1 },
      uses: [{ id: `${id}-s`, name: 'Skill', input: { skill } }],
    }),
    result(`${id}-s`, 'ok', { ms: ms + 1 }),
    reply('できた', {
      ms: ms + 2,
      requestId: `${id}-2`,
      model: 'claude-opus-5',
      usage: { in: 0, out },
      attributionSkill: skill,
    }),
  ]);

test('同じスキルの1回ごとが、時刻の昇順で推移として並ぶ', () => {
  // 横断は新しい順に読むので、渡ってくる順は時刻の逆になる。並べ直す責任はこちら側
  const agg = aggregateUsage([
    skillOnce('c', { ms: 300, out: 30 }),
    skillOnce('a', { ms: 100, out: 10 }),
    skillOnce('b', { ms: 200, out: 20 }),
  ]);
  const s = agg.skills.find((x) => x.skill === 'review');

  assert.deepEqual(s.series.map((p) => p.ite), [50, 100, 150]);
  // **どの回かを追える。** 重かった回を見つけたら、その会話を開きたくなる
  assert.deepEqual(s.series.map((p) => p.sessionId), ['a', 'b', 'c']);
  assert.equal(s.seriesOmitted, 0);
  // 畳んだ側は今までどおり（合計と平均は壊れていない）
  assert.equal(s.runs, 3);
  assert.equal(s.ite, 300);
});

test('推移から差を書くのは、比べる相手が3件そろってから', () => {
  const three = [
    skillOnce('a', { ms: 100, out: 20 }),
    skillOnce('b', { ms: 200, out: 20 }),
    skillOnce('c', { ms: 300, out: 20 }),
  ];

  // 3件だと相手が2件しかない。中央値が薄く、たまたま重かった1回で向きが反転する。
  // **推測で「変わっていません」と書かない**（「差が無い」と「比べられない」は別物）
  assert.equal(aggregateUsage(three).skills.find((x) => x.skill === 'review').trend, null);

  const t = aggregateUsage([...three, skillOnce('d', { ms: 400, out: 100 })]).skills.find(
    (x) => x.skill === 'review'
  ).trend;
  // 4件目でようやく BASELINE_MIN と同じ「相手が3件」に届く
  assert.equal(t.n, 3);
  assert.equal(t.prevMedian, 100, '最新を除いた3件の中央値');
  assert.equal(t.last, 500, '最新の1件');
});

test('時刻の無い区間は推移に混ぜず、落とした数を返す', () => {
  const agg = aggregateUsage([
    skillOnce('a', { ms: 100, out: 20 }),
    rec('b', [
      reply('やる', {
        timestamp: null,
        requestId: 'b1',
        model: 'claude-opus-5',
        usage: { in: 10, out: 1 },
        uses: [{ id: 'b-s', name: 'Skill', input: { skill: 'review' } }],
      }),
      // 区間の先頭になる要求から時刻が読めない形。合計には入るが、並べようがない
      reply('できた', {
        timestamp: null,
        requestId: 'b2',
        model: 'claude-opus-5',
        usage: { in: 0, out: 20 },
        attributionSkill: 'review',
      }),
    ]),
  ]);
  const s = agg.skills.find((x) => x.skill === 'review');

  // 並べようがないものを 0 として左端に置くと、いちばん軽い回に見える
  assert.equal(s.series.length, 1);
  // 畳んだ側には残る（合計は測れている）。**黙って捨てたことにしない**
  assert.equal(s.runs, 2);
  assert.equal(agg.skillsUndated, 1);
});

test('行は実消費の多い順に並べ、ログのパスは載せない', () => {
  const small = rec('small', [reply('x', { requestId: 's1', model: 'claude-opus-5', usage: { in: 10, out: 1 } })]);
  const big = rec('big', [reply('y', { requestId: 'b1', model: 'claude-opus-5', usage: { in: 9000, out: 900 } })]);

  const agg = aggregateUsage([small, big]);
  assert.deepEqual(agg.rows.map((r) => r.sessionId), ['big', 'small']);
  // 詳細は sessionId だけで開ける。絶対パスを画面へ出す理由が無い
  assert.equal(agg.rows[0].file, undefined);
  assert.equal(agg.rows[0].logFile, undefined);
  assert.equal(agg.rows[0].cwd, undefined);
});

// --- 直近の中央値（baseline） ----------------------------------------------

/**
 * 中央値の材料を1本作る。ite が読みやすいよう、入力トークンだけを持たせる。
 *
 * @param {string} id
 * @param {number} inTokens そのまま ite になる
 * @param {string} model
 */
const one = (id, inTokens, model = 'claude-opus-5') =>
  rec(id, [reply('', { requestId: `${id}-1`, model, usage: { in: inTokens } })]);

test('3本そろわなければ中央値を出さない', () => {
  const two = [one('a', 100), one('b', 200)];

  // 2本の「真ん中」は2つの平均でしかない。推測で埋めずに、まるごと出さない
  assert.equal(baselineFrom(two, 'claude-opus-5'), null);
  assert.ok(baselineFrom([...two, one('c', 300)], 'claude-opus-5'));
});

test('違うモデルは中央値の材料にしない', () => {
  const recs = [
    one('a', 100),
    one('b', 200),
    one('c', 300),
    one('x', 9000, 'claude-opus-4-6'),
    one('y', 9000, 'claude-opus-4-6'),
  ];

  const base = baselineFrom(recs, 'claude-opus-5');
  assert.equal(base.sessions, 3);
  assert.equal(base.ite, 200);
  assert.equal(base.model, 'claude-opus-5');

  // 数が足りないほうを指定したら、そちらは出ない
  assert.equal(baselineFrom(recs, 'claude-opus-4-6'), null);
});

test('比べたいモデルが分からなければ中央値を出さない', () => {
  assert.equal(baselineFrom([one('a', 100), one('b', 200), one('c', 300)], null), null);
});

test('要求が1件も無いセッションは中央値の材料にしない', () => {
  const recs = [
    one('a', 100),
    one('b', 200),
    one('c', 300),
    // /clear だけして終わったログ。0 を混ぜると中央値が下へ引きずられる
    rec('empty', []),
  ];

  assert.equal(baselineFrom(recs, 'claude-opus-5').sessions, 3);
});

test('測れなかった値は中央値の数に入れない', () => {
  const recs = [
    rec('a', [reply('', { requestId: 'a1', model: 'claude-opus-5', usage: { in: 100, cr: 900 } })]),
    rec('b', [reply('', { requestId: 'b1', model: 'claude-opus-5', usage: { in: 200, cr: 800 } })]),
    // 入力が1トークンも記録されていないと、命中率は分母が 0 になって null（出せない、の意味）
    rec('c', [reply('', { requestId: 'c1', model: 'claude-opus-5', usage: { out: 5 } })]),
  ];

  const base = baselineFrom(recs, 'claude-opus-5');
  assert.equal(base.sessions, 3);
  // ite は3本ぶん（25 / 190 / 280）。ite が読めない行は無い
  assert.equal(base.ite, 190);
  // 命中率を出せたのは a と b の2本だけ。null を 0 とみなして混ぜない
  // （混ぜたら [0, 0.8, 0.9] の真ん中で 0.8 になる）
  assert.equal(base.hitRate, 0.9);
});

test('圧縮の回数も中央値を出す', () => {
  const withCompact = (id, n) => rec(id, [
    reply('', { requestId: `${id}-1`, model: 'claude-opus-5', usage: { in: 100 } }),
    ...Array.from({ length: n }, (_, i) => ({
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: at(i + 1),
    })),
  ]);

  const base = baselineFrom([withCompact('a', 0), withCompact('b', 2), withCompact('c', 9)], 'claude-opus-5');
  assert.equal(base.compactCount, 2);
});

test('スキルもツールも無いセッションが混ざっても落ちない', () => {
  const agg = aggregateUsage([
    rec('a', [reply('ひとこと', { requestId: 'a1', model: 'claude-opus-5', usage: { in: 10, out: 1 } })]),
    // ツール呼び出しだけあって結果が来ていない（いま止まっている）セッション
    rec('b', [
      call('Read', { file_path: 'x' }, { id: 't1' }),
    ]),
  ]);
  assert.equal(agg.sessions, 2);
  assert.equal(agg.rows.length, 2);
  assert.ok(Array.isArray(agg.tools));
  assert.ok(Array.isArray(agg.skills));
});
