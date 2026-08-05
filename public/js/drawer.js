/* 狭い画面の一覧（引き出し）。
 *
 * 層2。store.js だけを見る。
 *
 * ここが下のほうに居るのは、一覧のカード（list.js）と書庫のカード（archive.js）が
 * 押されたときに setListOpen(false) を呼ぶため。main.js に置くと
 * list.js -> main.js -> list.js の循環になって立ち上がらない。
 */
import { dom } from './store.js';

/** 引き出しに切り替わる幅。CSS のメディアクエリと同じ値にする */
export const NARROW = matchMedia('(max-width: 860px)');

/**
 * 引き出しが閉じているあいだ、一覧に触れないようにする。
 *
 * 閉じた引き出しは画面の外にあるだけで、消えてはいない。
 * このままだと見えていないカードに Tab で入り込めるので、inert で丸ごと外す。
 * CSS の visibility でも隠せるが、切り替わりが1フレームで確定せず、
 * 開いた直後に focus を移せなくなるため使わない。
 */
function syncListInert() {
  dom.listPane.inert = NARROW.matches && !dom.app.classList.contains('is-list-open');
}

/**
 * 一覧の引き出しを開閉する。
 *
 * 狭い画面では一覧が画面の手前に出てくる。開けっぱなしにする理由が無いので、
 * 選んだら自分で引っ込む。広い画面では一覧が常に見えているため何もしない。
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

  // 広い画面では引き出し自体が無い。focus を勝手に動かすと操作を横取りしてしまう
  if (!changed || !NARROW.matches) return;

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

  // 幅が変わったら、その幅に合う状態へ戻す。
  // 広い画面では一覧が常に見えているので、開いた状態も触れない状態も残さない
  NARROW.addEventListener('change', (ev) => {
    if (ev.matches) syncListInert();
    else setListOpen(false);
  });

  syncListInert();
}
