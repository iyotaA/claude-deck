/**
 * 色と字の段のトークン（`public/css/tokens.css`）の約束を見る。
 *
 * ここに並ぶのは contract.test.mjs と同じ種類の約束 ――
 * **破っても何のエラーも出ないもの。**
 *
 * 配色は Ink ダークの1種類だけにしてある。前は明るいほうと暗いほうの2本立てで、
 * 色の実体（`--l-*` / `--d-*`）を意味トークンが指す2段の作りだった。
 * 2段は明暗を切り替えるためのもので、1種類になると目的が無くなるので畳んだ。
 * いまは `:root` の意味トークンに値を直に書いてある。
 *
 * 見ているのは4つ。
 *
 * - **切り替えの名残が戻ってこないこと**（tokens.css・index.html・public/js）。
 *   残ると、片方にしか効かない色や、押しても何も変わらないボタンが黙って生まれる
 * - 意味トークンの色が全部在って、形が読めること
 * - 字として使う色が、敷かれうる面のどれの上でも AA（4.5:1）を満たすこと
 * - 字の段が 12px を割らないこと
 *
 * **CSS を解析しない。** 字面を読むだけにしてある。
 * パーサを持ち込むと、外の道具を増やさない決まりに触れるうえ、
 * 落ちたときに「テストが壊れたのか実装が壊れたのか」が読みにくくなる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CSS_DIR = path.join(REPO, 'public', 'css');
const JS_DIR = path.join(REPO, 'public', 'js');

/** @param {string} p @returns {string} */
const read = (p) => fs.readFileSync(p, 'utf8');

/**
 * 消す範囲の中身を落として、改行だけ残す。
 *
 * コメントを消したあとも行番号がずれないようにするため。
 * 落ちたときに「何行目か」を出すので、ずれると探す場所を間違える。
 *
 * @param {string} m 消す範囲
 * @returns {string}
 */
const blank = (m) => m.replace(/[^\n]/g, '');

/**
 * CSS のコメントを落とした本文。
 *
 * **このリポジトリは説明が厚い。** 「前は `--l-*` だった」のような経緯が
 * コメントに残るので、そこを拾うと消したはずの名前が残っているように見える。
 *
 * @param {string} text
 * @returns {string}
 */
const cssCode = (text) => text.replace(/\/\*[\s\S]*?\*\//g, blank);

/**
 * JS のコメントを落とした本文。
 *
 * 落とし方は contract.test.mjs の `code()` と同じ（行頭の `//` と `*`、行末の `//`）。
 * 行を消さずに空にするのは、上の `blank` と同じく行番号を保つため。
 *
 * @param {string} text
 * @returns {string}
 */
const jsCode = (text) => text
  .split('\n')
  .map((line) => (/^\s*(\/\/|\/?\*)/.test(line) ? '' : line.replace(/\s\/\/.*$/, '')))
  .join('\n');

/**
 * HTML のコメントを落とした本文。
 *
 * @param {string} text
 * @returns {string}
 */
const htmlCode = (text) => text.replace(/<!--[\s\S]*?-->/g, blank);

/**
 * 文字の位置から行番号（1始まり）を出す。
 *
 * @param {string} text
 * @param {number} index
 * @returns {number}
 */
const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/**
 * 正規表現に当たった場所を「N 行目: その行」の形で全部返す。
 *
 * @param {string} text 探す本文（コメントを落としたもの）
 * @param {RegExp} re 探す字。`g` は付けなくてよい（ここで付け直す）
 * @returns {string[]}
 */
function hitsOf(text, re) {
  const lines = text.split('\n');
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  return [...text.matchAll(new RegExp(re.source, flags))].map((m) => {
    const n = lineAt(text, m.index);
    return `${n} 行目: ${lines[n - 1].trim()}`;
  });
}

const TOKENS = cssCode(read(path.join(CSS_DIR, 'tokens.css')));

/**
 * ブロックの中身を取り出す。
 *
 * 波かっこを数えて閉じ位置を探す。入れ子のブロックが来ても、
 * 最初の `}` で切らずに済むようにしてある。
 *
 * @param {string} text 探す本文
 * @param {string} head ブロックの見出し（`:root {` など）
 * @returns {string} 中身（見出しと閉じかっこは含まない）
 */
function block(text, head) {
  const at = text.indexOf(head);
  assert.notEqual(at, -1, `${head} が見つからない`);
  let depth = 0;
  for (let i = at + head.length - 1; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(at + head.length, i);
    }
  }
  throw new Error(`${head} が閉じていない`);
}

const ROOT = block(TOKENS, ':root {');

/**
 * `:root` が割り当てている値を引く。無ければ null。
 *
 * 前に区切りを要求しているのは、`--fg` が `--accent-fg` の尻尾に当たらないようにするため。
 *
 * @param {string} name `--fg` など
 * @returns {string|null}
 */
function valueOf(name) {
  const m = ROOT.match(new RegExp(String.raw`(?:^|[\s;{])${name}\s*:\s*([^;]+);`));
  return m ? m[1].trim() : null;
}

/**
 * `#RRGGBB` で書かれた色を引く。読めなければ落とす。
 *
 * @param {string} name `--fg` など
 * @returns {string}
 */
function hexOf(name) {
  const v = valueOf(name);
  assert.ok(
    v && /^#[0-9A-Fa-f]{6}$/.test(v),
    `${name} が #RRGGBB で読めない（${v ?? '割り当てが無い'}）`,
  );
  return v;
}

/* ── 名残 ─────────────────────────────────────────────── */

test('tokens.css に明暗の切り替えの名残（--l-* / --d-* / prefers-color-scheme / data-theme）が無い', () => {
  // どれか1つでも残ると、**片方の配色にしか効かない値**が混ざる。
  // 1種類しか出さない画面では、その片方を開く手段が無いので誰も気づけない
  const LEFTOVERS = [
    [/--l-/, '--l-*（明るいほうの実体）'],
    [/--d-/, '--d-*（暗いほうの実体）'],
    [/prefers-color-scheme/, '@media (prefers-color-scheme)'],
    [/data-theme/, '[data-theme]'],
  ];

  const bad = [];
  for (const [re, label] of LEFTOVERS) {
    for (const hit of hitsOf(TOKENS, re)) bad.push(`${label} … ${hit}`);
  }
  assert.deepEqual(bad, [], `tokens.css の本文に切り替えの名残がある:\n  ${bad.join('\n  ')}`);
});

/* ── 意味トークン ─────────────────────────────────────── */

/**
 * 面。字はこのどれかの上に載る。
 *
 * body の地は `--bg` ではなく1段沈んだ `--bg-sunk`（base.css）で、カードは `--bg-elev`、
 * 触れたときは `--bg-hi`、コードの箱は `--code-bg`。**地の1枚だけで測らない。**
 * 前は注記の数が地（`--bg`）の上の値だけで、沈んだ面では AA を割る色が出ていた。
 */
const GROUNDS = ['--bg', '--bg-sunk', '--bg-elev', '--bg-hi', '--code-bg'];

/** 字として使う色。字の3段と、強調・状態の色。 */
const INKS = [
  '--fg', '--fg-muted', '--fg-faint',
  '--accent', '--hot', '--warn', '--calm', '--done', '--off',
];

/** 色の意味トークン全部（18個）。上の2つに、線2つと塗りの上の字と薄い面を足したもの。 */
const COLORS = [...GROUNDS, ...INKS, '--border', '--border-strong', '--accent-fg', '--accent-soft'];

/** `rgb()` で持つもの。半透明で重ねて使うので `#RRGGBB` では書けない。 */
const ALPHA = new Set(['--accent-soft']);

test(':root に意味トークンの色が18個すべて在り、形が読める', () => {
  assert.equal(COLORS.length, 18, 'このテストの表が18個になっていない');

  const bad = [];
  for (const name of COLORS) {
    const v = valueOf(name);
    if (!v) {
      bad.push(`${name} … :root に割り当てが無い`);
    } else if (ALPHA.has(name)) {
      if (!/^rgb\(/.test(v)) bad.push(`${name} … rgb() で書いていない（${v}）`);
    } else if (!/^#[0-9A-Fa-f]{6}$/.test(v)) {
      bad.push(`${name} … #RRGGBB で書いていない（${v}）`);
    }
  }
  assert.deepEqual(bad, [], `意味トークンの色が揃っていない:\n  ${bad.join('\n  ')}`);
});

test(':root が color-scheme: dark を宣言している', () => {
  // 無いと、ブラウザが自分で描く部品（スクロールバー・入力欄・<dialog> の既定の canvas 色）が
  // 明るいまま残る。こちらのトークンが届かない場所なので、ここで言うしかない。
  // assert.match にしないのは、落ちたときに :root の中身が丸ごと出力へ流れて読めなくなるため
  const m = ROOT.match(/(?:^|[\s;{])color-scheme\s*:\s*([^;]+);/);
  assert.ok(
    m && m[1].trim() === 'dark',
    `:root の color-scheme が dark ではない（${m ? m[1].trim() : '宣言が無い'}）。ブラウザの部品だけ明るく出る`,
  );
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
 * 比を切り捨てで2桁にする。
 *
 * 四捨五入だと 4.497 が「4.50:1」と出て、割っているのに足りているように読める。
 *
 * @param {number} r
 * @returns {string}
 */
const ratio = (r) => (Math.floor(r * 100) / 100).toFixed(2);

test('字として使う色は、面5つのどれの上でも AA（4.5:1）を満たす', () => {
  const bad = [];
  for (const ink of INKS) {
    const fg = hexOf(ink);
    for (const ground of GROUNDS) {
      const bg = hexOf(ground);
      const r = contrast(fg, bg);
      if (r < 4.5) bad.push(`${ink}（${fg}）が ${ground}（${bg}）の上で ${ratio(r)}:1`);
    }
  }
  assert.deepEqual(bad, [], `AA の 4.5:1 を割る組がある:\n  ${bad.join('\n  ')}`);
});

test('塗った強調の上の字（--accent-fg × --accent）も 4.5:1 を満たす', () => {
  // `.btn.is-lead` は --accent を面に塗り、その上に --accent-fg で字を置く
  const fg = hexOf('--accent-fg');
  const bg = hexOf('--accent');
  const r = contrast(fg, bg);
  assert.ok(r >= 4.5, `--accent-fg（${fg}）が --accent（${bg}）の上で ${ratio(r)}:1（AA の 4.5 を割る）`);
});

/* ── 字の段 ──────────────────────────────────────────── */

test('字の段は 12px を割らず、--fs-0 から --fs-6 へ小さい順に並ぶ', () => {
  const sizes = [0, 1, 2, 3, 4, 5, 6].map((i) => {
    const v = valueOf(`--fs-${i}`);
    const m = v && v.match(/^(\d+(?:\.\d+)?)px$/);
    assert.ok(m, `--fs-${i} が px で読めない（${v ?? '割り当てが無い'}）`);
    return Number(m[1]);
  });

  assert.ok(
    sizes[0] >= 12,
    `--fs-0 が ${sizes[0]}px。添え物の段でも 12px を割ると読めない`,
  );
  // 同じ値は許す。--fs-3 と --fs-4 はどちらも 15px で、わざとそうしてある
  //（4 は Markdown の本文。3 を上げたときに本文を 15px のまま据え置いた）
  for (let i = 1; i < sizes.length; i += 1) {
    assert.ok(
      sizes[i] >= sizes[i - 1],
      `--fs-${i}（${sizes[i]}px）が --fs-${i - 1}（${sizes[i - 1]}px）より小さい。段が逆立ちしている`,
    );
  }
});

test('public/css に 12px 未満の font-size / font の直書きが無い', () => {
  // 段（--fs-*）を 12px 以上に上げても、直書きが1つ残っていればそこだけ小さいまま出る。
  // `--font-sans:` のような変数は前が `-` なので当たらない
  const bad = [];
  for (const f of fs.readdirSync(CSS_DIR).filter((n) => n.endsWith('.css'))) {
    const code = cssCode(read(path.join(CSS_DIR, f)));
    for (const m of code.matchAll(/(?:^|[\s;{])(font(?:-size)?)\s*:\s*([^;}]+)/g)) {
      const small = [...m[2].matchAll(/(\d*\.?\d+)px/g)].filter((n) => Number(n[1]) < 12);
      if (small.length === 0) continue;
      const at = m.index + m[0].indexOf(m[1]);
      bad.push(`${f} の ${lineAt(code, at)} 行目: ${m[1]}: ${m[2].trim()}`);
    }
  }
  assert.deepEqual(bad, [], `12px を割る字の直書きがある（--fs-* を使う）:\n  ${bad.join('\n  ')}`);
});

/* ── 画面側の名残 ─────────────────────────────────────── */

test('index.html に配色の切り替えが残っていない', () => {
  const html = htmlCode(read(path.join(REPO, 'public', 'index.html')));

  const bad = [];
  // ボタンが残ると、押しても何も変わらない絵が上のバーに居座る
  for (const hit of hitsOf(html, /theme-toggle/)) bad.push(`#theme-toggle … ${hit}`);
  // 属性が残ると、読む側がもう居ないのに「選べる」ように見える
  for (const hit of hitsOf(html, /data-theme/)) bad.push(`data-theme … ${hit}`);
  // `light dark` のままだと、ブラウザが OS の設定で明るい部品を描くことがある
  if (!/<meta\s+name="color-scheme"\s+content="dark"\s*\/?>/.test(html)) {
    bad.push('<meta name="color-scheme" content="dark"> が無い');
  }
  assert.deepEqual(bad, [], `index.html に切り替えの名残がある:\n  ${bad.join('\n  ')}`);
});

/** 画面側の .js を全部（`timeline/` も含む）。 */
function jsFiles() {
  const out = [];
  for (const dir of [JS_DIR, path.join(JS_DIR, 'timeline')]) {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.js')) out.push(path.join(dir, f));
    }
  }
  return out;
}

test('public/js に配色の切り替えを読む・動かすコードが残っていない', () => {
  // **`?theme=` と localStorage の古い値は、残っていても読まない。** 消しもしない（害が無いので触らない）。
  // 読む口が1つでも残ると、前の版のブックマークを開いた人だけ別の配色になりうる
  const WORDS = [
    [/claude-deck\.theme/, 'claude-deck.theme（localStorage の鍵）'],
    [/initTheme/, 'initTheme（起動時に配色を決める）'],
    [/themeToggle/, 'themeToggle（切り替えボタンの節点）'],
    [/data-theme/, 'data-theme（配色の属性）'],
    [/dataset\.theme\b/, 'dataset.theme（data-theme の別の書き方）'],
    [/get\(\s*['"]theme['"]\s*\)/, "get('theme')（?theme= を読む）"],
  ];

  const bad = [];
  for (const file of jsFiles()) {
    const code = jsCode(read(file));
    const rel = path.relative(JS_DIR, file).replace(/\\/g, '/');
    for (const [re, label] of WORDS) {
      for (const hit of hitsOf(code, re)) bad.push(`${rel} の ${hit} … ${label}`);
    }
  }
  assert.deepEqual(bad, [], `配色の切り替えが残っている:\n  ${bad.join('\n  ')}`);
});
