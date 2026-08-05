/* 画面側の小道具。
 *
 * ここに置くのは「渡されたものを整えて返す」だけのものにする。
 * store を見るもの・画面の節点を掴んで持ち続けるものは置かない。
 *
 * これは層0（誰にも依存しない）なので、このファイルから他を import した瞬間に
 * 依存の向きが壊れる。足したくなったら、それが本当に小道具かを一度考える。
 */

/**
 * 節点を1つ作る。
 *
 * 文字は textContent で入れる。innerHTML は使わない。
 * ここを通しておけば、ログ本文にタグが書かれていてもただの文字として出る
 *
 * @param {string} tag 要素名
 * @param {string|null} [className] class 属性。null なら付けない
 * @param {string|number|null} [text] 中に入れる文字。undefined / null なら入れない
 * @returns {HTMLElement}
 */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/* ------------------------------------------------------------------ 時間 */

/** 経過時間を読みやすくする。 */
export function since(ms) {
  if (ms === null || ms === undefined) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${String(s % 60).padStart(2, '0')}秒`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間${String(m % 60).padStart(2, '0')}分`;
  return `${Math.floor(h / 24)}日${h % 24}時間`;
}

/**
 * かかった時間。since() と違って秒より下を捨てない。
 *
 * ツールの往復は 200ms で終わるものが多く、since() に渡すと「0秒」が縦に並ぶ。
 * 1秒未満はミリ秒で出し、それ以上は since() に任せる（分・時間の粒度を持っている）。
 * @param {number|null} ms かかった時間。取れていなければ null
 */
export function dur(ms) {
  if (typeof ms !== 'number') return '—';
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return since(ms);
}

/* ------------------------------------------------------------------ 日時 */

export function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 日付を yyyy/MM/dd で。 */
export function ymd(d) {
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

/** 時刻を HH:mm:ss で。 */
export function hms(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * 日時を1行で。2段に割れない所（title 属性やヘッダの1項目）で使う。
 *
 * toLocaleString だと 2026/8/4 0:11:05 のようにゼロ埋めが落ちて桁がそろわないので、自前で組む。
 * @param {number|string|null} at ミリ秒、または日時文字列
 */
export function stamp(at) {
  if (!at) return '';
  const d = new Date(at);
  return `${ymd(d)} ${hms(d)}`;
}

/** 書庫の日時。年は同じものが並ぶので落とし、月日と時刻だけにする */
export function shortStamp(at) {
  if (!at) return '';
  const d = new Date(at);
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/* ------------------------------------------------------------------ 数値 */

export function num(n) {
  return typeof n === 'number' ? n.toLocaleString('ja-JP') : '?';
}

/** バイト数を KB で。書庫はログの大きさが「どれだけ話したか」の目安になる */
export function kb(bytes) {
  if (typeof bytes !== 'number') return '';
  return `${Math.round(bytes / 1024).toLocaleString('ja-JP')} KB`;
}

/** @param {number} bytes バイト数 */
export function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function shortModel(model) {
  if (!model) return null;
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

export function tokens(n) {
  if (!n) return null;
  if (n < 1000) return String(n);
  return `${Math.round(n / 1000)}k`;
}

/* ------------------------------------------------------------------ 定義リスト */

/**
 * 定義リストに1項目足す。値が無ければ何もしない。
 *
 * 「取れなかった項目は出さない」をここ1箇所で守る。呼ぶ側が毎回 if を書くと、
 * どこかで 0 や空文字を「取れなかった」と同じ扱いにしてしまう
 *
 * @param {HTMLElement} dl 足す先の dl
 * @param {string} label dt に出す語
 * @param {string|number|null} value dd に出す値。null / undefined / 空文字なら足さない
 */
export function fact(dl, label, value) {
  if (value === null || value === undefined || value === '') return;
  dl.append(el('dt', null, label), el('dd', null, value));
}
