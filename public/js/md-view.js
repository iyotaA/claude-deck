/* Markdown を節点へ組む。md.js が返したブロックの並びを受けて DOM にする。
 *
 * 層1。見るのは層0（util.js / md.js）だけ。store も画面の状態も見ない。
 *
 * 文字はすべて util.js の el / markUp / marked を通す。つまり textContent 経由で、
 * innerHTML は1文字も使わない。ログ本文を出す場所なので、ここは譲れない
 * （marked / markdown-it を使えないのもこれが理由。あれらは HTML の文字列を返す）。
 *
 * 検索の目印（<mark>）は装飾の中でも効かせる。**太字** の中や `コード` の中に
 * 当たった語が入ったとき、記法を描いたせいで目印が消えると、
 * 「一致 3 件」と出ているのに画面のどこにも色が付いていない状態になる。
 * だから地の文だけでなく、太字・コード・表のセルも markUp を通す。
 *
 * 逆に、記号そのものを検索したときは数と見た目が食い違う。
 * ** で検索すると countHits は素の文字列を数えるので「一致 2 件」と出るが、
 * 画面には ** が出ていない。これは承知の上で、記法を描く側を採っている。
 */
import { el, marked, markUp } from './util.js';
import { parseMarkdown } from './md.js';

/**
 * 装飾（spans）を節点の並びへ。
 *
 * 太字とコードは1つの要素、地の文は markUp が返す並びをそのまま広げる。
 *
 * @param {Array<object>} spans md.js の spans
 * @param {string|null} needle 検索語
 * @returns {Array<Node>}
 */
function spanNodes(spans, needle) {
  const out = [];
  for (const s of spans) {
    if (s.type === 'code') out.push(marked('code', 'md-code', s.v, needle));
    else if (s.type === 'strong') out.push(marked('strong', 'md-strong', s.v, needle));
    else out.push(...markUp(s.v, needle));
  }
  return out;
}

/**
 * 箇条書き。深さに合わせて本物の ul / ol を入れ子にする。
 *
 * md.js の items は平らな並びで、深さだけを持っている。ここで組み直す。
 * 深さは1つずつしか増えない（md.js がスタックで決めているため）ので、
 * 「1つ深くなったら直前の項目の中へ新しいリストを挿す」だけで足りる。
 *
 * チェックリスト（`- [x]` など）の項目は data-task を持つ。印そのものは
 * CSS が出すので、ここでは目印を付けるだけにする。
 *
 * 同じ深さで種類が変わったら（番号付きのあとに箇条書きが続くなど）、
 * 兄弟として別のリストを開く。1つの ol の中に混ぜると番号が続いてしまう。
 * そのために器（div.md-list）を1枚かぶせてある。
 *
 * @param {object} block { type:'list', items }
 * @param {string|null} needle 検索語
 */
function listNode(block, needle) {
  const host = el('div', 'md-list');
  // stack[深さ] = { list, ordered, li }。li はその深さの直近の項目（子を挿す先）
  const stack = [];

  for (const it of block.items) {
    // 浅くなったら、それより深いぶんを閉じる
    stack.length = Math.min(stack.length, it.depth + 1);

    let cur = stack[it.depth];
    if (!cur || cur.ordered !== it.ordered) {
      const list = el(it.ordered ? 'ol' : 'ul', 'md-ul');
      // 3. から始まる並び（切られた入力で普通に来る）の番号を守る
      if (it.ordered && it.num > 1 && !cur) list.start = it.num;
      const parent = it.depth === 0 ? host : (stack[it.depth - 1]?.li ?? host);
      parent.append(list);
      cur = { list, ordered: it.ordered, li: null };
      stack[it.depth] = cur;
    }

    const li = el('li');
    // チェックリストの印は CSS の ::marker が出す（markdown.css）。
    // 文字を節点に入れないのは、本文を選択してコピーしたときに混ざるため
    // （.md.is-cut::after の「…」と同じ理由）。印は md.js が本文から剥がしてある
    if (it.task) li.dataset.task = it.task;
    li.append(...spanNodes(it.spans, needle));
    cur.list.append(li);
    cur.li = li;
  }
  return host;
}

/**
 * 表。横に溢れるので器を1枚かぶせて、そこだけ横スクロールさせる。
 *
 * セルの数が食い違っていても揃えない。md.js が落とさずに渡してくるものを
 * そのまま出す（黙って捨てると、行があるのに中身が消える）。
 *
 * @param {object} block { type:'table', align, head, rows }
 * @param {string|null} needle 検索語
 */
function tableNode(block, needle) {
  const wrap = el('div', 'md-tablewrap');
  const table = el('table', 'md-table');

  const cell = (tag, spans, i) => {
    const c = el(tag);
    if (block.align[i]) c.style.textAlign = block.align[i];
    c.append(...spanNodes(spans, needle));
    return c;
  };

  const thead = el('thead');
  const hr = el('tr');
  block.head.forEach((spans, i) => hr.append(cell('th', spans, i)));
  thead.append(hr);
  table.append(thead);

  if (block.rows.length) {
    const tbody = el('tbody');
    for (const row of block.rows) {
      const tr = el('tr');
      row.forEach((spans, i) => tr.append(cell('td', spans, i)));
      tbody.append(tr);
    }
    table.append(tbody);
  }

  wrap.append(table);
  return wrap;
}

/**
 * ブロック1つを節点へ。
 *
 * 見出しは2段下げて h3〜h6 にする。パネル側が h3 を使っているので、
 * 本文の中に h1 を出すと見出しの階層が逆立ちする。
 * 見た目の大小は元の段（md-h1〜md-h6）で決めるので、6 で頭打ちにしても潰れない。
 *
 * @param {object} b ブロック
 * @param {string|null} needle 検索語
 * @returns {Node}
 */
function blockNode(b, needle) {
  if (b.type === 'h') {
    const h = el(`h${Math.min(b.level + 2, 6)}`, `md-h md-h${b.level}`);
    h.append(...spanNodes(b.spans, needle));
    return h;
  }

  if (b.type === 'code') {
    const pre = el('pre', b.open ? 'md-pre is-open' : 'md-pre');
    // 言語は色分けには使わない（実測で 885 件のうち 852 件が指定なし）。
    // 出すのは右上の小さな札だけなので、CSS から読めるところに置く
    if (b.lang) pre.dataset.lang = b.lang;
    pre.append(marked('code', null, b.text, needle));
    return pre;
  }

  if (b.type === 'list') return listNode(b, needle);
  if (b.type === 'table') return tableNode(b, needle);
  if (b.type === 'hr') return el('hr', 'md-hr');

  const p = el('p', 'md-p');
  p.append(...spanNodes(b.spans, needle));
  return p;
}

/**
 * ブロックの並びを描く。
 *
 * 返すのは器（div.md）1つ。中の見た目は markdown.css が `.md` の下だけで決めるので、
 * どのパネルへ入れても同じに見える。
 *
 * 口が mdView と2つあるのは、頭出し（timeline/blocks.js の bodyText）が
 * 同じ本文から「頭だけ」と「全文」の2つを描くため。文字列を受ける口しか無いと
 * 1件につき2回パースすることになる。パースは1回で済ませて、
 * 切ったブロックの並びと元の並びをそれぞれこちらへ渡す。
 *
 * @param {Array<object>} blocks md.js のブロックの並び
 * @param {string|null} [needle] 検索語。あれば当たった所に <mark> を付ける
 * @returns {HTMLElement}
 */
export function mdBlocks(blocks, needle) {
  const host = el('div', 'md');
  for (const b of blocks) host.append(blockNode(b, needle));
  return host;
}

/**
 * Markdown を1本、文字列から描く。
 *
 * 切らずに全部描く場所（プランの本文・「あなたの番」の応答）はこちらを呼ぶ。
 *
 * @param {string|null} text 本文
 * @param {string|null} [needle] 検索語
 * @returns {HTMLElement}
 */
export function mdView(text, needle) {
  return mdBlocks(parseMarkdown(text), needle);
}
