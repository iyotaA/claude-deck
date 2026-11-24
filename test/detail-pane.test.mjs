/**
 * 詳細ペイン（中央）の、字面で分かる約束。
 *
 * 画面刷新④（詳細と右）で決めたものを見張る。`detail.js` / `detail-wait.js` / `run-ask.js` は
 * DOM を触るので素の node では import できない。`navrail.test.mjs` / `groups.test.mjs` と
 * 同じく字面で見る。**崩れても画面を開くまで何のエラーも出ない**種類の約束なので。
 *
 * - 色の役（1色に役は1つ）。急ぎのパネル（`.panel.is-hot` / `.is-warn`）で色を持つのは
 *   見出しの字だけで、枠・光の輪・見出しの帯に状態色を敷かない。
 *   止まっている待ち（`.panel.is-block`）の左の太い線は太さだけ残して色を持たせない。
 *   許可要求カードの左の線・目的の左の線・メモの札も中立。メモは面を沈める
 * - 補足と重複をしまう。待ちのパネルの案内文（見出しと同じことを言う1行）と
 *   「Claude の最後の応答」の札が戻っていないこと。**中身は残す**
 *   （プランの保存先・許可要求が複数のときの「すべて答えるまで」）
 *
 * 字面はコメントを落としてから読む。このリポジトリは説明が厚く、
 * 「前は案内文があった」のような経緯がコメントに残るため。
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

/**
 * JS のコメントを落とした本文。落とし方は `navrail.test.mjs` / `groups.test.mjs` の `jsCode` と同じ
 * （行頭の `//` と `*`、行末の `//`）。
 */
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
 * `public/css/` の規則を全部、`{ file, selectors, decls }` の並びにする。
 *
 * 解析器は持たない。入れ子は `@media` の1段だけなので、`{` と `}` を含まない
 * 「セレクタ { 宣言 }」を拾えば中の規則も外の規則も取れる（`@media (…) {` の頭は
 * 宣言の側に `{` が来るので一致しない）。セレクタは空白を1つに均してから比べる。
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

/** 状態色とラベンダー。中立へ戻した場所に、どれも戻ってきてはいけない */
const TONE_RE = /var\(--(hot|warn|accent)\)/;

/* ── 色の役：急ぎのパネルで色を持つのは見出しの字だけ ─────────────── */

test('急ぎのパネル（.panel.is-hot / .is-warn）は字の色しか持たない。枠・光の輪・見出しの帯に色を敷かない', () => {
  // 前は枠と光の輪を --hot から混ぜ、見出しの帯にも薄く敷いていた。
  // 色は「あなたが何かすること」にだけ使う約束で、帯と枠まで塗ると1画面に赤い面が何重にもなる
  const bad = [];
  for (const r of cssRules()) {
    const hits = r.selectors.filter((s) => /\.panel\.is-(hot|warn)\b/.test(s));
    if (hits.length === 0) continue;
    for (const d of r.decls) {
      if (d.prop !== 'color') bad.push(`${r.file} … ${hits.join(', ')} { ${d.prop}: ${d.value} }`);
    }
  }
  assert.deepEqual(bad, [], `急ぎのパネルに字の色以外の指定がある:\n  ${bad.join('\n  ')}`);
});

test('急ぎのパネルの見出しの字は状態色のまま（止まっている＝--hot、うまくいっていない＝--warn）', () => {
  // 色を外しすぎない。見出しの字まで無彩色にすると、急ぎの印が太さだけになる
  const colorOf = (sel) => declsOf(sel).filter((d) => d.prop === 'color').map((d) => d.value);
  assert.deepEqual(colorOf('.panel.is-hot > h3'), ['var(--hot)']);
  assert.deepEqual(colorOf('.panel.is-warn > h3'), ['var(--warn)']);
});

test('止まっている待ち（.panel.is-block）は左の太い線（3px）を残し、線に色を持たせない', () => {
  const decls = declsOf('.panel.is-block');
  // 太さは色を見分けにくい人にも届く印なので残す
  assert.ok(
    decls.some((d) => /^border-left(-width)?$/.test(d.prop) && /\b3px\b/.test(d.value)),
    '.panel.is-block の左の線が 3px でなくなっている',
  );
  const toned = decls.filter((d) => TONE_RE.test(d.value)).map((d) => `${d.file} … ${d.prop}: ${d.value}`);
  assert.deepEqual(toned, [], `.panel.is-block に色が戻っている:\n  ${toned.join('\n  ')}`);
});

test('許可要求カード（.ask）・目的（.purpose）・メモの札（.detail-memo .k）に状態色もラベンダーも付けない', () => {
  // .ask の左の赤い線は、外の待ちのパネル（見出しが赤い）と同じことを言っていた。
  // 目的の左の線とメモの札のラベンダーは、押すもの・あなたの番・選んでいる場所のどれでもない
  const bad = [];
  for (const sel of ['.ask', '.purpose', '.detail-memo .k']) {
    for (const d of declsOf(sel)) {
      if (TONE_RE.test(d.value)) bad.push(`${d.file} … ${sel} { ${d.prop}: ${d.value} }`);
    }
  }
  assert.deepEqual(bad, [], `中立へ戻した線と札に色が戻っている:\n  ${bad.join('\n  ')}`);
});

test('メモは面を沈める（--bg-sunk）。押せないので枠は持たせない', () => {
  const decls = declsOf('.detail-memo');
  assert.ok(
    decls.some((d) => /^background(-color)?$/.test(d.prop) && d.value === 'var(--bg-sunk)'),
    '.detail-memo の面が --bg-sunk でない',
  );
  const borders = decls.filter((d) => /^border(-(top|right|bottom|left))?(-(width|color|style))?$/.test(d.prop));
  assert.deepEqual(borders.map((d) => `${d.prop}: ${d.value}`), [], '.detail-memo に枠がある（押せないものに枠を持たせない）');
});

/* ── 補足と重複をしまう：案内文と札が戻っていない ─────────────────── */

test('待ちのパネルの案内文と「Claude の最後の応答」の札が public/js に戻っていない', () => {
  // 案内文は見出し（「あなたの番 — 実行を許可する」など）と同じことを言う1行だった
  const WORDS = [
    [/guide\.lead\b/, 'guide.lead（待ち・許可要求の案内文を差す口）'],
    [/'選択肢を選ぶまで、この先へ進みません'/, '案内文「選択肢を選ぶまで、この先へ進みません」'],
    [/'この計画で進めてよいかを決めてください'/, '案内文「この計画で進めてよいかを決めてください」'],
    [/'このツールを実行してよいかを決めてください'/, '案内文「このツールを実行してよいかを決めてください」'],
    [/'Claude は応答を返し終えて止まっています'/, '案内文「Claude は応答を返し終えて止まっています」'],
    [/'Claude の最後の応答'/, '札「Claude の最後の応答」'],
  ];
  const bad = [];
  for (const file of jsFiles()) {
    const code = jsCode(read(file));
    const rel = path.relative(JS_DIR, file).replace(/\\/g, '/');
    for (const [re, label] of WORDS) {
      if (re.test(code)) bad.push(`${rel} … ${label}`);
    }
  }
  assert.deepEqual(bad, [], `消した案内文と札が残っている:\n  ${bad.join('\n  ')}`);
});

test('待ちの表（WAIT_GUIDE / ASK_GUIDE）が案内文（lead）を持たない', () => {
  // 使う口を消したのに表に文だけ残ると、次に触る人が「どこに出ているのか」を探すことになる
  const bad = ['detail-wait.js', 'run-ask.js']
    .filter((f) => /\blead\s*:/.test(jsCode(read(path.join(JS_DIR, f)))));
  assert.deepEqual(bad, [], `案内文（lead:）が表に残っている: ${bad.join(' / ')}`);
});

test('札ではなく中身のもの（プランの保存先・「すべて答えるまで」）は残っている', () => {
  // 保存先はパスそのものが中身。「すべて答えるまで」は要求が何件来ているかの情報
  assert.match(jsCode(read(path.join(JS_DIR, 'detail-wait.js'))), /'プランの保存先 '/);
  assert.match(jsCode(read(path.join(JS_DIR, 'run-ask.js'))), /すべて答えるまで/);
});

/* ── 置き場所：タブ帯は題の下で動かない ───────────────────────── */

/**
 * 関数1本の本体（`{` から対応する `}` まで）。コメントを落とした本文から切り出す。
 * 括弧を数えるだけなので、文字列の中に片方だけの `{` `}` があると狂う
 * （`detail.js` には無い。落ちたら「本体を切り出せない」で止まる）。
 *
 * @param {string} code コメントを落とした本文
 * @param {string} name 関数名
 * @returns {string}
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

const detailCode = () => jsCode(read(path.join(JS_DIR, 'detail.js')));

test('答えないと進まない待ちはタブ帯の直下（タブ帯より上に置かない）', () => {
  // タブ帯より上に置くと、待ちの高さ（Markdown は 24rem まで）でタブ帯が上下し、
  // 押す位置が毎回変わる。直下に置けば、どのタブを見ていても止まっていることは見える
  const body = fnBody(detailCode(), 'renderDetailInner');
  const bar = body.indexOf('wrap.append(tabBar(ctx))');
  const wait = body.search(/if \(row\.blocking === true\) \{[^}]*waitingBlock\(row, d\)/);
  const stack = body.indexOf('wrap.append(stack)');
  assert.ok(bar >= 0, 'renderDetailInner がタブ帯を積んでいない');
  assert.ok(wait >= 0, 'renderDetailInner が答えないと進まない待ち（row.blocking === true）を積んでいない');
  assert.ok(bar < wait, '答えないと進まない待ちがタブ帯より上に積まれている');
  assert.ok(wait < stack, '答えないと進まない待ちが選んだタブの中身より後ろに積まれている');
});

test('目的（summaryBlock）は「いま」タブの先頭。タブ帯より上に戻さない', () => {
  const code = detailCode();
  // 目的は長さがセッションごと・時刻ごとに違うので、タブ帯より上に置くとタブ帯が上下する
  assert.doesNotMatch(fnBody(code, 'renderDetailInner'), /summaryBlock\(/, '目的がタブ帯より上（renderDetailInner）で組まれている');
  const fill = fnBody(code, 'fillTab');
  const now = fill.slice(fill.indexOf('default:'));
  assert.ok(fill.indexOf('default:') >= 0, 'fillTab に「いま」の枝（default）が無い');
  const purpose = now.search(/summaryBlock\(/);
  assert.ok(purpose >= 0, '「いま」タブで目的を組んでいない');
  for (const later of ['waitingBlock(', 'RunView.runPanel(', 'RunResume.resumePanel(']) {
    const at = now.indexOf(later);
    assert.ok(at >= 0, `「いま」タブに ${later} が無い`);
    assert.ok(purpose < at, `目的が ${later} より後ろにある（先頭に置く）`);
  }
  // 組む場所は1つだけ（2か所で組むと、同じ目的が1画面に2回並ぶ）
  assert.equal(code.match(/summaryBlock\(/g).length, 1, 'summaryBlock を呼ぶ場所が1つでない');
});

test('待ちは両方に出さない（タブ帯の直下は blocking だけ、「いま」の中は blocking でないものだけ）', () => {
  const code = detailCode();
  assert.equal(code.match(/waitingBlock\(/g).length, 2, 'waitingBlock を呼ぶ場所が2つでない');
  // 「いま」の中は blocking でないもの（返信待ち）だけ。条件を外すと同じパネルが1画面に2枚並ぶ
  assert.match(fnBody(code, 'fillTab'), /if \(row\.blocking !== true\) add\(waitingBlock\(row, d\)\)/);
});

test('答えないと進まない待ちの高さの上限（24rem）は残す', () => {
  // どのタブでも出るので、長いプラン1本で選んだタブの中身が画面の外まで押し出される
  const decls = declsOf('.is-block .md');
  assert.ok(decls.some((d) => d.prop === 'max-height' && d.value === '24rem'), '.is-block .md の 24rem が無い');
});

/* ── 頭：2つの群と次の一手（段3） ──────────────────────────── */

test('消した頭の部品（題名の横の群 .detail-title・作業フォルダの全文 .path）が戻っていない', () => {
  const bad = [];
  for (const r of cssRules()) {
    for (const s of r.selectors) {
      if (/\.detail-title\b/.test(s)) bad.push(`${r.file} … ${s}`);
      if (/\.detail-sub \.path\b/.test(s)) bad.push(`${r.file} … ${s}`);
    }
  }
  const code = detailCode();
  if (/'detail-title'/.test(code)) bad.push("detail.js … el(…, 'detail-title')");
  if (/el\('span', 'path'/.test(code)) bad.push("detail.js … el('span', 'path', …)（頭に作業フォルダの全文）");
  assert.deepEqual(bad, [], `消した頭の部品が残っている:\n  ${bad.join('\n  ')}`);
});

test('次の一手の判断は next-step.js だけが持つ（頭を組む側は渡された結果を描くだけ）', () => {
  const head = jsCode(read(path.join(JS_DIR, 'detail-head.js')));
  // 前は detail-head.js が row.alive && row.pid を見て「ターミナルを前面に」を出していた
  assert.doesNotMatch(head, /row\.alive/, 'detail-head.js が生きているかを自分で見ている');
  assert.doesNotMatch(head, /'ターミナル/, 'detail-head.js が一手の名前を持っている（NEXT_STEPS の1か所に置く）');
  const code = detailCode();
  assert.equal((code.match(/nextStep\(/g) ?? []).length, 1, 'detail.js が nextStep を呼ぶ場所が1つでない');
  // パレットの「ターミナルを前面に」も同じ判断を通す（パレットは自分で決めない）
  const pal = jsCode(read(path.join(JS_DIR, 'palette.js')));
  assert.match(pal, /canFocusTerminal\(/, 'palette.js が canFocusTerminal を通していない');
  assert.doesNotMatch(pal, /cur\?\.alive && cur\.pid/, 'palette.js に前の判断（alive && pid）が残っている');
});

test('頭の右上の絵だけのボタン（☆・✎・数値・コピー）は名前（title と aria-label）と data-refocus を持つ', () => {
  // 頭は作り直されるので、名前で焦点を拾い直す。絵だけのボタンは名前を外さない
  const code = detailCode();
  for (const fn of ['pinButton', 'memoButton', 'inspButton']) {
    const body = fnBody(code, fn);
    assert.match(body, /dataset\.refocus = '/, `${fn} に data-refocus が無い`);
    assert.match(body, /\.title = /, `${fn} に title が無い`);
    assert.match(body, /setAttribute\('aria-label'/, `${fn} に aria-label が無い`);
  }
  const head = jsCode(read(path.join(JS_DIR, 'detail-head.js')));
  for (const name of ['copy', 'next']) {
    assert.match(head, new RegExp(`dataset\.refocus = '${name}'`), `detail-head.js の ${name} に data-refocus が無い`);
  }
  assert.match(head, /setAttribute\('aria-label', '再開コマンドをコピー'\)/, 'コピーに aria-label が無い');
});

test('押した結果の一言は節点ではなくモジュールに控える（作り直しで消えない）', () => {
  const head = jsCode(read(path.join(JS_DIR, 'detail-head.js')));
  assert.match(head, /let lastHint = /, '一言の控え（lastHint）が無い');
  assert.match(head, /lastHint\.sessionId === sessionId/, '組み直すときに控えを書き戻していない');
});

test('押した結果の一言は数秒で消える。別のセッションへ移ったら持ち越さない', () => {
  // 期限が無いと「コピーしました」が同じセッションの作り直しのたびに残り続ける
  const head = jsCode(read(path.join(JS_DIR, 'detail-head.js')));
  assert.match(head, /const HINT_MS = \d+;/, '一言の期限（HINT_MS）が無い');
  assert.match(fnBody(head, 'sayHint'), /setTimeout\(clearHint, HINT_MS\)/, '一言を期限で消していない');
  const body = fnBody(head, 'detailActions');
  assert.match(body, /lastHint\.sessionId !== sessionId\) clearHint\(\)/, '別のセッションへ移ったときに控えを消していない');
  // 返事が着いたときに別のセッションへ移っていたら控えない（戻ってきたときに他人の結果を出さない）
  assert.match(fnBody(head, 'sayHint'), /if \(hintSession !== sessionId\) return;/, '移ったあとに着いた返事を控えている');
});

test('メモは1行で切り、全文は title に入れる', () => {
  const decls = declsOf('.detail-memo');
  const has = (prop, value) => decls.some((d) => d.prop === prop && d.value === value);
  assert.ok(has('white-space', 'nowrap'), '.detail-memo が折り返す');
  assert.ok(has('text-overflow', 'ellipsis'), '.detail-memo に「…」が無い');
  assert.match(fnBody(detailCode(), 'renderHead'), /memo\.title = row\.memo/, 'メモの全文を title に入れていない');
  // 列が暗黙の auto だと、切らない字の長さまでペインが窓の外へ伸びる（実測。820px の窓で 900px）
  assert.ok(
    declsOf('.detail-pane').some((d) => d.prop === 'grid-template-columns' && d.value === 'minmax(0, 1fr)'),
    '.detail-pane の列が minmax(0, 1fr) に固定されていない（1行で切ったメモでペインが伸びる）',
  );
});

test('置き場所の札は押せないので枠も面も持たない。作業フォルダの全文は右の診断にある', () => {
  const bad = declsOf('.detail-sub .place')
    .filter((d) => /^(border|background|box-shadow)/.test(d.prop))
    .map((d) => `${d.prop}: ${d.value}`);
  assert.deepEqual(bad, [], `.detail-sub .place に枠か面がある: ${bad.join(' / ')}`);
  const panels = jsCode(read(path.join(JS_DIR, 'detail-panels.js')));
  assert.match(fnBody(panels, 'basicsPanel'), /fact\(setup, '作業フォルダ', row\.cwd\)/, '診断に作業フォルダが無い');
});

/* ── 右の紙：レールをやめて頭の絵から開く（段4） ─────────────────── */

const indexHtml = () => read(path.join(REPO, 'public', 'index.html')).replace(/<!--[\s\S]*?-->/g, '');

test('右のレール（#rail）が index.html・public/js・public/css に戻っていない', () => {
  const bad = [];
  const html = indexHtml();
  if (/id="rail"/.test(html)) bad.push('index.html … id="rail"');
  if (/class="rail"/.test(html)) bad.push('index.html … class="rail"');
  for (const file of jsFiles()) {
    const code = jsCode(read(file));
    const rel = path.relative(JS_DIR, file).replace(/\\/g, '/');
    for (const [re, label] of [
      [/dom\.rail\b/, 'dom.rail'],
      [/getElementById\('rail'\)/, "getElementById('rail')"],
      [/rail-btn/, '.rail-btn'],
      [/syncRail\b/, 'syncRail'],
    ]) {
      if (re.test(code)) bad.push(`${rel} … ${label}`);
    }
  }
  for (const r of cssRules()) {
    for (const s of r.selectors) {
      if (/(^|[\s,>+~])\.rail(-btn)?\b/.test(s)) bad.push(`${r.file} … ${s}`);
    }
  }
  assert.deepEqual(bad, [], `消した右のレールが残っている:\n  ${bad.join('\n  ')}`);
});

test('右の紙を開く口は頭の「数値」の絵（トグル）。紙の頭に数値｜診断の切り替えと × がある', () => {
  const body = fnBody(detailCode(), 'inspButton');
  assert.match(body, /toggleInspector\(\)/, '頭の数値の絵が toggleInspector を呼んでいない');
  assert.match(body, /aria-pressed/, '頭の数値の絵が開閉を aria-pressed で示していない');
  const html = indexHtml();
  const head = html.match(/<div class="insp-head">([\s\S]*?)<\/div>\s*<div class="insp-body"/);
  assert.ok(head, 'index.html に .insp-head が無い');
  assert.match(head[1], /id="insp-tabs"/, '紙の頭に数値｜診断の切り替え（#insp-tabs）が無い');
  assert.match(head[1], /role="group"/, '切り替えに role="group" が無い');
  assert.match(head[1], /id="insp-close"/, '紙の頭に × が無い');
});

test('右の紙の定義（INSP_DEFS）は使う所の無い絵を持たない。頭の絵は inspButton が持つ', () => {
  // 絵を使うのは開く口（頭の絵1つ）だけ。紙ごとに絵を持つと、使わない値が定義に残る
  const code = detailCode();
  const defs = code.match(/export const INSP_DEFS = \[([\s\S]*?)\];/);
  assert.ok(defs, 'detail.js に INSP_DEFS が無い');
  assert.doesNotMatch(defs[1], /\bicon:/, 'INSP_DEFS に使う所の無い icon が残っている');
  assert.match(fnBody(code, 'inspButton'), /icon\('chart', 16\)/, '頭の数値の絵が inspButton に無い');
});

test('右の紙の開閉は localStorage に覚える。鍵は store.js の LS に置く', () => {
  const store = jsCode(read(path.join(JS_DIR, 'store.js')));
  const ls = store.match(/export const LS = Object\.freeze\(\{([\s\S]*?)\}\)/);
  assert.ok(ls, 'store.js に LS が無い');
  assert.match(ls[1], /inspOpen: 'claude-deck\.inspOpen'/, 'LS に右の紙の開閉の鍵（inspOpen）が無い');
  // 初めの判断は純関数（insp-open.js）を通す。URL・覚えた値・窓の広さの3つを渡す
  assert.match(store, /initialInspector\(\{/, 'store.js が initialInspector を通していない');
  assert.match(detailCode(), /localStorage\.setItem\(LS\.inspOpen/, 'detail.js が開閉を覚えていない');
});

test('.deck の列は一覧 × 右の紙の4通りで、子の数と釣り合う（閉じて2列・紙を開いて3列）', () => {
  const cols = (sel) => declsOf(sel)
    .filter((d) => d.prop === 'grid-template-columns' && d.file === 'base.css')
    .map((d) => d.value);
  const tracks = (v) => v.replace(/\([^)]*\)/g, '()').trim().split(/\s+/).length;
  const cases = [['.deck', 2], ['.is-list-open .deck', 2], ['.is-insp-open .deck', 3], ['.is-list-open.is-insp-open .deck', 3]];
  for (const [sel, n] of cases) {
    const [v] = cols(sel);
    assert.ok(v, `${sel} の列が base.css に無い`);
    assert.equal(tracks(v), n, `${sel} の列が ${n} 本でない（${v}）`);
    // 右のレールの列（末尾の auto）が戻っていない
    assert.doesNotMatch(v, /\bauto$/, `${sel} の末尾に右のレールの列（auto）が残っている`);
  }
});

/* ── 右の紙の中身：無彩色・差に色なし・説明文の置き場所（段5） ───────── */

const panelCode = () => jsCode(read(path.join(JS_DIR, 'usage-panel.js')));
const chartCode = () => jsCode(read(path.join(JS_DIR, 'usage-chart.js')));

/** 色の付いたトークン。右の紙のグラフに戻ってきてはいけない */
const HUE_RE = /var\(--(accent|hot|warn|done|calm|off)\)/;

/** グラフの強調の色を受ける変数。部品は既定（ラベンダー）付きで受け、右の紙だけが宣言する */
const CHART_HI = 'var(--chart-hi, var(--accent))';

test('右の紙のグラフ（横棒の1位・スパークライン）は無彩色。.insp は変数を宣言するだけ', () => {
  // 色の出どころを1か所にする。部品の側で .insp を名指しして塗り直さない
  const hi = declsOf('.insp').filter((d) => d.prop === '--chart-hi');
  assert.equal(hi.length, 1, '.insp が --chart-hi を1つ宣言していない');
  assert.doesNotMatch(hi[0].value, HUE_RE, `.insp の --chart-hi に色が付いている（${hi[0].value}）`);
  const bad = [];
  for (const r of cssRules()) {
    for (const s of r.selectors) {
      if (!/^\.insp .*\.(bar-fill|spark-area|spark-line)$/.test(s)) continue;
      for (const d of r.decls) {
        if (['background', 'fill', 'stroke'].includes(d.prop)) bad.push(`${r.file} … ${s} { ${d.prop}: ${d.value} }`);
      }
    }
  }
  assert.deepEqual(bad, [], `右の紙のグラフを .insp の詳細度で塗り直している（色の出どころが2か所になる）:\n  ${bad.join('\n  ')}`);
});

test('数値モード（横断）のグラフの色は触らない（変数が無ければラベンダー。宣言するのは .insp だけ）', () => {
  // ⑤で「バランスがいい」と言われた画面。部品は既定付きで受けるので、変数を宣言しない横断はそのまま
  const fill = declsOf('.bar.is-top .bar-fill').filter((d) => d.file === 'usage.css' && d.prop === 'background');
  assert.deepEqual(fill.map((d) => d.value), [CHART_HI], '素の .bar.is-top .bar-fill が変数（既定はラベンダー）で受けていない');
  const area = declsOf('.spark-area').filter((d) => d.file === 'usage.css' && d.prop === 'fill');
  assert.deepEqual(area.map((d) => d.value), [CHART_HI], '素の .spark-area が変数（既定はラベンダー）で受けていない');
  const line = declsOf('.spark-line').filter((d) => d.file === 'usage.css' && d.prop === 'stroke');
  assert.deepEqual(line.map((d) => d.value), [CHART_HI], '素の .spark-line が変数（既定はラベンダー）で受けていない');
  const declared = cssRules()
    .filter((r) => r.decls.some((d) => d.prop === '--chart-hi'))
    .map((r) => `${r.file} … ${r.selectors.join(', ')}`);
  assert.deepEqual(declared, ['usage.css … .insp'], `--chart-hi を .insp 以外でも宣言している:\n  ${declared.join('\n  ')}`);
});

test('右の紙の横棒の名前は1行で「…」で切り、全文は title に入れる（1字ずつ折らない）', () => {
  // 紙は狭く、長いツール名（mcp__…）が1字ずつ縦に伸びていた
  const d = declsOf('.insp .bar-label');
  const has = (prop, value) => d.some((x) => x.prop === prop && x.value === value);
  assert.ok(has('white-space', 'nowrap'), '.insp .bar-label が折り返す');
  assert.ok(has('overflow', 'hidden'), '.insp .bar-label が溢れを隠していない（「…」が出ない）');
  assert.ok(has('text-overflow', 'ellipsis'), '.insp .bar-label に「…」が無い');
  // 数値モード（横断）の素の指定はそのまま（全幅では折り返しで足りる）
  assert.ok(
    declsOf('.bar-label').some((x) => x.file === 'usage.css' && x.prop === 'overflow-wrap' && x.value === 'anywhere'),
    '素の .bar-label の折り返しが変わっている（数値モードの見た目が変わる）',
  );
  const code = chartCode();
  assert.match(fnBody(code, 'barLabel'), /\.title = /, '名前の全文を title に入れていない');
  for (const fn of ['barList', 'shareBar', 'trendList']) {
    assert.match(fnBody(code, fn), /barLabel\(/, `${fn} が barLabel を通していない`);
  }
  assert.doesNotMatch(code.replace(fnBody(code, 'barLabel'), ''), /el\('span', 'bar-label'/, 'barLabel を通さずに名前を組んでいる所がある');
});

test('差（増減）に色を付けない', () => {
  // 実消費が多いのは、単に長く働いた日かもしれない。良し悪しを決めるのは読む人
  const bad = [];
  for (const r of cssRules()) {
    if (!r.selectors.some((s) => /\.stat-delta\b/.test(s))) continue;
    for (const d of r.decls) {
      if (HUE_RE.test(d.value)) bad.push(`${r.file} … ${r.selectors.join(', ')} { ${d.prop}: ${d.value} }`);
    }
  }
  assert.deepEqual(bad, [], `差に色が付いている:\n  ${bad.join('\n  ')}`);
  assert.doesNotMatch(chartCode(), /stat-delta (is-|up|down|good|bad)/, '差に良し悪しのクラスを付けている');
});

test('誤読を防ぐ注記は右の紙に字のまま残っている（吹き出しへ移さない）', () => {
  const p = panelCode();
  const KEEP = [
    [/帰属は原因ではありません/, '因果の注記（スキル）'],
    [/中央値との比較です/, '差が何との比較か（中央値の注記）'],
    [/足し合わせない値です/, '文脈保有量は足し合わせない'],
    [/ツール以外（あなたの発言など）/, '帰属できなかったぶん（ツール以外）'],
    [/測れなかった回/, '帰属できなかったぶん（測れなかった回）'],
    [/この分は入っていません/, 'サブエージェントは上の実消費に入っていない'],
    [/サブエージェントの消費に占めるぶんです/, 'サブエージェントの割合の分母'],
    [/実際の消費はこれより多いです/, '頭だけ読んだ記録（過少）'],
    [/金額ではありません/, '実消費は金額ではない'],
  ];
  const lost = KEEP.filter(([re]) => !re.test(p)).map(([, label]) => label);
  assert.deepEqual(lost, [], `誤読を防ぐ注記が消えている: ${lost.join(' / ')}`);
  assert.match(chartCode(), /モデルまたぎでは比べられません/, '命中率のモデルの注記が消えている');
  // 但し書きの札（.stat-note）は常に出す
  assert.doesNotMatch(cssCode(read(path.join(CSS_DIR, 'usage.css'))), /\.stat-note[^{]*\{[^}]*display:\s*none/);
});

test('読み方の説明（ツールの節・内訳の節）は見出しの吹き出しへ移す。注記の段には置かない', () => {
  const p = panelCode();
  const tools = p.slice(p.indexOf('toolsBlockOf(usage.tools'));
  assert.match(tools.slice(0, 400), /tip:/, 'ツールの節の説明が見出しの吹き出し（tip）に渡っていない');
  assert.doesNotMatch(tools.slice(0, 400), /\bnote:/, 'ツールの節の説明が注記（note）のまま');
  assert.match(fnBody(p, 'iteBlock'), /block\('実消費の内訳', \{ tip:/, '内訳の説明が見出しの吹き出しに無い');
});

test('見出しの吹き出しはキーボードでも読める（押せる印・名前・焦点で出る吹き出し。title と二重にしない）', () => {
  const body = fnBody(chartCode(), 'block');
  assert.match(body, /el\('button'/, '吹き出しの印が押せる要素（button）でない');
  assert.match(body, /aria-label/, '吹き出しの印に名前（aria-label）が無い');
  assert.match(body, /dataset\.tip = /, '吹き出しの中身（data-tip）が無い');
  assert.doesNotMatch(body, /\.title = /, 'title も付けている（OS の札と吹き出しが二重に出る）');
  const shown = cssRules().some((r) => r.selectors.some((s) => /\.tip-mark:focus-visible::after/.test(s)));
  assert.ok(shown, '吹き出しが焦点（:focus-visible）で出ない');
});

test('吹き出しの見た目（枠・面・影・字）は左のレールと見出しの印で1か所に書く', () => {
  // 位置・出し入れ・折り返し・余白は目的が違う（レールは横へ1行、印は下へ折り返す）ので別のまま
  const VISUAL = ['border', 'border-radius', 'background', 'box-shadow', 'color', 'font-size', 'font-weight', 'text-align'];
  const TIP_RE = /(\.navrail-item\[data-tip\]|\.navrail-rate\[data-tip\]|\.tip-mark)::after$/;
  const rules = cssRules().filter((r) => r.selectors.some((s) => TIP_RE.test(s)));
  const shared = rules.filter((r) => ['.navrail-item[data-tip]::after', '.navrail-rate[data-tip]::after', '.tip-mark::after']
    .every((s) => r.selectors.includes(s)));
  assert.equal(shared.length, 1, '吹き出しの見た目をまとめた規則が1つでない');
  const missing = VISUAL.filter((p) => !shared[0].decls.some((d) => d.prop === p));
  assert.deepEqual(missing, [], `まとめた規則に見た目の宣言が足りない: ${missing.join(', ')}`);
  const dup = rules
    .filter((r) => r !== shared[0])
    .flatMap((r) => r.decls.filter((d) => VISUAL.includes(d.prop)).map((d) => `${r.file} … ${r.selectors.join(', ')} { ${d.prop} }`));
  assert.deepEqual(dup, [], `吹き出しの見た目を2か所に書いている:\n  ${dup.join('\n  ')}`);
});

test('紙の題と重なるパネルの見出し（数値・診断）を右の紙に出さない', () => {
  // 紙の頭に「数値｜診断」の切り替えと題があるので、中に同じ名前の見出しを重ねない
  assert.doesNotMatch(fnBody(panelCode(), 'usagePanel'), /panel\('数値'/, '数値のパネルの見出しが残っている');
  const panels = jsCode(read(path.join(JS_DIR, 'detail-panels.js')));
  assert.doesNotMatch(fnBody(panels, 'basicsPanel'), /panel\('診断'/, '診断のパネルの見出しが残っている');
});
