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
    '--upd-pct', // 取り寄せの％（update.js の fillRing）
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
  const defined = new Set();
  const used = new Set();
  for (const f of fs.readdirSync(CSS)) {
    const src = read(path.join(CSS, f));
    for (const m of src.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)) defined.add(m[1]);
    for (const m of src.matchAll(/var\((--[a-z0-9-]+)/g)) used.add(m[1]);
  }
  const dead = [...defined].filter((n) => !used.has(n));
  assert.deepEqual(
    dead, [],
    `使われていない意味トークンがある（要る場面が来たときに、使う側と一緒に足す）:\n  ${dead.join('\n  ')}`,
  );
});

/* ── 一覧 ─────────────────────────────────────────────── */

// どの行をどの束へ置くか（枠「あなたの番」・ピン留め・状態の見出し・そのほか）は
// `groups.js` の純関数で、`groups.test.mjs` が import して見ている。
// ここに残すのは、描く側（`list.js`）の字面でしか確かめられないことだけ

const LIST = read(path.join(JS, 'list.js'));

/**
 * JS のコメントを落とした本文。落とし方は `navrail.test.mjs` / `tokens.test.mjs` の `jsCode` と同じ
 * （行頭の `//` と `*`、行末の `//`）。list.js は説明が厚く、消した語がコメントに残るため
 */
const LIST_CODE = LIST
  .split('\n')
  .map((line) => (/^\s*(\/\/|\/?\*)/.test(line) ? '' : line.replace(/\s\/\/.*$/, '')))
  .join('\n');

test('どの束にも入らない状態は「そのほか」へ落ちる。消えはしない', () => {
  // 落ちる先があること自体を見る。**状態を1つ足した日に一覧から行が消えるのが困る**ので、
  // ここは受け皿の束（groups.js の REST_GROUP）を描く行が在ることの確認（振り分けは groupRows の rest）
  assert.match(LIST_CODE, /buildGroup\(REST_GROUP,\s*rest\)/, 'どの束にも入らない行の受け皿を描いていない');
});

test('list.js は状態の名前も束の id も列挙しない（groups.js の定義を読むだけ）', () => {
  // 列挙すると、状態や束を1つ足した日に groups.js と list.js の片方だけが直る。
  // 止まっているかは groupRows が振り分けた束（と束の wants）で、開け閉めは束の foldable で決める。
  // 例外は「動いている行か」の 'running' だけ（ピン留めに入った動いている行も「いま何をしているか」を出すので、
  // 束からは決められない。材料は一覧の鍵に入っている state）
  const BAD = [
    [/STOP_STATES/, 'STOP_STATES（止まっている状態の表。振り分けは groupRows が済ませている）'],
    [/'needs-|'awaiting-reply'|'ended'|'unknown'/, '状態の名前'],
    [/===\s*'(stop|reply|run|done|pinned|rest)'/, '束の id の文字列で分岐している'],
    [/states:\s*\[/, '束の定義をその場で作っている（groups.js に置く）'],
  ];
  const bad = BAD.filter(([re]) => re.test(LIST_CODE)).map(([, label]) => label);
  assert.deepEqual(bad, [], `list.js が束の判断を持っている:\n  ${bad.join('\n  ')}`);
});

test('一覧の鍵に時刻を混ぜない。開け閉めは混ぜる', () => {
  // 時刻を混ぜると毎秒鍵が動いて組み直しになり、スクロール位置が先頭へ飛ぶうえ、
  // 焦点を持っていた行が消えて上下キーが効かなくなる
  const key = LIST.match(/function listKey\([\s\S]*?\n\}/);
  assert.ok(key, 'listKey が見つからない');
  assert.doesNotMatch(
    key[0], /idleOf|since\(|lastActivityAt/,
    '一覧の鍵に時刻が混ざっている。毎秒組み直してスクロールと焦点が飛ぶ',
  );
  // 開け閉めで出す行が変わる。混ぜないと、押しても組み直されない
  assert.match(key[0], /openFolds/, '一覧の鍵に開け閉め（openFolds）が入っていない。押しても行が出ない');
});

test('refreshTimes が一覧の行の経過と「いま何をしているか」を差し替える', () => {
  // 一覧は鍵が変わるまで組み直さないので、時刻を動かす場所がここしかない。
  // 忘れると経過が固まったままになる
  const fn = LIST.match(/export function refreshTimes\([\s\S]*?\n\}/);
  assert.ok(fn, 'refreshTimes が見つからない');
  assert.match(fn[0], /\.m\b/, 'refreshTimes が行の経過（.m）を見ていない。経過が固まる');
  assert.match(fn[0], /paintNow/, 'refreshTimes が「いま何をしているか」を差し替えていない');
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
