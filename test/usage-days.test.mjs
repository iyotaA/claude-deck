/**
 * 数値モードの「日ごとの実消費」の線グラフに、どの日をどう描くか（`public/js/usage-days.js`）。
 *
 * 画面刷新⑤の D2〜D5。純関数で、import は層0 の `day-text.js`（日付の言い方）だけなので、画面のファイルのまま Node から呼ぶ。
 *
 * - 描くのは `meta.scanFrom`（全部数えてある最初の日）から今日まで。境目より前は描かない（D2）
 * - 境目が決められない（null）・古いサーバー（キーが無い）は描かない側に倒す（0 と不明を分ける）
 * - 描く範囲で使わなかった日は 0（D4。そこの 0 は測って 0）
 * - 今日は `meta.now` からサーバーと同じ丸め方（地方時の日）で出す
 * - 日数の上限（全部読めたときに境目が昔になりすぎる）・描ける日が無いとき・山（D5）
 *
 * 時刻は地方時で組む（日の鍵が地方時で決まるので、走らせる機械の時間帯が変わっても期待する鍵が変わらない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY_CHART_MAX, DAY_TICKS_ALL, localDay, dayLabel, niceMax, dayChartView, partialNote, chartNote, clipNote,
} from '../public/js/usage-days.js';
import { localDay as serverLocalDay } from '../src/parse/usage.mjs';

/** 地方時のその時刻 */
const local = (y, mo, d, h = 12, mi = 0, s = 0, ms = 0) => new Date(y, mo - 1, d, h, mi, s, ms).getTime();

/** いま（2026-11-24 火曜の 15:00） */
const NOW = local(2026, 11, 24, 15);

/**
 * `/api/usage` の応答の形（線グラフが読むところだけ）。
 *
 * @param {Array<[string, number]>} rows 日と実消費
 * @param {object} [meta] meta の上書き。scanFrom を消したいときは { scanFrom: undefined, drop: true }
 */
function resp(rows, meta = {}, extra = {}) {
  const { drop, ...over } = meta;
  const m = { now: NOW, indexed: 553, scanned: 30, scanLimited: true, scanMax: 60, empty: 0, scanFrom: '2026-11-20', ...over };
  if (drop) delete m.scanFrom;
  return {
    limit: 30,
    daily: { list: rows.map(([day, ite]) => ({ day, ite, requests: ite > 0 ? 1 : 0 })), undated: 0 },
    meta: m,
    ...extra,
  };
}

/* ── 日の鍵 ─────────────────────────────────────────────── */

test('日の鍵の組み方はサーバー（parse/usage.mjs の localDay）と同じ', () => {
  // 画面は src/ を import できないので、組み方を写してある。ここで食い違いを見張る
  // （食い違うと scanFrom と行の鍵が1日ずれ、境目の日を描いたり落としたりする）
  const samples = [
    local(2026, 11, 24, 0, 0, 0, 0), local(2026, 11, 24, 23, 59, 59, 999),
    local(2026, 12, 31, 23, 30), local(2027, 1, 1, 0, 0), local(2026, 2, 28, 12), local(2028, 2, 29, 9),
    local(2026, 3, 8, 2, 30), local(2026, 11, 1, 1, 30), 0, Date.parse('2026-08-04T09:00:00.000Z'),
  ];
  for (const t of samples) assert.equal(localDay(t), serverLocalDay(t), new Date(t).toString());
});

test('日の名前は「11/18（水）」の形', () => {
  assert.equal(dayLabel('2026-11-18'), '11/18（水）');
  assert.equal(dayLabel('2026-11-24'), '11/24（火）');
  assert.equal(dayLabel('2027-01-01'), '1/1（金）');
});

test('目盛りの上端は 1・2・5 の刻みで切り上げる', () => {
  assert.equal(niceMax(82.0e6), 100e6);
  assert.equal(niceMax(36.6e6), 50e6);
  assert.equal(niceMax(50e6), 50e6);
  assert.equal(niceMax(16.4e6), 20e6);
  assert.equal(niceMax(1), 1);
  assert.equal(niceMax(1000), 1000);
  // 使っていない（0）なら上端も 0。線は底に沿う
  assert.equal(niceMax(0), 0);
});

/* ── 描いてよい日（D2）と 0 で埋める（D4）─────────────────── */

test('描くのは境目（scanFrom）から今日まで。境目より前の日は描かない', () => {
  const v = dayChartView(resp([['2026-11-18', 46.2e6], ['2026-11-19', 41.4e6], ['2026-11-20', 18.9e6], ['2026-11-21', 4.1e6], ['2026-11-24', 16.4e6]]));
  assert.equal(v.status, 'ok');
  assert.equal(v.from, '2026-11-20');
  assert.equal(v.to, '2026-11-24');
  // 11-18・11-19 は一部しか数えていない。完全な日と同じ顔で並べると左が低く出て右肩上がりに読める
  assert.deepEqual(v.days.map((x) => x.day), ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24']);
});

test('描く範囲で使わなかった日は 0（測って 0）', () => {
  const v = dayChartView(resp([['2026-11-20', 18.9e6], ['2026-11-21', 4.1e6], ['2026-11-24', 16.4e6]]));
  // 11-22・11-23 は行が無い。境目より後なので「読んでいない」ではなく「使っていない」
  assert.deepEqual(v.days.map((x) => x.ite), [18.9e6, 4.1e6, 0, 0, 16.4e6]);
  assert.deepEqual(v.days.map((x) => x.requests), [1, 1, 0, 0, 1]);
});

test('今日は meta.now から地方時で出す（日付が変わる前後で1日ずれる）', () => {
  const rows = [['2026-11-20', 1e6]];
  assert.equal(dayChartView(resp(rows, { now: local(2026, 11, 24, 23, 59, 59, 999) })).to, '2026-11-24');
  assert.equal(dayChartView(resp(rows, { now: local(2026, 11, 25, 0, 0, 0, 0) })).to, '2026-11-25');
  // 今日まで描くので、行の無い今日も 0 で入る
  assert.equal(dayChartView(resp(rows, { now: local(2026, 11, 25, 0, 30) })).days.at(-1).ite, 0);
});

test('meta.now が無ければ、行のいちばん新しい日までにする（知らない日を 0 で足さない）', () => {
  const v = dayChartView(resp([['2026-11-20', 1e6], ['2026-11-22', 2e6]], { now: undefined }));
  assert.equal(v.to, '2026-11-22');
  assert.deepEqual(v.days.map((x) => x.day), ['2026-11-20', '2026-11-21', '2026-11-22']);
});

test('月と年をまたいでも暦どおりに並ぶ', () => {
  const v = dayChartView(resp([['2026-12-30', 1e6], ['2027-01-02', 2e6]], { scanFrom: '2026-12-30', now: local(2027, 1, 2, 10) }));
  assert.deepEqual(v.days.map((x) => x.day), ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
});

test('入ってきた応答を書き換えない', () => {
  const d = resp([['2026-11-20', 1e6], ['2026-11-24', 2e6]]);
  const before = JSON.stringify(d);
  dayChartView(d);
  assert.equal(JSON.stringify(d), before);
});

/* ── 決められないとき・描ける日が無いとき ─────────────────── */

test('境目が null（決められない）なら描かない', () => {
  const v = dayChartView(resp([['2026-11-20', 1e6]], { scanFrom: null }));
  assert.equal(v.status, 'unknown');
  assert.deepEqual(v.days, []);
  // 日の名前として読めない値も同じ扱い（推測で描かない）
  assert.equal(dayChartView(resp([['2026-11-20', 1e6]], { scanFrom: 'abc' })).status, 'unknown');
  assert.equal(dayChartView(resp([['2026-11-20', 1e6]], { scanFrom: '2026-02-31' })).status, 'unknown');
});

test('古いサーバー（scanFrom のキーが無い）も描かない。決められないのと同じ側に倒す', () => {
  const v = dayChartView(resp([['2026-11-20', 1e6]], { drop: true }));
  assert.equal(v.status, 'old');
  assert.deepEqual(v.days, []);
  assert.equal(dayChartView({ daily: { list: [] } }).status, 'old', 'meta ごと無い');
});

test('境目が今日より後（今日のぶんも欠けている）なら描ける日は 0 日', () => {
  // 本数を少なく選んだ日に、今日動いたログを読み切れなかった
  const v = dayChartView(resp([['2026-11-24', 5e6]], { scanFrom: '2026-11-25' }));
  assert.equal(v.status, 'none');
  assert.deepEqual(v.days, []);
  assert.equal(v.canWiden, true, '本数を増やせる（30 < 60）');
  assert.equal(dayChartView(resp([['2026-11-24', 5e6]], { scanFrom: '2026-11-25' }, { limit: 60 })).canWiden, false, 'もう上限');
});

test('描ける日が1日だけなら線は引かない（short）', () => {
  const v = dayChartView(resp([['2026-11-24', 5e6]], { scanFrom: '2026-11-24' }));
  assert.equal(v.status, 'short');
  assert.deepEqual(v.days.map((x) => x.day), ['2026-11-24']);
});

/* ── 日数の上限 ─────────────────────────────────────────── */

test('全部読めて境目が昔になりすぎても、描くのは直近の上限ぶんだけ。切ったことは数で返す', () => {
  // 全部読めたとき境目は「いちばん古い日ごとの行」なので、ログが少ない人では何か月も前になる
  const v = dayChartView(resp([['2026-09-26', 1e6], ['2026-11-24', 2e6]], { scanFrom: '2026-09-26', indexed: 12, scanned: 12, scanLimited: false }));
  assert.equal(DAY_CHART_MAX, 30);
  assert.equal(v.days.length, DAY_CHART_MAX);
  assert.equal(v.from, '2026-10-26');
  assert.equal(v.to, '2026-11-24');
  // 9/26〜10/25 の 30 日はそろっているが描いていない
  assert.equal(v.clipped, 30);
  assert.match(clipNote(v), /直近 30 日だけ/);
  assert.equal(clipNote(dayChartView(resp([['2026-11-20', 1e6]]))), null, '切っていなければ言わない');
});

/* ── 山（D5）─────────────────────────────────────────────── */

test('山はいちばん多い日。同じ量なら新しい日', () => {
  const v = dayChartView(resp([['2026-11-20', 9e6], ['2026-11-21', 30e6], ['2026-11-23', 30e6], ['2026-11-24', 2e6]]));
  assert.equal(v.peak.day, '2026-11-23');
  assert.equal(v.peak.ite, 30e6);
  assert.equal(v.peak.index, 3);
  assert.equal(v.peak.label, '11/23（月）');
  assert.equal(v.max, 50e6);
});

test('描く範囲でどの日も使っていなければ山は無い（0 を山と呼ばない）', () => {
  const v = dayChartView(resp([['2026-11-18', 9e6]], { scanFrom: '2026-11-22' }));
  assert.equal(v.status, 'ok');
  assert.deepEqual(v.days.map((x) => x.ite), [0, 0, 0]);
  assert.equal(v.peak, null);
  assert.equal(v.max, 0);
  // 線は底に沿う
  assert.deepEqual(v.days.map((x) => x.y), [1, 1, 1]);
});

/* ── 置き場所（x / y）と目盛り ─────────────────────────────── */

test('点は日の列の真ん中（目盛りの字の列と揃う）、高さは上端に対する割合', () => {
  const v = dayChartView(resp([['2026-11-20', 25e6], ['2026-11-21', 50e6], ['2026-11-22', 0], ['2026-11-23', 10e6]], { now: local(2026, 11, 23, 9) }));
  assert.deepEqual(v.days.map((x) => x.x), [0.125, 0.375, 0.625, 0.875]);
  assert.deepEqual(v.days.map((x) => x.y), [0.5, 0, 1, 0.8]);
});

test('目盛りは 14 日までは毎日、それより多いと今日から数えて間引く。月の変わり目は月も書く', () => {
  const few = dayChartView(resp([['2026-11-20', 1e6]]));
  assert.ok(few.days.every((x) => x.tick), '5日なら全部に目盛り');
  assert.equal(few.days[0].tick, '11/20', '最初の目盛りは月も書く');
  assert.equal(few.days[1].tick, '21');
  assert.equal(few.days[0].weekday, '金');

  const many = dayChartView(resp([['2026-10-26', 1e6]], { scanFrom: '2026-10-26' }));
  assert.equal(DAY_TICKS_ALL, 14);
  assert.equal(many.days.length, 30);
  const ticks = many.days.filter((x) => x.tick);
  assert.ok(ticks.length <= DAY_TICKS_ALL, `目盛りが ${ticks.length} 個ある`);
  assert.ok(many.days.at(-1).tick, '今日には必ず目盛り');
  // 月が変わったところ（11/1 以降の最初の目盛り）は月を書く
  const firstNov = ticks.find((x) => x.day >= '2026-11-01');
  assert.match(firstNov.tick, /^11\//);
});

/* ── 注記（誤読を防ぐ。消さない）─────────────────────────── */

test('境目より前に一部しか数えていない日があれば、その日付を添えて言う', () => {
  const v = dayChartView(resp([['2026-11-18', 46.2e6], ['2026-11-20', 18.9e6]]));
  assert.equal(v.cut, true);
  assert.equal(partialNote(v), '11/20（金）より前は一部しか読んでいません。読まなかったログのぶんが抜けています。');
});

test('全部読めていれば一部の日は無いので言わない', () => {
  const v = dayChartView(resp([['2026-11-20', 1e6]], { indexed: 12, scanned: 12, scanLimited: false }));
  assert.equal(v.cut, false);
  assert.equal(partialNote(v), null);
  // 行が境目より前にあれば、読んだ本数が合っていても一部の日がある（読めなかったログなど）
  const w = dayChartView(resp([['2026-11-18', 1e6], ['2026-11-20', 1e6]], { indexed: 12, scanned: 12, scanLimited: false }));
  assert.equal(w.cut, true);
});

test('決められないとき・描ける日が無いときも、何が起きているかを一言で言う', () => {
  assert.match(partialNote(dayChartView(resp([], { scanFrom: null }))), /どの日から全部そろっているかが分かりません/);
  assert.match(partialNote(dayChartView(resp([], { drop: true }))), /サーバーが古い/);
  assert.match(partialNote(dayChartView(resp([], { scanFrom: '2026-11-25' }))), /全部そろっている日がまだありません/);

  // 概要（線を描かない場所）の一言
  assert.match(chartNote(dayChartView(resp([], { scanFrom: null }))), /線は描いていません/);
  assert.match(chartNote(dayChartView(resp([], { drop: true }))), /線は描いていません/);
  const none = chartNote(dayChartView(resp([], { scanFrom: '2026-11-25' })));
  assert.match(none, /全部そろっている日がまだない/);
  assert.match(none, /本数を増やす/, '増やせるなら行き先を言う');
  assert.doesNotMatch(chartNote(dayChartView(resp([], { scanFrom: '2026-11-25' }, { limit: 60 }))), /本数を増やす/, '上限なら言わない');
  assert.match(chartNote(dayChartView(resp([['2026-11-24', 1e6]], { scanFrom: '2026-11-24' }))), /11\/24（火）の1日だけ/);
  assert.equal(chartNote(dayChartView(resp([['2026-11-20', 1e6]]))), null, '描けるときは言わない');
});

test('描けないときは、上の絞り込みで何を変えればそろう日が増えるかまで言う（本数・期間）', () => {
  // 1日だけ（short）も、本数を増やせるなら言う（既定より少ない本数で、今日と昨日しか読めなかったとき）
  const short = (meta, extra) => chartNote(dayChartView(resp([['2026-11-24', 1e6]], { scanFrom: '2026-11-24', ...meta }, extra)));
  assert.match(short({}, { limit: 10 }), /1日だけ.*本数を増やす/);
  assert.doesNotMatch(short({}, { limit: 60 }), /本数を増やす|期間を広げる/, '上限まで選んでいれば勧める手が無い');

  // 期間で絞り、期間の中は全部読めた（上限に当たっていない）。期間で外したログが境目を決めているので、広げれば増える
  const byDays = { indexed: 553, scanned: 12, scanLimited: false };
  const v = dayChartView(resp([['2026-11-24', 1e6]], { scanFrom: '2026-11-24', ...byDays }, { days: 1 }));
  assert.equal(v.canLengthen, true);
  assert.equal(v.canWiden, false, '上限に当たっていないので本数では変わらない');
  assert.match(chartNote(v), /期間を広げる/);
  assert.doesNotMatch(chartNote(v), /本数を増やす/);
  // 期間で外したものが無い（索引の全部を読めた）なら、広げても変わらない
  assert.doesNotMatch(short({ indexed: 12, scanned: 12, scanLimited: false }, { days: 7 }), /期間を広げる/);
  // 期間を絞っていなければ言わない
  assert.doesNotMatch(short(byDays, { days: null }), /期間を広げる/);
  // 上限に当たっているあいだは、期間を広げても境目は動かない（いちばん新しい外れものは上限の外のまま）
  const limited = dayChartView(resp([['2026-11-24', 1e6]], { scanFrom: '2026-11-24' }, { days: 7, limit: 60 }));
  assert.equal(limited.canLengthen, false);

  // そろう日が0日（none）では期間を勧めない。期間で外したログの最終更新は「いま − 期間」より前なので、
  // 境目を今日より後へは押し出さない（0日の原因は上限で外したログか、読めなかったログ）
  const none = dayChartView(resp([], { scanFrom: '2026-11-25', ...byDays }, { days: 1 }));
  assert.equal(none.status, 'none');
  assert.doesNotMatch(chartNote(none), /期間を広げる/);
  // 古いサーバー（scanLimited が無い）では期間を勧めない（期間の中を全部読めたか分からない）
  assert.equal(dayChartView(resp([], { scanFrom: '2026-11-24', scanLimited: undefined, indexed: 9, scanned: 3 }, { days: 1 })).canLengthen, false);
});
