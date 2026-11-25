/**
 * 書庫モード（`archive.js` / `archive.css`）の、字面で分かる約束（画面刷新⑤）。
 *
 * `archive.js` は DOM を触るので素の node では import できない。`usage-mode.test.mjs` と
 * 同じく字面で見る。**崩れても画面を開くまで何のエラーも出ない**種類の約束なので。
 *
 * - 探す帯は数値の頭（`.usage-head`）と同じ帯。`.list-head` を借り、書庫だけで余白を上書きしない。
 *   帯の中の押せるものは背を1つの規則でそろえる。探す帯の指定は `archive.css` の1か所
 *   （`list.css` に残っていた「単体で置く」指定は消した。戻さない）
 * - 「中身も探す」はチェックのまま・検索欄の文言に「題」を入れない・絞り込みの札は押せる段のまま
 *   （手本のモックと違うところは、採らなかった理由ごと public/CLAUDE.md の「書庫（探す帯とカード）」にある）
 * - 結果の床は --bg（D22）。題の行数に上限なし（D19）。カードの中に絵を置かない（D20）
 * - カードの数値は4つの格子（D21）。届く前の点線の器は格子と同じ式で背を取り、0 を書かない。
 *   格子はカードの底にそろえる。範囲は書庫だけで、数値モードのカード（共有の `.card`）は変えない
 *
 * 字面はコメントを落としてから読む。このリポジトリは説明が厚く、経緯がコメントに残るため。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const JS_DIR = path.join(REPO, 'public', 'js');
const CSS_DIR = path.join(REPO, 'public', 'css');

/** @param {string} p @returns {string} */
const read = (p) => fs.readFileSync(p, 'utf8');

/** CSS のコメントを落とした本文 */
const cssCode = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '');

/** HTML のコメントを落とした本文 */
const htmlCode = (text) => text.replace(/<!--[\s\S]*?-->/g, '');

/** JS のコメントを落とした本文（`usage-mode.test.mjs` の `jsCode` と同じ落とし方） */
const jsCode = (text) => text
  .split('\n')
  .map((line) => (/^\s*(\/\/|\/?\*)/.test(line) ? '' : line.replace(/\s\/\/.*$/, '')))
  .join('\n');

/**
 * `public/css/` の規則を全部、`{ file, selectors, decls }` の並びにする
 * （`usage-mode.test.mjs` の `cssRules` と同じ読み方。入れ子は `@media` の1段だけ）。
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
        return { prop: d.slice(0, i).trim(), value: d.slice(i + 1).trim().replace(/\s+/g, ' ') };
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
 * その宣言の値を1つだけ取る（同じセレクタ・同じ性質が2か所にあれば落とす）。
 * @param {string} selector
 * @param {string} prop
 */
function valueOf(selector, prop) {
  const found = declsOf(selector).filter((d) => d.prop === prop);
  assert.equal(found.length, 1, `${selector} { ${prop} } が ${found.length} か所にある（1か所に置く）:\n  ${found.map((d) => `${d.file} … ${d.value}`).join('\n  ')}`);
  return found[0].value;
}

/**
 * 関数の本体を括弧を数えて切り出す（`usage-mode.test.mjs` の `fnBody` と同じ）。
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

const archiveCode = () => jsCode(read(path.join(JS_DIR, 'archive.js')));
const indexHtml = () => htmlCode(read(path.join(REPO, 'public', 'index.html')));

/**
 * index.html の、その id を持つ開きタグ。
 * @param {string} id
 */
function tagOf(id) {
  const tag = indexHtml().match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`));
  assert.ok(tag, `#${id} が index.html に無い`);
  return tag[0];
}

/* ── 探す帯 ──────────────────────────────────────────────── */

test('探す帯は数値の頭と同じ帯（.list-head を借り、書庫だけで余白を上書きしない）', () => {
  assert.match(tagOf('archive-head'), /class="list-head archive-head"/, '#archive-head が .list-head を借りていない');
  assert.match(tagOf('usage-head'), /class="list-head usage-head"/, '#usage-head が .list-head を借りていない（比べる相手が変わった）');
  // 前は書庫だけ余白を広げていて、書庫と数値を行き来すると帯の背が跳ねた（実測 52.6px / 51px）
  const own = cssRules()
    .filter((r) => r.selectors.some((s) => /\.archive-head$/.test(s)))
    .flatMap((r) => r.decls.filter((d) => /^padding/.test(d.prop)).map((d) => `${r.file} … ${r.selectors.join(', ')} { ${d.prop}: ${d.value} }`));
  assert.deepEqual(own, [], `探す帯が自分の余白を持っている（数値の頭と背が食い違う）:\n  ${own.join('\n  ')}`);
  assert.equal(valueOf('.archive-head', 'flex-wrap'), 'wrap', '探す帯が折り返さない（狭い窓で横にはみ出す）');
  // 件数は同じ行の右端。数値の頭（#usage-count）と同じ作法
  assert.equal(valueOf('.archive-head #archive-count', 'margin-left'), 'auto', '件数が右端へ寄っていない');
  assert.equal(valueOf('.usage-head #usage-count', 'margin-left'), 'auto', '数値の頭の件数の置き方が変わった（そろえる相手）');
});

test('帯の中の押せるもの（今日のまとめ・検索欄・絞り込みの札）の背は1つの規則でそろえる', () => {
  // 中身なりだと select の札が 34px、検索欄と今日のまとめが 31px で、1行の中で上下がずれていた（実測）
  const rules = cssRules();
  const rule = rules.find((r) => r.selectors.includes('.archive-field') && r.selectors.includes('.archive-head .today-open'));
  assert.ok(rule, '.archive-field と .archive-head .today-open を1つの規則でそろえていない');
  assert.deepEqual(rule.decls.map((d) => d.prop), ['min-height'], 'そろえる規則に背のほかの指定が混ざっている');
  // 背を決める場所を2つにしない（片方だけ直した日に食い違う）
  const other = [];
  for (const r of rules) {
    if (r === rule) continue;
    for (const s of r.selectors) {
      if (!/^(\.archive-field|\.archive-head \.today-open|\.today-open)$/.test(s)) continue;
      for (const d of r.decls) if (/^(min-)?height$/.test(d.prop)) other.push(`${r.file} … ${s} { ${d.prop}: ${d.value} }`);
    }
  }
  assert.deepEqual(other, [], `帯の押せるものの背を別の所でも決めている:\n  ${other.join('\n  ')}`);
  // 外す口は入れない（ピル型の小さな丸で、札と形を変えるのが役目）
  assert.ok(!rule.selectors.some((s) => /archive-clear/.test(s)), '外す口まで札と同じ背にしている（形を変える約束）');
});

test('帯の背（34px）の数は base.css の --band-ctl-h の1か所。書庫の札も数値の頭の節ナビもそこから引く', () => {
  // 前は書庫の札が 2.125rem、節ナビが 1.75rem（借りた器の余白と枠を足して 34px になる前提）と、
  // 別々の単位の数で書いてあった。片方だけ直すと、1行の帯の中で黙って上下がずれる
  const defs = cssRules().flatMap((r) => r.decls
    .filter((d) => d.prop === '--band-ctl-h')
    .map((d) => `${r.file} … ${r.selectors.join(', ')} { ${d.value} }`));
  assert.deepEqual(defs, ['base.css … :root { 2.125rem }'], `帯の背の定義が1か所でない（または値が変わった）:\n  ${defs.join('\n  ')}`);
  assert.equal(valueOf('.archive-field', 'min-height'), 'var(--band-ctl-h)', '書庫の札の背が帯の変数から出ていない');
  // 節ナビは、帯の背から借りた器（.live-filter）の内側の余白と枠を上下ぶん引いた式
  assert.equal(valueOf('.usage-head .usage-nav button', 'height'),
    'calc(var(--band-ctl-h) - 2 * (var(--seg-pad) + var(--seg-line)))', '節ナビの札の背が、帯の背から器の余白と枠を引いた式になっていない');
  // 器の余白と枠は、引く側と同じ変数で持つ（数を書き写すと、器だけ直した日に節ナビがずれる）
  assert.equal(valueOf('.live-filter', 'padding'), 'var(--seg-pad)', '.live-filter の余白が変数から出ていない');
  assert.match(valueOf('.live-filter', 'border'), /^var\(--seg-line\) solid /, '.live-filter の枠の太さが変数から出ていない');
  // どこにも背の数を直に戻さない
  const literal = cssRules().flatMap((r) => r.decls
    .filter((d) => /^(min-)?height$/.test(d.prop) && /^(2\.125rem|1\.75rem|34px|28px)$/.test(d.value)
      && r.selectors.some((s) => /archive-field|today-open|usage-nav/.test(s)))
    .map((d) => `${r.file} … ${r.selectors.join(', ')} { ${d.prop}: ${d.value} }`));
  assert.deepEqual(literal, [], `帯の背を数で直に書いている:\n  ${literal.join('\n  ')}`);
});

test('探す帯の指定は archive.css の1か所。list.css に「単体で置く」指定を戻さない', () => {
  const loose = [];
  for (const r of cssRules()) {
    for (const s of r.selectors) {
      if (/\.archive-head\b|\.archive-q\b|\.archive-field\b|#archive-count\b/.test(s) && r.file !== 'archive.css') {
        loose.push(`${r.file} … ${s}`);
      }
      // 一覧の頭のラベル（前は書庫の「中身も探す」だけに当たっていた）
      if (/\.list-head label\b/.test(s)) loose.push(`${r.file} … ${s}`);
    }
  }
  assert.deepEqual(loose, [], `探す帯の指定が archive.css の外にある（中に丸い線が出た名残）:\n  ${loose.join('\n  ')}`);
  // 器の中身はブラウザの既定ごと外して、器に任せる（枠・丸み・影・字）
  for (const sel of ['.archive-field .archive-q', '.archive-field select']) {
    const got = Object.fromEntries(declsOf(sel).filter((d) => d.file === 'archive.css').map((d) => [d.prop, d.value]));
    assert.equal(got.border, '0', `${sel} が枠を外していない（二重の枠になる）`);
    assert.equal(got['border-radius'], '0', `${sel} が丸みを外していない`);
    assert.equal(got['box-shadow'], 'none', `${sel} が影を外していない（中に丸い線が出る）`);
    assert.equal(got.font, 'inherit', `${sel} が帯の字を継いでいない（入力欄がシステムの字になる）`);
  }
});

test('「中身も探す」はチェックのまま。入れた印は --accent', () => {
  // 「どれを見るか」の切り替え（.live-filter）ではなく、いまの検索に本文を足すかどうかの1つの選択
  assert.match(indexHtml(), /<label><input type="checkbox" id="archive-deep"> 中身も探す<\/label>/, '「中身も探す」がラベルつきのチェックでない');
  assert.equal(valueOf('.archive-head input[type="checkbox"]', 'accent-color'), 'var(--accent)', '入れた印が --accent でない');
  assert.match(archiveCode(), /dom\.archiveDeep\.checked/, 'archive.js がチェックの checked を読んでいない');
});

test('検索欄の文言に「題」を入れない（浅い検索は題では当たらない）', () => {
  const tag = tagOf('archive-q');
  assert.match(tag, /placeholder="ID・置き場所で探す"/, '検索欄の文言が変わった');
  assert.doesNotMatch(tag, /placeholder="[^"]*題/, '検索欄の文言に「題」が入っている（手本のモックの文言。浅い検索は題を読んでいない行が大半）');
});

test('絞り込みの札の面は押せる段（--bg-elev ＋ 影）のまま。手本のモックの沈めた面にしない', () => {
  assert.equal(valueOf('.archive-field', 'background'), 'var(--bg-elev)', '絞り込みの札の面が押せる段でない');
  assert.match(valueOf('.archive-field', 'box-shadow'), /var\(--sh-1\)/, '絞り込みの札が影を持たない（押せるものは浮かせる）');
});

/* ── 結果のグリッドとカード ───────────────────────────────── */

test('結果の床は --bg（D22）。左右の余白は帯と同じで、カードの左の縁が帯とそろう', () => {
  assert.equal(valueOf('.archive-grid', 'background'), 'var(--bg)', '書庫の床が --bg でない（数値モードの床と同じにする）');
  // padding の左右（2つ目の値）を比べる。帯は .list-head の余白をそのまま使う
  const side = (v) => v.split(' ')[1];
  assert.equal(side(valueOf('.archive-grid', 'padding')), side(valueOf('.list-head', 'padding')),
    '書庫の床の左右の余白が帯と違う（カードの左の縁が帯の「今日のまとめ」とずれる）');
});

test('カードの題の行数に上限を付けない（D19）', () => {
  const bad = [];
  for (const r of cssRules()) {
    for (const s of r.selectors) {
      // 数値モードのカード（.is-usage）は別の問い。書庫に当たりうるものだけ見る
      if (!/\.card-title\b/.test(s) || /is-usage/.test(s)) continue;
      for (const d of r.decls) {
        if (/line-clamp|^max-height$|^text-overflow$/.test(d.prop)) bad.push(`${r.file} … ${s} { ${d.prop}: ${d.value} }`);
      }
    }
  }
  assert.deepEqual(bad, [], `書庫のカードの題を切っている（探しに来た人が読むのは題）:\n  ${bad.join('\n  ')}`);
});

test('カードの中に絵を置かない（D20）。絵は絞り込みの札にだけ', () => {
  assert.doesNotMatch(fnBody(archiveCode(), 'buildArchiveCard'), /icon\(/, '書庫のカードに絵を置いている');
  // カードの定型（置き場所・ブランチの札）も絵を持たない
  const card = jsCode(read(path.join(JS_DIR, 'card.js')));
  assert.doesNotMatch(card, /from '\.\/icons\.js'|icon\(/, 'カードの定型（card.js）が絵を持っている');
  // 札の絵は initArchive が差す（ここは残す）
  assert.match(fnBody(archiveCode(), 'initArchive'), /icon\('folder', 14\)/, '絞り込みの札の絵が無くなった');
});

test('カードの数値は4つの格子（D21）。列の数は数値の定義の数と同じ', () => {
  const code = archiveCode();
  const defs = code.match(/const STAT_DEFS = \[([\s\S]*?)\n\];/);
  assert.ok(defs, 'STAT_DEFS が見つからない');
  const n = defs[1].match(/\{ key: '/g)?.length;
  assert.equal(n, 4, '数値の数が4つでない');
  assert.equal(valueOf('.card-stats', 'display'), 'grid', '数値の器が格子でない');
  assert.equal(valueOf('.card-stats', 'grid-template-columns'), `repeat(${n}, minmax(0, 1fr))`, '格子の列の数が数値の数と違う');
  // 1マスはラベルの下に値
  assert.equal(valueOf('.card-stat', 'display'), 'grid', '1マスがラベルの下に値の形でない');
  assert.match(fnBody(code, 'fillStats'), /el\('span', 'k', d\.label\), el\('span', 'v', d\.of\(u\)\)/, '1マスの中身（ラベル → 値）が変わった');
});

test('届く前の点線の器は、格子と同じ式で背を取る。0 を書かない', () => {
  // 前は1行ぶんの 1.1rem を手で書いていて、届くと器が 8px 伸びていた（実測）
  const wait = valueOf('.card-stats.is-waiting', 'min-height');
  for (const v of ['1px', 'var(--stat-pad)', 'var(--stat-k)', 'var(--stat-gap)', 'var(--stat-v)']) {
    assert.ok(wait.includes(v), `点線の器の背に ${v} が入っていない（届いたあとの格子と背が食い違う）: ${wait}`);
  }
  assert.equal(valueOf('.card-stats.is-waiting', 'border-top-style'), 'dashed', 'まだ届いていないことを点線で示していない');
  // 同じ変数を、届いたあとの格子が使っている
  assert.equal(valueOf('.card-stats', 'padding-top'), 'var(--stat-pad)');
  assert.match(valueOf('.card-stats', 'border-top'), /^1px /, '上の区切り線の太さが器の式（1px）と違う');
  assert.equal(valueOf('.card-stat', 'gap'), 'var(--stat-gap)');
  assert.equal(valueOf('.card-stat .k', 'line-height'), 'var(--stat-k)');
  assert.match(valueOf('.card-stat .v', 'font'), /\/ var\(--stat-v\)/, '値の行の高さが器の式（--stat-v）と違う');
  // 届いていない（undefined）ときは中身を空にするだけ。「0」も「—」も書かない
  assert.match(fnBody(archiveCode(), 'fillStats'), /if \(u === undefined\) \{\s*box\.replaceChildren\(\);\s*return;\s*\}/,
    'まだ届いていないときに中身を空にして返していない（0 と不明が同じ顔になる）');
});

test('格子はカードの底にそろえる。縦の flex にするのは書庫のカードだけ', () => {
  assert.equal(valueOf('.archive-grid .card', 'display'), 'flex', '書庫のカードが縦の flex でない（格子の高さが題の長さでずれる）');
  assert.equal(valueOf('.archive-grid .card', 'flex-direction'), 'column');
  assert.equal(valueOf('.archive-grid .card > .card-stats', 'margin-top'), 'auto', '格子をカードの底へ送っていない');
  // 共有の .card（数値モードのカードも使う）は grid のまま
  const base = declsOf('.card').filter((d) => d.file === 'list.css' && d.prop === 'display');
  assert.deepEqual(base.map((d) => d.value), ['grid'], '共有の .card の組み方が変わった（数値モードのカードにも効く）');
  const usage = declsOf('.card.is-usage').filter((d) => d.prop === 'display');
  assert.deepEqual(usage, [], '数値モードのカードの組み方を変えている（書庫だけの指定にする）');
});

test('選んだカードの面は床（--bg）と同じにしない。一覧の選んでいる行と同じ顔（--bg-hi ＋ --border-strong、光の輪なし）', () => {
  // 書庫の床（D22）も数値モードの床も --bg。前は選んだカードの面が --bg で、床と同じ色に抜けて見えた
  const floors = [valueOf('.archive-grid', 'background'), valueOf('.usage-pane', 'background')];
  const face = valueOf('.card[aria-current="true"]', 'background');
  assert.ok(!floors.includes(face), `選んだカードの面（${face}）が床（${floors.join(' / ')}）と同じ（中身が抜けて見える）`);
  // 一覧の選んでいる行と同じ考え方（ラベンダーを減らす決め）
  assert.equal(face, valueOf('.row[aria-current="true"]', 'background'), '選んだカードの面が一覧の選んでいる行と違う');
  assert.equal(valueOf('.card[aria-current="true"]', 'border-color'), valueOf('.row[aria-current="true"]', 'border-color'),
    '選んだカードの枠が一覧の選んでいる行と違う');
  // 光の輪（--accent-soft）を付けない。影を上書きしなければ素の .card の --sh-1 ＋ --hi のまま
  const ring = declsOf('.card[aria-current="true"]').filter((d) => /accent/.test(d.value)).map((d) => `${d.file} … ${d.prop}: ${d.value}`);
  assert.deepEqual(ring, [], `選んだカードにラベンダー（光の輪・混ぜた枠）が残っている:\n  ${ring.join('\n  ')}`);
  // 面は字の比の表（tokens.test.mjs の GROUNDS）が測っている面の1つ。選んだ面の上でも字は 4.5:1 以上
  assert.match(read(path.join(REPO, 'test', 'tokens.test.mjs')), new RegExp(`GROUNDS = \\[[^\\]]*'${face.replace(/^var\((--[\w-]+)\)$/, '$1')}'`),
    '選んだカードの面が字の比の表で測られていない面になった');
  // 選んだカードでは格子の区切り線も濃くする（素の --border は --bg-hi とほぼ同じ明るさで消える）
  assert.equal(valueOf('.card[aria-current="true"] .card-stats', 'border-top-color'), 'var(--border-strong)',
    '選んだカードで数値の格子の区切り線が消える');
});

test('範囲は書庫だけ。数値の格子の指定は archive.css にだけあり、共有の .card は変えていない', () => {
  const loose = [];
  for (const r of cssRules()) {
    for (const s of r.selectors) {
      if (/\.card-stats?\b/.test(s) && r.file !== 'archive.css') loose.push(`${r.file} … ${s}`);
    }
  }
  assert.deepEqual(loose, [], `数値の格子の指定が書庫の外にある:\n  ${loose.join('\n  ')}`);
  assert.doesNotMatch(jsCode(read(path.join(JS_DIR, 'usage-tab.js'))), /card-stats?/, '数値モードのカードが書庫の数値の格子を使っている');
  // 共有の .card（list.css）の面・余白・触れたときの浮き方は前のまま（数値モードのカードにも効く）
  const card = Object.fromEntries(declsOf('.card').filter((d) => d.file === 'list.css').map((d) => [d.prop, d.value]));
  assert.equal(card.background, 'var(--bg-elev)');
  assert.equal(card.padding, '.6rem .7rem .6rem 1rem');
  assert.equal(card.gap, '.3rem');
  // 触れたときは -1px（手本のモックの -2px は採らない。「段の当て方」の表）
  assert.equal(valueOf('.card:hover', 'transform'), 'translateY(-1px)');
});
