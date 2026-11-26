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
 *   いちばん重いものは1位＋「次は」の札で、何で並べているかを消さない（D18）。概要の見出しは帯にしない（2列の中で帯が列の外へはみ出すため）
 * - 横断（`usage-tab.js`）の誤読を防ぐ注記が字のまま残っている（右の紙のぶんは `detail-pane.test.mjs`）
 * - 数値のカードを押しても作業台へ移さず、書庫と同じく拡大の窓で開く（D27）
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
  assert.match(fnBody(chartCode(), 'statTile'), /smallUnit \? unitValue\(/, 'statTile が smallUnit のときだけ割る形になっていない');
  const loose = [];
  for (const r of cssRules()) {
    for (const s of r.selectors) {
      if (/\.stat-unit\b/.test(s) && !s.startsWith('.usage-pane ')) loose.push(`${r.file} … ${s}`);
    }
  }
  assert.deepEqual(loose, [], `単位の見た目が数値モードの外にもある:\n  ${loose.join('\n  ')}`);
});

test('「数 ＋ 単位の span」を組むのは usage-chart.js の unitValue の1か所（札もいちばん重いものもそこを通す）', () => {
  // 前は statTile と heavyBlock が同じ組み方（splitUnit → span.stat-unit）を書き写していた
  const unit = fnBody(chartCode(), 'unitValue');
  assert.match(unit, /splitUnit\(value\)/, 'unitValue が splitUnit で割っていない');
  assert.match(unit, /el\('span', 'stat-unit', unit\)/, 'unitValue が単位を .stat-unit で包んでいない');
  // 単位のクラス名を JS に書くのは unitValue の中だけ
  const named = jsFiles().flatMap((f) => {
    const code = jsCode(read(f));
    const n = (code.match(/'stat-unit'/g) ?? []).length;
    return n ? [`${path.basename(f)} × ${n}`] : [];
  });
  assert.deepEqual(named, ['usage-chart.js × 1'], `単位の span を組む場所が1か所でない:\n  ${named.join('\n  ')}`);
  assert.equal((unit.match(/'stat-unit'/g) ?? []).length, 1, '単位のクラス名が unitValue の外にある');
  // いちばん重いものの1位の量も同じ組み方を通す
  const heavy = fnBody(tabCode(), 'heavyBlock');
  assert.match(heavy, /unitValue\(el\('span', 'heavy-v'\), value\)/, 'いちばん重いものの量が unitValue を通っていない');
  assert.doesNotMatch(heavy, /splitUnit/, 'いちばん重いものが自分で単位を割っている（組み方の写し）');
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

/* ── 数値のカードを拡大の窓で開く（D27）────────────────────── */

test('数値のカードを押しても作業台へ移さず、書庫と同じく拡大の窓で開く（モードは数値のまま）', () => {
  const main = jsCode(read(path.join(JS_DIR, 'main.js')));
  assert.match(main, /initUsageTab\(\{ onPick: \(\) => openZoom\(\) \}\)/, '数値のカードを押したあとに拡大の窓を開いていない');
  assert.doesNotMatch(main, /initUsageTab\(\{ onPick: \(\) => setMode\('work'\) \}\)/, '数値のカードを押すと作業台へ移る形が残っている');
  // 書庫と同じ形（並べて読めるように）
  assert.match(main, /initArchive\(\{ onPick: \(\) => openZoom\(\) \}\)/, '書庫のカードの開き方が変わっている');

  const card = fnBody(tabCode(), 'usageCard');
  // 選んでから開く（書庫の buildArchiveCard と同じ順）。逆にすると、前に選んでいたセッションが拡大の窓に一瞬出る
  const sel = card.indexOf("select(row.sessionId, 'usage', row)");
  const pick = card.indexOf('onPick?.()');
  assert.ok(sel >= 0, "カードが select(row.sessionId, 'usage', row) で選んでいない（押した行を控えさせていない）");
  assert.ok(pick > sel, '選ぶ前に拡大の窓を開いている（前に選んでいたものが一瞬出る）');
  // 一覧の引き出しを畳む口は要らない（数値モードに一覧は無い。焦点は拡大の窓が流れる箱へ移す）
  assert.doesNotMatch(card, /closeListAfterPick/, '作業台の一覧を畳む口が残っている');
});

test('一覧に居ないセッションでも、押した行の控えから詳細の頭を組める（詳細が届く前に窓が畳まれない）', () => {
  // renderDetailInner は headOf(store.selected) が空だと拡大を畳む。詳細はまだ届いていないので、
  // 一覧（store.rows）にも書庫の行にも居ないセッション（数値のカードの大半）は、開いた直後に閉じていた（実測）
  const body = fnBody(jsCode(read(path.join(JS_DIR, 'rows.js'))), 'rowOf');
  assert.match(body, /store\.archive\.rows\.find\(/, '書庫の行へ落とす口が消えている');
  assert.match(body, /store\.pickedRow\?\.sessionId === sessionId \? store\.pickedRow : null/,
    '押した行の控えへ落とす口が無い（または id で突き合わせていない）');
  // **数値の並びは引きに行かない。** 引き直しの最中（前の並びが薄く出て押せる）に押すと、届いた並びに
  // そのセッションが居ないことがあり、詳細の届く前の組み直しで窓が突然閉じた
  assert.doesNotMatch(body, /store\.usageTab/, 'rowOf が数値の並び（引き直しで差し替わる）を見ている');
  // 一覧の行がいちばん先（状態などの新しい項目を持つのはあちらだけ）、控えは最後
  assert.ok(body.indexOf('store.rows.find(') < body.indexOf('store.archive.rows'), '一覧の行より先に書庫の行を見ている');
  assert.ok(body.indexOf('store.archive.rows') < body.indexOf('store.pickedRow'), '書庫の行より先に控えを見ている');

  // 控えるのは select の第3引数。**早い return より前で控える**（同じセッションを押し直しても控えが残る）
  const sel = fnBody(jsCode(read(path.join(JS_DIR, 'session.js'))), 'select');
  const keep = sel.indexOf('store.pickedRow = picked');
  const early = sel.indexOf('return;');
  assert.ok(keep >= 0 && early >= 0 && keep < early, '同じセッションを押し直したとき、早い return で控えを書き損ねる');
  assert.match(sel, /row && row\.sessionId === sessionId \? row : null/, '控える行がそのセッションのものか確かめていない');
  assert.match(jsCode(read(path.join(JS_DIR, 'session.js'))), /export function select\(sessionId, from = 'live', row = null\)/,
    'select が押した行（第3引数）を受け取らない');
  // 書庫のカードも同じく押した行を渡す（検索の引き直しの最中に押したときも同じことが起きる）
  assert.match(fnBody(jsCode(read(path.join(JS_DIR, 'archive.js'))), 'buildArchiveCard'), /select\(row\.sessionId, 'archive', row\)/,
    '書庫のカードが押した行を控えさせていない');
});

test('詳細の頭へ状態を上書きするのは一覧の行だけ（書庫の行・押した行の控えの古い状態で上書きしない）', () => {
  // 控え（store.pickedRow）は押した時点の写し。今日のまとめの行は alive を持つので、控えから上書きすると
  // まとめを引いた時点の古い値が詳細の上に乗る。前は rowOf の行から上書きしていて、「控えには状態の項目を
  // 持たない行しか入れない」を呼ぶ側が守る約束だった（今日のまとめの題が行を渡せなかったのはそのため）
  const body = fnBody(jsCode(read(path.join(JS_DIR, 'rows.js'))), 'headOf');
  assert.match(body, /const live = store\.rows\.find\(\(r\) => r\.sessionId === sessionId\)/,
    '上書きの出どころを一覧の行から引いていない');
  assert.match(body, /if \(key in live\) head\[key\] = live\[key\]/, '一覧の行から状態を上書きしていない');
  assert.doesNotMatch(body, /head\[key\] = row\[key\]/, 'rowOf の返した行（書庫の行・控え）から状態を上書きしている');
  // 詳細が届く前は手元の行（一覧 → 書庫の行 → 控え）で組む。空だと拡大の窓が畳まれる
  assert.match(body, /if \(!detail\) return rowOf\(sessionId\);/, '詳細が届く前に手元の行へ落としていない（窓が畳まれる）');
  assert.equal((body.match(/rowOf\(/g) ?? []).length, 1, 'rowOf の行を詳細が届く前の落とし先以外にも使っている');
});

test('拡大の窓の「作業台で開く」は、作業台の外（書庫・数値）から開いたときに出す', () => {
  const zoom = jsCode(read(path.join(JS_DIR, 'zoom.js')));
  assert.match(fnBody(zoom, 'openZoom'), /dom\.zoomWork\.hidden = store\.mode === 'work'/,
    '「作業台で開く」を出す条件が「作業台の外から開いたとき」になっていない');
  assert.doesNotMatch(zoom, /store\.mode !== 'archive'/, '「作業台で開く」を書庫のときだけに絞っている（数値から開くと移る口が無い）');
});

test('拡大の窓の close の受け手は、窓が開き直していたら何もしない（遅れて着いた close が新しい窓を閉じない）', () => {
  // close() を呼んでも 'close' は一拍あとに届く。そのあいだに別のカードを押して開き直すと、
  // 遅れて着いた 'close' が closeZoom() を呼び、開いたばかりの窓を閉じていた（同じ瞬間に撃って再現）
  const zoom = jsCode(read(path.join(JS_DIR, 'zoom.js')));
  const init = fnBody(zoom, 'initZoom');
  assert.match(init, /addEventListener\('close', \(\) => \{\s*if \(dom\.zoom\.open\) return;\s*closeZoom\(\);\s*\}\)/,
    "'close' の受け手が、窓が開き直していても閉じにいく");
  // 'cancel' には付けない。Esc の 'cancel' の時点では open がまだ true なので、付けると Esc で閉じなくなる
  assert.match(init, /addEventListener\('cancel', \(\) => closeZoom\(\)\)/, "'cancel' の受け手が素の closeZoom() でない");
  // 開閉の判断は節点の位置のまま（旗を持たない）。dialog.open を見るのは dialog そのものを扱う2箇所だけ
  // （closeZoom の「閉じ済みなら close() を呼ばない」と、'close' の受け手）
  assert.match(fnBody(zoom, 'isZoomed'), /return dom\.detailPane\.parentElement === dom\.zoomBody;/,
    '開いているかの判断が節点の位置でなくなっている');
  assert.equal((zoom.match(/dom\.zoom\.open/g) ?? []).length, 2, 'dialog.open を開閉の判断にまで使い始めている');
});

test('数値モードで拡大を開いているあいだも、apply() は詳細を描き直す（作業台でないあいだの早期 return を抜ける）', () => {
  // 動いている最中のセッションも数値のカードに並ぶ。開いて見ているものが古いまま止まらないように
  const apply = fnBody(jsCode(read(path.join(JS_DIR, 'stream.js'))), 'apply');
  assert.match(apply, /if \(store\.mode !== 'work'\) \{\s*if \(isZoomed\(\)\) \{\s*renderDetailIfNeeded\(\);\s*loadDetail\(store\.selected/,
    '作業台でないあいだ、拡大を開いていても詳細を描き直していない');
  assert.doesNotMatch(apply, /store\.mode === 'archive'/, '早期 return を抜ける判定が書庫だけに絞られている');
});

test('拡大の窓は .app の外にある（数値モードで詳細ペインを消す .is-usage .detail-pane が、運んだ先に当たらない）', () => {
  const html = htmlCode(read(path.join(REPO, 'public', 'index.html')));
  const appAt = html.indexOf('<div class="app" id="app">');
  const zoomAt = html.indexOf('<dialog class="zoom" id="zoom"');
  assert.ok(appAt >= 0 && zoomAt >= 0, '.app か拡大の窓が index.html に無い');
  // .app の閉じタグを div の入れ子を数えて探す
  const re = /<div\b|<\/div>/g;
  re.lastIndex = appAt;
  let depth = 0;
  let closedAt = -1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) {
      closedAt = m.index;
      break;
    }
  }
  assert.ok(closedAt > appAt && closedAt < zoomAt, '拡大の窓が .app の中にある（数値・書庫から開いた窓が空で出る）');
  // 寄りかかっている先の指定（子孫セレクタで詳細ペインを消している）
  assert.ok(declsOf('.is-usage .detail-pane').some((d) => d.prop === 'display' && d.value === 'none'),
    '数値モードで詳細ペインを消す指定が見当たらない（この約束の前提が変わった）');
});

test('セッションの節の一言は「押すと拡大の窓で開く」と言う（右に出る・作業台へ移るとは言わない）', () => {
  const rows = fnBody(tabCode(), 'rowsBlock');
  assert.doesNotMatch(rows, /押すと右に中身が出ます/, '前の言い方（右に中身が出る）が残っている');
  assert.match(rows, /拡大/, '押すと拡大の窓で開くことを言っていない');
});

test('節ナビを組み直しても、押していた札へ焦点を名前で拾い直す', () => {
  // 引き直すたびに札を作り直すので、キーボードで札にいた人の焦点が body へ落ちる
  const nav = fnBody(tabCode(), 'renderUsageNav');
  assert.match(nav, /dataset\.refocus = /, '節ナビの札が data-refocus を持たない');
  assert.match(nav, /\.focus\(\)/, '節ナビを組み直したあと焦点を戻していない');
});
