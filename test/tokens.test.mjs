/**
 * 色のトークン（`public/css/tokens.css`）の二重定義を見る。
 *
 * ここに並ぶのは contract.test.mjs と同じ種類の約束 ――
 * **片方だけ直しても何のエラーも出ないもの。**
 *
 * `tokens.css` は同じ意味トークンを3箇所で割り当てている。
 *
 * - `:root`（明るいほう）
 * - `@media (prefers-color-scheme: dark)` の中
 * - `:root[data-theme="dark"]`（閲覧側が選んだとき）
 *
 * 1つ足したときに下2つを忘れると、**明るいほうでは正しく、暗いほうでだけ
 * 古い色が出る**（あるいは変数ごと解決できずに宣言が丸ごと落ちる）。
 * どちらも画面を開いて配色を切り替えるまで気づけない。
 *
 * **CSS を解析しない。** 字面を読むだけにしてある。ここで見たいのは
 * 「3箇所に同じ名前が在るか」だけで、値の正しさではない。
 * パーサを持ち込むと、外の道具を増やさない決まりに触れるうえ、
 * 落ちたときに「テストが壊れたのか実装が壊れたのか」が読みにくくなる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const CSS = fs.readFileSync(
  fileURLToPath(new URL('../public/css/tokens.css', import.meta.url)),
  'utf8',
);

/**
 * ブロックの中身を取り出す。
 *
 * 波かっこを数えて閉じ位置を探す。`@media` のように入れ子になっているものが
 * あるので、最初の `}` で切ってはいけない。
 *
 * @param {string} head ブロックの見出し（`:root {` など）
 * @returns {string} 中身（見出しと閉じかっこは含まない）
 */
function block(head) {
  const at = CSS.indexOf(head);
  assert.notEqual(at, -1, `${head} が見つからない`);
  let depth = 0;
  for (let i = at + head.length - 1; i < CSS.length; i += 1) {
    if (CSS[i] === '{') depth += 1;
    else if (CSS[i] === '}') {
      depth -= 1;
      if (depth === 0) return CSS.slice(at + head.length, i);
    }
  }
  throw new Error(`${head} が閉じていない`);
}

/**
 * そのブロックが割り当てている変数の名前を集める。
 *
 * @param {string} text ブロックの中身
 * @returns {Set<string>}
 */
function assigned(text) {
  return new Set([...text.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
}

const ROOT = block(':root {');
const MEDIA = block('@media (prefers-color-scheme: dark) {');
const PICKED = block(':root[data-theme="dark"] {');

/** `:root` が置いている意味トークン。`--l-*` と `--d-*`（実体）は除く。 */
function meaningful(names) {
  return [...names].filter((n) => !n.startsWith('--l-') && !n.startsWith('--d-'));
}

test('明るいほうの実体（--l-*）と暗いほうの実体（--d-*）が1対1で揃っている', () => {
  const light = [...assigned(ROOT)].filter((n) => n.startsWith('--l-'));
  const dark = new Set([...assigned(ROOT)].filter((n) => n.startsWith('--d-')));

  assert.ok(light.length >= 20, `--l-* が少なすぎる（${light.length}）。読めていない`);

  for (const name of light) {
    const twin = name.replace(/^--l-/, '--d-');
    assert.ok(dark.has(twin), `${name} に対する ${twin} が無い。暗いほうだけ古くなる`);
  }
  for (const name of dark) {
    const twin = name.replace(/^--d-/, '--l-');
    assert.ok(assigned(ROOT).has(twin), `${name} に対する ${twin} が無い`);
  }
});

test('暗いほうへの差し替えが2箇所とも同じ顔ぶれ', () => {
  const media = meaningful(assigned(MEDIA));
  const picked = meaningful(assigned(PICKED));

  // color-scheme は変数ではないので、上の正規表現には引っかからない
  assert.deepEqual(
    media.slice().sort(),
    picked.slice().sort(),
    '@media の側と [data-theme="dark"] の側で、差し替えている顔ぶれが違う',
  );
});

test('明るいほうで割り当てた意味トークンは、暗いほうでも全部差し替わる', () => {
  // 明暗で変える必要がないもの。:root の1箇所だけで済ませてある
  //（--l-* / --d-* を増やさないぶん、二重定義を両方直す義務も生まれない）
  const SHARED = new Set([
    '--font-sans', '--font-mono',
    '--r-xs', '--r-sm', '--r-md', '--r-lg', '--r-pill',
    '--fs-0', '--fs-1', '--fs-2', '--fs-3', '--fs-4', '--fs-5', '--fs-6', '--fs-7',
    '--lh-tight', '--lh-read',
    '--scrim', '--read-max',
  ]);

  const picked = new Set(meaningful(assigned(PICKED)));

  for (const name of meaningful(assigned(ROOT))) {
    if (SHARED.has(name)) continue;
    assert.ok(
      picked.has(name),
      `${name} が暗いほうで差し替わっていない。`
      + '明暗で変えないものなら、このテストの SHARED へ足す',
    );
  }
});

test('暗いほうで差し替えているものは、明るいほうにも居る', () => {
  const root = assigned(ROOT);
  for (const name of meaningful(assigned(PICKED))) {
    assert.ok(root.has(name), `${name} が明るいほうに無い。暗いほうでしか定義されていない`);
  }
});

test('意味トークンは実体（--l-* / --d-*）を指す。色を直に書かない', () => {
  // 直に書くと、明暗のどちらか片方にしか効かない値が意味トークンに混ざる。
  // 例外は明暗で変えないもの（膜と読む幅）だけ
  const EXCEPT = new Set(['--scrim', '--read-max']);

  for (const [, name, value] of ROOT.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    if (name.startsWith('--l-') || name.startsWith('--d-')) continue;
    if (EXCEPT.has(name)) continue;
    if (/^(--font|--r-|--fs-|--lh-)/.test(name)) continue;
    assert.match(
      value.trim(),
      /^var\(--[ld]-/,
      `${name} が実体を指していない（${value.trim()}）。片方の配色にしか効かない`,
    );
  }
});
