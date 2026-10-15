/* 数値の概要の札に添える「新旧の差」と「推移」。
 *
 * 層0。**import ゼロの純関数**なので Node からテストできる
 * （test/usage-trend.test.mjs。update-banner.js と同じ形）。
 *
 * **比べる相手は、同じ窓の中の古い半分。** `/api/usage` の応答には、いま読んだ本数
 * （既定 30 本）より前のセッションは入っていない。前の 30 本も読むと全文を読む量が倍になり
 * （実測 459ms）、60 本を選んだときは走査の上限（USAGE_SCAN_MAX = 60）を超えて比べられない。
 * だから読んだ窓を時刻で半分に割り、新しい半分と古い半分を比べる。追加の読み込みはゼロ。
 */

/** 半分に割って比べるのに要る本数の下限。2本ずつ無いと、1本の偏りがそのまま差になる */
export const TREND_MIN = 4;

/**
 * 窓を時刻で半分に割り、新しい半分と古い半分の値を出す。
 *
 * 並べる鍵は `mtimeMs`（最後に書かれた時刻）。応答の `rows` は実消費の多い順なので、
 * そのまま割ると「重い半分と軽い半分」になってしまう。
 *
 * 本数が奇数なら、真ん中の1本はどちらにも入れない（半分どうしの本数を揃える。
 * 本数が違うと合計の差が本数の差になる）。
 *
 * 要求が 0 件の行・数が読めない行は落とす（/clear の残骸など。0 と不明を混ぜない）。
 *
 * **キャッシュ命中率の差は出さない。** 行ごとの命中率から半分ぶんの命中率を
 * 正しく組み直すには入力トークンの内訳が要るが、行には無い。要求の数で重み付けした
 * 近似を出すと、上の札（正しい値）と食い違う。推移の線だけ出す。
 *
 * @param {Array<object>} rows `/api/usage` の `rows`
 * @returns {null|{
 *   half: number,
 *   ite: {now: number, base: number},
 *   perReq: {now: number, base: number},
 *   series: {ite: number[], perReq: number[], hitRate: number[]|null},
 * }} 比べられなければ null
 */
export function halfTrend(rows) {
  if (!Array.isArray(rows)) return null;
  const list = rows
    .filter((r) => r
      && Number.isFinite(r.mtimeMs)
      && Number.isFinite(r.ite)
      && Number.isFinite(r.requests)
      && r.requests > 0)
    .slice()
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  if (list.length < TREND_MIN) return null;

  const half = Math.floor(list.length / 2);
  const older = list.slice(0, half);
  const newer = list.slice(list.length - half);

  const sum = (xs, key) => xs.reduce((s, r) => s + r[key], 0);
  const o = { ite: sum(older, 'ite'), req: sum(older, 'requests') };
  const n = { ite: sum(newer, 'ite'), req: sum(newer, 'requests') };

  // 命中率は全部の行で読めるときだけ線にする（モデルが混ざった行は null で来る）。
  // 抜けを詰めると、線の横の位置が本と合わなくなる
  const rates = list.map((r) => r.hitRate);
  const hitRate = rates.every((v) => Number.isFinite(v)) ? rates : null;

  return {
    half,
    ite: { now: n.ite, base: o.ite },
    perReq: { now: n.ite / n.req, base: o.ite / o.req },
    series: {
      ite: list.map((r) => r.ite),
      perReq: list.map((r) => r.ite / r.requests),
      hitRate,
    },
  };
}
