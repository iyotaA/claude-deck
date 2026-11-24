/**
 * 数値モード（横断。`usage-tab.js` / `usage-mode.css`）の、字面で分かる約束（画面刷新⑤）。
 *
 * `usage-tab.js` は DOM を触るので素の node では import できない。`detail-pane.test.mjs` と
 * 同じく字面で見る。**崩れても画面を開くまで何のエラーも出ない**種類の約束なので。
 * 整形の小道具（`usage-chart.js` の `splitUnit`）だけは関数を呼ぶ ―― あのファイルは
 * `document` を関数の中でしか触らないので、読み込むだけなら何も起きない。
 *
 * - 主役の札（実消費）だけを `--accent` で塗る。範囲は数値モード（`.usage-pane`）だけで、
 *   右の紙の札は塗らない（D7）。押せない札のままなので枠も影も持たない
 * - 主役の上の線は `.is-hero` が `--chart-hi` を宣言して受ける（D8。右の紙の `.insp` と同じ受け方）
 * - 単位（M・k・%・本）を小さく出すのは数値モードの札だけ（D13）
 * - 節ナビは一覧の「すべて｜稼働中」（`.live-filter`）を借り、使い手の居なくなった `.tab` は消す（D14）。
 *   頭は1行の帯で、狭い窓では折り返す（横にはみ出さない）
 * - 概要に日ごとの線グラフを1枚（D6）。期間の切り替えは置かない（D1）。字は HTML で置く。
 *   「これより前は一部しか読んでいません」を線グラフと節「推移」の両方に添える（D2。消さない）。
 *   何を描くかの判断そのもの（境目・0 埋め・山）は `usage-days.test.mjs` が関数を呼んで見ている
 * - 概要の札の下は2列（D17。左: 線グラフ・いちばん重いもの／右: 内訳・読み方）。内訳は横棒のまま（D16）、
 *   いちばん重いものは1位＋「次は」の札で、何で並べているかを消さない（D18）。概要の見出しは帯にしない（K13）
 * - 横断（`usage-tab.js`）の誤読を防ぐ注記が字のまま残っている（右の紙のぶんは `detail-pane.test.mjs`）
 *
 * 主役の札の上の字の比（4.5:1）は `tokens.test.mjs` が見ている（比の計算はあちらにある）。
 * 字面はコメントを落としてから読む。このリポジトリは説明が厚く、経緯がコメントに残るため。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitUnit } from '../public/js/usage-chart.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const JS_DIR = path.join(REPO, 'public', 'js');
const CSS_DIR = path.join(REPO, 'public', 'css');

/** @param {string} p @returns {string} */
const read = (p) => fs.readFileSync(p, 'utf8');

/** CSS のコメントを落とした本文 */
const cssCode = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '');

/** HTML のコメントを落とした本文 */
const htmlCode = (text) => text.replace(/<!--[\s\S]*?-->/g, '');

/** JS のコメントを落とした本文（`detail-pane.test.mjs` の `jsCode` と同じ落とし方） */
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

/**
 * `public/css/` の規則を全部、`{ file, selectors, decls }` の並びにする
 * （`detail-pane.test.mjs` の `cssRules` と同じ読み方。入れ子は `@media` の1段だけ）。
 *
 * @returns {{ file: string, selectors: string[], decls: { prop: string, value: string }[] }[]}
 */
function cssRules() {
  const out = [];
  for (const file of fs.readdirSync(CSS_DIR).filter((n) => n.endsWith('.css'))) {
    for (const m of cssCode(read(path.join(CSS_DIR, file))).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' '));
      const decls = m[2].split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
        const i = d.indexOf(':');
        return { prop: d.slice(0, i).trim(), value: d.slice(i + 1).trim() };
      });
      out.push({ file, selectors, decls });
    }
  }
  return out;
}

/**
 * そのセレクタを名指しした規則の宣言を、ファイル名つきで全部。
 * @param {string} selector 空白を1つに均した形
 */
function declsOf(selector) {
  return cssRules()
    .filter((r) => r.selectors.includes(selector))
    .flatMap((r) => r.decls.map((d) => ({ ...d, file: r.file })));
}

/**
 * 関数の本体を括弧を数えて切り出す（`detail-pane.test.mjs` の `fnBody` と同じ）。
 * @param {string} code コメントを落とした本文
 * @param {string} name 関数名
 */
function fnBody(code, name) {
  const head = code.search(new RegExp(`function\\s+${name}\\s*\\(`));
  assert.ok(head >= 0, `${name} が見つからない`);
  const open = code.indexOf('{', code.indexOf(')', head));
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  assert.fail(`${name} の本体を切り出せない（括弧が閉じていない）`);
}

const tabCode = () => jsCode(read(path.join(JS_DIR, 'usage-tab.js')));
const panelCode = () => jsCode(read(path.join(JS_DIR, 'usage-panel.js')));
const chartCode = () => jsCode(read(path.join(JS_DIR, 'usage-chart.js')));

/** 主役の札の規則。数値モードの器（.usage-pane）に絞ってある */
const HERO = '.usage-pane .stat.is-hero';

/* ── 主役の塗り（D7）──────────────────────────────────────── */

test('主役の札は実消費の1枚だけ。印（is-hero）を付けるのは数値モードの札を組む所だけ', () => {
  const tiles = fnBody(tabCode(), 'tiles');
  assert.match(tiles, /const ite = statTile\('実消費'/, '実消費の札が tiles に無い');
  assert.match(tiles, /ite\.classList\.add\('is-hero'\)/, '実消費の札に主役の印が付いていない');
  assert.equal(tabCode().match(/is-hero/g)?.length, 1, '主役の印を実消費の札のほかにも付けている');
  // 右の紙の札は塗らない（右の紙は「数値モードの主題」ではない）
  assert.doesNotMatch(panelCode(), /is-hero/, '右の紙（usage-panel.js）が主役の印を付けている');
  assert.doesNotMatch(chartCode(), /is-hero/, '共有の部品（usage-chart.js）が主役の印を持っている（右の紙にも付く）');
});

test('主役の塗りは数値モード（.usage-pane）に絞り、右の紙の札（素の .stat）は沈めた面のまま', () => {
  const fill = declsOf(HERO).filter((d) => d.prop === 'background');
  assert.deepEqual(fill.map((d) => `${d.file} … ${d.value}`), ['usage-mode.css … var(--accent)'],
    `${HERO} の面が --accent でない（トークンを増やさず --accent で塗る）`);
  const loose = [];
  for (const r of cssRules()) {
    for (const s of r.selectors) {
      if (!/\bis-hero\b/.test(s)) continue;
      if (r.file !== 'usage-mode.css' || !s.startsWith('.usage-pane ')) loose.push(`${r.file} … ${s}`);
    }
  }
  assert.deepEqual(loose, [], `主役の指定が数値モードの外にもある（右の紙の札まで塗れる）:\n  ${loose.join('\n  ')}`);
  // 共有の部品（usage.css）の札は今のまま。右の紙はこれを使う
  const base = declsOf('.stat').filter((d) => d.file === 'usage.css' && d.prop === 'background');
  assert.deepEqual(base.map((d) => d.value), ['var(--bg-sunk)'], '素の .stat の面が変わっている（右の紙の札まで変わる）');
});

test('主役の札も押せない札のまま。塗るのは面だけで、枠と影と押せる印は持たない', () => {
  // 押せる .card.is-usage（枠＋面＋行き先の印）と止まった絵で見分けが付かなくなる
  const bad = declsOf(HERO)
    .filter((d) => /^(border(?!-radius)|box-shadow|cursor|outline)/.test(d.prop))
    .map((d) => `${d.prop}: ${d.value}`);
  assert.deepEqual(bad, [], `主役の札が押せるものの形を持っている:\n  ${bad.join('\n  ')}`);
});

/* ── 主役の上の線（D8）────────────────────────────────────── */

test('主役の上の線は .is-hero が --chart-hi を宣言して受ける。線と面を直に塗らない', () => {
  // 塗った面（--accent）の上でラベンダーの線は消える。受け方は右の紙（.insp）と同じで、色の出どころを1か所に
  const hi = declsOf(HERO).filter((d) => d.prop === '--chart-hi');
  assert.deepEqual(hi.map((d) => d.value), ['var(--accent-fg)'], `${HERO} が --chart-hi を塗った面の上の字の色で宣言していない`);
  const bad = [];
  for (const r of cssRules()) {
    for (const s of r.selectors) {
      if (!/\bis-hero\b.*\.(spark-line|spark-area|bar-fill)\b/.test(s)) continue;
      for (const d of r.decls) {
        if (['background', 'fill', 'stroke'].includes(d.prop)) bad.push(`${r.file} … ${s} { ${d.prop}: ${d.value} }`);
      }
    }
  }
  assert.deepEqual(bad, [], `主役の線を直に塗っている（色の出どころが2か所になる）:\n  ${bad.join('\n  ')}`);
});

/* ── 単位を小さく（D13）──────────────────────────────────── */

test('札の値を数と単位に割る（0 と不明はそのまま）', () => {
  assert.deepEqual(splitUnit('150.6M'), { num: '150.6', unit: 'M' });
  assert.deepEqual(splitUnit('42k'), { num: '42', unit: 'k' });
  assert.deepEqual(splitUnit('98.2%'), { num: '98.2', unit: '%' });
  assert.deepEqual(splitUnit('1,234 本'), { num: '1,234', unit: '本' });
  // 単位の無い値と「測れない」は割らない（— を単位として小さくしない）
  assert.deepEqual(splitUnit('850'), { num: '850', unit: null });
  assert.deepEqual(splitUnit('0'), { num: '0', unit: null });
  assert.deepEqual(splitUnit('—'), { num: '—', unit: null });
  assert.deepEqual(splitUnit(''), { num: '', unit: null });
});

test('単位を小さく出すのは数値モードの札だけ。右の紙の札は今のまま', () => {
  const tiles = fnBody(tabCode(), 'tiles');
  assert.equal(tiles.match(/smallUnit: true/g)?.length, 4, '数値モードの4枚の札が単位を小さく出していない');
  assert.doesNotMatch(panelCode(), /smallUnit/, '右の紙（usage-panel.js）の札まで単位を小さくしている');
  // 既定は割らない。指定しなかった札（右の紙）の値は1本の字のまま
  assert.match(chartCode(), /function statTile\([^)]*\{ smallUnit = false \} = \{\}\)/, 'statTile の既定が「割らない」でない');
  assert.match(fnBody(chartCode(), 'statTile'), /smallUnit \? splitUnit\(value\) : null/, 'statTile が smallUnit のときだけ割る形になっていない');
  const loose = [];
  for (const r of cssRules()) {
    for (const s of r.selectors) {
      if (/\.stat-unit\b/.test(s) && !s.startsWith('.usage-pane ')) loose.push(`${r.file} … ${s}`);
    }
  }
  assert.deepEqual(loose, [], `単位の見た目が数値モードの外にもある:\n  ${loose.join('\n  ')}`);
});

/* ── 節ナビと帯（D14）────────────────────────────────────── */

test('節ナビは「すべて｜稼働中」（.live-filter）を借りる。押せる切り替えの組（role="group"）のまま', () => {
  const html = htmlCode(read(path.join(REPO, 'public', 'index.html')));
  const tag = html.match(/<div[^>]*\bid="usage-nav"[^>]*>/);
  assert.ok(tag, '#usage-nav が index.html に無い');
  assert.match(tag[0], /class="[^"]*\blive-filter\b[^"]*"/, '#usage-nav が .live-filter を借りていない');
  assert.match(tag[0], /role="group"/, '#usage-nav が role="group" でない');
  const nav = fnBody(tabCode(), 'renderUsageNav');
  assert.match(nav, /el\('button', null, sec\.label\)/, '節ナビの札にクラスを付けている（見た目は器の .live-filter が持つ）');
  assert.match(nav, /aria-pressed/, '節ナビの札が aria-pressed を持たない');
});

test('使い手の居なくなった .tab（下線式）は消した。CSS にも JS にも戻っていない', () => {
  const css = [];
  for (const r of cssRules()) {
    for (const s of r.selectors) {
      if (/(^|[\s>+~])\.tab(?![\w-])/.test(s)) css.push(`${r.file} … ${s}`);
    }
  }
  assert.deepEqual(css, [], `.tab の規則が残っている:\n  ${css.join('\n  ')}`);
  // URL の ?tab=（store.js）は別物なので、クラスとして付ける形だけを探す
  const js = [];
  for (const file of jsFiles()) {
    const code = jsCode(read(file));
    if (/el\('[a-z]+', 'tab'|className = 'tab'|classList\.add\('tab'\)/.test(code)) js.push(path.basename(file));
  }
  assert.deepEqual(js, [], `.tab を付けている所がある: ${js.join(', ')}`);
});

test('数値の頭は1行の帯。節ナビが行をまるごと取らず、狭い窓では縮んで折り返す', () => {
  assert.ok(declsOf('.usage-head').some((d) => d.prop === 'flex-wrap' && d.value === 'wrap'), '.usage-head が折り返さない');
  const nav = cssRules()
    .filter((r) => r.selectors.some((s) => /\.usage-nav$/.test(s)))
    .flatMap((r) => r.decls.map((d) => ({ ...d, sel: r.selectors.join(', ') })));
  const full = nav.filter((d) => (d.prop === 'flex' && /100%/.test(d.value)) || (d.prop === 'flex-basis' && d.value === '100%'));
  assert.deepEqual(full.map((d) => `${d.sel} { ${d.prop}: ${d.value} }`), [], '節ナビが帯の1行をまるごと取っている（帯が2行になる）');
  // .live-filter は flex: none（縮まない）。借りたまま縮めないと、狭い窓で横にはみ出す。
  // 上書きは読む順でなく詳細度で勝たせる（.live-filter は 0,1,0）
  const own = declsOf('.usage-head .usage-nav');
  assert.ok(own.some((d) => d.prop === 'flex' && /^0 1 /.test(d.value)), '.usage-head .usage-nav が縮めない（.live-filter の flex: none のまま）');
  assert.ok(own.some((d) => d.prop === 'flex-wrap' && d.value === 'wrap'), '.usage-head .usage-nav が札を折り返さない');
  assert.ok(own.some((d) => d.prop === 'min-width' && d.value === '0'), '.usage-head .usage-nav が器より細くなれない');
  // 件数は同じ行の右端（一覧の #list-count と同じ作法）
  assert.ok(declsOf('.usage-head #usage-count').some((d) => d.prop === 'margin-left' && d.value === 'auto'), '件数が右端へ寄っていない');
});

/* ── 推移の線グラフ（D1〜D6）──────────────────────────────── */

test('概要に日ごとの線グラフを1枚置く。何を描くかは層0（usage-days.js）が決める', () => {
  const code = tabCode();
  assert.match(fnBody(code, 'overviewBlock'), /main\.append\(daysBlock\(d\)\)/, '概要が線グラフの節を（左の列に）置いていない');
  const days = fnBody(code, 'daysBlock');
  assert.match(days, /dayChartView\(d\)/, '描いてよい日を層0 の dayChartView で決めていない');
  assert.match(days, /view\.status === 'ok'[\s\S]*dayChart\(view\)/, '描けるときだけ線を描く形になっていない');
  // 期間の切り替え（7 / 14 / 30 日）は置かない（D1。3つとも同じ応答になる）
  assert.doesNotMatch(days, /'button'/, '線グラフの節に押すもの（期間の切り替えなど）がある');
  // 線グラフは数値モードだけ。右の紙では使わない
  assert.doesNotMatch(panelCode(), /dayChart/, '右の紙（usage-panel.js）が線グラフを使っている');
});

test('「これより前は一部しか読んでいません」を線グラフと節「推移」の両方に添える（誤読を防ぐ注記。消さない）', () => {
  const code = tabCode();
  assert.match(fnBody(code, 'daysBlock'), /partialNote\(view\)/, '線グラフに一部の日の一言が無い');
  assert.match(fnBody(code, 'daysBlock'), /chartNote\(view\)/, '描かないときの一言が無い（空の箱になる）');
  assert.match(fnBody(code, 'daysBlock'), /clipNote\(view\)/, '上限で切ったことを言っていない');
  const daily = fnBody(code, 'dailyBlock');
  assert.match(daily, /partialNote\(view\)/, '節「推移」に一部の日の一言が無い');
  // 前の注記は左端の日まで全部足したように読めた
  assert.doesNotMatch(daily, /全部足したもの/, '「同じ期間に走ったセッションを全部足したもの」が残っている');
  // 横棒と表はそのまま
  assert.match(daily, /barList\(/, '節「推移」の横棒が消えた');
  assert.match(daily, /tableDetails\(/, '節「推移」の表が消えた');
});

test('線グラフの字は HTML で置く（SVG の text にしない）。innerHTML を使わず、読み上げの名前を持つ', () => {
  const chart = chartCode();
  const body = fnBody(chart, 'dayChart');
  assert.match(body, /svgEl\('svg'/, '線を svgEl で組んでいない');
  assert.doesNotMatch(body, /svgEl\('text'/, 'SVG の text で字を描いている（viewBox の伸び縮みで 12px を割る）');
  assert.doesNotMatch(body, /svgEl\('circle'/, '山の点を SVG の circle で描いている（横に潰れて楕円になる）');
  assert.match(body, /role: 'img'/, '線が role="img" を持たない');
  assert.match(body, /'aria-label': label/, '線に読み上げの名前が無い');
  assert.match(body, /日ぶん/, '読み上げの名前が何日ぶんかを言っていない');
  assert.match(body, /いちばん多いのは/, '読み上げの名前がいちばん多い日を言っていない');
  assert.doesNotMatch(chart, /innerHTML/, 'usage-chart.js が innerHTML を使っている');
});

test('線グラフの色は数値モードのグラフと同じ受け方（var(--chart-hi, var(--accent))）。状態色を使わない', () => {
  const bad = [];
  for (const r of cssRules()) {
    if (!r.selectors.some((s) => /\.day-chart/.test(s))) continue;
    for (const d of r.decls) {
      if (/var\(--(hot|warn|done|calm|off)\)/.test(d.value)) bad.push(`${r.file} … ${r.selectors.join(', ')} { ${d.prop}: ${d.value} }`);
      // ラベンダーを直に書かない。変数で受けて、宣言が無いときだけラベンダーに落ちる
      if (/var\(--accent\)/.test(d.value) && !d.value.includes('var(--chart-hi, var(--accent))')) {
        bad.push(`${r.file} … ${r.selectors.join(', ')} { ${d.prop}: ${d.value} }`);
      }
    }
  }
  assert.deepEqual(bad, [], `線グラフの色の受け方が違う:\n  ${bad.join('\n  ')}`);
  assert.ok(declsOf('.day-chart-line').some((d) => d.prop === 'stroke' && d.value === 'var(--chart-hi, var(--accent))'));
});

/* ── 概要の下段（D16〜D18）────────────────────────────────── */

test('概要の札の下は2列。左に線グラフと重いもの、右に内訳と読み方', () => {
  const body = fnBody(tabCode(), 'overviewBlock');
  const at = (re) => {
    const m = body.match(re);
    assert.ok(m, `${re} が概要に無い`);
    return m.index;
  };
  // 左の列（main）と右の列（side）。手本のモックの .u-body / .side と同じ並び
  assert.ok(at(/main\.append\(daysBlock\(d\)\)/) < at(/main\.append\(heavy\)/), '左の列が 線グラフ → 重いもの の順でない');
  assert.ok(at(/side\.append\(share\)/) < at(/side\.append\(read\)/), '右の列が 内訳 → 読み方 の順でない');
  assert.match(body, /heavyBlock\(d, go\)/);
  assert.match(body, /shareBlock\(d\)/);
  assert.match(body, /readBlock\(d, trend\)/);
  // 札の読み方は札の直下ではなく右の列へ（札の器 tiles は札だけを返す）
  assert.doesNotMatch(fnBody(tabCode(), 'tiles'), /readNote\(/, '札の読み方が札の直下に残っている');

  // 狭い窓では1列に落ちて、横にはみ出さない（列は縮められる。右の列は折り返すと全幅へ伸びる）
  const cols = declsOf('.usage-over');
  assert.ok(cols.some((d) => d.prop === 'flex-wrap' && d.value === 'wrap'), '2列が折り返さない（狭い窓で横にはみ出す）');
  for (const sel of ['.usage-over-main', '.usage-over-side']) {
    const d = declsOf(sel);
    assert.ok(d.some((x) => x.prop === 'min-width' && x.value === '0'), `${sel} が器より細くなれない`);
    assert.ok(d.some((x) => x.prop === 'flex' && /^\d+ 1 /.test(x.value)), `${sel} が縮めない・伸びない`);
  }
});

test('いちばん重いものは1位＋「次は」の札。何で並べているかを消さない。絵は付けない', () => {
  const body = fnBody(tabCode(), 'heavyBlock');
  // 1画面に3つのものさしが混ざるので、札ごとに基準を書く（書かないと同じ順序で並んでいると読まれる）
  for (const basis of ['文脈への積み上がりが多い順', '全体の実消費に占める割合が大きい順', '実消費が多い順']) {
    assert.ok(body.includes(`'${basis}'`), `「${basis}」が消えている`);
  }
  assert.match(body, /次は /, '2位（次は）を出していない');
  // 絵は行き先の印（chevron）だけ。ツール・スキル・セッションの飾りの絵は付けない（D18）
  const icons = [...body.matchAll(/icon\('([\w-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(icons, ['chevron'], `重いものの札に飾りの絵がある: ${icons.join(', ')}`);
  // 押せない札は沈めた面だけ（.stat と同じ段）。押せるのは行き先のボタンだけ
  const face = declsOf('.usage-heavy .heavy');
  assert.ok(face.some((d) => d.prop === 'background' && d.value === 'var(--bg-sunk)'), '重いものの札が沈めた面でない');
  // 角丸（border-radius）は札の形なので数えない（.stat も --r-md を持つ）
  assert.deepEqual(face.filter((d) => /^(border(?!-radius)|box-shadow|cursor)/.test(d.prop)).map((d) => d.prop), [],
    '重いものの札が押せるものの形（枠・影・手の形）を持っている');
});

test('内訳は横棒のまま（ドーナツにしない）。因果の注記も同じ節に字で残す', () => {
  const body = fnBody(tabCode(), 'shareBlock');
  assert.match(body, /shareBar\('スキルに帰属'/, '内訳の横棒が無い');
  assert.match(body, /帰属は原因ではありません/, '内訳の節から因果の注記が消えている');
  const donut = jsFiles().filter((f) => /donut/i.test(jsCode(read(f)))).map((f) => path.basename(f));
  assert.deepEqual(donut, [], `ドーナツを組んでいる所がある: ${donut.join(', ')}`);
});

test('消した部品（.usage-two と、行で並べていた .usage-peek / peek-*）が戻っていない', () => {
  const GONE = /usage-two|usage-peek|\bpeek-(k|v|head|basis|go)\b/;
  const hits = [];
  for (const f of jsFiles()) if (GONE.test(jsCode(read(f)))) hits.push(path.relative(REPO, f));
  for (const f of fs.readdirSync(CSS_DIR).filter((n) => n.endsWith('.css'))) {
    if (GONE.test(cssCode(read(path.join(CSS_DIR, f))))) hits.push(`public/css/${f}`);
  }
  if (GONE.test(htmlCode(read(path.join(REPO, 'public', 'index.html'))))) hits.push('public/index.html');
  for (const f of fs.readdirSync(path.join(REPO, 'test')).filter((n) => n.endsWith('.mjs') && n !== 'usage-mode.test.mjs')) {
    if (GONE.test(read(path.join(REPO, 'test', f)))) hits.push(`test/${f}`);
  }
  assert.deepEqual(hits, [], `消した部品の名前が残っている:\n  ${hits.join('\n  ')}`);
});

test('概要の節見出しは sticky の帯にしない（2列の中で帯が列からはみ出す）。ほかの節は帯のまま', () => {
  const over = declsOf('.is-usage .usage-sec[data-sec="over"] .usage-block > h4');
  assert.ok(over.some((d) => d.prop === 'position' && d.value === 'static'), '概要の節見出しが sticky のまま');
  assert.ok(over.some((d) => d.prop === 'margin' && !/-/.test(d.value)), '概要の節見出しが負の margin（列の外へ伸びる帯）のまま');
  assert.ok(declsOf('.is-usage .usage-block > h4').some((d) => d.prop === 'position' && d.value === 'sticky'),
    'ほかの節の見出しまで sticky でなくなっている');
});

test('数値モード（横断）の誤読を防ぐ注記は字のまま残っている（1本も減らさない）', () => {
  // 右の紙のぶんは detail-pane.test.mjs が見ている。こちらは横断（usage-tab.js）のぶん
  const code = tabCode();
  const KEEP = [
    [/帰属は原因ではありません/, '因果の注記（これが無い状態で出荷しない）'],
    [/残りはどのスキルにも紐づいていません/, '内訳の残り（無帰属）'],
    [/下の割合を足しても 100% にならないのは/, 'スキルの割合を足しても 100% にならない理由'],
    [/1要求あたりは長さの違いを均した値です/, '1要求あたりの読み方'],
    [/差は、読んだ本数を時刻で半分に割り/, '差が何と何の比較か'],
    [/本まで読みました/, '上限で切ったこと（読んだ本数）'],
    [/本は要求なし/, '要求0本で外したもの'],
    [/モデルを1つ選ぶと出ます/, '命中率が出ない理由と出し方'],
    [/比べる相手が足りないものは差を出しません/, 'スキルの推移の差を出さないとき'],
    [/回は絵から外しました/, '絵から外した回（切ったこと）'],
    [/推移に並べていません/, '時刻の読めなかった回'],
    [/は上限で切りました/, 'スキルを上限で切ったこと'],
    [/読んだセッションを日ごとに足したものです/, '日ごとの合計が何か'],
    [/どの日にも入っていません/, '時刻の取れなかった要求'],
    [/同じ名前の別フォルダーは分けられません/, '置き場所のまとめ方'],
  ];
  const lost = KEEP.filter(([re]) => !re.test(code)).map(([, label]) => label);
  assert.deepEqual(lost, [], `横断の注記が消えている: ${lost.join(' / ')}`);
  // 因果の注記は2か所（概要の内訳とスキルの節）。片方だけ消えても気づけるよう数で見る
  assert.ok((code.match(/帰属は原因ではありません/g) ?? []).length >= 2, '因果の注記が概要とスキルの節の両方に無い');
  // 読み方の塊が、読んだ本数の断りと命中率の但し書きを右の列で出す
  const readBody = fnBody(code, 'readBlock');
  assert.match(readBody, /scanNote\(d\)/, '読み方から読んだ本数の断りが消えた');
  assert.match(readBody, /crossHitRateNote\(d\)/, '読み方から命中率の但し書きが消えた');
  // 層0・層1 に置いてある注記の文
  assert.match(jsCode(read(path.join(JS_DIR, 'usage-days.js'))), /より前は一部しか読んでいません/, '一部の日の一言が消えた');
  assert.match(chartCode(), /モデルまたぎでは比べられません/, '命中率のモデルの注記が消えた');
  // **注記を吹き出しへ移さない。** 数値モードは全幅で場所があるので、読み方も本文に置いている。
  // 吹き出し（tip）を使い始めるなら、移すものが誤読を防ぐ注記でないことを確かめてからここを直す
  assert.doesNotMatch(code, /\btip:/, '数値モードが見出しの吹き出し（tip）を使っている');
});

test('節ナビを組み直しても、押していた札へ焦点を名前で拾い直す', () => {
  // 引き直すたびに札を作り直すので、キーボードで札にいた人の焦点が body へ落ちる
  const nav = fnBody(tabCode(), 'renderUsageNav');
  assert.match(nav, /dataset\.refocus = /, '節ナビの札が data-refocus を持たない');
  assert.match(nav, /\.focus\(\)/, '節ナビを組み直したあと焦点を戻していない');
});
