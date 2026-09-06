/**
 * どの層からも使う小道具のうち、`text.mjs` 以外の4枚。
 *
 *   `lru.mjs`     … キャッシュの器（`read/cache.mjs` と `view/usage.mjs` が持つ）
 *   `env.mjs`     … 止めるスイッチの読み方
 *   `objects.mjs` … 壊れた JSON を触る前の確かめ
 *   `tools.mjs`   … ツールの説明としきい値
 *
 * **どれも純関数なのに、テストが1枚も無かった。**
 * `run/` `parse/` `notify/` では「判断だけをテストする」が徹底されているので、
 * ここは方針からの取りこぼし（意図した除外だと書いてある場所が無い）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLru } from '../src/shared/lru.mjs';
import { isSwitchOn } from '../src/shared/env.mjs';
import { isPlainObject } from '../src/shared/objects.mjs';
import { describeTool, isLongRunningTool, LONG_RUNNING_TOOLS, MAX_DETAIL } from '../src/shared/tools.mjs';

/* ── lru ─────────────────────────────────────────────── */

test('lru は入れたものを取れる', () => {
  const c = createLru(3);
  c.set('a', 1);
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('無い'), undefined, '無いものは undefined');
  assert.equal(c.size(), 1);
});

test('lru は溢れたら、いちばん長く触っていないものから捨てる', () => {
  const c = createLru(2);
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  assert.equal(c.get('a'), undefined, '古い a が落ちる');
  assert.equal(c.get('b'), 2);
  assert.equal(c.get('c'), 3);
  assert.equal(c.size(), 2);
});

test('lru は取ったものを「最近使った」に戻す', () => {
  // ここが LRU の芯。取っただけで寿命が延びないと、ただの FIFO になる
  const c = createLru(2);
  c.set('a', 1);
  c.set('b', 2);
  c.get('a');          // a を触ったので、次に落ちるのは b
  c.set('c', 3);
  assert.equal(c.get('a'), 1, '触った a が残る');
  assert.equal(c.get('b'), undefined, '触っていない b が落ちる');
});

test('lru は同じ鍵を入れ直しても件数が増えない', () => {
  const c = createLru(2);
  c.set('a', 1);
  c.set('a', 2);
  assert.equal(c.size(), 1);
  assert.equal(c.get('a'), 2, '新しい値で上書き');
});

test('lru は undefined を入れても「持っている」', () => {
  // **`get` の戻りだけで有無を決めない。** `store.has` を先に見ているので、
  // 値が undefined でも「入っている」ままになる（件数に数える）
  const c = createLru(2);
  c.set('a', undefined);
  assert.equal(c.size(), 1);
});

test('lru は max が 0 でも落ちない', () => {
  // 呼ぶ側が数を計算して渡すので、0 が来ないとは言い切れない
  const c = createLru(0);
  c.set('a', 1);
  assert.equal(c.size(), 0);
  assert.equal(c.get('a'), undefined);
});

test('lru は clear で空になる', () => {
  const c = createLru(3);
  c.set('a', 1);
  c.clear();
  assert.equal(c.size(), 0);
});

test('lru の store は共有されない', () => {
  // **器は同じでも中身は別。** 共有すると、数値の集計（数百バイト）と
  // 一覧の tail memo（最大 42MB）が同じ 240 枠を取り合う
  const a = createLru(2);
  const b = createLru(2);
  a.set('k', 1);
  assert.equal(b.get('k'), undefined);
  assert.equal(b.size(), 0);
});

/* ── env ─────────────────────────────────────────────── */

test('isSwitchOn は 0・false・no を「立っていない」とする', () => {
  // `set X=0` で止めたつもりになる勘違いを防ぐ
  for (const v of ['0', 'false', 'no', 'FALSE', ' No ', 'NO']) {
    assert.equal(isSwitchOn(v), false, `${JSON.stringify(v)} が立っている扱い`);
  }
});

test('isSwitchOn は空と未設定を「立っていない」とする', () => {
  // `set X=` で消したときにここへ落ちる
  for (const v of ['', '   ', undefined, null, 0, 1, true, {}]) {
    assert.equal(isSwitchOn(v), false, `${JSON.stringify(v)} が立っている扱い`);
  }
});

test('isSwitchOn は中身のある文字列を「立っている」とする', () => {
  for (const v of ['1', 'true', 'yes', 'on', 'なんでも']) {
    assert.equal(isSwitchOn(v), true, `${JSON.stringify(v)} が立っていない扱い`);
  }
});

/* ── objects ─────────────────────────────────────────── */

test('isPlainObject は配列と null を弾く', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject({ a: 1 }), true);
  assert.equal(isPlainObject([]), false, '配列を通すと .foo が黙って undefined になる');
  assert.equal(isPlainObject(null), false);
  for (const v of [undefined, 0, '', 'x', 42, true, () => {}]) {
    assert.equal(isPlainObject(v), false, `${JSON.stringify(v)} を通した`);
  }
});

test('isPlainObject は素性までは見ない', () => {
  // **`Object.getPrototypeOf` を見ない**のは意図した割り切り。
  // 欲しいのは「`x.foo` と書いて安全か」で、素性の証明ではない
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject(new Date()), true);
});

/* ── tools ───────────────────────────────────────────── */

test('isLongRunningTool は表と mcp__ の前置で決める', () => {
  assert.equal(isLongRunningTool('Bash'), true);
  assert.equal(isLongRunningTool('mcp__whatever__do'), true, 'MCP は名前を知らないまま増える');
  assert.equal(isLongRunningTool('Read'), false);
  // **`Task*` を前置で拾わない。** TaskCreate / TaskUpdate / TaskStop は p90 < 300ms
  assert.equal(isLongRunningTool('TaskCreate'), false);
  assert.equal(isLongRunningTool('Task'), true);
});

test('isLongRunningTool は文字列でないものを弾く', () => {
  for (const v of [null, undefined, 42, {}, []]) {
    assert.equal(isLongRunningTool(v), false, `${JSON.stringify(v)} で落ちるか true`);
  }
});

test('LONG_RUNNING_TOOLS に Task* の細かいものを足していない', () => {
  // 足すと「短いのに長く走る扱い」になって、状態の判定が鈍る
  for (const name of ['TaskCreate', 'TaskUpdate', 'TaskStop']) {
    assert.equal(LONG_RUNNING_TOOLS.has(name), false, `${name} が表に入っている`);
  }
});

test('describeTool はツールごとに見る場所を変える', () => {
  assert.equal(describeTool('Bash', { command: 'ls -la' }), 'ls -la');
  assert.equal(describeTool('Bash', { description: '一覧を出す', command: 'ls' }), '一覧を出す',
    'description があればそちらを優先する');
  assert.equal(describeTool('Read', { file_path: 'C:/a/b.mjs' }), 'C:/a/b.mjs');
  assert.equal(describeTool('Glob', { pattern: '**/*.mjs' }), '**/*.mjs');
  assert.equal(describeTool('WebFetch', { url: 'https://example.test/x' }), 'https://example.test/x');
});

test('describeTool の Grep は場所があれば添える', () => {
  assert.equal(describeTool('Grep', { pattern: 'foo' }), 'foo');
  assert.equal(describeTool('Grep', { pattern: 'foo', path: 'src' }), 'foo in src');
  assert.equal(describeTool('Grep', {}), null, '材料が無ければ null');
});

test('describeTool の Skill は引数があれば添える', () => {
  assert.equal(describeTool('Skill', { skill: 'run' }), 'run');
  assert.equal(describeTool('Skill', { skill: 'run', args: '--fast' }), 'run (--fast)');
});

test('describeTool の AskUserQuestion は1問目だけ見る', () => {
  // 何を聞かれて止まっているのかが知りたい情報。全部並べる場所ではない
  const input = { questions: [{ question: '進めますか' }, { question: '2問目' }] };
  assert.equal(describeTool('AskUserQuestion', input), '進めますか');
  assert.equal(describeTool('AskUserQuestion', { questions: [] }), null);
  assert.equal(describeTool('AskUserQuestion', { questions: 'x' }), null, '配列でなくても落ちない');
});

test('describeTool の ExitPlanMode は plan を見る', () => {
  // 既定の枝（description / file_path / command / url）はすべて undefined になるので、
  // ここを持たないと**プラン承認待ちの「何を待っているか」が空**になる
  assert.equal(describeTool('ExitPlanMode', { plan: '# やること\n- a' }), '# やること - a');
  assert.equal(describeTool('ExitPlanMode', {}), null);
});

test('describeTool は知らないツールでも材料を探す', () => {
  assert.equal(describeTool('未知のツール', { description: 'なにか' }), 'なにか');
  assert.equal(describeTool('未知のツール', { url: 'https://x.test' }), 'https://x.test');
  assert.equal(describeTool('未知のツール', {}), null);
});

test('describeTool は input が無くても落ちない', () => {
  // ログの形は公開仕様ではない。キーごと無い行が来る
  for (const v of [null, undefined]) {
    assert.equal(describeTool('Bash', v), null);
    assert.equal(describeTool('未知のツール', v), null);
  }
});

test('describeTool は長い説明を max で切る', () => {
  const long = 'x'.repeat(MAX_DETAIL + 50);
  assert.equal(describeTool('Bash', { command: long }).length, MAX_DETAIL);
  assert.equal(describeTool('Bash', { command: long }, 10).length, 10);
});
