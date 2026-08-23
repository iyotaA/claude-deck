/**
 * Markdown のパーサ。public/js/md.js の判断だけを見る。
 *
 * 画面側のファイルだが、パーサは DOM を1つも触らないので Node から import できる
 * （拡張子が .js なのは public/ の決まり。package.json が type:module なので ESM で読める）。
 *
 * 見るのは2点に絞ってある。
 *   1. 記法を記法として読めること
 *   2. 途中で切れた入力で壊れないこと（clip() が「…（以下省略）」を足すので日常的に来る）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, inlineSpans, isPlain } from '../public/js/md.js';

/** spans を「装飾の種類:中身」の並びに畳む。読みやすさのため */
const flat = (spans) => spans.map((s) => `${s.type}:${s.v}`);

/* ------------------------------------------------------------------ 空 */

test('空の入力はブロック0件。null / undefined でも落ちない', () => {
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseMarkdown(null), []);
  assert.deepEqual(parseMarkdown(undefined), []);
  assert.deepEqual(parseMarkdown('   \n\n  \n'), []);
});

/* ------------------------------------------------------------------ 見出し */

test('見出しは # の後に空白があるときだけ', () => {
  assert.deepEqual(parseMarkdown('# 見出し'), [
    { type: 'h', level: 1, spans: [{ type: 'text', v: '見出し' }] },
  ]);
  assert.equal(parseMarkdown('###### 6段')[0].level, 6);
});

test('# の後に空白が無いものは見出しにしない', () => {
  // #!/bin/sh や #1 のような書き方を見出しへ化かさないため
  const b = parseMarkdown('#見出しではない');
  assert.equal(b[0].type, 'p');
  assert.deepEqual(flat(b[0].spans), ['text:#見出しではない']);
});

test('# が7つ以上なら見出しにしない', () => {
  assert.equal(parseMarkdown('####### 7段')[0].type, 'p');
});

test('見出しの中の装飾も読む', () => {
  const b = parseMarkdown('## `code` と **太字**');
  assert.deepEqual(flat(b[0].spans), ['code:code', 'text: と ', 'strong:太字']);
});

/* ------------------------------------------------------------------ 装飾 */

test('太字とインラインコード', () => {
  assert.deepEqual(flat(inlineSpans('**太い**')), ['strong:太い']);
  assert.deepEqual(flat(inlineSpans('a `b` c')), ['text:a ', 'code:b', 'text: c']);
});

test('閉じていない記号はただの文字として残す', () => {
  // clip() で切られた入力が来る。ここで装飾に化かすと、そこから先が全部太字になる
  assert.deepEqual(flat(inlineSpans('**切れた')), ['text:**切れた']);
  assert.deepEqual(flat(inlineSpans('`切れた')), ['text:`切れた']);
  assert.deepEqual(flat(inlineSpans('****')), ['text:****']);
});

test('コードの中の ** は太字にしない', () => {
  // バッククォートを先に見ているため。** を含むコードを画面へ出せる
  assert.deepEqual(flat(inlineSpans('`**a**`')), ['code:**a**']);
});

test('バッククォート2本で囲む形も読む', () => {
  assert.deepEqual(flat(inlineSpans('``a`b``')), ['code:a`b']);
});

test('斜体（* 1つ）は装飾しない', () => {
  // *.js のようなふつうの文字列が斜体に化けるのを防ぐため、はじめから見ない
  assert.deepEqual(flat(inlineSpans('*.js を消す')), ['text:*.js を消す']);
});

/* ------------------------------------------------------------------ フェンス */

test('コードフェンスは言語つきでも無しでも読む', () => {
  assert.deepEqual(parseMarkdown('```js\nconst a = 1;\n```'), [
    { type: 'code', lang: 'js', text: 'const a = 1;', open: false },
  ]);
  const bare = parseMarkdown('```\nplain\n```');
  assert.equal(bare[0].lang, null);
  assert.equal(bare[0].text, 'plain');
});

test('閉じていないフェンスは open で返す', () => {
  // clip() が「…（以下省略）」を足すので、この形は日常的に来る
  assert.deepEqual(parseMarkdown('```\n途中で切れた'), [
    { type: 'code', lang: null, text: '途中で切れた', open: true },
  ]);
});

test('フェンスの中の # は見出しにしない', () => {
  const b = parseMarkdown('```\n# コメント\n- 箇条書きでもない\n```');
  assert.equal(b.length, 1);
  assert.equal(b[0].text, '# コメント\n- 箇条書きでもない');
});

test('~~~ でも開ける。閉じるのは同じ記号だけ', () => {
  const b = parseMarkdown('~~~\n```\n~~~');
  assert.equal(b.length, 1);
  assert.equal(b[0].text, '```');
  assert.equal(b[0].open, false);
});

test('フェンスの前後の段落は分かれる', () => {
  const b = parseMarkdown('前\n```\nx\n```\n後');
  assert.deepEqual(b.map((x) => x.type), ['p', 'code', 'p']);
});

/* ------------------------------------------------------------------ 箇条書き */

test('箇条書きは1つのブロックにまとまる', () => {
  const b = parseMarkdown('- 一\n- 二\n- 三');
  assert.equal(b.length, 1);
  assert.equal(b[0].type, 'list');
  assert.equal(b[0].items.length, 3);
  assert.deepEqual(b[0].items.map((i) => i.depth), [0, 0, 0]);
  assert.equal(b[0].items[0].ordered, false);
});

test('番号付きは番号を持つ', () => {
  const b = parseMarkdown('1. 一\n2) 二');
  assert.deepEqual(b[0].items.map((i) => i.num), [1, 2]);
  assert.deepEqual(b[0].items.map((i) => i.ordered), [true, true]);
});

test('深さは字下げの量ではなく相対で決める', () => {
  // 2つ字下げする人と4つ字下げする人がいる。量を信じると片方が崩れる
  const two = parseMarkdown('- 親\n  - 子\n    - 孫\n  - 子\n- 親');
  assert.deepEqual(two[0].items.map((i) => i.depth), [0, 1, 2, 1, 0]);

  const four = parseMarkdown('- 親\n    - 子\n        - 孫');
  assert.deepEqual(four[0].items.map((i) => i.depth), [0, 1, 2]);
});

test('深さの上限は3', () => {
  const b = parseMarkdown('- 0\n  - 1\n    - 2\n      - 3\n        - 4');
  assert.deepEqual(b[0].items.map((i) => i.depth), [0, 1, 2, 3, 3]);
});

test('字下げされた継続行は直前の項目へ足す', () => {
  const b = parseMarkdown('- 長い項目の\n  続き');
  assert.equal(b[0].items.length, 1);
  assert.deepEqual(flat(b[0].items[0].spans), ['text:長い項目の\n続き']);
});

test('空行1つはリストの中の隙間として飲む。2つで終わり', () => {
  const one = parseMarkdown('- 一\n\n- 二');
  assert.equal(one.length, 1);
  assert.equal(one[0].items.length, 2);

  const two = parseMarkdown('- 一\n\n\n地の文');
  assert.deepEqual(two.map((x) => x.type), ['list', 'p']);
});

test('字下げの無い文が来たらリストは終わる', () => {
  const b = parseMarkdown('- 一\n地の文');
  assert.deepEqual(b.map((x) => x.type), ['list', 'p']);
  assert.equal(b[0].items.length, 1);
});

test('項目の中の装飾も読む', () => {
  const b = parseMarkdown('- `a.js` を **消す**');
  assert.deepEqual(flat(b[0].items[0].spans), ['code:a.js', 'text: を ', 'strong:消す']);
});

/* ------------------------------------------------------------------ 表 */

test('表は区切り行があるときだけ', () => {
  const b = parseMarkdown('| 名前 | 役割 |\n|---|---|\n| a | b |\n| c | d |');
  assert.equal(b.length, 1);
  assert.equal(b[0].type, 'table');
  assert.deepEqual(b[0].head.map(flat), [['text:名前'], ['text:役割']]);
  assert.equal(b[0].rows.length, 2);
  assert.deepEqual(b[0].rows[1].map(flat), [['text:c'], ['text:d']]);
});

test('区切り行が無ければ表にしない', () => {
  const b = parseMarkdown('| これは | 表ではない |\nただの行');
  assert.deepEqual(b.map((x) => x.type), ['p']);
});

test('寄せの指定を読む', () => {
  const b = parseMarkdown('| a | b | c | d |\n|:--|--:|:-:|---|\n| 1 | 2 | 3 | 4 |');
  assert.deepEqual(b[0].align, ['left', 'right', 'center', null]);
});

test('セルの数が食い違っても落とさない', () => {
  // 黙って捨てると、行があるのに中身が消える。多い側はそのまま持つ
  const b = parseMarkdown('| a | b |\n|---|---|\n| 1 | 2 | 3 |\n| 4 |');
  assert.deepEqual(b[0].rows.map((r) => r.length), [3, 1]);
});

test('エスケープしたパイプはセルの中の文字', () => {
  const b = parseMarkdown('| 記号 |\n|---|\n| a \\| b |');
  assert.deepEqual(flat(b[0].rows[0][0]), ['text:a | b']);
});

test('表は空行か | の無い行で終わる', () => {
  const b = parseMarkdown('| a |\n|---|\n| 1 |\n\n地の文');
  assert.deepEqual(b.map((x) => x.type), ['table', 'p']);
  assert.equal(b[0].rows.length, 1);
});

/* ------------------------------------------------------------------ 水平線 */

test('水平線は3種類の記号を読む', () => {
  assert.deepEqual(parseMarkdown('---'), [{ type: 'hr' }]);
  assert.deepEqual(parseMarkdown('***'), [{ type: 'hr' }]);
  assert.deepEqual(parseMarkdown('___'), [{ type: 'hr' }]);
  assert.deepEqual(parseMarkdown('- - -'), [{ type: 'hr' }]);
});

test('| の行の次に水平線が来ても表にしない', () => {
  // dividerCells が | を要求している。ここを緩めると1列の表に化ける
  const b = parseMarkdown('a | b\n---');
  assert.deepEqual(b.map((x) => x.type), ['p', 'hr']);
});

test('箇条書きの記号は水平線にしない', () => {
  assert.equal(parseMarkdown('- 一')[0].type, 'list');
});

/* ------------------------------------------------------------------ 段落 */

test('段落は空行で分かれ、中の改行は残る', () => {
  // 改行を残すのは、画面側が white-space: pre-wrap で出しているため
  const b = parseMarkdown('一行目\n二行目\n\n次の段落');
  assert.deepEqual(b.map((x) => x.type), ['p', 'p']);
  assert.deepEqual(flat(b[0].spans), ['text:一行目\n二行目']);
  assert.deepEqual(flat(b[1].spans), ['text:次の段落']);
});

test('見出しは段落を切る', () => {
  const b = parseMarkdown('地の文\n# 見出し\n続き');
  assert.deepEqual(b.map((x) => x.type), ['p', 'h', 'p']);
});

/* ------------------------------------------------------------------ 素の文字か */

test('isPlain は記法が無いときだけ true', () => {
  assert.equal(isPlain(parseMarkdown('ただの文\n改行あり')), true);
  assert.equal(isPlain(parseMarkdown('')), true);
  assert.equal(isPlain(parseMarkdown('**太字**あり')), false);
  assert.equal(isPlain(parseMarkdown('# 見出し')), false);
  assert.equal(isPlain(parseMarkdown('一\n\n二')), false);
});
