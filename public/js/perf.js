/* 描画にかかった時間。
 *
 * 道具は足さない。console から deckPerf() を呼べば p95 が出る。
 * 目安は初回の renderDetail() が 50ms 未満、時系列の描き直しが 16ms 未満（1フレーム）。
 *
 * 時系列側からも mark('timeline', t0) で入れる。測る側を2つに割ると
 * deckPerf() が片方しか見えなくなるので、入れ物はこのファイル1つに保つ。
 */

/** 直近40回ぶんだけ持つ。無限に伸ばすと、開いたまま放置したときに増え続ける */
const perfLog = { detail: [], timeline: [] };

/** @param {'detail'|'timeline'} kind @param {number} t0 performance.now() の値 */
export function mark(kind, t0) {
  const a = perfLog[kind];
  a.push(performance.now() - t0);
  if (a.length > 40) a.shift();
}

/**
 * console から呼ぶ口。
 *
 * import された時点で window に付く。ビルド工程が無いので、
 * 「使っていない」と判断されて消えることはない
 */
window.deckPerf = () => {
  const p95 = (a) => {
    if (!a.length) return null;
    const sorted = [...a].sort((x, y) => x - y);
    return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] * 10) / 10;
  };
  const of = (a) => ({ n: a.length, p95: p95(a), last: a.length ? Math.round(a[a.length - 1] * 10) / 10 : null });
  return { detail: of(perfLog.detail), timeline: of(perfLog.timeline) };
};
