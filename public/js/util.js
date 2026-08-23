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

/* ------------------------------------------------------------------ 文字の目印 */

/**
 * 検索語に当たった所を <mark> で囲んだ節点の並びを返す。
 *
 * innerHTML は使わない。当たった所は要素として作り、それ以外は createTextNode で入れる。
 * ログ本文にタグが書かれていても、ただの文字として出る。
 *
 * 正規表現も使わない。検索語は人が打つ文字列なので、記号のたびにエスケープが要る。
 *
 * もとは timeline/search.js にあった。Markdown の描画（md-view.js）からも呼ぶので
 * 層0 へ移した。timeline/ の中のファイルは外から直に import しない決まりなので、
 * あちらに置いたままでは md-view.js から呼べない。
 *
 * @param {string|null} text
 * @param {string|null} needle 検索語。null なら素の文字として1つ返す
 * @returns {Array<Node>}
 */
export function markUp(text, needle) {
  const t = String(text ?? '');
  if (!needle) return [document.createTextNode(t)];

  // 大小を無視して探す。ただし toLowerCase で長さが変わる文字（İ など）が混ざると
  // 元の文字列と位置がずれて、関係ない所を切り出す。
  // そのときだけ大小を区別する検索に落とす。ずれた強調を出すより外れるほうがまし
  const lower = t.toLowerCase();
  const nLower = needle.toLowerCase();
  const exact = lower.length !== t.length || nLower.length !== needle.length;
  const hay = exact ? t : lower;
  const pin = exact ? needle : nLower;

  const out = [];
  let from = 0;
  for (;;) {
    const hit = hay.indexOf(pin, from);
    if (hit < 0) break;
    if (hit > from) out.push(document.createTextNode(t.slice(from, hit)));
    out.push(el('mark', null, t.slice(hit, hit + pin.length)));
    from = hit + pin.length;
  }
  if (!out.length) return [document.createTextNode(t)];
  if (from < t.length) out.push(document.createTextNode(t.slice(from)));
  return out;
}

/**
 * 検索語の強調つきで節点を1つ作る。
 *
 * el() と同じ形で呼べるようにしてある。needle が null なら el() と同じものができる
 */
export function marked(tag, className, text, needle) {
  const node = el(tag, className);
  node.append(...markUp(text, needle));
  return node;
}

/** 検索語が何回出てくるか。markUp と同じ数え方（大小は無視、重なりは数えない） */
export function countHits(text, needle) {
  if (!needle) return 0;
  const hay = String(text ?? '').toLowerCase();
  const pin = needle.toLowerCase();
  if (!pin) return 0;
  let n = 0;
  let from = 0;
  for (;;) {
    const hit = hay.indexOf(pin, from);
    if (hit < 0) return n;
    n += 1;
    from = hit + pin.length;
  }
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

/* ------------------------------------------------------------------ カードのタグ */

/**
 * サブエージェントを使った印。一覧と書庫の両方が同じ形で出す。
 *
 * 0 と null では何も返さない。「使っていない」をわざわざ書くとタグが全行に並び、
 * 使ったものを探せなくなる。null は「まだ数えていない」なので、なおさら書けない。
 *
 * @param {number|null} count 記録ファイルの件数。null は不明
 * @returns {HTMLElement|null} 足すものが無ければ null
 */
export function agentTag(count) {
  if (!count) return null;
  const tag = el('span', 'tag is-agents', `サブエージェント ${num(count)}`);
  tag.title = 'サブエージェントの記録が残っています。詳細の「サブエージェントの記録」で開けます';
  return tag;
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
