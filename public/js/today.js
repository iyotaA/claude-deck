/**
 * 今日のまとめの窓（`<dialog id="today">`）。層7。
 *
 * その日に動いたセッションの「決めたこと」と「書き換えたファイル」を1枚に並べる。
 * 日報や引き継ぎの下書きに使う。**新しいモードは作らない** ―― 入口は書庫の頭のボタンと
 * Ctrl+K で、開くのは窓。見終わったら閉じて元の画面へ戻る。
 *
 * 中身は `/api/today` から**開いたときに1回だけ**引く（全文を読む重い窓口なので、毎秒は撃たない）。
 * Markdown の組み立てと、画面とコピーで共有する言い方は `today-md.js`（層0）に置く。
 *
 * セッションの題を押すと、窓を閉じて拡大モーダルで開く（書庫のカードと同じ開き方）。
 */
import { el } from './util.js';
import { icon } from './icons.js';
import { dom } from './dom.js';
import { getJson } from './api.js';
import { closeOnBackdrop } from './modal.js';
import { select } from './session.js';
import { openZoom } from './zoom.js';
import { TODAY_AGO_MAX_UI, decisionText, isQuiet, shortPath, spanText, todayMarkdown } from './today-md.js';

/** いま見ている日（何日前か） */
let ago = 0;
/** 届いた応答。コピーはこれから組む（画面の節点から拾い直さない） */
let data = null;
/** 引き直しが重なったとき、古い応答で上書きしないための番号 */
let seq = 0;

/**
 * 窓を開く。開くたびに引き直す（閉じているあいだに動いたぶんを拾う）。
 * 見る日は覚えたまま（きのうを見ていたら、次もきのうから）。
 */
export function openToday() {
  if (dom.today.open) return;
  dom.todayMsg.textContent = '';
  dom.today.showModal();
  load();
}

/** 引いて描く。失敗は窓の中に理由を出す（黙って空にしない） */
async function load() {
  const my = ++seq;
  dom.todayCopy.disabled = true;
  dom.todayBody.replaceChildren(el('p', 'today-empty', '読んでいます…'));
  try {
    const d = await getJson(`/api/today?ago=${ago}`);
    if (my !== seq) return;
    data = d;
    render();
  } catch (err) {
    if (my !== seq) return;
    data = null;
    dom.todayBody.replaceChildren(el('p', 'today-empty', `読めませんでした: ${err.message}`));
  }
}

/** 数の帯の1つ */
function stat(value, label) {
  const s = el('span', 'today-stat');
  s.append(el('b', null, value), document.createTextNode(label));
  return s;
}

/**
 * セッションの題。押すと窓を閉じて、拡大モーダルで開く。
 * @param {object} row
 * @param {string} cls
 */
function openButton(row, cls) {
  const b = el('button', cls, row.title ?? row.sessionId.slice(0, 8));
  b.type = 'button';
  b.title = row.title ?? row.sessionId;
  b.addEventListener('click', () => {
    // 閉じてから開く。<dialog> を2枚重ねると、閉じたあと焦点がどちらへ戻るかが読めなくなる
    dom.today.close();
    select(row.sessionId, 'archive');
    openZoom();
  });
  return b;
}

/** 1本ぶん。左に置き場所と時刻、右に題・決めたこと・書き換えたファイル */
function entry(row) {
  const li = el('li', 'today-ent');
  const tm = el('div', 'today-tm');
  tm.append(el('b', null, row.project), el('span', null, spanText(row)));
  if (row.alive) tm.append(el('span', 'today-alive', '動いている'));

  const body = el('div', 'today-main');
  body.append(openButton(row, 'today-title'));

  if (row.decisions.length || row.plansApproved) {
    body.append(el('span', 'today-k', '決めたこと'));
    const ul = el('ul', 'today-dec');
    for (const d of row.decisions) ul.append(el('li', null, decisionText(d)));
    if (row.decisionsOmitted) ul.append(el('li', 'is-more', `ほか ${row.decisionsOmitted} 件`));
    if (row.plansApproved) ul.append(el('li', null, `プランを ${row.plansApproved} 件承認`));
    body.append(ul);
  }
  if (row.files.length) {
    body.append(el('span', 'today-k', '書き換えたファイル'));
    const files = el('div', 'today-files');
    for (const f of row.files) {
      const c = el('code', null, shortPath(f.path, row.cwd));
      c.title = f.path;
      files.append(c);
    }
    if (row.filesOmitted) files.append(el('span', 'is-more', `ほか ${row.filesOmitted} 個`));
    body.append(files);
  }
  li.append(tm, body);
  return li;
}

/** 届いた応答を描く */
function render() {
  const t = data.totals;
  const nodes = [];

  const sum = el('div', 'today-sum');
  sum.append(
    stat(String(t.sessions), '動いたセッション'),
    stat(String(t.projects), '置き場所'),
    stat(String(t.decisions), '決めたこと'),
    stat(String(t.files), '書き換えたファイル'),
  );
  nodes.push(sum);

  // 切ったことは黙らない
  if (data.meta?.scanLimited) {
    nodes.push(el('p', 'today-note',
      `新しい ${data.meta.scanMax} 本だけを見ています（この日以降に書かれたログは ${data.meta.candidates} 本）`));
  }

  if (!data.rows.length) {
    nodes.push(el('p', 'today-empty', 'この日に動いたセッションはありません'));
  } else {
    const busy = data.rows.filter((r) => !isQuiet(r));
    const quiet = data.rows.filter(isQuiet);
    if (busy.length) {
      const ul = el('ul', 'today-list');
      for (const r of busy) ul.append(entry(r));
      nodes.push(ul);
    }
    // 決めたことも書き換えも無かったもの。動いた事実は消さないが、下に畳む
    if (quiet.length) {
      const det = el('details', 'today-quiet');
      det.append(el('summary', null, `そのほかに動いたもの ${quiet.length} 本（決めたことも書き換えたファイルも無し）`));
      const ul = el('ul', null);
      for (const r of quiet) {
        const li = el('li', null);
        li.append(el('span', 'today-q-tm', `${r.project}  ${spanText(r)}`), openButton(r, 'today-q-title'));
        ul.append(li);
      }
      det.append(ul);
      nodes.push(det);
    }
  }

  dom.todayBody.replaceChildren(...nodes);
  dom.todayCopy.disabled = !data.rows.length;
}

/** Markdown でコピー。手元のクリップボードに入れるだけで、外へは送らない */
async function copy() {
  if (!data) return;
  try {
    await navigator.clipboard.writeText(todayMarkdown(data));
    dom.todayMsg.textContent = 'コピーしました';
  } catch (err) {
    dom.todayMsg.textContent = `コピーできませんでした: ${err.message}`;
  }
}

/**
 * 見る日の選択肢。「きょう」「きのう」のあとは日付で出す（「3日前」だと曜日が分からない）。
 */
function fillAgo() {
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  for (let i = 0; i <= TODAY_AGO_MAX_UI; i += 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const date = `${d.getMonth() + 1}/${d.getDate()}（${days[d.getDay()]}）`;
    const label = i === 0 ? `きょう ${date}` : i === 1 ? `きのう ${date}` : date;
    const o = el('option', null, label);
    o.value = String(i);
    dom.todayAgo.append(o);
  }
}

/** 配線。main.js から1回だけ呼ぶ */
export function initToday() {
  fillAgo();
  dom.todayOpen.prepend(icon('doc', 14));
  dom.todayCopy.prepend(icon('copy', 14));
  dom.todayAgo.closest('.archive-field').prepend(icon('clock', 14));
  dom.todayOpen.addEventListener('click', openToday);
  dom.todayClose.addEventListener('click', () => dom.today.close());
  dom.todayCopy.addEventListener('click', copy);
  dom.todayAgo.addEventListener('change', () => {
    ago = Number(dom.todayAgo.value) || 0;
    dom.todayMsg.textContent = '';
    load();
  });
  closeOnBackdrop(dom.today);
}
