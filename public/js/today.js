/**
 * 今日のまとめの窓（`<dialog id="today">`）。層7。
 *
 * その日に動いたセッションの「決めたこと」と「書き換えたファイル」を1枚に並べる。
 * 日報や引き継ぎの下書きに使う。**新しいモードは作らない** ―― 入口は左のレール・書庫の頭のボタン・
 * Ctrl+K の3つで、開くのは窓。見終わったら閉じて元の画面へ戻る。
 *
 * 中身は `/api/today` から**開いたときに1回だけ**引く（全文を読む重い窓口なので、毎秒は撃たない）。
 * 日を替えたら引き直す。**日を替える口は3つ（日の選択・前の日・次の日）あるが、通る道は `setAgo` の1本**
 * （丸め・選択の値・題・矢印の押せる押せない・一言の消去・引き直しを1か所でやる）。
 * Markdown の組み立てと、画面とコピーで共有する言い方、どの日を見るかの判断（範囲・日の言い方・
 * 矢印の行き先）は `today-md.js`（層0）に置く。
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
import {
  TODAY_AGO_MAX_UI, agoDate, agoLabel, agoSteps, clampAgo,
  decisionText, isQuiet, shortPath, spanText, todayMarkdown,
} from './today-md.js';

/** いま見ている日（何日前か） */
let ago = 0;
/** 届いた応答。コピーはこれから組む（画面の節点から拾い直さない） */
let data = null;
/** 引き直しが重なったとき、古い応答で上書きしないための番号 */
let seq = 0;

/**
 * 足の1行に一言出す（設定モーダル・起こすフォームの `say` と同じ作法）。
 * 色は `.settings-msg[data-tone]` が持つ（済んだ = good・できなかった = bad）。空で消える。
 *
 * @param {string} text
 * @param {''|'good'|'bad'} [tone]
 */
function say(text, tone = '') {
  dom.todayMsg.textContent = text;
  dom.todayMsg.dataset.tone = text ? tone : '';
}

/**
 * 窓を開く。開くたびに引き直す（閉じているあいだに動いたぶんを拾う）。
 * 見る日は覚えたまま（きのうを見ていたら、次もきのうから）。
 *
 * **日の選択肢も開くたびに組み直す。** 常駐していると、起動した日に組んだ「きょう 11/24」が
 * 次の日も残り、題（開くたびにその日の日付で組む）と選択肢の日付が食い違う。
 */
export function openToday() {
  if (dom.today.open) return;
  fillAgo();
  dom.today.showModal();
  setAgo(ago);
}

/**
 * 見る日を替える。**日を替える口（日の選択・前の日・次の日・開いたとき）はすべてここを通る。**
 * 口ごとに別の道を持つと、矢印だけ選択の値を書き忘れる・題が古いまま、のような食い違いが起きる。
 *
 * @param {unknown} next 何日前か（範囲の外と数でないものは `clampAgo` が丸める）
 */
function setAgo(next) {
  ago = clampAgo(next);
  dom.todayAgo.value = String(ago);
  renderHead();
  say('');
  load();
}

/**
 * 頭の題と矢印を、いま見ている日に合わせる。
 *
 * **端の矢印は隠さずに押せなくする（disabled）。** 隠すと日の選択と × の位置が端に来るたびに横へずれ、
 * 続けて押していた手元の下へ別のボタンが来る。拡大の窓の「← 前／次の待ち →」も、
 * 押す先が無いときは消さずに押せなくしている（`zoom.js` の `syncZoomWaits`）。
 * 押せないことは形で見せる（薄くし、触れても面を出さない。`base.css` の `.ibtn[disabled]`）。
 * 「押せない顔のボタンを出さない」の約束は、押しても何も起きないのに押せる顔をしているもの
 * （詳細の頭の次の一手）の話で、押せないと見えているボタンはそれに当たらない
 */
function renderHead() {
  dom.todayDay.textContent = agoDate(ago, Date.now());
  const steps = agoSteps(ago);
  dom.todayPrev.disabled = steps.prev === null;
  dom.todayNext.disabled = steps.next === null;
}

/**
 * 前後の矢印を押した。行き先は `agoSteps` が決める（端なら null で何もしない）。
 *
 * **端に着いて押せなくなったら、焦点を反対の矢印へ渡す。** 押した矢印が disabled になると焦点が外れ、
 * キーボードで続けて押していた人の焦点が窓の外（body）へ落ちる。
 *
 * @param {'prev'|'next'} dir
 */
function step(dir) {
  const target = agoSteps(ago)[dir];
  if (target === null) return;
  const btn = dir === 'prev' ? dom.todayPrev : dom.todayNext;
  const held = document.activeElement === btn;
  setAgo(target);
  if (held && btn.disabled) (dir === 'prev' ? dom.todayNext : dom.todayPrev).focus();
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

/**
 * Markdown でコピー。手元のクリップボードに入れるだけで、外へは送らない。
 * 結果は足の一言（押したボタンのすぐ左）に出す。日を替えるか開き直すまで残す
 * （窓の足の一言は、設定モーダル・起こすフォームと同じく次の操作まで残す作法）
 */
async function copy() {
  if (!data) return;
  try {
    await navigator.clipboard.writeText(todayMarkdown(data));
    say('コピーしました', 'good');
  } catch (err) {
    say(`コピーできませんでした: ${err.message}`, 'bad');
  }
}

/**
 * 見る日の選択肢。「きょう」「きのう」のあとは日付で出す（「3日前」だと曜日が分からない）。
 * 言い方は窓の題と同じ `agoLabel` / `agoDate`（`today-md.js`）から。開くたびに組み直す（`openToday`）
 */
function fillAgo() {
  const now = Date.now();
  const opts = [];
  for (let i = 0; i <= TODAY_AGO_MAX_UI; i += 1) {
    const o = el('option', null, agoLabel(i, now));
    o.value = String(i);
    opts.push(o);
  }
  dom.todayAgo.replaceChildren(...opts);
  dom.todayAgo.value = String(ago);
}

/** 配線。main.js から1回だけ呼ぶ */
export function initToday() {
  fillAgo();
  // 書庫の頭の入口。**レールの札と同じ絵（today）にする**（同じことをする口なので、
  // 別の形にすると覚え直しになる）。レールの札の絵は main.js が他の札とまとめて差す
  dom.archiveToday.prepend(icon('today', 14));
  dom.todayCopy.prepend(icon('copy', 14));
  dom.todayAgo.closest('.archive-field').prepend(icon('clock', 14));
  // 前後の矢印。**絵を新しく作らない** … 右向きの chevron（起こすフォームの畳み・終了の開け閉めと同じ形）を
  // そのまま「次の日」に、CSS で裏返して「前の日」に使う（`.today-step.is-prev .icon`）
  dom.todayPrev.append(icon('chevron'));
  dom.todayNext.append(icon('chevron'));
  // 入口は2つ（左のレール・書庫の頭）。どちらも同じ窓を開く
  for (const btn of [dom.todayOpen, dom.archiveToday]) btn.addEventListener('click', openToday);
  // 閉じる口は頭の × と足の「閉じる」（手本のモックと同じ。足の並びで「閉じる」と「コピー」を選べる）
  for (const btn of [dom.todayClose, dom.todayCloseFoot]) btn.addEventListener('click', () => dom.today.close());
  dom.todayCopy.addEventListener('click', copy);
  // 日を替える口は3つ。どれも setAgo の1本を通る
  dom.todayAgo.addEventListener('change', () => setAgo(dom.todayAgo.value));
  dom.todayPrev.addEventListener('click', () => step('prev'));
  dom.todayNext.addEventListener('click', () => step('next'));
  closeOnBackdrop(dom.today);
}
