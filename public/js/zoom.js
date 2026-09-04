/* 詳細ペインの拡大表示。
 *
 * 層2。store.js だけを見る。
 *
 * ここが層2 に居るのは drawer.js の setListOpen と同じ理由。
 * タブの帯へ拡大ボタンを出すのは detail.js（層4）なので、
 * 層7 に置くと 4 -> 7 の逆流になる。
 *
 * **中身を組み直さない。既にある .detail-pane を節点ごとモーダルへ移す。**
 * 「いま」タブの中身は許可要求のカード（run-ask.js）と入力欄
 * （run-view.js / run-resume.js）を含んでいて、あれは節点を module-level に
 * 1つだけ持ち、「押しても画面からカードを消さない」「sending を解くのは
 * askBlock() の入口の1箇所だけ」「入力中の caret を消さない」という約束が
 * その1つに紐づいている。モーダル側へ2枚目を組むと、どちらが本物かを
 * 管理する話が丸ごと増える（人が承認したものと違うものが動く、いちばん高い事故の隣）。
 * 移すだけなら DOM の同一性も配線も焦点の控えもそのまま生きる。
 *
 * 開いているかは**節点がどこに居るか**で決まる。**旗を持たない。**
 * dialog.open も見ない（実測: Esc で閉じたとき Chrome は 'cancel' しか投げず、
 * その時点では open がまだ true。あそこを基準にすると、閉じる途中に組み直した札が
 * 「縮小」のまま残る）。2箇所に持てば必ず片方が古くなる。
 */
import { store } from './store.js';
import { dom } from './dom.js';
import { closeOnBackdrop } from './modal.js';

/**
 * 開閉したことを外へ知らせる口。main.js が renderDetail を差す。
 *
 * 帯のボタンの文字（拡大／縮小）と aria-pressed を組み直すために要る。
 * Esc と背面でも閉じるので、押しボタン側の handler で書き換える形にすると
 * そちらの経路で札が「縮小」のまま残る。
 *
 * ここから detail.js を import しないのは層の向き（2 -> 4 は逆流）。
 * initMode({ onUsage }) や subscribeRuns(fn) と同じ差し方にしてある。
 */
let changed = () => {};

/**
 * 「作業台で開く」を押されたときに呼ぶもの。main.js が差す。
 *
 * ここから mode.js を import しない（層2 -> 層7 は逆流）。
 * initMode({ onArchive }) と同じ差し方にしてある。
 */
let toWork = () => {};

/** 拡大しているか。旗を持たず、節点がどこに居るかで決める */
export function isZoomed() {
  return dom.detailPane.parentElement === dom.zoomBody;
}

/**
 * 控えておいた位置へ戻す。
 *
 * **入れる前に一度読む。** 節点を挿し直した直後は版面がまだ計算されていないことがあり、
 * そのまま入れると「中身の高さ 0」に丸められて先頭へ飛ぶ
 * （実測: 畳むほうだけ 0 になった。dialog が display: none になった中に
 * 一瞬でも居ると、その間は箱そのものが無いため）。
 * 読むとそこで計算が確定するので、あとの代入が通る。
 *
 * @param {number} top 控えておいた位置
 */
function restoreScroll(top) {
  void dom.detail.scrollHeight;
  dom.detail.scrollTop = top;
}

/**
 * モーダルへ移す。
 *
 * 移すと中の位置は 0 に戻るので、控えてから戻す。
 * changed()（= 組み直し）も同じ理由で scrollTop より前に呼ぶ。
 */
export function openZoom() {
  if (isZoomed()) return;
  // 書庫から開いたときだけ「作業台で開く」を出す。作業台で拡大しているあいだは
  // もうそこに居るので、押す先が無い
  dom.zoomWork.hidden = store.mode !== 'archive';
  const top = dom.detail.scrollTop;
  dom.zoomBody.append(dom.detailPane);
  dom.app.classList.add('is-zoom');
  dom.zoom.showModal();
  changed();
  restoreScroll(top);
  // 組み直しで帯のボタンごと消えるため、showModal() が当てた焦点は残らない。
  // 流れる箱（tabindex="-1"）へ移せば、そのまま矢印キーで読み進められる
  dom.detail.focus({ preventScroll: true });
}

/**
 * 元の場所（.deck の中の .list-pane の次）へ戻す。
 *
 * **何度呼ばれても平気にしてある。** 閉じる経路が3つ（× と背面は 'click'、
 * Esc は 'cancel'、明示の close() は 'close'）あり、どれが先に来るかは
 * browser 任せだから。判断は「節点が .zoom-body に居るか」だけ。
 */
function restore() {
  if (!isZoomed()) return;
  const top = dom.detail.scrollTop;
  dom.listPane.after(dom.detailPane);
  dom.app.classList.remove('is-zoom');
  changed();
  restoreScroll(top);
  dom.detail.focus({ preventScroll: true });
}

export function closeZoom() {
  if (!isZoomed()) return;
  // **出すのが先、閉じるのが後。** 逆にすると display: none になった dialog の中で
  // ペインを掴むことになり、版面が消えているぶん位置の戻しが効かない。
  //
  // 'cancel' から来たときは、この後に既定の動作でもう一度閉じにいく。
  // 閉じ済みの dialog への close() は何も起きないので、二重でも困らない
  restore();
  if (dom.zoom.open) dom.zoom.close();
}

export function toggleZoom() {
  if (isZoomed()) closeZoom();
  else openZoom();
}

/**
 * 拡大モーダルを配線する。main.js から1回だけ呼ぶ。
 *
 * @param {{onChange?: () => void}} hooks 開閉したあとに詳細を組み直す口
 */
export function initZoom({ onChange, onOpenInWork } = {}) {
  if (onChange) changed = onChange;
  if (onOpenInWork) toWork = onOpenInWork;

  // 閉じてから移る。**順番を逆にしない。** 先にモードを替えると、
  // 詳細ペインが dialog の中に居るまま作業台の骨格へ切り替わり、中央が空で出る
  dom.zoomWork.addEventListener('click', () => {
    closeZoom();
    toWork();
  });

  // **'cancel' と 'close' の両方で受ける。**
  // 仕様の上では Esc は 'cancel' -> 'close' の順に来ることになっているが、
  // **実測（Chrome）では 'cancel' しか来ない**（open は false になる）。
  // 片方だけに配線すると、Esc で閉じたあとペインが畳まれた dialog の中に
  // 取り残され、盤も隠れたままになる（画面が真っ黒になる）。
  // closeZoom() は二度呼ばれても平気なので、両方に付けておく
  dom.zoom.addEventListener('cancel', () => closeZoom());
  dom.zoom.addEventListener('close', () => closeZoom());
  dom.zoomClose.addEventListener('click', () => closeZoom());

  // 閉じ方を差し替える。節点を詳細ペインへ戻す後始末があるので素の close() では足りない
  closeOnBackdrop(dom.zoom, closeZoom);
}
