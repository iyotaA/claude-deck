/* 層0。日付の言い方（「M/D（曜）」）と曜日。**import ゼロの純関数**なので Node から import してテストできる。
 *
 * 使うのは2枚 … 今日のまとめの窓の題と日の選択肢（`today-md.js` の `agoDate`）と、
 * 数値モードの線グラフの日付（`usage-days.js` の `dayLabel` と目盛りの曜日）。
 * **言い方をここ1つで組む。** 前は2枚がそれぞれ曜日の表と組み方を持っていて、
 * 片方だけ直した日に、窓の題と線グラフの日付が別の言い方になりえた。
 * 同じ言い方になることは `test/today-md.test.mjs` が2枚を呼んで突き合わせている。
 *
 * 日は地方時で読む（`/api/today` も `/api/usage` の日ごとの行も地方時の日で切っている）。
 */

/** 曜日。「3日前」と書くより、日付と曜日のほうが日報の日と結び付く */
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/**
 * その日の曜日を1字で（地方時）。
 *
 * @param {Date} date
 * @returns {string}
 */
export function weekdayOf(date) {
  return WEEKDAYS[date.getDay()];
}

/**
 * その日の「M/D（曜）」（地方時。`11/24（火）`）。
 *
 * @param {Date} date
 * @returns {string}
 */
export function dayText(date) {
  return `${date.getMonth() + 1}/${date.getDate()}（${weekdayOf(date)}）`;
}
