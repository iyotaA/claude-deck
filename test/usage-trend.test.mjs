/**
 * 数値の概要の「新旧の差」と「推移」（public/js/usage-trend.js）。
 *
 * 画面側のファイルだが import ゼロの純関数なので Node から読める
 * （update-banner.test.mjs と同じ形）。
 *
 * 守りたいのは3つ。時刻で割ること（応答の rows は重い順で来る）・
 * 半分どうしの本数を揃えること・0 と不明を混ぜないこと。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { halfTrend, TREND_MIN } from '../public/js/usage-trend.js';

/** 1本ぶんの行。t は時刻の並び（小さいほど古い） */
const row = (t, ite, requests = 10, hitRate = 0.9) => ({ mtimeMs: t, ite, requests, hitRate });

test('時刻で並べ替えてから割る（応答の rows は重い順で来る）', () => {
  // 重い順に並んで届いても、古い2本と新しい2本で比べる
  const v = halfTrend([row(4, 400), row(1, 100), row(3, 300), row(2, 200)]);
  assert.equal(v.half, 2);
  assert.deepEqual(v.ite, { now: 700, base: 300 });
  assert.deepEqual(v.series.ite, [100, 200, 300, 400]);
});

test('1要求あたりは半分ごとの合計で割る（本ごとの値の平均にしない）', () => {
  const v = halfTrend([row(1, 100, 10), row(2, 300, 10), row(3, 100, 1), row(4, 900, 9)]);
  // 古い半分: 400 / 20 = 20。新しい半分: 1000 / 10 = 100
  assert.deepEqual(v.perReq, { now: 100, base: 20 });
  assert.deepEqual(v.series.perReq, [10, 30, 100, 100]);
});

test('本数が奇数なら真ん中の1本はどちらにも入れない', () => {
  const v = halfTrend([row(1, 1), row(2, 2), row(3, 1000), row(4, 4), row(5, 5)]);
  assert.equal(v.half, 2);
  assert.deepEqual(v.ite, { now: 9, base: 3 });
  // 線には全部載せる（割るのは差のためだけ）
  assert.equal(v.series.ite.length, 5);
});

test(`${TREND_MIN} 本に満たなければ比べない`, () => {
  assert.equal(halfTrend([row(1, 1), row(2, 2), row(3, 3)]), null);
  assert.equal(halfTrend([]), null);
  assert.equal(halfTrend(null), null);
});

test('要求が 0 件の行・数が読めない行は落とす（0 と不明を混ぜない）', () => {
  const v = halfTrend([
    row(1, 10), row(2, 20), row(3, 30), row(4, 40),
    row(5, 0, 0),
    { mtimeMs: 6, ite: null, requests: 5 },
    { ite: 99, requests: 5 },
  ]);
  assert.equal(v.half, 2);
  assert.deepEqual(v.series.ite, [10, 20, 30, 40]);
});

test('命中率の線は全部の行で読めるときだけ出す', () => {
  const ok = halfTrend([row(1, 1, 1, 0.5), row(2, 1, 1, 0.6), row(3, 1, 1, 0.7), row(4, 1, 1, 0.8)]);
  assert.deepEqual(ok.series.hitRate, [0.5, 0.6, 0.7, 0.8]);
  const mixed = halfTrend([row(1, 1, 1, 0.5), row(2, 1, 1, null), row(3, 1, 1, 0.7), row(4, 1, 1, 0.8)]);
  assert.equal(mixed.series.hitRate, null);
});
