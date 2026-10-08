/**
 * Markdown のパーサ。public/js/md.js の判断だけを見る。
 *
 * 画面側のファイルだが、パーサは DOM を1つも触らないので Node から import できる
 * （拡張子が .js なのは public/ の決まり。package.json が type:module なので ESM で読める）。
 *
 * 見るのは3点に絞ってある。
 *   1. 記法を記法として読めること
 *   2. 途中で切れた入力で壊れないこと（clip() が「…（以下省略）」を足すので日常的に来る）
 *   3. 頭出し（headBlocks）が中途半端な単位で終わらないこと
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, inlineSpans, headBlocks, blocksText, SAFE_HREF_RE } from '../public/js/md.js';

/**
 * spans を「印:中身」の並びに畳む。読みやすさのため。
 *
 * spans は平らな run に印（strong / del / href）を付けた形なので、印を + で繋いで頭に出す。
 * 太字の地の文は `strong:太字`、太字の中のコードは `strong+code:x`、
 * リンクは `link(URL):表示名`。印の無い地の文だけが `text:` になる。
 */
const flat = (spans) => spans.map((s) => {
  const tags = [];
  if (s.href) tags.push(`link(${s.href})`);
  if (s.strong) tags.push('strong');
  if (s.del) tags.push('del');
  if (s.type === 'code') tags.push('code');
  return `${tags.length ? tags.join('+') : 'text'}:${s.v}`;
});

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

/* ------------------------------------------------------------ チェックリスト */

test('チェックリストの4つの印を読む', () => {
  // [~] は GFM に無く Claude が独自に書くもの。実測1件で in_progress の意味だった
  const b = parseMarkdown('- [ ] 未\n- [x] 済\n- [X] 済\n- [~] 中');
  assert.deepEqual(b[0].items.map((i) => i.task), ['todo', 'done', 'done', 'doing']);
});

test('印は本文から剥がす', () => {
  // 残すと画面に印が二重に出るうえ、blocksText（予算と一致数の物差し）にも入る
  const b = parseMarkdown('- [x] Phase 1: 初期理解');
  assert.deepEqual(flat(b[0].items[0].spans), ['text:Phase 1: 初期理解']);
});

test('チェックボックスではない [n] を印にしない', () => {
  // 実データにある手順の番号（ユーザーの指示文で4件）。中を1文字なら何でも通す形に
  // すると、この番号が消えて空のチェックボックスに化ける
  const b = parseMarkdown('- [2] 消す対象の一覧とサイズを記録\n- [3] フルバックアップ');
  assert.deepEqual(b[0].items.map((i) => i.task), [null, null]);
  assert.deepEqual(flat(b[0].items[0].spans), ['text:[2] 消す対象の一覧とサイズを記録']);
});

test('印の後ろに空白が無ければ読まない', () => {
  // `- [x]abc` は記法として曖昧なので、素の文字として残す
  const b = parseMarkdown('- [x]くっついている');
  assert.equal(b[0].items[0].task, null);
  assert.deepEqual(flat(b[0].items[0].spans), ['text:[x]くっついている']);
});

test('印だけで本文が無い行も読む', () => {
  const b = parseMarkdown('- [ ]');
  assert.equal(b[0].items[0].task, 'todo');
  assert.deepEqual(b[0].items[0].spans, []);
});

test('番号付きでもチェックリストを読む', () => {
  // 実測では箇条書きだけだが、ul と ol で分ける理由が無い
  const b = parseMarkdown('1. [x] 済\n2. [ ] 未');
  assert.deepEqual(b[0].items.map((i) => i.task), ['done', 'todo']);
  assert.deepEqual(b[0].items.map((i) => i.ordered), [true, true]);
});

test('ふつうの項目の task は null', () => {
  // 0 と不明を分けるのと同じで、印が無いことを 'todo' に丸めない
  const b = parseMarkdown('- ただの項目');
  assert.equal(b[0].items[0].task, null);
});

test('入れ子でも印を読む', () => {
  const b = parseMarkdown('- [ ] 親\n  - [x] 子');
  assert.deepEqual(b[0].items.map((i) => [i.depth, i.task]), [[0, 'todo'], [1, 'done']]);
});

test('印の中の装飾は印を剥がしたあとで読む', () => {
  const b = parseMarkdown('- [x] `a.js` を **消す**');
  assert.equal(b[0].items[0].task, 'done');
  assert.deepEqual(flat(b[0].items[0].spans), ['code:a.js', 'text: を ', 'strong:消す']);
});

test('blocksText に印は入らない', () => {
  // 印は ::marker で出すので画面に文字として出ない。物差しに入れると
  // 「一致 N 件」と画面の色が食い違う
  assert.equal(blocksText(parseMarkdown('- [x] 済\n- [ ] 未')), '済\n未');
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

/* ------------------------------------------------------------------ 頭出し */

/** 頭出しの結果を「種類:中身」の並びに畳む */
const heads = (r) => r.blocks.map((b) => {
  if (b.type === 'p' || b.type === 'h') return `${b.type}:${b.spans.map((x) => x.v).join('')}`;
  if (b.type === 'code') return `code:${b.text}`;
  if (b.type === 'list') return `list:${b.items.map((i) => i.spans.map((x) => x.v).join('')).join('|')}`;
  if (b.type === 'table') return `table:${b.rows.length}`;
  return b.type;
});

test('予算に収まればそのまま返す', () => {
  const blocks = parseMarkdown('一行だけ');
  const r = headBlocks(blocks, 100, 10);
  assert.equal(r.cut, false);
  // ブロックを作り直さない。だから全文と頭出しで同じ並びを使い回せる
  assert.equal(r.blocks[0], blocks[0]);
});

test('ブロックの境目で切る', () => {
  const r = headBlocks(parseMarkdown('あいうえお\n\nかきくけこ'), 7, 10);
  assert.equal(r.cut, true);
  assert.deepEqual(heads(r), ['p:あいうえお', 'p:かき']);
});

test('行数の予算でも切る', () => {
  const r = headBlocks(parseMarkdown('あ\nい\nう\nえ'), 100, 2);
  assert.deepEqual(heads(r), ['p:あ\nい']);
  assert.equal(r.cut, true);
});

test('段落の切り跡の前に空白を残さない', () => {
  // 「…」の前に隙間が空くと、切ったのか元から空いているのかが読めない
  const r = headBlocks(parseMarkdown('あい   うえお'), 5, 10);
  assert.deepEqual(heads(r), ['p:あい']);
});

test('装飾の途中で切れても記号は漏れない', () => {
  // 切っているのは描いた結果。** が本文へ出てくることはない
  const r = headBlocks(parseMarkdown('ふつう **太字のとても長い所**'), 8, 10);
  assert.deepEqual(flat(r.blocks[0].spans), ['text:ふつう ', 'strong:太字のと']);
});

test('見出しは切っても段を保つ', () => {
  const r = headBlocks(parseMarkdown('# 見出しが長い'), 3, 10);
  assert.equal(r.blocks[0].type, 'h');
  assert.equal(r.blocks[0].level, 1);
  assert.deepEqual(flat(r.blocks[0].spans), ['text:見出し']);
});

test('閉じているフェンスを切っても open を立てない', () => {
  // open は「源のフェンスが閉じていない」印。頭出しで切ったことをここで立てると
  // 意味が2つになる（続きがあることは器の側の切り跡が出す）
  const r = headBlocks(parseMarkdown('```\na\nb\nc\n```'), 100, 2);
  assert.equal(r.blocks[0].text, 'a\nb');
  assert.equal(r.blocks[0].open, false);
  assert.equal(r.cut, true);

  // 源が閉じていないぶんはそのまま持っていく
  const open = headBlocks(parseMarkdown('```\na\nb\nc'), 100, 2);
  assert.equal(open.blocks[0].open, true);
});

test('表は見出しの行を予算より優先して残す', () => {
  // 見出しの無い表は表として読めない
  const r = headBlocks(parseMarkdown('| aaaa | bbbb |\n|---|---|\n| 1 | 2 |'), 3, 1);
  assert.equal(r.blocks[0].type, 'table');
  assert.equal(r.blocks[0].head.length, 2);
  assert.equal(r.blocks[0].rows.length, 0);
});

test('表は行の途中で切らない', () => {
  const r = headBlocks(parseMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |'), 8, 10);
  assert.deepEqual(heads(r), ['table:1']);
  assert.deepEqual(r.blocks[0].rows[0].map(flat), [['text:1'], ['text:2']]);
});

test('箇条書きは2件目以降を切らない', () => {
  // 項目の途中で終わると、まだ続きの行があるように見える
  const r = headBlocks(parseMarkdown('- あいう\n- えおか\n- きくけ'), 7, 10);
  assert.deepEqual(heads(r), ['list:あいう|えおか']);
});

test('箇条書きの1件目だけは切って入れる', () => {
  // ここで諦めると、箇条書きしか無い本文の頭出しが空になる
  const r = headBlocks(parseMarkdown('- あいうえおかきくけこ\n- 次'), 4, 10);
  assert.deepEqual(heads(r), ['list:あいうえ']);
});

test('末尾に残った区切り線は落とす', () => {
  // 後ろには切り跡の「…」しか来ないので、区切る先の無い線だけが残る
  const r = headBlocks(parseMarkdown('あい\n\n---\n\nうえ'), 2, 10);
  assert.deepEqual(heads(r), ['p:あい']);
  assert.equal(r.cut, true);
});

test('1文字も入らなければブロック0件で切ったと返す', () => {
  const r = headBlocks(parseMarkdown('あいう'), 0, 10);
  assert.deepEqual(r.blocks, []);
  assert.equal(r.cut, true);
});

/* ------------------------------------------------------------ 描いたあとの文字 */

test('blocksText は記法の記号を含まない', () => {
  // 予算も検索の一致数も、これ1つを物差しにする。素の文字を数えると
  // ** や | まで数に入り、「一致 3 件」と出ているのに画面に色が付かない
  const src = '# 見出し\n\n**太字**と `code`\n\n---\n\n- 項目';
  assert.equal(blocksText(parseMarkdown(src)), '見出し\n太字と code\n項目');
});

test('blocksText は表のセルをタブで繋ぐ', () => {
  // 空文字で繋ぐと、隣のセルと跨いだ語が一致してしまう
  const src = '| a | b |\n|---|---|\n| 1 | 2 |';
  assert.equal(blocksText(parseMarkdown(src)), 'a\tb\n1\t2');
});

test('blocksText はリンクの URL を数えず、表示名だけを数える', () => {
  // URL は画面に文字として出ない（title に入るだけ）。数えると「一致 N 件」と色が食い違う。
  // 素の URL は画面にそのまま出るので数える
  const src = '[資料](https://example.com/doc) と https://a.example/x';
  assert.equal(blocksText(parseMarkdown(src)), '資料 と https://a.example/x');
});

/* ------------------------------------------------------------------ リンク */

test('http / https のリンクは表示名に href を付ける', () => {
  assert.deepEqual(flat(inlineSpans('[資料](https://example.com/a?b=1) を見る')), [
    'link(https://example.com/a?b=1):資料',
    'text: を見る',
  ]);
  assert.deepEqual(flat(inlineSpans('[x](HTTP://example.com)')), ['link(HTTP://example.com):x']);
});

test('表の中のリンクも読む', () => {
  // 実測で来たのはこの形（表の1列目に [表示名](URL)）。前は記号ごと出ていた
  const b = parseMarkdown('| 参考 | 何を |\n|---|---|\n| [gist](https://gist.github.com/x) | 元ネタ |');
  assert.deepEqual(flat(b[0].rows[0][0]), ['link(https://gist.github.com/x):gist']);
});

test('javascript: と相対パスはリンクにせず、表示名だけを出す', () => {
  // javascript: を通したら終わり。相対パスは ClaudeDeck から開けない
  assert.deepEqual(flat(inlineSpans('[押す](javascript:alert) だけ')), ['text:押す', 'text: だけ']);
  assert.deepEqual(flat(inlineSpans('[手順](./docs/a.md)')), ['text:手順']);
  assert.deepEqual(flat(inlineSpans('[宛先](mailto:a@example.com)')), ['text:宛先']);
  // 表示名の中の記法は描く
  assert.deepEqual(flat(inlineSpans('[`a.md`](a.md)')), ['code:a.md']);
});

test('href を付けてよいかの式は http / https だけを通す', () => {
  // md-view.js も a を作る直前にこの式で確かめる
  assert.ok(SAFE_HREF_RE.test('https://x'));
  assert.ok(SAFE_HREF_RE.test('http://x'));
  assert.ok(!SAFE_HREF_RE.test('javascript:alert(1)'));
  assert.ok(!SAFE_HREF_RE.test(' https://x'));
  assert.ok(!SAFE_HREF_RE.test('//example.com'));
});

test('画像記法は丸ごと素の文字（中の URL もリンクにしない）', () => {
  assert.deepEqual(flat(inlineSpans('![図](https://example.com/a.png)')), ['text:![図](https://example.com/a.png)']);
});

test('Wiki リンク [[x]] は素の文字', () => {
  assert.deepEqual(flat(inlineSpans('[[設計の判断]] を見る')), ['text:[[設計の判断]] を見る']);
});

test('閉じていない [ や、( の続かない [ ] は素の文字', () => {
  assert.deepEqual(flat(inlineSpans('[途中で切れた')), ['text:[途中で切れた']);
  assert.deepEqual(flat(inlineSpans('[注] 補足')), ['text:[注] 補足']);
  // URL に空白があればリンクではない
  assert.deepEqual(flat(inlineSpans('[a](b c)')), ['text:[a](b c)']);
  // ) で閉じていなければリンクではない。中の URL は素の URL として拾う
  assert.deepEqual(flat(inlineSpans('[表示名](https://example.com')), [
    'text:[表示名](',
    'link(https://example.com):https://example.com',
  ]);
});

/* ------------------------------------------------------------------ 素の URL */

test('素の URL をリンクにする', () => {
  assert.deepEqual(flat(inlineSpans('見て https://example.com/a/b?c=1#d です')), [
    'text:見て ',
    'link(https://example.com/a/b?c=1#d):https://example.com/a/b?c=1#d',
    'text: です',
  ]);
});

test('素の URL は日本語の 」 や 、 で止まる', () => {
  assert.deepEqual(flat(inlineSpans('「https://example.com/x」、次へ')), [
    'text:「',
    'link(https://example.com/x):https://example.com/x',
    'text:」、次へ',
  ]);
});

test('素の URL の末尾の句読点と、対応しない ) は外す', () => {
  assert.deepEqual(flat(inlineSpans('https://example.com/x.')), [
    'link(https://example.com/x):https://example.com/x',
    'text:.',
  ]);
  assert.deepEqual(flat(inlineSpans('(https://example.com/x)')), [
    'text:(',
    'link(https://example.com/x):https://example.com/x',
    'text:)',
  ]);
  // 対応の取れた括弧は URL の一部
  assert.deepEqual(flat(inlineSpans('https://en.wikipedia.org/wiki/Foo_(bar)')), [
    'link(https://en.wikipedia.org/wiki/Foo_(bar)):https://en.wikipedia.org/wiki/Foo_(bar)',
  ]);
});

test('直前が英数字なら素の URL として読まない', () => {
  assert.deepEqual(flat(inlineSpans('xhttps://example.com')), ['text:xhttps://example.com']);
  // スキームだけで中身が無いものも読まない
  assert.deepEqual(flat(inlineSpans('https://')), ['text:https://']);
});

test('コードの中の URL はリンクにしない', () => {
  assert.deepEqual(flat(inlineSpans('`https://example.com`')), ['code:https://example.com']);
});

/* ------------------------------------------------------------------ 太字の中 */

test('太字の中のコードを読む', () => {
  // 実測で assistant の 4.4%。前はバッククォートがそのまま太字で出ていた
  assert.deepEqual(flat(inlineSpans('**チェッカー（`x.py`）**')), [
    'strong:チェッカー（',
    'strong+code:x.py',
    'strong:）',
  ]);
});

test('太字の中のリンクと素の URL を読む', () => {
  assert.deepEqual(flat(inlineSpans('**[資料](https://example.com) と https://a.example**')), [
    'link(https://example.com)+strong:資料',
    'strong: と ',
    'link(https://a.example)+strong:https://a.example',
  ]);
});

test('リンクの表示名の中の太字とコードを読む', () => {
  assert.deepEqual(flat(inlineSpans('[**`a.js`** を開く](https://example.com)')), [
    'link(https://example.com)+strong+code:a.js',
    'link(https://example.com): を開く',
  ]);
});

/* ------------------------------------------------------------------ 打ち消し */

test('打ち消しを読む。中の記法も読む', () => {
  assert.deepEqual(flat(inlineSpans('~~古い案~~ 新しい案')), ['del:古い案', 'text: 新しい案']);
  assert.deepEqual(flat(inlineSpans('~~`a.js`~~')), ['del+code:a.js']);
  assert.deepEqual(flat(inlineSpans('**~~消した~~**')), ['strong+del:消した']);
});

test('閉じていない ** と ~~ は素の文字のまま', () => {
  assert.deepEqual(flat(inlineSpans('~~切れた')), ['text:~~切れた']);
  assert.deepEqual(flat(inlineSpans('**太字の `x` 切れ')), ['text:**太字の ', 'code:x', 'text: 切れ']);
  assert.deepEqual(flat(inlineSpans('~~~~')), ['text:~~~~']);
});

/* ------------------------------------------------------------------ 引用 */

test('続いている > の行を1つの引用にまとめる', () => {
  const b = parseMarkdown('> 一行目\n> 二行目\n\n地の文');
  assert.deepEqual(b.map((x) => x.type), ['quote', 'p']);
  assert.deepEqual(b[0].blocks.map((x) => x.type), ['p']);
  assert.deepEqual(flat(b[0].blocks[0].spans), ['text:一行目\n二行目']);
});

test('引用の中の記法も読む', () => {
  const b = parseMarkdown('> ## 見出し\n> - `a.js` を **消す**\n>\n> [資料](https://example.com)');
  assert.deepEqual(b[0].blocks.map((x) => x.type), ['h', 'list', 'p']);
  assert.deepEqual(flat(b[0].blocks[1].items[0].spans), ['code:a.js', 'text: を ', 'strong:消す']);
  assert.deepEqual(flat(b[0].blocks[2].spans), ['link(https://example.com):資料']);
});

test('引用は > の無い行で終わる。前の段落も切る', () => {
  const b = parseMarkdown('地の文\n> 引用\n続き');
  assert.deepEqual(b.map((x) => x.type), ['p', 'quote', 'p']);
});

test('引用の中の引用も読む', () => {
  const b = parseMarkdown('> 外\n>\n> > 中');
  assert.deepEqual(b[0].blocks.map((x) => x.type), ['p', 'quote']);
  assert.deepEqual(flat(b[0].blocks[1].blocks[0].spans), ['text:中']);
});

test('フェンスの中の > は引用にしない', () => {
  const b = parseMarkdown('```\n> そのまま\n```');
  assert.deepEqual(b, [{ type: 'code', lang: null, text: '> そのまま', open: false }]);
});

test('blocksText は引用の記号を含まない', () => {
  assert.equal(blocksText(parseMarkdown('> **あ**\n>\n> い')), 'あ\nい');
});

test('引用は途中で切っても引用のまま', () => {
  const r = headBlocks(parseMarkdown('> あいうえお\n>\n> かきくけこ\n\n後ろ'), 7, 10);
  assert.equal(r.cut, true);
  assert.equal(r.blocks.length, 1);
  assert.equal(r.blocks[0].type, 'quote');
  assert.deepEqual(r.blocks[0].blocks.map((b) => flat(b.spans)), [['text:あいうえお'], ['text:かき']]);
});

test('引用の中身が1文字も入らなければ引用ごと落とす', () => {
  const r = headBlocks(parseMarkdown('あいう\n\n> えお'), 3, 10);
  assert.deepEqual(heads(r), ['p:あいう']);
  assert.equal(r.cut, true);
});

/* ------------------------------------------------------------ 表のセルの <br> */

test('表のセルの <br> を改行にする（見出し行も、大小も問わない）', () => {
  const b = parseMarkdown('| 上<br>下 | a<BR/>b |\n|---|---|\n| 1<br />2 | x |');
  assert.deepEqual(b[0].head.map(flat), [['text:上\n下'], ['text:a\nb']]);
  assert.deepEqual(flat(b[0].rows[0][0]), ['text:1\n2']);
});

test('コードの中の <br> は変えない', () => {
  const b = parseMarkdown('| 書き方 |\n|---|\n| `<br>` で改行 |');
  assert.deepEqual(flat(b[0].rows[0][0]), ['code:<br>', 'text: で改行']);
});

test('表の外の <br> は素の文字のまま', () => {
  assert.deepEqual(flat(parseMarkdown('a<br>b')[0].spans), ['text:a<br>b']);
});

/* ------------------------------------------------------------ 空行で離す */

test('空行を1つ挟んだ直後の項目に gap を立てる', () => {
  const b = parseMarkdown('- 一\n- 二\n\n- 三\n- 四');
  assert.equal(b.length, 1);
  assert.deepEqual(b[0].items.map((i) => i.gap), [false, false, true, false]);
});

test('gap を立てても番号付きの番号は振り直さない', () => {
  const b = parseMarkdown('1. 一\n\n2. 二');
  assert.deepEqual(b[0].items.map((i) => [i.num, i.gap]), [[1, false], [2, true]]);
});

test('継続行のあとの空行も gap になる', () => {
  const b = parseMarkdown('- 一\n  続き\n\n- 二');
  assert.deepEqual(b[0].items.map((i) => i.gap), [false, true]);
});

/* ------------------------------------------------------------ 頭出しが印を保つ */

test('頭出しで切っても印（太字・リンク・打ち消し）を落とさない', () => {
  // cutSpans が { type, v } だけを作り直すと、頭出しだけリンクや太字が消える
  const r = headBlocks(parseMarkdown('**[とても長い表示名](https://example.com)** と ~~消した~~'), 4, 10);
  assert.deepEqual(flat(r.blocks[0].spans), ['link(https://example.com)+strong:とても長']);

  const list = headBlocks(parseMarkdown('- ~~済~~ [a](https://x.example) の続きがとても長い\n- 次'), 5, 10);
  assert.deepEqual(flat(list.blocks[0].items[0].spans), ['del:済', 'text: ', 'link(https://x.example):a', 'text: の']);
});

/* ------------------------------------------------------------ レビューの手当て */

test('リンクの URL は対応の取れた ) で閉じる', () => {
  // 最初の ) で切ると Foo_(bar の別ページへリンクしてしまう
  assert.deepEqual(flat(inlineSpans('[Foo](https://en.wikipedia.org/wiki/Foo_(bar)) を見る')), [
    'link(https://en.wikipedia.org/wiki/Foo_(bar)):Foo',
    'text: を見る',
  ]);
});

test('括弧を含む javascript: もリンクにならず、表示名だけが残る', () => {
  // 対応を数えるので、閉じ括弧が本文へ漏れない
  assert.deepEqual(flat(inlineSpans('[押す](javascript:alert(1)) だけ')), ['text:押す', 'text: だけ']);
});

test('リンクの URL の ( が閉じていなければリンクにしない', () => {
  assert.deepEqual(flat(inlineSpans('[a](https://x.example/(b c')), ['text:[a](', 'link(https://x.example/(b):https://x.example/(b', 'text: c']);
});

test('引用の入れ子は上限（8段）まで。超えたぶんは素の文字', () => {
  // 上限が無いと、> を数千並べた1行で再帰が深くなって落ちる
  const deep = parseMarkdown(`${'>'.repeat(5000)} 深い`);
  let b = deep[0];
  let n = 0;
  while (b.type === 'quote') {
    n += 1;
    b = b.blocks[0];
  }
  assert.equal(n, 8);
  assert.equal(b.type, 'p');
  assert.ok(blocksText(deep).endsWith('> 深い'));

  // 上限より浅いものは今までどおり
  const two = parseMarkdown('> > 中');
  assert.equal(two[0].blocks[0].type, 'quote');
});

test('長い悪意ある入力でも時間が掛からない', () => {
  // [a](x の繰り返しは [ のたびに行末まで、) の連なりは外すたびに全体を数え直すと2乗になる
  const links = '[a](x'.repeat(10000);
  const parens = `https://a${')'.repeat(200000)}`;
  const t0 = Date.now();
  assert.equal(inlineSpans(links).length, 1);
  assert.deepEqual(flat(inlineSpans(parens)).slice(0, 1), ['link(https://a):https://a']);
  // 単体なら 0.1 秒ほど。npm test は他のファイルと並んで走るので、余裕を大きく取る
  assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0}ms`);
});

test('<br> のある表は、頭出しの行数を blockSize と同じく改行で数える', () => {
  // 1行目が3行ぶんの高さを取る。予算 4 なら見出しと1行目まで、予算 3 なら見出しだけ
  const src = '| 見出し |\n|---|\n| 一<br>二<br>三 |\n| 次 |';
  const r = headBlocks(parseMarkdown(src), 1000, 4);
  assert.equal(r.cut, true);
  assert.equal(r.blocks[0].rows.length, 1);

  const tight = headBlocks(parseMarkdown(src), 1000, 3);
  assert.equal(tight.blocks[0].rows.length, 0);
});
