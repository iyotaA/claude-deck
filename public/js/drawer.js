/* 一覧の開閉。
 *
 * 層2。store.js だけを見る。
 *
 * **広い窓では列を畳む。狭い窓では手前に重なる引き出し。**
 * 姿は CSS が決める（base.css の grid と narrow.css の position: fixed）。
 * ここが持つのは開いているかどうかの1つだけで、窓の広さは見ない。
 * 以前は広い窓で何もしないガード（NARROW.matches）が3か所に入っていて、
 * **外し忘れると画面外のカードに Tab で入り込めた。**
 *
 * ここが下のほうに居るのは、一覧のカード（list.js）と書庫のカード（archive.js）が
 * 押されたときに setListOpen(false) を呼ぶため。main.js に置くと
 * list.js -> main.js -> list.js の循環になって立ち上がらない。
 */
import { dom } from './store.js';

/** 開閉を覚えておく鍵。「見たいときだけ開く」運用なので、次に開いたときも同じ形にする */
const LIST_OPEN_KEY = 'claude-deck.listOpen';

/**
 * 手前に重なる形か。CSS のメディアクエリと同じ値にする。
 *
 * ここで見たいのは窓の広さそのものではなく「一覧が中央を覆っているか」。
 * 覆っていれば選んだあとに畳む必要があり、列なら畳む必要が無い
 */
const overlaps = () => matchMedia('(max-width: 860px)').matches;

/**
 * 引き出しが閉じているあいだ、一覧に触れないようにする。
 *
 * 閉じた引き出しは画面の外にあるだけで、消えてはいない。
 * このままだと見えていないカードに Tab で入り込めるので、inert で丸ごと外す。
 * CSS の visibility でも隠せるが、切り替わりが1フレームで確定せず、
 * 開いた直後に focus を移せなくなるため使わない。
 *
 * **窓の広さを見ない。** 広い窓でも閉じた引き出しは画面の外にある
 */
function syncListInert() {
  dom.listPane.inert = !dom.app.classList.contains('is-list-open');
}

/**
 * 一覧を開閉する。
 *
 * 広い窓では列が伸び縮みし、狭い窓では手前に重なる紙が出入りする。
 * どちらも目印は .is-list-open ひとつで、姿の違いは CSS が持つ。
 *
 * @param {boolean} open 開くなら true
 * @param {HTMLElement|null} moveFocusTo 閉じたあとに focus を移す先
 * @param {boolean} [remember] 開閉を覚えるか。人が押したときだけ true
 */
export function setListOpen(open, moveFocusTo = null, remember = true) {
  const changed = dom.app.classList.contains('is-list-open') !== open;
  dom.app.classList.toggle('is-list-open', open);
  dom.listToggle.setAttribute('aria-expanded', String(open));
  dom.listToggle.setAttribute('aria-label', open ? 'セッション一覧を閉じる' : 'セッション一覧を開く');
  syncListInert();

  if (remember) localStorage.setItem(LIST_OPEN_KEY, open ? '1' : '0');

  // 状態が動いていなければ焦点も動かさない（操作を横取りしない）
  if (!changed) return;

  // **焦点を移すのは重なっているときだけ。** あちらは一覧が中央を覆うので、
  // 開いた先で選ばないと話が進まない。列なら中央も生きているから、
  // 焦点を奪うと「見たかっただけ」の人の操作を横取りすることになる
  if (!overlaps()) return;

  if (open) {
    const card = dom.list.querySelector('.card[aria-current="true"]') ?? dom.list.querySelector('.card');
    card?.focus();
  } else if (moveFocusTo) {
    moveFocusTo.focus();
  }
}

/**
 * セッションを選んだあとの後始末。
 *
 * **重なっているときだけ畳む。** 狭い窓の一覧は中央を覆っているので、
 * 選んだらどく必要がある。広い窓は列なので**畳まない** ―― 見比べながら
 * 次を選ぶことがあるし、畳むと開けておいた意味が無くなる。
 *
 * 覚えない（remember: false）。ここで閉じたのは人が畳んだのではなく、
 * 覆っていたものがどいただけなので、次に開いたときの形に持ち越さない
 *
 * @param {HTMLElement|null} moveFocusTo 畳んだあとに focus を移す先
 */
export function closeListAfterPick(moveFocusTo = null) {
  if (!overlaps()) return;
  setListOpen(false, moveFocusTo, false);
}

/**
 * 覚えている開閉を返す。
 *
 * 既定は開く。前の形（常設の列）と同じ見え方で始めるほうが、
 * 更新して初めて開いた人が戸惑わない
 */
export function initialListOpen() {
  return localStorage.getItem(LIST_OPEN_KEY) !== '0';
}

export function initListDrawer() {
  dom.listToggle.addEventListener('click', () => {
    const open = !dom.app.classList.contains('is-list-open');
    setListOpen(open, dom.listToggle);
  });

  dom.listClose.addEventListener('click', () => setListOpen(false, dom.listToggle));
  dom.scrim.addEventListener('click', () => setListOpen(false, dom.listToggle));

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !dom.app.classList.contains('is-list-open')) return;
    ev.preventDefault();
    setListOpen(false, dom.listToggle);
  });

  // 窓の広さで形が変わらなくなったので、幅の変化を見張る必要が無くなった。
  // （前は広くなった時点で setListOpen(false) して列へ戻していた）

  syncListInert();
}
