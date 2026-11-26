/* 行の導出。
 *
 * 一覧の行・書庫の行・詳細の応答という3つの出どころから、
 * 画面が「1つの行」として扱えるものを組む。どこから来たかで見え方が変わらないようにする。
 *
 * 層2。store.js だけを見る。
 * detailErrorNow をここに置いているのは、詳細の描画側と取得側の両方が使うため。
 * どちらかに置くと、2つが互いを import することになる。
 */
import { store } from './store.js';

/** そのセッションが実際に動いている時間を、末尾の追記からの経過で出す。 */
export function idleOf(row) {
  if (row.lastActivityAt) return Math.max(0, store.now - row.lastActivityAt);
  return row.idleMs ?? null;
}

/**
 * 一覧から素の行を引く。無ければ書庫の行、次に押して選んだときの行の控え（`store.pickedRow`）に落とす。
 *
 * ここで返した行は、詳細が届く前の頭にそのまま使われる（headOf）。詳細が届いたあとは、
 * 状態の項目（LIVE_FIELDS）を詳細の上へ上書きするのに**一覧の行しか使わない**ので、
 * 書庫の行や控えが状態の項目を持っていても（今日のまとめの行は alive を持つ）古い値は乗らない。
 * 書庫と数値の行は logSize を持っているので、そこから開いたセッションでも detailStampOf が本物の目印を取れる
 * （今日のまとめの行は持たないので、目印は不明＝0 になり詳細を毎回取り直す）。
 *
 * **控えに落とすのは、書庫・数値のカードと今日のまとめの題を拡大の窓で開くため**（数値は画面刷新⑤の D27）。
 * `renderDetailInner` は `headOf` が空だと拡大を畳む。押した直後は詳細がまだ届いていないので、
 * 一覧（24時間より古いものは居ない）にも書庫の行にも居ないセッションは、開いた直後に閉じていた（実測。
 * 新しい順に読む数値の 60 本には、一覧に居ない終わったセッションが普通に混ざる）。
 *
 * **数値の並び（`store.usageTab.data.rows`）は引きに行かない。** 引き直しの最中（前の並びが薄く出ていて
 * 押せる）にカードを押すと、届いた並びにそのセッションが居ないことがあり（本数・期間・モデルで絞り直したとき）、
 * 詳細が届く前の組み直しで窓が突然閉じた。押した時点の行を控えておけば、並びが差し替わっても消えない。
 *
 * @param {string|null} sessionId
 * @returns {object|null} どれにも居なければ null
 */
export function rowOf(sessionId) {
  if (!sessionId) return null;
  return store.rows.find((r) => r.sessionId === sessionId)
    ?? store.archive.rows.find((r) => r.sessionId === sessionId)
    // 控えは id で突き合わせる（別のセッションの控えを返さない）
    ?? (store.pickedRow?.sessionId === sessionId ? store.pickedRow : null);
}

/**
 * 詳細ペインが使う項目のうち、一覧の行のほうが新しいもの。
 *
 * 一覧は SSE で毎秒引き直され、詳細は開いた時点のもの。
 * 状態をここで一覧に上書きさせないと、左のカードと右のヘッダが食い違う。
 * 逆に身元（title / model / cwd）は詳細のほうが当たる。
 * 一覧は末尾64KB、詳細は全文を読んで解析しているため。
 *
 * `run`（台帳の行）だけは「新しいほう」ではなく**一覧の行しか持っていない**。
 * 合流させているのが `server.mjs` の `refresh()` で、詳細の窓口は台帳を知らないため。
 * 台帳に無いセッションの行では `key in live` が偽になるので、詳細の値がそのまま残る。
 *
 * 上書きする項目を配列で名前付けするのは、プロパティの並び順に判断を埋めないため。
 */
export const LIVE_FIELDS = [
  'state', 'stateLabel', 'ball', 'blocking', 'idleMs', 'lastActivityAt',
  'waitingFor', 'stateReason', 'stateConfident', 'statusRaw', 'alive', 'pid', 'run',
  // ピンとメモ。会話ログには無く、サーバーが一覧の行にだけ載せる（src/marks）
  'pinned', 'memo',
];

/**
 * 詳細ペインが見る「行に相当するもの」を組む。
 *
 * 一覧の行だけを頼りにすると、一覧に居ないセッション（24時間より古いもの）を
 * 開けない。詳細の応答は身元と状態の項目を同じ形で持っているので、そこから組める。
 *
 * **状態の項目を上書きするのは一覧の行（`store.rows`）だけ。** 一覧は毎秒引き直しているが、
 * 書庫の行と押した行の控え（`store.pickedRow`）は引いた・押した時点の写しで、詳細より古い。
 * 前は rowOf の返した行から上書きしていて、「控えには状態の項目を持たない行しか入れない」を
 * 呼ぶ側が守る約束になっていた。今日のまとめの行は alive を持つのでその約束に入れず、
 * 題を押しても行を渡せなかった。そのため一覧にも書庫の行にも居ない前の日のセッションは、
 * 詳細の届く前の組み直しで拡大の窓が畳まれていた（1回目だけ。2回目は詳細のキャッシュが効いて開く。実測）。
 * 上書きの出どころをここで一覧に絞れば、控えに何を入れても詳細の上に古い状態は乗らない。
 *
 * @param {string|null} sessionId
 * @returns {object|null} どちらの出どころも無ければ null
 */
export function headOf(sessionId) {
  if (!sessionId) return null;
  const detail = store.detail?.sessionId === sessionId ? store.detail : null;
  // 詳細が届く前は手元の行で組む（一覧 → 書庫の行 → 押した行の控え）。空だと拡大の窓が畳まれる
  if (!detail) return rowOf(sessionId);
  const head = { ...detail };
  const live = store.rows.find((r) => r.sessionId === sessionId);
  if (live) {
    for (const key of LIVE_FIELDS) {
      if (key in live) head[key] = live[key];
    }
  }
  return head;
}

/** 一覧に出す行。頭の「すべて｜稼働中」で「稼働中」を選んでいるあいだは終わったものを落とす */
export function visibleRows() {
  return store.onlyLive ? store.rows.filter((r) => r.alive) : store.rows;
}

/** いま選んでいるセッションの取得エラー。前のセッションのものは無関係なので出さない */
export function detailErrorNow() {
  return store.detailErrorFor === store.selected ? store.detailError : null;
}
