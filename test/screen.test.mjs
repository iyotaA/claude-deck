/**
 * 画面側（`public/`）の、走らせないと分からない食い違いを見る。
 *
 * ここに並ぶのは `docs.test.mjs` と同じ性質のもの ――
 * **ブラウザで開くまで気づけないのに、字面を読めば分かること。**
 *
 * このリポジトリに linter は無い。だから
 * 「import した名前が本当に export されているか」も、
 * 「CSS が参照しているトークンが定義されているか」も、誰も見ていなかった。
 * どちらも間違えると**画面が真っ白になるか、宣言が丸ごと落ちる**。
 *
 * **中身は動かさない。** `list.js` も `store.js` も DOM と `localStorage` を触るので、
 * 素の node では import すらできない。見るのは字面だけにしてある。
 * 落ちたときは「壊した」ではなく「両側を見比べろ」の合図として読む。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const JS = path.join(ROOT, 'public', 'js');
const CSS = path.join(ROOT, 'public', 'css');

/** @param {string} p @returns {string} */
const read = (p) => fs.readFileSync(p, 'utf8');

/** 画面側の .js を全部（`timeline/` も含む）。 */
function jsFiles() {
  const out = [];
  for (const dir of [JS, path.join(JS, 'timeline')]) {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.js')) out.push(path.join(dir, f));
    }
  }
  return out;
}

/** そのファイルが export している名前。 */
function exportsOf(file) {
  const src = read(file);
  const out = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    out.add(m[1]);
  }
  // `export { a, b as c }` の形も拾う
  for (const m of src.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) out.add(name.trim());
    }
  }
  return out;
}

test('画面側の import した名前が、相手側で export されている', () => {
  const bad = [];
  for (const file of jsFiles()) {
    for (const m of read(file).matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
      const target = path.resolve(path.dirname(file), m[2]);
      if (!fs.existsSync(target)) {
        bad.push(`${path.basename(file)} → ${m[2]} が無い`);
        continue;
      }
      const has = exportsOf(target);
      for (const raw of m[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/)[0].trim();
        if (name && !has.has(name)) {
          bad.push(`${path.basename(file)} ← ${name}（${m[2]} が export していない）`);
        }
      }
    }
  }
  assert.deepEqual(bad, [], `解決しない import がある:\n  ${bad.join('\n  ')}`);
});

test('CSS が参照しているトークンが、どこかで定義されている', () => {
  // JS が要素へ直に書く変数。CSS の中には定義が無いので、ここで除く
  const FROM_JS = new Set([
    '--state-color', '--list-w', '--insp-w', '--list-col', '--insp-col',
  ]);

  const defined = new Set();
  const used = new Map();
  for (const f of fs.readdirSync(CSS)) {
    const src = read(path.join(CSS, f));
    for (const m of src.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)) defined.add(m[1]);
    for (const m of src.matchAll(/var\((--[a-z0-9-]+)/g)) {
      if (!used.has(m[1])) used.set(m[1], f);
    }
  }

  const missing = [...used]
    .filter(([name]) => !defined.has(name) && !FROM_JS.has(name))
    .map(([name, f]) => `${name}（${f}）`);
  assert.deepEqual(missing, [], `定義の無いトークンを参照している:\n  ${missing.join('\n  ')}`);
});

test('使う先の無い意味トークンを残さない', () => {
  // 色の実体（--l-* / --d-*）は意味トークンから指されるので、ここでは見ない
  const defined = new Set();
  const used = new Set();
  for (const f of fs.readdirSync(CSS)) {
    const src = read(path.join(CSS, f));
    for (const m of src.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)) defined.add(m[1]);
    for (const m of src.matchAll(/var\((--[a-z0-9-]+)/g)) used.add(m[1]);
  }
  const dead = [...defined].filter((n) => !used.has(n) && !/^--[ld]-/.test(n));
  assert.deepEqual(
    dead, [],
    `使われていない意味トークンがある（要る場面が来たときに、使う側と一緒に足す）:\n  ${dead.join('\n  ')}`,
  );
});

/* ── ボールの所在の帯 ────────────────────────────────────── */

const STORE = read(path.join(JS, 'store.js'));
const LIST = read(path.join(JS, 'list.js'));

/** `store.js` の表から状態の語だけを取り出す。 */
function statesIn(re) {
  const m = STORE.match(re);
  assert.ok(m, `${re} が読めない`);
  return [...m[1].matchAll(/'([\w-]+)'/g)].map((x) => x[1]);
}

test('帯へ出す状態と、一覧の見出しの状態が重ならない', () => {
  const hero = new Set(statesIn(/export const HERO_STATES = new Set\(\[([^\]]+)\]\)/));
  // 見出しの `states` に並ぶ語だけを見る（id とラベルは拾わない）
  const groups = STORE.match(/export const STATE_GROUPS = \[([\s\S]*?)\];/)[1];
  const listed = [...groups.matchAll(/states: \[([^\]]+)\]/g)]
    .flatMap((m) => [...m[1].matchAll(/'([\w-]+)'/g)].map((x) => x[1]));

  const dup = listed.filter((s) => hero.has(s));
  assert.deepEqual(dup, [], `帯と一覧の両方に出る状態がある（選ぶと aria-current が二重になる）: ${dup.join(' ')}`);
});

test('どの見出しにも入らない状態は「そのほか」へ落ちる。消えはしない', () => {
  // 落ちる先があること自体を見る。**状態を1つ足した日に一覧から行が消えるのが困る**ので、
  // ここは「そのほか」を組む行が在ることの確認
  assert.match(LIST, /そのほか/, 'どの見出しにも入らない行の受け皿が無い');
});

test('帯の鍵に時刻を混ぜない', () => {
  // 混ぜると毎秒鍵が動いて組み直しになり、**横へ送った位置が先頭へ戻る**。
  // 「ほか N 件」を見に行った瞬間に引き戻される
  const key = LIST.match(/function heroKey\([\s\S]*?\n\}/);
  assert.ok(key, 'heroKey が見つからない');
  assert.doesNotMatch(
    key[0], /idleOf|since\(|lastActivityAt/,
    '帯の鍵に時刻が混ざっている。毎秒組み直して横スクロールが戻る',
  );
});

test('refreshTimes が帯の経過も差し替える', () => {
  // 帯は鍵が変わるまで組み直さないので、時刻を動かす場所がここしかない。
  // 忘れると経過が固まったままになる
  const fn = LIST.match(/export function refreshTimes\([\s\S]*?\n\}/);
  assert.ok(fn, 'refreshTimes が見つからない');
  assert.match(fn[0], /heroBand/, 'refreshTimes が帯を見ていない。経過が固まる');
});

test('稼働中の一覧を掴む所が、圧縮した行（.row）も拾う', () => {
  // カードから圧縮した行へ替えたので、`.card` だけ見ている所は空振りする。
  // 上下キー・引き出しを開いたときの焦点・選択の印の3つが当たる
  for (const f of ['main.js', 'drawer.js', 'session.js']) {
    const src = read(path.join(JS, f));
    const hits = [...src.matchAll(/querySelector(?:All)?\(([^)]*\.card[^)]*)\)/g)];
    for (const h of hits) {
      // 書庫（dom.archive）はカードのままなので、そちらは見なくてよい
      const line = src.slice(Math.max(0, h.index - 60), h.index + h[0].length);
      if (/dom\.archive/.test(line)) continue;
      assert.match(
        h[1], /\.row/,
        `${f} の ${h[0]} が .row を拾っていない（稼働中の一覧で空振りする）`,
      );
    }
  }
});
