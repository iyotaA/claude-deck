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
    '--fs-0', '--fs-1', '--fs-2', '--fs-3', '--fs-4', '--fs-5', '--fs-6',
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

/* ── コントラスト ─────────────────────────────────────── */

/**
 * 相対輝度（WCAG 2.x）。
 *
 * **外の道具を入れずに書ける。** 10行の純関数なので、
 * 「依存パッケージを増やさない」に触らない。
 *
 * @param {string} hex `#RRGGBB`
 * @returns {number}
 */
function luminance(hex) {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/**
 * 対比。大きいほうが上に来るように割る。
 *
 * @param {string} fg 字の色
 * @param {string} bg 地の色
 * @returns {number}
 */
function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * トークンの値を引く。`#RRGGBB` 以外（rgb() など）は null。
 *
 * @param {string} name `--l-fg` など
 * @returns {string|null}
 */
function hexOf(name) {
  const m = ROOT.match(new RegExp(String.raw`${name}\s*:\s*(#[0-9A-Fa-f]{6})\b`));
  return m ? m[1] : null;
}

test('字の3段は、実際に敷かれている2つの地の両方で AA を満たす', () => {
  // **`--l-bg` だけで測らない。** tokens.css の注記はその地の値だが、
  // `body` の地は `--l-bg-sunk`（base.css）で1段沈んでいる。
  // 沈んだ面の上で使っている実例：`.statusbar` の枠の使用率、`.settings-read`
  const bg = hexOf('--l-bg');
  const sunk = hexOf('--l-bg-sunk');
  assert.ok(bg && sunk, '地の値が読めない');

  for (const name of ['--l-fg', '--l-fg-muted', '--l-fg-faint']) {
    const fg = hexOf(name);
    assert.ok(fg, `${name} が読めない`);
    for (const [label, ground] of [['--l-bg', bg], ['--l-bg-sunk', sunk]]) {
      const r = contrast(fg, ground);
      assert.ok(
        r >= 4.5,
        `${name} が ${label} の上で ${r.toFixed(2)}:1（AA の 4.5 を割る）`,
      );
    }
  }
});

test('暗いほうの字の3段も、両方の地で AA を満たす', () => {
  const dark = block(':root[data-theme="dark"] {');
  const hex = (name) => {
    const m = dark.match(new RegExp(String.raw`${name}\s*:\s*(#[0-9A-Fa-f]{6})\b`));
    return m ? m[1] : null;
  };
  // 暗いほうは `--d-*` の実体が `:root` 側に居る。意味トークンから辿らず直に引く
  const bg = hexOf('--d-bg');
  const sunk = hexOf('--d-bg-sunk');
  assert.ok(bg && sunk, `暗いほうの地が読めない（${bg} / ${sunk}）`);

  for (const name of ['--d-fg', '--d-fg-muted', '--d-fg-faint']) {
    const fg = hexOf(name);
    assert.ok(fg, `${name} が読めない`);
    for (const [label, ground] of [['--d-bg', bg], ['--d-bg-sunk', sunk]]) {
      const r = contrast(fg, ground);
      assert.ok(r >= 4.5, `${name} が ${label} の上で ${r.toFixed(2)}:1（AA の 4.5 を割る）`);
    }
  }
  assert.ok(hex, '（dark ブロックの読み取りは将来の拡張用。いまは実体を直に見ている）');
});
