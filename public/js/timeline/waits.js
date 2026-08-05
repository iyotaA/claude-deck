/* 待ち時間の見せ方。ラベルと注記、行に付ける小さな札、facts に出す1行。
 *
 * 待っていた時間は、時系列の行（item.js）と詳細の facts（main.js 側）の両方に出る。
 * 同じ数字を2通りに書くと、同じ待ちが場所によって違って見えるので、言い方をここに1つだけ置く。
 *
 * 依存は util.js だけ。時系列の他の部品からは独立している。
 */
import { el, since } from '../util.js';

/**
 * 待ちの種類ごとの言い方。
 *
 * どれも「〜までの間」で止める。「迷った時間」「悩んだ時間」とは書かない。
 * ログから分かるのは前のやり取りからの経過だけで、席を外していた時間と区別できない
 */
export const WAIT_LABELS = {
  answer: '回答までの間',
  plan: '承認までの間',
  denial: '却下までの間',
  reply: '返信までの間',
  tool: 'ツールの往復',
};

/** 待ちに必ず添える注記。言い切らないための断り書き */
export const WAIT_NOTE = '「…までの間」は前のやり取りからの経過時間です。席を外していた時間と区別できないため、迷っていた時間とは限りません。';

/**
 * 待ち時間の印を1つ作る。
 *
 * wait が null のときは何も返さない。圧縮や中断を跨いだ区間・時刻が取れなかった区間が
 * そこに当たる。0 と書くと「即答した」に読めるので、取れなかったものは出さない。
 *
 * @param {object|null} wait digest の item.wait（{kind, ms, away}）
 * @returns {HTMLElement|null}
 */
export function waitBadge(wait) {
  if (!wait || typeof wait.ms !== 'number') return null;
  const node = el('span', 'tl-wait', `${WAIT_LABELS[wait.kind] ?? '間'} ${since(wait.ms)}`);
  node.title = WAIT_NOTE;
  // 4時間を超える間は、判断に使った時間として読ませない
  if (wait.away) {
    node.dataset.away = 'true';
    node.append(el('span', 'away', '席を外していた可能性'));
  }
  return node;
}

/**
 * 待ちの集計を1行にする。
 *
 * 測れたものが1つも無ければ null。fact() が null を素通りするので、
 * 「取れなかった項目は出さない」が自動で守られる。
 *
 * @param {object|null} bucket stats.waits の1つ（{count, totalMs, maxMs, away}）
 */
export function waitFact(bucket) {
  if (!bucket) return null;
  const parts = [];
  if (bucket.count > 0) {
    parts.push(`${bucket.count} 回`);
    parts.push(`合計 ${since(bucket.totalMs)}`);
    parts.push(`最長 ${since(bucket.maxMs)}`);
  }
  // 4時間超は合計に混ぜていない。件数だけは出して「無かった」と読ませない
  if (bucket.away > 0) parts.push(`4時間超 ${bucket.away} 回は別枠`);
  return parts.length ? parts.join(' / ') : null;
}
