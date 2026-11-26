/**
 * 今日のまとめの窓（`today.js` / `index.html` の `#today` / `archive.css` の `.today-*`）の、
 * 字面で分かる約束（画面刷新⑤の D23〜D26）。
 *
 * `today.js` は DOM を触るので素の node では import できない。`archive-mode.test.mjs` と同じく字面で見る。
 * どの日を見るかの判断そのもの（範囲・日の言い方・矢印の行き先と端）は `today-md.test.mjs` が関数を呼んで見ている。
 *
 * - 日を替える口（日の選択・前の日・次の日・開いたとき）はすべて `setAgo` の1本を通る（D23）
 * - 端の矢印は隠さずに押せなくする。押せなくなった矢印から焦点を反対へ渡す
 * - 題に日付を出す。日の選択肢は開くたびに組み直す
 * - 足は 一言 → 閉じる → Markdown でコピー。塗るのはコピーの1つだけ（D26）
 * - 1本ずつは横罫のまま（D24）・数の帯は字だけのまま（D25）・窓の高さは固定のまま
 * - 題を押したら、押した行を控えさせてから拡大の窓で開く（窓を閉じる → 選ぶ → 開く）
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
 * `public/css/` の規則を全部、`{ file, selectors, decls }` の並びにする（`archive-mode.test.mjs` と同じ読み方）。
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

/** @param {string} selector */
function declsOf(selector) {
  return cssRules()
    .filter((r) => r.selectors.includes(selector))
    .flatMap((r) => r.decls.map((d) => ({ ...d, file: r.file })));
}

/**
 * 関数の本体を括弧を数えて切り出す（`usage-mode.test.mjs` の `fnBody` と同じ）。
 * @param {string} code
 * @param {string} name
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

const todayCode = () => jsCode(read(path.join(JS_DIR, 'today.js')));

/** index.html の `<dialog id="today">` の中身（コメントを落としたもの） */
function todayDialog() {
  const html = htmlCode(read(path.join(REPO, 'public', 'index.html')));
  const m = html.match(/<dialog[^>]*\bid="today"[^>]*>([\s\S]*?)<\/dialog>/);
  assert.ok(m, '<dialog id="today"> が index.html に無い');
  return m[1];
}

/** 窓の中の、その id を持つ開きタグ */
function tagIn(html, id) {
  const tag = html.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`));
  assert.ok(tag, `#${id} が今日のまとめの窓に無い`);
  return tag[0];
}

/* ── 日の選び方（D23）────────────────────────────────────── */

test('日を替える口（日の選択・前の日・次の日・開いたとき）はすべて setAgo の1本を通る', () => {
  const code = todayCode();
  const init = fnBody(code, 'initToday');
  assert.match(init, /dom\.todayAgo\.addEventListener\('change', \(\) => setAgo\(dom\.todayAgo\.value\)\)/, '日の選択が setAgo を通っていない');
  assert.match(init, /dom\.todayPrev\.addEventListener\('click', \(\) => step\('prev'\)\)/, '前の日が step を通っていない');
  assert.match(init, /dom\.todayNext\.addEventListener\('click', \(\) => step\('next'\)\)/, '次の日が step を通っていない');
  // 矢印の行き先は層0 の agoSteps が決め、行き先が無ければ何もしない。行き先があれば setAgo を通る
  const step = fnBody(code, 'step');
  assert.match(step, /agoSteps\(ago\)\[dir\]/, '矢印の行き先を agoSteps で決めていない');
  assert.match(step, /if \(target === null\) return;/, '端で押されても何もしない形になっていない');
  assert.match(step, /setAgo\(target\)/, '矢印が setAgo を通っていない');
  assert.match(fnBody(code, 'openToday'), /setAgo\(ago\)/, '開いたときに setAgo を通っていない');
  // setAgo が1か所でやること（丸め・選択の値・題と矢印・一言の消去・引き直し）
  const set = fnBody(code, 'setAgo');
  for (const [re, what] of [
    [/ago = clampAgo\(next\)/, '丸め（clampAgo）'],
    [/dom\.todayAgo\.value = String\(ago\)/, '日の選択の値'],
    [/renderHead\(\)/, '題と矢印'],
    [/say\(''\)/, '一言の消去'],
    [/load\(\)/, '引き直し'],
  ]) assert.match(set, re, `setAgo が ${what} をやっていない`);
  // ほかの口が ago を直に書き換えない・load を直に呼ばない（道が2本になる）
  assert.equal(code.match(/(?<!let )\bago = /g)?.length, 1, 'ago を setAgo 以外でも書き換えている');
  assert.equal(code.match(/(?<!function )\bload\(\)/g)?.length, 1, 'load を setAgo 以外からも呼んでいる');
});

test('中身を引くのは load の1か所だけ（開いたとき1回・日を替えたとき）', () => {
  const code = todayCode();
  assert.equal(code.match(/getJson\(/g)?.length, 1, '/api/today を引く所が2か所以上ある');
  assert.match(fnBody(code, 'load'), /getJson\(`\/api\/today\?ago=\$\{ago\}`\)/, 'load が /api/today?ago= を引いていない');
  // 配線のときに引かない（開くまで撃たない）
  const init = fnBody(code, 'initToday');
  assert.doesNotMatch(init, /load\(/, '配線のときに引いている（開く前から重い窓口を撃つ）');
  // 日の選択の受け口（`() => setAgo(…)`）のほかに、配線そのものの中で日を替えない
  assert.doesNotMatch(init.replace(/=> setAgo\(/g, ''), /setAgo\(/, '配線のときに日を替えている（開く前から重い窓口を撃つ）');
});

test('端の矢印は隠さずに押せなくする（disabled）。押せなくなった矢印から焦点を反対へ渡す', () => {
  const head = fnBody(todayCode(), 'renderHead');
  assert.match(head, /const steps = agoSteps\(ago\)/, '矢印の押せる押せないを agoSteps で決めていない');
  assert.match(head, /dom\.todayPrev\.disabled = steps\.prev === null/, '前の日を端で押せなくしていない');
  assert.match(head, /dom\.todayNext\.disabled = steps\.next === null/, '次の日を端で押せなくしていない');
  assert.doesNotMatch(todayCode(), /today(Prev|Next)\.hidden/, '端の矢印を隠している（隣のボタンの位置がずれる）');
  // キーボードで続けて押していた人の焦点が窓の外へ落ちない
  assert.match(fnBody(todayCode(), 'step'), /if \(held && btn\.disabled\) \(dir === 'prev' \? dom\.todayNext : dom\.todayPrev\)\.focus\(\)/,
    '押せなくなった矢印から焦点を反対の矢印へ渡していない');
  // 押せないことを止まった絵で見せる（薄く・触れても面を出さない）
  const off = declsOf('.ibtn[disabled]');
  assert.ok(off.some((d) => d.prop === 'opacity'), '.ibtn[disabled] が薄くならない');
  const hover = declsOf('.ibtn[disabled]:hover');
  assert.ok(hover.some((d) => d.prop === 'background' && d.value === 'none'), '押せない矢印に触れると面が出る');
});

test('矢印は日の選択の両脇。絵だけのボタンなので名前を持ち、絵は chevron を使い回す（前の日は裏返す）', () => {
  const html = todayDialog();
  const group = html.match(/<div class="today-days"[^>]*role="group"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(group, '日を選ぶ一組（.today-days・role="group"）が無い');
  const order = ['today-prev', 'today-ago', 'today-next'].map((id) => group[1].indexOf(`id="${id}"`));
  assert.ok(order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2], '並びが 前の日 → 日の選択 → 次の日 でない');
  for (const [id, name] of [['today-prev', '前の日'], ['today-next', '次の日']]) {
    const tag = tagIn(html, id);
    assert.match(tag, /class="ibtn today-step/, `#${id} が補助のアイコンボタン（.ibtn）でない`);
    assert.match(tag, new RegExp(`title="${name}"`), `#${id} に title が無い`);
    assert.match(tag, new RegExp(`aria-label="${name}"`), `#${id} に aria-label が無い`);
  }
  // 絵を新しく作らない
  const init = fnBody(todayCode(), 'initToday');
  assert.match(init, /dom\.todayPrev\.append\(icon\('chevron'\)\)/);
  assert.match(init, /dom\.todayNext\.append\(icon\('chevron'\)\)/);
  assert.ok(declsOf('.today-step.is-prev .icon').some((d) => d.prop === 'transform' && /scaleX\(-1\)/.test(d.value)),
    '前の日の絵を裏返していない');
  // 押すたびに矢印の位置が動かない（右端へ寄せ、日の選択の幅を決めておく）
  assert.ok(declsOf('.today-days').some((d) => d.prop === 'margin-left' && d.value === 'auto'), '日を選ぶ一組が右端へ寄っていない');
  assert.ok(declsOf('.today-days .archive-field').some((d) => d.prop === 'min-width'), '日の選択の幅を決めていない（選んだ札の長さで矢印が動く）');
});

test('題に日付を出し、日の選択肢は開くたびに組み直す（同じ言い方の agoDate / agoLabel）', () => {
  assert.match(todayDialog(), /<h2 id="today-title">まとめ <span class="today-day" id="today-day"><\/span><\/h2>/, '題に日付の器が無い');
  assert.match(fnBody(todayCode(), 'renderHead'), /dom\.todayDay\.textContent = agoDate\(ago, Date\.now\(\)\)/, '題の日付を agoDate で組んでいない');
  const fill = fnBody(todayCode(), 'fillAgo');
  assert.match(fill, /agoLabel\(i, now\)/, '日の選択肢を agoLabel で組んでいない');
  assert.match(fill, /replaceChildren\(/, '日の選択肢を組み直さずに足している（開くたびに増える）');
  assert.match(fnBody(todayCode(), 'openToday'), /fillAgo\(\)/, '開くたびに日の選択肢を組み直していない（常駐すると日付が古いまま残る）');
});

/* ── 足のボタン（D26）────────────────────────────────────── */

test('足は 一言 → 閉じる → Markdown でコピー。塗るのはコピーの1つだけ', () => {
  const html = todayDialog();
  const foot = html.match(/<div class="settings-foot">([\s\S]*?)<\/div>/);
  assert.ok(foot, '窓の足が無い');
  const order = ['today-msg', 'today-close-foot', 'today-copy'].map((id) => foot[1].indexOf(`id="${id}"`));
  assert.ok(order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2], '足の並びが 一言 → 閉じる → コピー でない');
  assert.match(tagIn(html, 'today-copy'), /class="btn is-lead"/, 'Markdown でコピーが塗った主ボタンでない');
  assert.match(tagIn(html, 'today-close-foot'), /class="btn"/, '足の閉じるが普通のボタンでない');
  // 窓の中で塗るのは1つ（1画面に1つ）。JS が後から塗ることもしない
  assert.equal(html.match(/\bis-lead\b/g)?.length, 1, '今日のまとめの窓で塗ったボタンが1つでない');
  assert.doesNotMatch(todayCode(), /is-lead/, 'today.js が塗ったボタンを足している');
  // コピーは頭に残っていない（頭と足に2つ並べない）
  const head = html.match(/<div class="settings-head today-head">([\s\S]*?)<div class="today-body"/);
  assert.ok(head, '窓の頭が無い');
  assert.doesNotMatch(head[1], /today-copy/, 'コピーが頭にも残っている');
  // 閉じる口は頭の × と足の「閉じる」の2つで、どちらも窓を閉じるだけ
  assert.match(fnBody(todayCode(), 'initToday'), /for \(const btn of \[dom\.todayClose, dom\.todayCloseFoot\]\) btn\.addEventListener\('click', \(\) => dom\.today\.close\(\)\)/,
    '頭の × と足の閉じるが同じ閉じ方になっていない');
});

test('押した結果の一言は足の一言に、設定モーダルと同じ作法（data-tone）で出す', () => {
  const code = todayCode();
  assert.match(fnBody(code, 'say'), /dom\.todayMsg\.dataset\.tone = text \? tone : ''/, '一言の色を data-tone で持っていない');
  const copy = fnBody(code, 'copy');
  assert.match(copy, /say\('コピーしました', 'good'\)/, 'コピーできたことを good で言っていない');
  assert.match(copy, /say\(`コピーできませんでした: \$\{err\.message\}`, 'bad'\)/, 'コピーできなかったことを bad で言っていない');
  assert.doesNotMatch(code.replace(fnBody(code, 'say'), ''), /todayMsg\.textContent =/, '一言を say を通さずに書いている（色が付け外しされない）');
  assert.match(tagIn(todayDialog(), 'today-msg'), /role="status"/, '一言が読み上げに乗らない');
});

/* ── 1本ずつ・数の帯・窓の高さ（D24・D25）──────────────────── */

test('1本ずつは横罫のまま（カードにしない）・数の帯は字だけ・窓の高さは固定のまま', () => {
  const ent = declsOf('.today-ent');
  assert.ok(ent.some((d) => d.prop === 'border-bottom'), '1本ずつの区切りの横罫が無い');
  const boxy = ent.filter((d) => /^(background|box-shadow|border-radius|border)$/.test(d.prop)).map((d) => `${d.prop}: ${d.value}`);
  assert.deepEqual(boxy, [], `1本ずつを箱で囲んでいる（カードにしない約束）:\n  ${boxy.join('\n  ')}`);
  // 押せない数の帯は面も枠も持たない
  for (const sel of ['.today-sum', '.today-stat', '.today-stat b']) {
    const bad = declsOf(sel).filter((d) => /^(background|box-shadow|border-radius|border(?!-bottom))/.test(d.prop)).map((d) => `${sel} { ${d.prop}: ${d.value} }`);
    assert.deepEqual(bad, [], `数の帯が面や枠を持っている（押せない札は字だけ）:\n  ${bad.join('\n  ')}`);
  }
  // 状態の点を付けない（窓口が alive しか持たない）
  assert.doesNotMatch(fnBody(todayCode(), 'entry'), /toneOf|colorOf|data-s|'state'/, '1本ずつに状態の点を付けている');
  // 高さは固定（日を替えるたびに中身の量が変わっても窓が上下に跳ねない）
  const win = declsOf('.today-win');
  assert.ok(win.some((d) => d.prop === 'height'), '窓の高さを固定していない');
  assert.ok(!win.some((d) => d.prop === 'max-height'), '窓の高さを max-height にしている（中身なりで跳ねる）');
});

/* ── 題を押して開く ─────────────────────────────────────── */

test('題を押したら、押した行を控えさせてから拡大の窓で開く（窓を閉じる → 選ぶ → 開く）', () => {
  // 前の日のセッションは24時間の一覧にも書庫の行にも居ない。行を渡さないと控え（store.pickedRow）が空で、
  // 詳細の届く前の組み直しで拡大の窓が畳まれていた（1回目だけ。2回目は詳細のキャッシュが効いて開く。実測）
  const body = fnBody(todayCode(), 'openButton');
  const close = body.indexOf('dom.today.close()');
  const sel = body.indexOf("select(row.sessionId, 'archive', row)");
  const open = body.indexOf('openZoom()');
  assert.ok(sel >= 0, "題が select(row.sessionId, 'archive', row) で選んでいない（押した行を控えさせていない）");
  // <dialog> を2枚重ねない（閉じたあと焦点がどちらへ戻るかが読めなくなる）。選ぶ前に開くと前のセッションが一瞬出る
  assert.ok(close >= 0 && close < sel && sel < open, '窓を閉じる → 選ぶ → 開くの順になっていない');
});
