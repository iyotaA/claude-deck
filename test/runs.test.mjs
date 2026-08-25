/**
 * 画面側の実行の台帳。public/js/runs.js の判断だけを見る。
 *
 * 画面側のファイルだが、`rateView()` は DOM を1つも触らない純関数なので
 * Node から import できる（`md.test.mjs` と同じ形。`runs.js` は
 * `EventSource` を関数の中でしか呼ばないので、読み込むだけなら何も起きない）。
 *
 * 見るのは枠の使用率の判断1点。**アカウント共通の値を上のバーに1つだけ出す**ため、
 * 「いつ測ったか」と「もう空いたか」を間違えると、古い数を今の数の顔で出すことになる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateView, RATE_STALE_MS, RATE_HOT } from '../public/js/runs.js';

/** 2026-08-25 20:36:49 JST 相当。値そのものに意味は無い */
const NOW = 1787657809199;

/** 秒の unix 時刻。resetsAt はミリ秒ではない（実測） */
const SEC = (ms) => Math.floor(ms / 1000);

const rl = (over = {}) => ({
  fiveHour: 0.37,
  sevenDay: 0.72,
  resetsAt: SEC(NOW + 60 * 60_000),
  at: NOW,
  ...over,
});

/* ------------------------------------------------------------------ 基本 */

test('割合は百分率になる', () => {
  const v = rateView(rl(), NOW);
  assert.equal(v.fiveHour, '37%');
  assert.equal(v.sevenDay, '72%');
});

test('0 は 0% として出す。読めなかった（不明）とは別物', () => {
  const v = rateView(rl({ fiveHour: 0, sevenDay: null }), NOW);
  assert.equal(v.fiveHour, '0%');
  assert.equal(v.sevenDay, null, '読めなかったほうは null のまま');
});

test('どちらも読めなければ出さない', () => {
  assert.equal(rateView(rl({ fiveHour: null, sevenDay: null }), NOW), null);
});

test('観測そのものが無ければ出さない', () => {
  assert.equal(rateView(null, NOW), null);
  assert.equal(rateView(undefined, NOW), null);
});

/* ------------------------------------------------------- いつ測ったか */

test('測ったばかりなら但し書きを出さない', () => {
  assert.equal(rateView(rl({ at: NOW - 60_000 }), NOW).age, null);
});

test('5分より古ければ「いつ測ったか」を添える', () => {
  assert.equal(rateView(rl({ at: NOW - RATE_STALE_MS }), NOW).age, '5分前');
});

test('但し書きは分より細かくしない', () => {
  // 毎秒呼ばれるので、秒まで出すと印が毎秒変わって組み直しを止められない
  const a = rateView(rl({ at: NOW - 12 * 60_000 - 30_000 }), NOW).age;
  const b = rateView(rl({ at: NOW - 12 * 60_000 - 59_000 }), NOW).age;
  assert.equal(a, '12分前');
  assert.equal(b, a, '同じ分のうちは同じ文字');
});

test('1時間・1日を跨ぐと単位が上がる', () => {
  assert.equal(rateView(rl({ at: NOW - 90 * 60_000 }), NOW).age, '1時間前');
  assert.equal(rateView(rl({ at: NOW - 50 * 60 * 60_000 }), NOW).age, '2日前');
});

/* ------------------------------------------------------------ 空いた枠 */

test('resetsAt を過ぎたら5時間枠は落とす。7日枠は残す', () => {
  // 空いているのに古い数を今の数の顔で出さない。
  // 新しい数は次の rate_limit_event が来るまで分からないので、そこは黙る
  const v = rateView(rl({ resetsAt: SEC(NOW - 1000) }), NOW);
  assert.equal(v.gone, true);
  assert.equal(v.fiveHour, null);
  assert.equal(v.sevenDay, '72%');
});

test('resetsAt を過ぎて7日枠も読めなければ、まるごと出さない', () => {
  const v = rateView(rl({ resetsAt: SEC(NOW - 1000), sevenDay: null }), NOW);
  assert.equal(v, null);
});

test('resetsAt はミリ秒ではなく秒として読む', () => {
  // ミリ秒として比べると必ず過去になり、5時間枠が常に落ちる
  const v = rateView(rl({ resetsAt: SEC(NOW + 1000) }), NOW);
  assert.equal(v.gone, false);
  assert.equal(v.fiveHour, '37%');
});

test('resetsAt が読めなければ空いたとは言わない', () => {
  const v = rateView(rl({ resetsAt: null }), NOW);
  assert.equal(v.gone, false);
  assert.equal(v.resetsAt, null);
  assert.equal(v.fiveHour, '37%');
});

/* -------------------------------------------------------------- 目立たせ */

test('9割を超えたら目立たせる', () => {
  assert.equal(rateView(rl({ fiveHour: RATE_HOT }), NOW).hot, true);
  assert.equal(rateView(rl({ fiveHour: 0.5, sevenDay: 0.95 }), NOW).hot, true);
  assert.equal(rateView(rl(), NOW).hot, false);
});

test('空いた5時間枠は目立たせない', () => {
  // 落とした数で赤くすると、消えた数の理由が画面のどこにも無くなる
  const v = rateView(rl({ fiveHour: 0.99, resetsAt: SEC(NOW - 1000) }), NOW);
  assert.equal(v.hot, false);
});
