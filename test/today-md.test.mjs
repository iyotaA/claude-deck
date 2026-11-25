/**
 * 今日のまとめを Markdown にする側（`public/js/today-md.js`）。
 *
 * 画面側のファイルだが純関数で、import は層0 の `day-text.js` だけなので、Node から読める。
 * 見たいのは「画面と同じ並びで、切ったことを黙らない」こと。
 * どの日を見るかの判断（範囲の丸め・日の言い方・前後の矢印の行き先と端）もここで関数を呼んで見る。
 * 日の言い方は、数値モードの線グラフの日付（`usage-days.js` の `dayLabel`）と同じになることも突き合わせる
 * （組み方は `day-text.js` の1か所）。
 * 窓の配線（矢印と日の選択が同じ道を通ること・端で押せないこと・足のボタン）は `today-win.test.mjs` が字面で見る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  TODAY_AGO_MAX_UI, agoDate, agoLabel, agoSteps, clampAgo, isQuiet, shortPath, spanText, todayMarkdown,
} from '../public/js/today-md.js';
import { dayLabel, localDay } from '../public/js/usage-days.js';
import { dayText, weekdayOf } from '../public/js/day-text.js';
import { TODAY_AGO_MAX } from '../src/view/today.mjs';

const at = (h, m) => new Date(2026, 9, 15, h, m).getTime();

/** 応答の1行。何も渡さなければ「動いただけ」の行 */
function row(over = {}) {
  return {
    sessionId: 'abcdef12-0000', title: '題', cwd: 'C:\\work\\demo', project: 'demo',
    firstAt: at(10, 15), lastAt: at(10, 23), alive: false,
    decisions: [], decisionsTotal: 0, decisionsOmitted: 0, plansApproved: 0,
    files: [], filesTotal: 0, filesOmitted: 0,
    ...over,
  };
}

function data(rows, meta = {}) {
  return {
    day: '2026-10-15',
    rows,
    totals: { sessions: rows.length, projects: 1, decisions: 1, files: 1 },
    meta: { scanLimited: false, scanMax: 60, candidates: rows.length, ...meta },
  };
}

test('見出し・決めたこと・書き換えたファイルを画面と同じ順で出す。パスは作業フォルダから見た形', () => {
  const md = todayMarkdown(data([row({
    decisions: [{ topic: '範囲', choice: 'B' }, { topic: null, choice: '自由入力' }],
    decisionsTotal: 2,
    files: [{ path: 'C:\\work\\demo\\src\\a.js', count: 2, tools: ['Edit'] }],
    filesTotal: 1,
  })]));
  assert.match(md, /^# まとめ（2026-10-15）/);
  assert.match(md, /動いたセッション 1 本・置き場所 1 つ\n/);
  assert.match(md, /## demo — 題（10:15–10:23）/);
  assert.match(md, /- 範囲: B\n- 自由入力/);
  assert.match(md, /- `src\\a\.js`/);
});

test('切ったぶんは「ほか N」で残す。走査を打ち切ったことも書く', () => {
  const md = todayMarkdown(data([row({
    decisions: [{ topic: 'a', choice: 'b' }], decisionsTotal: 21, decisionsOmitted: 20,
    files: [{ path: 'x', count: 1, tools: [] }], filesTotal: 31, filesOmitted: 30,
  })], { scanLimited: true, candidates: 75 }));
  assert.match(md, /- ほか 20 件/);
  assert.match(md, /- ほか 30 個/);
  assert.match(md, /新しい 60 本だけ.*75 本中/);
});

test('決めたことも書き換えも無い行は、最後に名前だけ並べる（動いた事実は消さない）', () => {
  const md = todayMarkdown(data([row({ title: '調べただけ' })]));
  assert.ok(isQuiet(row()));
  assert.ok(!isQuiet(row({ plansApproved: 1 })));
  assert.match(md, /## そのほかに動いたもの\n\n- demo — 調べただけ（10:15–10:23）/);
  assert.doesNotMatch(md, /## demo — 調べただけ/);
});

test('作業フォルダの外のパスは元のまま。大小と区切りの違いは同じとみなす', () => {
  assert.equal(shortPath('C:\\Other\\a.js', 'C:\\work'), 'C:\\Other\\a.js');
  assert.equal(shortPath('c:/WORK/b/c.js', 'C:\\work\\'), 'b/c.js');
  assert.equal(shortPath('C:\\workspace\\a.js', 'C:\\work'), 'C:\\workspace\\a.js');
  assert.equal(shortPath('a.js', null), 'a.js');
});

test('時刻の言い方。同じ分なら1つだけ', () => {
  assert.equal(spanText(row({ lastAt: at(10, 15) })), '10:15');
  assert.equal(spanText(row({ firstAt: null })), '--:--–10:23');
});

test('選べる日数がサーバーの上限と揃っている', () => {
  assert.equal(TODAY_AGO_MAX_UI, TODAY_AGO_MAX);
});

/* ── どの日を見るか（窓の頭の矢印と日の選択。画面刷新⑤の D23）──────────── */

test('何日前かを選べる範囲の整数へ丸める。数でないものは「きょう」', () => {
  assert.equal(clampAgo(3), 3);
  assert.equal(clampAgo('2'), 2);
  assert.equal(clampAgo(2.9), 2);
  assert.equal(clampAgo(-1), 0);
  assert.equal(clampAgo(TODAY_AGO_MAX_UI + 5), TODAY_AGO_MAX_UI);
  for (const v of [undefined, null, '', 'abc', NaN]) assert.equal(clampAgo(v), 0, `${String(v)} を「きょう」に倒していない`);
});

test('前後の矢印の行き先。前の日は1日古く、次の日は1日新しい。端は null（押せない）', () => {
  assert.deepEqual(agoSteps(0), { prev: 1, next: null }, 'きょうより先へは行けない');
  assert.deepEqual(agoSteps(3), { prev: 4, next: 2 });
  assert.deepEqual(agoSteps(TODAY_AGO_MAX_UI), { prev: null, next: TODAY_AGO_MAX_UI - 1 }, '選べるいちばん古い日より前へは行けない');
  // 範囲の外から来ても丸めてから決める（どの口から来ても同じ道）
  assert.deepEqual(agoSteps(99), agoSteps(TODAY_AGO_MAX_UI));
  assert.deepEqual(agoSteps('x'), agoSteps(0));
  // 矢印だけで、選べる日を端から端まで1日ずつ全部たどれる（飛ばす日も、行き止まりの手前で止まる日も無い）
  const seen = [0];
  for (let a = 0; agoSteps(a).prev !== null; a = agoSteps(a).prev) seen.push(agoSteps(a).prev);
  assert.deepEqual(seen, Array.from({ length: TODAY_AGO_MAX_UI + 1 }, (_, i) => i));
});

test('日の言い方。題と選択肢が同じ「M/D（曜）」で、選択肢は「きょう」「きのう」のあと日付だけ（地方時）', () => {
  const now = new Date(2026, 10, 24, 9, 30).getTime(); // 2026-11-24（火）
  assert.equal(agoDate(0, now), '11/24（火）');
  assert.equal(agoDate(1, now), '11/23（月）');
  assert.equal(agoLabel(0, now), 'きょう 11/24（火）');
  assert.equal(agoLabel(1, now), 'きのう 11/23（月）');
  assert.equal(agoLabel(2, now), '11/22（日）');
  assert.equal(agoLabel(2, now), agoDate(2, now), '3日目からは選択肢と題が同じ言い方');
  // 月をまたぐ・範囲の外は丸める
  const first = new Date(2026, 11, 2, 0, 5).getTime(); // 2026-12-02（水）の 00:05
  assert.equal(agoDate(3, first), '11/29（日）');
  assert.equal(agoDate(99, first), agoDate(TODAY_AGO_MAX_UI, first));
  // 日付が変わる前後で「きょう」が動く（基準の時刻を外から渡すので、開きっぱなしでも古い日に固まらない）
  assert.equal(agoLabel(0, new Date(2026, 10, 24, 23, 59).getTime()), 'きょう 11/24（火）');
  assert.equal(agoLabel(0, new Date(2026, 10, 25, 0, 0).getTime()), 'きょう 11/25（水）');
});

test('窓の題の日付（agoDate）と数値の線グラフの日付（dayLabel）は同じ言い方。組み方は day-text.js の1か所', () => {
  // 前は2枚がそれぞれ曜日の表と「M/D（曜）」の組み方を持っていて、片方だけ直すと別の言い方になりえた
  const now = new Date(2026, 11, 2, 9, 0).getTime(); // 2026-12-02（水）。月をまたぐ日も入れる
  for (let ago = 0; ago <= TODAY_AGO_MAX_UI; ago += 1) {
    const d = new Date(now);
    d.setDate(d.getDate() - ago);
    const fromWin = agoDate(ago, now);
    assert.equal(dayLabel(localDay(d.getTime())), fromWin, `${ago} 日前で、窓の題と線グラフの日付の言い方が違う`);
    assert.equal(dayText(d), fromWin, `${ago} 日前で、day-text.js の言い方と違う`);
  }
  // 年をまたぐ日と曜日の1字
  assert.equal(dayLabel('2027-01-01'), agoDate(0, new Date(2027, 0, 1, 12).getTime()));
  assert.equal(weekdayOf(new Date(2026, 10, 24)), '火');
  // 曜日の表と組み方を2枚に戻さない（day-text.js だけが持つ）
  const JS = new URL('../public/js/', import.meta.url);
  for (const f of ['today-md.js', 'usage-days.js']) {
    const src = fs.readFileSync(new URL(f, JS), 'utf8');
    assert.doesNotMatch(src, /'日', '月', '火'/, `${f} が曜日の表を持っている（day-text.js から借りる）`);
    assert.match(src, /from '\.\/day-text\.js';/, `${f} が day-text.js から import していない`);
  }
});
