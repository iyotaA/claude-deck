/* 一覧の引き出し。
 *
 * 層2。store.js だけを見る。
 *
 * **窓の広さに関わらず引き出し。** 一覧を列から降ろしたので、広い窓でも
 * 出し入れする紙になった。以前は狭い窓だけの仕掛けで、広い窓では
 * 何もしないガード（NARROW.matches）が3か所に入っていた。
 * **そのガードを外し忘れると、広い窓で画面外のカードに Tab で入り込める。**
 *
 * ここが下のほうに居るのは、一覧のカード（list.js）と書庫のカード（archive.js）が
 * 押されたときに setListOpen(false) を呼ぶため。main.js に置くと
 * list.js -> main.js -> list.js の循環になって立ち上がらない。
 */
import { dom } from './store.js';

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
 * 一覧の引き出しを開閉する。
 *
 * 一覧は画面の手前に出てくる。開けっぱなしにする理由が無いので、選んだら自分で引っ込む。
 *
 * @param {boolean} open 開くなら true
 * @param {HTMLElement|null} moveFocusTo 閉じたあとに focus を移す先
 */
export function setListOpen(open, moveFocusTo = null) {
  const changed = dom.app.classList.contains('is-list-open') !== open;
  dom.app.classList.toggle('is-list-open', open);
  dom.listToggle.setAttribute('aria-expanded', String(open));
  dom.listToggle.setAttribute('aria-label', open ? 'セッション一覧を閉じる' : 'セッション一覧を開く');
  syncListInert();

  // 状態が動いていなければ焦点も動かさない（操作を横取りしない）
  if (!changed) return;

  if (open) {
    // 選ぶために開いたので、選べる場所へ移る
    const card = dom.list.querySelector('.card[aria-current="true"]') ?? dom.list.querySelector('.card');
    card?.focus();
  } else if (moveFocusTo) {
    moveFocusTo.focus();
  }
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
