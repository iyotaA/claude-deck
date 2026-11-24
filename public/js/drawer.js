/* 一覧の開閉。
 *
 * 層2。dom.js だけを見る。
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
import { dom } from './dom.js';

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
  // 開閉の口は作業台の左上の1つだけ（広い窓でも狭い窓でも同じボタン。開いても閉じても同じ位置）。
  // **旗を2つ持たない** ―― 正は .app のクラス1つで、ここは名前と aria-expanded を合わせるだけ。
  // 絵だけのボタンなので、名前は aria-label と title の両方に入れる（触れば名前が出る）
  const name = open ? 'セッション一覧を閉じる' : 'セッション一覧を開く';
  dom.listToggle.setAttribute('aria-expanded', String(open));
  dom.listToggle.setAttribute('aria-label', name);
  dom.listToggle.title = name;
  syncListInert();

  if (remember) localStorage.setItem(LIST_OPEN_KEY, open ? '1' : '0');

  // 状態が動いていなければ焦点も動かさない（操作を横取りしない）
  if (!changed) return;

  // **焦点を移すのは重なっているときだけ。** あちらは一覧が中央を覆うので、
  // 開いた先で選ばないと話が進まない。列なら中央も生きているから、
  // 焦点を奪うと「見たかっただけ」の人の操作を横取りすることになる
  if (!overlaps()) return;

  if (open) {
    // 稼働中の一覧は圧縮した行（`.row`）。**`.card` だけ見ていると何も掴めない**
    // （書庫はカードのままなので、両方を拾う形にしてある）
    const card = dom.list.querySelector('.card[aria-current="true"], .row[aria-current="true"]')
      ?? dom.list.querySelector('.card, .row');
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

/**
 * 一覧の引き出しを配線する。作業台の左上の開閉・引き出しの中の ×・Esc・外側の押下。
 *
 * **開閉の口は作業台の左上の `#list-toggle` 1つ。** 広い窓でも狭い窓でも同じボタンで、
 * 開いても閉じても画面の上の位置は変わらない（`.deck` の左上に絶対配置。base.css）。
 * `#list-pane` の外に置いてあるのは、閉じると一覧が幅 0 と inert になって中のものを押せなくなるため。
 * 押したボタンは作り直さないので、焦点はボタンに残る。
 * 一覧の無い書庫と数値のあいだは CSS（base.css）が隠す。
 * 前は上のバーの左端に居て、作業台のときだけそこに出るのが浮いていた（ユーザーの声）。
 * さらに前は広い窓だけ作業台の左端の細い帯にもう1つ組んでいて、同じことをする口が2つあった。
 *
 * **窓の広さは見張らない。** 広さで形が変わらなくなったので要らなくなった
 * （前は広くなった時点で `setListOpen(false)` して列へ戻していた）。
 */
export function initListDrawer() {
  dom.listToggle.addEventListener('click', () => {
    const open = !dom.app.classList.contains('is-list-open');
    setListOpen(open, dom.listToggle);
  });

  dom.listClose.addEventListener('click', () => setListOpen(false, dom.listToggle));
  dom.scrim.addEventListener('click', () => setListOpen(false, dom.listToggle));

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !dom.app.classList.contains('is-list-open')) return;
    // モーダルが開いているあいだの Esc は横取りしない。
    // `<dialog>` の Esc は cancel で処理されるが keydown は document までバブルするので、
    // 見ないと**モーダルを閉じただけで一覧まで畳まれる**。しかも remember が既定 true なので
    // localStorage に焼き付き、次に開いたときも畳まれたままになる。
    // preventDefault() は dialog の close request を止めないので、こちらが降りるしかない
    // （palette.js の open() が「重ねない」を決めているのと同じ判定）
    if (document.querySelector('dialog[open]')) return;
    ev.preventDefault();
    setListOpen(false, dom.listToggle);
  });

  syncListInert();
}
