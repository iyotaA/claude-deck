/**
 * 左のレール（画面の切り替え）と上のバーの約束。
 *
 * 見るのは2種類。
 *
 * - `public/js/nav.js` の判断（import ゼロの純関数なので Node から呼べる。
 *   `update-banner.js` / `today-md.js` と同じ形）。モードの名前とキーの出どころ・
 *   数字キーを効かせない条件・止まっている数の数え方・作業台の札の名前
 * - `index.html` と `public/js/` の字面。**消した部品が戻っていないこと**と、
 *   レール・上のバーに置くと決めた節点がそこに居ること。
 *   消した部品（下段の帯・版・左の細い帯）は、戻ってきても何のエラーも出ずに
 *   画面のどこかへ黙って居座るので、字面で見張る（`tokens.test.mjs` と同じ作法）
 *
 * 字面はコメントを落としてから読む。このリポジトリは説明が厚く、
 * 「前は下段（.statusbar）に置いていた」のような経緯がコメントに残るため。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODE_LIST, modeOfKey, blockingCount, workName, modeName, modeTip } from '../public/js/nav.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const JS_DIR = path.join(REPO, 'public', 'js');

/** @param {string} p @returns {string} */
const read = (p) => fs.readFileSync(p, 'utf8');

/** HTML のコメントを落とした本文 */
const htmlCode = (text) => text.replace(/<!--[\s\S]*?-->/g, '');

/**
 * JS のコメントを落とした本文。落とし方は `tokens.test.mjs` の `jsCode` と同じ
 * （行頭の `//` と `*`、行末の `//`）。
 */
const jsCode = (text) => text
  .split('\n')
  .map((line) => (/^\s*(\/\/|\/?\*)/.test(line) ? '' : line.replace(/\s\/\/.*$/, '')))
  .join('\n');

const HTML = htmlCode(read(path.join(REPO, 'public', 'index.html')));

/**
 * 開きタグから閉じタグまでを切り出す。入れ子の同名タグは来ない前提
 * （`<nav>` の中に `<nav>`、`<header class="topbar">` の中に `<header>` は置いていない）。
 *
 * @param {string} open 開きタグの頭（`<nav class="navrail"` など）
 * @param {string} close 閉じタグ（`</nav>` など）
 * @returns {string}
 */
function section(open, close) {
  const at = HTML.indexOf(open);
  assert.notEqual(at, -1, `${open} が index.html に無い`);
  const end = HTML.indexOf(close, at);
  assert.notEqual(end, -1, `${open} の ${close} が見つからない`);
  return HTML.slice(at, end);
}

/** その id を持つ開きタグを1つ返す（無ければ null）。要素名は数字も含む（`h1`） */
function tagWithId(text, id) {
  const m = text.match(new RegExp(`<[a-z][a-z0-9]*\\b[^>]*\\bid="${id}"[^>]*>`));
  return m ? m[0] : null;
}

/** キーの出来事の形。素のオブジェクトで足りる（modeOfKey は読むだけ） */
const key = (k, over = {}) => ({
  key: k, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...over,
});

/* ── モードの名前とキー（出どころはここ1つ） ─────────────────────── */

test('MODE_LIST は 作業台・書庫・数値 の順で、キーは 1・2・3', () => {
  assert.deepEqual(MODE_LIST.map((m) => m.id), ['work', 'archive', 'usage']);
  assert.deepEqual(MODE_LIST.map((m) => m.key), ['1', '2', '3']);
});

test('MODE_LIST の名前は空でなく、重ならない', () => {
  const labels = MODE_LIST.map((m) => m.label);
  for (const l of labels) assert.ok(typeof l === 'string' && l.trim(), `名前が空: ${JSON.stringify(l)}`);
  assert.equal(new Set(labels).size, labels.length, `名前が重なっている: ${labels.join(' ')}`);
});

/* ── 数字キー ───────────────────────────────────────────── */

test('1・2・3 で 作業台・書庫・数値 へ移る', () => {
  assert.equal(modeOfKey(key('1')), 'work');
  assert.equal(modeOfKey(key('2')), 'archive');
  assert.equal(modeOfKey(key('3')), 'usage');
});

test('ほかのキーでは移らない', () => {
  assert.equal(modeOfKey(key('4')), null);
  assert.equal(modeOfKey(key('a')), null);
  assert.equal(modeOfKey(key('0')), null);
});

test('Ctrl・Meta・Alt を押しているときは移らない（ブラウザのタブ切り替えなどを奪わない）', () => {
  assert.equal(modeOfKey(key('1', { ctrlKey: true })), null);
  assert.equal(modeOfKey(key('2', { metaKey: true })), null);
  assert.equal(modeOfKey(key('3', { altKey: true })), null);
});

test('IME の変換中は移らない（全角の数字を打っている最中に画面が替わらない）', () => {
  assert.equal(modeOfKey(key('1', { isComposing: true })), null);
});

test('焦点が入力欄にあるときは移らない', () => {
  assert.equal(modeOfKey(key('1'), { editable: true }), null);
});

test('<dialog> が開いているときは移らない', () => {
  assert.equal(modeOfKey(key('2'), { modal: true }), null);
});

/* ── 止まっている数 ─────────────────────────────────────── */

const BLOCKING = { 'needs-answer': true, 'needs-approval': true, 'awaiting-reply': false, running: false };

test('止まっている状態の数だけを足す', () => {
  const counts = { 'needs-answer': 2, 'needs-approval': 1, 'awaiting-reply': 4, running: 3 };
  assert.equal(blockingCount(counts, BLOCKING), 3);
});

test('counts が空なら 0（受け取ったうえで、止まっているものが無い）', () => {
  assert.equal(blockingCount({}, BLOCKING), 0);
});

test('counts が無ければ null（まだ受け取っていない。「無い」と「知らない」を分ける）', () => {
  assert.equal(blockingCount(undefined, BLOCKING), null);
  assert.equal(blockingCount(null, BLOCKING), null);
});

test('blocking に無い状態は足さない（知らない状態を止まっていると数えない）', () => {
  assert.equal(blockingCount({ 'needs-answer': 1, 'new-state': 5 }, BLOCKING), 1);
});

/* ── 作業台の札の名前 ────────────────────────────────────── */

test('まだ数を知らないときは、件数の言葉を付けない', () => {
  assert.equal(workName(null), '作業台');
});

test('0 件なら「ありません」と言う（下段の帯にあった1行の役目）', () => {
  assert.match(workName(0), /^作業台/);
  assert.match(workName(0), /ありません/);
});

test('件数があれば、その数を名前に入れる', () => {
  assert.match(workName(3), /^作業台/);
  assert.match(workName(3), /3/);
});

test('件数を名前に持つ札は作業台の1つだけ（counts）', () => {
  assert.deepEqual(MODE_LIST.filter((m) => m.counts).map((m) => m.id), ['work']);
});

test('件数を持たない札の名前と吹き出しは、件数を渡されても変わらない', () => {
  const archive = MODE_LIST.find((m) => m.id === 'archive');
  assert.equal(modeName(archive, 3), '書庫');
  assert.equal(modeTip(archive, 3), '書庫　2');
});

test('吹き出しは「名前　キー」の1行目と、件数の2行目（知らないときは1行だけ）', () => {
  const work = MODE_LIST.find((m) => m.id === 'work');
  assert.equal(modeTip(work, null), '作業台　1');
  const [head, tail] = modeTip(work, 0).split('\n');
  assert.equal(head, '作業台　1');
  assert.match(tail, /ありません/);
  assert.equal(modeName(work, 2), workName(2));
});

/* ── 字面：レールと上のバー ─────────────────────────────── */

test('レールに 作業台・書庫・数値・今日のまとめ・枠の輪・設定・説明 が居る', () => {
  const rail = section('<nav class="navrail"', '</nav>');
  for (const id of ['mode-work', 'mode-archive', 'mode-usage', 'today-open', 'rate', 'settings-open', 'about-open']) {
    assert.ok(tagWithId(rail, id), `#${id} が nav.navrail の中に無い`);
  }
});

test('レールの節点に title を付けない（吹き出しと OS の札が二重に出る）', () => {
  const rail = section('<nav class="navrail"', '</nav>');
  assert.doesNotMatch(rail, /\stitle="/, 'nav.navrail の中に title がある。名前は aria-label と data-tip が持つ');
});

test('消した部品が index.html に戻っていない', () => {
  const GONE = [
    [/statusbar/, '下段の帯（.statusbar）'],
    [/id="summary"/, '状態ごとの数（#summary）'],
    [/id="ver"/, '上のバーの版（#ver）'],
    [/rail-left/, '作業台の左端の細い帯（#rail-left）'],
    [/class="modes"/, '上のバーのモードの札（.modes）'],
  ];
  const bad = GONE.filter(([re]) => re.test(HTML)).map(([, label]) => label);
  assert.deepEqual(bad, [], `消したはずの部品が残っている: ${bad.join(' / ')}`);
});

test('上のバーに 一覧の開閉・題・接続の札・探す欄・再読み込み・起こす が居る', () => {
  const bar = section('<header class="topbar">', '</header>');
  for (const id of ['list-toggle', 'page-title', 'live', 'palette-open', 'reload', 'runform-open']) {
    assert.ok(tagWithId(bar, id), `#${id} が上のバーに無い`);
  }
});

test('上のバーの「起こす」は塗らない（塗った面は1画面に1つ。詳細の次の一手に譲る）', () => {
  const bar = section('<header class="topbar">', '</header>');
  const tag = tagWithId(bar, 'runform-open');
  assert.ok(tag, '#runform-open が上のバーに無い');
  assert.doesNotMatch(tag, /is-lead/, `#runform-open に is-lead が付いている: ${tag}`);
});

/* ── 字面：消した口が JS に戻っていない ─────────────────────── */

test('public/js に消した口（下段のまとめ・版・左の帯のボタン）が残っていない', () => {
  const WORDS = [
    [/renderSummary/, 'renderSummary（下段のまとめ）'],
    [/dom\.summary\b/, 'dom.summary'],
    [/dom\.ver\b/, 'dom.ver（上のバーの版）'],
    [/railBtn/, 'railBtn（作業台の左端の帯のボタン）'],
  ];
  const bad = [];
  for (const dir of [JS_DIR, path.join(JS_DIR, 'timeline')]) {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
      const code = jsCode(read(path.join(dir, f)));
      for (const [re, label] of WORDS) {
        if (re.test(code)) bad.push(`${f} … ${label}`);
      }
    }
  }
  assert.deepEqual(bad, [], `消した口が残っている:\n  ${bad.join('\n  ')}`);
});
