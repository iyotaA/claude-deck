/**
 * 一覧の「どの行をどの束へ置くか」（`public/js/groups.js`）と、上の帯を外した字面。
 *
 * 見るのは2種類。
 *
 * - `groups.js` の判断。import ゼロの純関数なので Node から呼べる
 *   （`nav.js` / `update-banner.js` と同じ形）。枠「あなたの番」に止まっているものと
 *   返信待ちの両方が入ること・ピンが付いていても枠が先なこと・並べ替えないこと・
 *   知らない状態を黙って落とさないこと
 * - `index.html` / `public/js/` / `public/css/` の字面。**消した部品が戻っていないこと。**
 *   上の帯（大きい札）と「残り N 件を出す」は、戻ってきても何のエラーも出ずに
 *   画面のどこかへ黙って居座るので、字面で見張る（`navrail.test.mjs` と同じ作法）
 *
 * 字面はコメントを落としてから読む。このリポジトリは説明が厚く、
 * 「前は上に帯があった」のような経緯がコメントに残るため。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  YOURS_GROUPS, STATE_GROUPS, PINNED_GROUP, REST_GROUP, STOP_STATES, groupRows,
} from '../public/js/groups.js';
import { STATE_BLOCKING } from '../src/parse/state.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const JS_DIR = path.join(REPO, 'public', 'js');
const CSS_DIR = path.join(REPO, 'public', 'css');

/** 一覧の行の形。見るのは sessionId と state と pinned だけなので、それだけで足りる */
const row = (id, state, over = {}) => ({ sessionId: id, state, ...over });

/** @param {object[]} rows @returns {string[]} 並びをそのまま id にする */
const ids = (rows) => rows.map((r) => r.sessionId);

/** 状態の見出しのうち、その id のものに入った行 */
const inGroup = (g, id) => g.groups.find((x) => x.group.id === id)?.rows ?? null;

/* ── 枠「あなたの番」 ─────────────────────────────────────── */

test('止まっている状態の行は yours.stop、返信待ちは yours.reply に入る', () => {
  const g = groupRows([
    row('a', 'needs-answer'),
    row('b', 'needs-plan-approval'),
    row('c', 'needs-approval'),
    row('d', 'awaiting-reply'),
  ]);
  assert.deepEqual(ids(g.yours.stop), ['a', 'b', 'c']);
  assert.deepEqual(ids(g.yours.reply), ['d']);
  // 枠に入ったものは、ほかのどこにも出ない（同じ行が2か所に出ると aria-current が二重になる）
  assert.deepEqual(g.pinned, []);
  assert.deepEqual(g.rest, []);
  for (const { group, rows } of g.groups) assert.deepEqual(rows, [], `${group.id} に枠の行が漏れている`);
});

test('ピンの付いた止まっている行・返信待ちの行は枠に入り、pinned には入らない', () => {
  // ボールの所在が先。ピンは「覚えておきたい」の印で、待たせていることより弱い
  const g = groupRows([
    row('s', 'needs-approval', { pinned: true }),
    row('w', 'awaiting-reply', { pinned: true }),
  ]);
  assert.deepEqual(ids(g.yours.stop), ['s']);
  assert.deepEqual(ids(g.yours.reply), ['w']);
  assert.deepEqual(g.pinned, []);
});

test('ピンの付いた実行中・終了の行は pinned に入り、状態の見出しには入らない', () => {
  const g = groupRows([
    row('r', 'running', { pinned: true }),
    row('e', 'ended', { pinned: true }),
    row('r2', 'running'),
  ]);
  assert.deepEqual(ids(g.pinned), ['r', 'e']);
  assert.deepEqual(ids(inGroup(g, 'run')), ['r2']);
  assert.deepEqual(inGroup(g, 'done'), []);
});

test('実行中は実行中の見出し、終了は終了の見出し、知らない状態は rest', () => {
  const g = groupRows([
    row('r', 'running'),
    row('e', 'ended'),
    row('x', 'brand-new-state'),
    row('u', 'unknown'),
  ]);
  assert.deepEqual(ids(inGroup(g, 'run')), ['r']);
  assert.deepEqual(ids(inGroup(g, 'done')), ['e']);
  // **黙って落とさない。** サーバーが状態を1つ足した日に一覧から行が消えるほうが困る
  assert.deepEqual(ids(g.rest), ['x', 'u']);
});

test('ピンの付いた知らない状態の行は pinned に入る（rest と二重にしない）', () => {
  const g = groupRows([row('x', 'brand-new-state', { pinned: true })]);
  assert.deepEqual(ids(g.pinned), ['x']);
  assert.deepEqual(g.rest, []);
});

test('並び順を変えない（入ってきた順のまま）', () => {
  // store.rows はサーバーが STATE_RANK と開始時刻で並べたもの。前から拾うだけにする。
  // わざと「手をつける順」と食い違う並びで渡す（needs-answer は needs-approval より先の状態だが、後ろに置く）
  const g = groupRows([
    row('e1', 'ended'),
    row('r1', 'running'),
    row('w1', 'awaiting-reply'),
    row('e2', 'ended'),
    row('s1', 'needs-approval'),
    row('w2', 'awaiting-reply'),
    row('s2', 'needs-answer'),
    row('r2', 'running'),
  ]);
  assert.deepEqual(ids(g.yours.stop), ['s1', 's2']);
  assert.deepEqual(ids(g.yours.reply), ['w1', 'w2']);
  assert.deepEqual(ids(inGroup(g, 'run')), ['r1', 'r2']);
  assert.deepEqual(ids(inGroup(g, 'done')), ['e1', 'e2']);
});

test('入ってきた配列を書き換えない', () => {
  const rows = [row('e', 'ended'), row('s', 'needs-answer')];
  const before = ids(rows);
  groupRows(rows);
  assert.deepEqual(ids(rows), before);
});

test('行が0本なら全部空', () => {
  const g = groupRows([]);
  assert.deepEqual(g.yours, { stop: [], reply: [] });
  assert.deepEqual(g.pinned, []);
  assert.deepEqual(g.rest, []);
  for (const { group, rows } of g.groups) assert.deepEqual(rows, [], `${group.id} が空でない`);
});

/* ── 表 ───────────────────────────────────────────────── */

test('枠の小見出しは「許可・質問で止まっている」→「返信待ち」、枠の外は 実行中 → 終了', () => {
  assert.deepEqual(YOURS_GROUPS.map((g) => g.id), ['stop', 'reply']);
  assert.deepEqual(YOURS_GROUPS.map((g) => g.label), ['許可・質問で止まっている', '返信待ち']);
  assert.deepEqual(STATE_GROUPS.map((g) => g.id), ['run', 'done']);
  // groups は表の順に全部並ぶ（空の見出しを出すかどうかは描く側が決める）
  assert.deepEqual(groupRows([]).groups.map((x) => x.group.id), ['run', 'done']);
});

test('同じ状態が2つの表（YOURS_GROUPS と STATE_GROUPS）に出ない', () => {
  const all = [...YOURS_GROUPS, ...STATE_GROUPS].flatMap((g) => g.states);
  const dup = all.filter((s, i) => all.indexOf(s) !== i);
  assert.deepEqual(dup, [], `2つの見出しに出る状態がある（選ぶと aria-current が二重になる）: ${dup.join(' ')}`);
});

test('STOP_STATES は YOURS_GROUPS の stop と同じ顔ぶれ', () => {
  // 拡大モーダルの「次の待ち」が回るのはこの集合。枠の小見出しと食い違うと、
  // 枠に居るのに回らない（または枠に居ないのに回る）ものができる
  const stop = YOURS_GROUPS.find((g) => g.id === 'stop');
  assert.deepEqual([...STOP_STATES].sort(), [...stop.states].sort());
  assert.ok(!STOP_STATES.has('awaiting-reply'), '返信待ちは「次の待ち」で回らない');
});

test('STOP_STATES はサーバーの STATE_BLOCKING が真の状態と同じ顔ぶれ', () => {
  // 左のレールのバッジは meta.stateBlocking（＝ STATE_BLOCKING）で数え、一覧の枠の「止まっている」と
  // 拡大モーダルの「次の待ち」は STOP_STATES で拾う。状態を1つ足した日に片方だけ直すと、
  // バッジは 3 と言うのに枠の「止まっている」は 2 件、のように黙って食い違う
  const blocking = Object.entries(STATE_BLOCKING).filter(([, v]) => v === true).map(([k]) => k);
  assert.deepEqual(
    [...STOP_STATES].sort(), blocking.sort(),
    '止まっている状態の顔ぶれが、src/parse/state.mjs の STATE_BLOCKING と public/js/groups.js で違う',
  );
});

test('ピン留めとそのほかの束も groups.js が持つ（状態を持たない束）', () => {
  // 描く側（list.js）がその場で束を作ると、束の定義が2か所に割れる
  assert.equal(PINNED_GROUP.label, 'ピン留め');
  assert.equal(PINNED_GROUP.icon, 'star', 'ピン留めの見出しは点ではなく星の絵');
  assert.equal(PINNED_GROUP.states, undefined, 'ピン留めは状態の束ではない');
  assert.equal(REST_GROUP.label, 'そのほか');
  assert.equal(REST_GROUP.states, undefined, 'そのほかは「どの状態にも当たらない」の受け皿で、状態を名指ししない');
  const ids = [...YOURS_GROUPS, ...STATE_GROUPS, PINNED_GROUP, REST_GROUP].map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length, `束の id が重なっている: ${ids.join(' ')}`);
});

test('開け閉めするのは終了だけ、2行目に何を求めているかを出すのは止まっているものだけ', () => {
  // 描く側は id の文字列ではなく、この印を読んで分岐する
  const all = [...YOURS_GROUPS, ...STATE_GROUPS, PINNED_GROUP, REST_GROUP];
  assert.deepEqual(all.filter((g) => g.foldable).map((g) => g.id), ['done']);
  assert.deepEqual(all.filter((g) => g.wants).map((g) => g.id), ['stop']);
});

/* ── 字面：上の帯と「残り N 件を出す」が戻っていない ─────────────── */

/** @param {string} p @returns {string} */
const read = (p) => fs.readFileSync(p, 'utf8');

/** HTML のコメントを落とした本文 */
const htmlCode = (text) => text.replace(/<!--[\s\S]*?-->/g, '');

/** CSS のコメントを落とした本文 */
const cssCode = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * JS のコメントを落とした本文。落とし方は `navrail.test.mjs` / `tokens.test.mjs` の `jsCode` と同じ
 * （行頭の `//` と `*`、行末の `//`）。
 */
const jsCode = (text) => text
  .split('\n')
  .map((line) => (/^\s*(\/\/|\/?\*)/.test(line) ? '' : line.replace(/\s\/\/.*$/, '')))
  .join('\n');

/** 画面側の .js を全部（`timeline/` も含む） */
function jsFiles() {
  const out = [];
  for (const dir of [JS_DIR, path.join(JS_DIR, 'timeline')]) {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.js')) out.push(path.join(dir, f));
    }
  }
  return out;
}

test('index.html に上の帯（hero-wrap / hero-band / css/hero.css）が残っていない', () => {
  const html = htmlCode(read(path.join(REPO, 'public', 'index.html')));
  const GONE = [
    [/hero-wrap/, '帯の器（.hero-wrap）'],
    [/hero-band/, '帯の札の並び（#hero-band）'],
    [/css\/hero\.css/, '帯の CSS（css/hero.css）'],
  ];
  const bad = GONE.filter(([re]) => re.test(html)).map(([, label]) => label);
  assert.deepEqual(bad, [], `消したはずの帯が index.html に残っている: ${bad.join(' / ')}`);
});

test('public/js に帯の口と「残り N 件を出す」の段が残っていない', () => {
  const WORDS = [
    [/renderHero/, 'renderHero（帯を描く）'],
    [/initHero/, 'initHero（帯の配線）'],
    [/heroFolded/, 'heroFolded（帯の畳み）'],
    [/heroBand|heroWrap/, 'dom.heroBand / dom.heroWrap（帯の節点）'],
    [/HERO_STATES/, 'HERO_STATES（帯へ出す状態。いまは groups.js の STOP_STATES）'],
    [/ENDED_FIRST/, 'ENDED_FIRST（終了の最初の5件）'],
    [/row-more/, '.row-more（残り N 件を出す）'],
  ];
  const bad = [];
  for (const file of jsFiles()) {
    const code = jsCode(read(file));
    const rel = path.relative(JS_DIR, file).replace(/\\/g, '/');
    for (const [re, label] of WORDS) {
      if (re.test(code)) bad.push(`${rel} … ${label}`);
    }
  }
  assert.deepEqual(bad, [], `消した口が残っている:\n  ${bad.join('\n  ')}`);
});

test('見出しの表（STATE_GROUPS）を持つのは groups.js だけ', () => {
  // 前は store.js にあった。2か所に置くと、状態を1つ足した日に片方だけ直る
  const owners = jsFiles()
    .filter((f) => /export\s+const\s+STATE_GROUPS\b/.test(jsCode(read(f))))
    .map((f) => path.basename(f));
  assert.deepEqual(owners, ['groups.js']);
});

test('public/css に帯の規則と「残り N 件を出す」が残っていない', () => {
  assert.ok(!fs.existsSync(path.join(CSS_DIR, 'hero.css')), 'hero.css が残っている（名前が嘘になるので消す）');
  const bad = [];
  for (const f of fs.readdirSync(CSS_DIR).filter((n) => n.endsWith('.css'))) {
    const code = cssCode(read(path.join(CSS_DIR, f)));
    for (const [re, label] of [[/\.hero-/, '.hero-*（帯）'], [/\.row-more\b/, '.row-more（残り N 件を出す）']]) {
      if (re.test(code)) bad.push(`${f} … ${label}`);
    }
  }
  assert.deepEqual(bad, [], `消した規則が残っている:\n  ${bad.join('\n  ')}`);
});
