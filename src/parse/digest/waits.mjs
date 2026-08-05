/**
 * 待ち時間。「どれだけ待たせたか」と「どれだけ待たされたか」を測る。
 *
 * 扱うのは**終わった待ちだけ**。進行中の待ちは現在時刻が要るので、
 * こちらでは持たない（一覧側の state.mjs が idleMs として持っている）。
 * digest が現在時刻を受け取らないのはそのためで、決定論であることが
 * read/cache.mjs の memo と画面側の detailCache の前提になっている。
 */
import { timestampOf, slashCommandOf, isInterrupt } from '../entries.mjs';
import { AWAY_MS } from './limits.mjs';

/**
 * 待ちを跨いだら「連続した1つの待ち」ではなくなる地点の時刻。
 *
 * 文脈の圧縮・スラッシュコマンド（とくに /clear）・中断のあとは、
 * 前の呼び出しの続きとして数えると別の作業だった時間まで足してしまう
 *
 * @param {Array} scoped 対象の行
 * @returns {number[]} 昇順の時刻
 */
export function collectBarriers(scoped) {
  const out = [];
  for (const entry of scoped) {
    const at = timestampOf(entry);
    if (at === null) continue;
    if (entry?.type === 'system' && entry.subtype === 'compact_boundary') {
      out.push(at);
      continue;
    }
    if (entry?.type !== 'user') continue;
    if (slashCommandOf(entry) || isInterrupt(entry)) out.push(at);
  }
  return out.sort((a, b) => a - b);
}

/**
 * 待ち時間を組む。
 *
 * 取れないときは null を返す。0 と書いてはいけない。
 * 「測れなかった」と「待たせていない」は別のことなので、混ぜると集計が嘘になる
 *
 * @param {string} kind 何を待っていたか（answer / plan / denial / reply / tool）
 * @param {number|null} fromAt 待ち始めた時刻
 * @param {number|null} toAt 待ちが終わった時刻
 * @param {number[]} barriers 跨いだら別の待ちになる地点
 * @returns {object|null} 測れないときは null
 */
export function waitOf(kind, fromAt, toAt, barriers) {
  if (typeof fromAt !== 'number' || typeof toAt !== 'number') return null;
  const ms = toAt - fromAt;
  if (ms < 0) return null;
  for (const b of barriers) {
    if (b > fromAt && b < toAt) return null;
  }
  return { kind, fromAt, toAt, ms, away: ms >= AWAY_MS };
}

/** 待ちの集計の初期値。種類ごとに件数・合計・最長を持つ。 */
export function emptyWaitStats() {
  const bucket = () => ({ count: 0, totalMs: 0, maxMs: 0, away: 0 });
  return {
    answer: bucket(),
    plan: bucket(),
    denial: bucket(),
    reply: bucket(),
    // ふつうのツールの往復。許可待ちと実行時間が混ざるので、上の4つとは足し合わせない
    tool: bucket(),
  };
}

/**
 * 待ちを集計に足す。
 *
 * 4時間超は合計に混ぜず away の件数だけ増やす。
 * 昼をまたいだ空白を混ぜると「回答までの間 合計 9時間」のような無意味な数になる
 *
 * @param {object} waits emptyWaitStats() の結果
 * @param {object|null} wait waitOf() の結果
 */
export function addWait(waits, wait) {
  if (!wait) return;
  const b = waits[wait.kind];
  if (!b) return;
  if (wait.away) {
    b.away += 1;
    return;
  }
  b.count += 1;
  b.totalMs += wait.ms;
  if (wait.ms > b.maxMs) b.maxMs = wait.ms;
}
