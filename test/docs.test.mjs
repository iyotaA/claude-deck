/**
 * 地図（`CLAUDE.md` の表）が実物と食い違っていないかを見る。
 *
 * このリポジトリは「どこに何があるか」を表で持っている。
 * **表は放っておくと必ず腐る。** 実際に腐っていた。
 * `src/view/query.mjs` と `src/shared/lru.mjs` と `src/shared/objects.mjs` は
 * リファクタの途中で足したのに、6段ぶん表に載らないまま進んでいた
 * （気づいたのは全部終わったあとの点検で、その間ずっと地図が嘘をついていた）。
 *
 * 見るのは**片方向だけ。** 「実物が表に載っているか」は見るが、
 * 「表に載っているものが実在するか」は見ない。
 * 消えたものを由来として語る記述（`mode.js` の「もとは `board.js`」など）は
 * 正しい説明なので、そこを落としてはいけない。
 *
 * 落ちたときにやるのは表へ1行足すことで、テストを直すことではない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * そのフォルダの中のファイル名を集める。
 *
 * @param {string} rel リポジトリ直下からの相対パス
 * @param {RegExp} match 拾う拡張子
 * @param {boolean} [deep] 下のフォルダまで潜るか
 * @returns {string[]} ファイル名（フォルダ名は付けない）
 */
function filesIn(rel, match, deep = false) {
  const dir = path.join(ROOT, rel);
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (deep) out.push(...filesIn(path.join(rel, e.name), match, true));
    } else if (match.test(e.name)) {
      out.push(e.name);
    }
  }
  return out;
}

/** @param {string} rel @returns {string} 中身 */
function doc(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/**
 * 表の中の、その行だけを取り出す。
 *
 * 行を丸ごと見るのは、同じ名前が別の層にもあるため（`state` は parse にも view にもある）。
 * 表全体で探すと、片方に載っていればもう片方が抜けていても通ってしまう。
 *
 * @param {string} text 表を含む文書
 * @param {string} head 行の先頭のセルの中身（`` `src/view/` `` など）
 * @returns {string} その1行
 */
function row(text, head) {
  const line = text.split('\n').find((l) => l.startsWith(`| \`${head}\` `));
  assert.ok(line, `表に ${head} の行が無い`);
  return line;
}

/**
 * 名前が表の中に在るか。前後をバッククォートで挟んで探す。
 *
 * 素の `includes` だと `state` が `startupState` にも当たる。
 *
 * @param {string} text 探す先
 * @param {string} name 探す名前
 * @returns {boolean}
 */
function listed(text, name) {
  return text.includes(`\`${name}\``);
}

test('src/ の8つの層のファイルが、ルートの表に全部載っている', () => {
  const map = doc('CLAUDE.md');
  const layers = ['read', 'parse', 'view', 'notify', 'run', 'update', 'startup', 'shared', 'os'];

  for (const layer of layers) {
    const line = row(map, `src/${layer}/`);
    // 下のフォルダ（`parse/digest/`）まで潜る。あちらは行の中に括弧で並べてある
    for (const file of filesIn(`src/${layer}`, /\.mjs$/, true)) {
      const stem = file.replace(/\.mjs$/, '');
      assert.ok(listed(line, stem), `src/${layer}/${file} がルートの表に無い`);
    }
  }
});

test('public/js のファイルが、画面側の層の表に全部載っている', () => {
  const map = doc('public/CLAUDE.md');
  for (const file of filesIn('public/js', /\.js$/)) {
    assert.ok(listed(map, file), `public/js/${file} が public/CLAUDE.md の表に無い`);
  }
  // 時系列の中は表に1行（`timeline/`）でまとめてあり、内訳は import の順を書いた行が持つ。
  // **その行だけを見る。** 文書全体で探すと `view` や `index` が別の話に当たって素通りする
  const order = map.split('\n').find((l) => l.includes('`timeline/` の中も同じで'));
  assert.ok(order, 'timeline/ の中の順を書いた行が見つからない');

  for (const file of filesIn('public/js/timeline', /\.js$/)) {
    const stem = file.replace(/\.js$/, '');
    assert.ok(listed(order, stem), `public/js/timeline/${file} が順を書いた行に無い`);
  }
});

test('public/css のファイルが、CSS の表に全部載っている', () => {
  const map = doc('public/CLAUDE.md');
  for (const file of filesIn('public/css', /\.css$/)) {
    assert.ok(listed(map, file), `public/css/${file} が public/CLAUDE.md の表に無い`);
  }
});

test('CSS の表の並びが、index.html の <link> の並びと同じ', () => {
  // **並びがそのまま重ね順になる。** 表の順が実物と食い違うと、
  // 「narrow.css は最後」のような約束を表から確かめられなくなる
  const links = [...doc('public/index.html').matchAll(/href="css\/([a-z-]+\.css)"/g)].map((m) => m[1]);
  assert.ok(links.length > 0, 'index.html から <link> を拾えない');

  const map = doc('public/CLAUDE.md');
  const rows = map
    .split('\n')
    .map((l) => l.match(/^\| `([a-z-]+\.css)` \|/))
    .filter(Boolean)
    .map((m) => m[1]);

  assert.deepEqual(rows, links, 'CSS の表の並びが index.html の <link> と違う');
  assert.equal(rows.at(-1), 'narrow.css', 'narrow.css が最後ではない');
});

test('test/ のテストが、test/CLAUDE.md の一覧に全部載っている', () => {
  const map = doc('test/CLAUDE.md');
  for (const file of filesIn('test', /\.test\.mjs$/)) {
    assert.ok(listed(map, file), `test/${file} が test/CLAUDE.md の一覧に無い`);
  }
});

test('launcher/ のファイルが、launcher/CLAUDE.md の表に全部載っている', () => {
  const map = doc('launcher/CLAUDE.md');
  for (const file of filesIn('launcher', /\.(cs|csproj)$/)) {
    assert.ok(listed(map, file), `launcher/${file} が launcher/CLAUDE.md の表に無い`);
  }
});
