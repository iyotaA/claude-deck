/**
 * 画面側の実行の台帳。public/js/runs.js の判断だけを見る。
 *
 * 画面側のファイルだが、`rateView()` / `ringView()` は DOM を1つも触らない純関数なので
 * Node から import できる（`md.test.mjs` と同じ形。`runs.js` は
 * `EventSource` を関数の中でしか呼ばないので、読み込むだけなら何も起きない）。
 *
 * 見るのは枠の使用率の判断1点。**アカウント共通の値を左のレールの輪に1つだけ出す**ため、
 * 「いつ測ったか」と「もう空いたか」を間違えると、古い数を今の数の顔で出すことになる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateView, ringView, RATE_STALE_MS, RATE_WEEK_MS, RATE_HOT, RATE_WARN } from '../public/js/runs.js';

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
  assert.equal(v.five.text, '37%');
  assert.equal(v.seven.text, '72%');
});

test('0 は 0% として出す。読めなかった（不明）とは別物', () => {
  const v = rateView(rl({ fiveHour: 0, sevenDay: null }), NOW);
  assert.equal(v.five.text, '0%');
  assert.equal(v.seven, null, '読めなかったほうは null のまま');
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
  assert.equal(v.five, null);
  assert.equal(v.seven.text, '72%');
});

test('resetsAt を過ぎて7日枠も読めなければ、まるごと出さない', () => {
  const v = rateView(rl({ resetsAt: SEC(NOW - 1000), sevenDay: null }), NOW);
  assert.equal(v, null);
});

test('resetsAt はミリ秒ではなく秒として読む', () => {
  // ミリ秒として比べると必ず過去になり、5時間枠が常に落ちる
  const v = rateView(rl({ resetsAt: SEC(NOW + 1000) }), NOW);
  assert.equal(v.gone, false);
  assert.equal(v.five.text, '37%');
});

test('resetsAt が読めなければ空いたとは言わない', () => {
  const v = rateView(rl({ resetsAt: null }), NOW);
  assert.equal(v.gone, false);
  assert.equal(v.resetsAt, null);
  assert.equal(v.five.text, '37%');
});

/* --------------------------------------------------- 7日より古い観測 */

test('7日の枠は、測ってからちょうど7日なら残す', () => {
  const v = rateView(rl({ at: NOW - RATE_WEEK_MS, resetsAt: null }), NOW);
  assert.equal(v.seven.text, '72%');
});

test('7日の枠は、測ってから7日を少しでも過ぎたら落とす（5時間枠はそのまま）', () => {
  // 7日の枠を測った数は、7日経てば今の枠を何も表していない
  const v = rateView(rl({ at: NOW - RATE_WEEK_MS - 1, resetsAt: SEC(NOW + 60_000) }), NOW);
  assert.equal(v.seven, null);
  assert.equal(v.five.text, '37%', '5時間枠の扱いは resetsAt だけで決まる（年齢では落とさない）');
  // 名前では「読めていない」と言わない（読めたが古すぎる、が正しい）
  assert.match(ringView(v).label, /7日枠は測ってから7日を過ぎた/);
  assert.doesNotMatch(ringView(v).label, /7日\s*読めていません/);
});

test('7日の枠を落として5時間枠も空いていれば、何も出さない', () => {
  const v = rateView(rl({ at: NOW - 31 * 24 * 60 * 60_000, resetsAt: SEC(NOW - 1000) }), NOW);
  assert.equal(v, null);
});

test('7日以内の古い観測は、今どおり古い印（何日前か）つきで出す', () => {
  const v = rateView(rl({ at: NOW - 3 * 24 * 60 * 60_000, resetsAt: null }), NOW);
  assert.equal(v.seven.text, '72%');
  assert.equal(v.age, '3日前');
  assert.equal(ringView(v).stale, true);
});

/* -------------------------------------------------------------- 目立たせ */

test('9割を超えたら赤の段にする', () => {
  assert.equal(rateView(rl({ fiveHour: RATE_HOT }), NOW).five.tone, 'hot');
  assert.equal(rateView(rl({ fiveHour: 0.5, sevenDay: 0.95 }), NOW).seven.tone, 'hot');
  const v = rateView(rl(), NOW);
  assert.deepEqual([v.five.tone, v.seven.tone], ['', '']);
});

test('空いた5時間枠は目立たせない', () => {
  // 落とした数で赤くすると、消えた数の理由が画面のどこにも無くなる
  const v = rateView(rl({ fiveHour: 0.99, resetsAt: SEC(NOW - 1000) }), NOW);
  assert.equal(v.five, null);
  assert.equal(v.seven.tone, '');
});

/* ------------------------------------------------------------ 枠ごとの形 */

test('枠は名前ではなく鍵（five / seven）で持つ。どちらも長さ・字・色の段・丸める前の値を持つ', () => {
  const v = rateView(rl(), NOW);
  assert.deepEqual(v.five, { value: 0.37, ratio: 0.37, text: '37%', tone: '' });
  assert.deepEqual(v.seven, { value: 0.72, ratio: 0.72, text: '72%', tone: '' });
});

test('0 は 0 として持ち、読めなかった枠は null にする', () => {
  const v = rateView(rl({ fiveHour: 0, sevenDay: null }), NOW);
  assert.deepEqual(v.five, { value: 0, ratio: 0, text: '0%', tone: '' });
  assert.equal(v.seven, null);
});

test('色の段は RATE_WARN で黄、RATE_HOT で赤（境目ちょうどは上の段）', () => {
  const tone = (x) => rateView(rl({ fiveHour: x, sevenDay: null }), NOW).five.tone;
  assert.equal(tone(RATE_WARN - 0.01), '');
  assert.equal(tone(RATE_WARN), 'warn');
  assert.equal(tone(RATE_HOT - 0.01), 'warn');
  assert.equal(tone(RATE_HOT), 'hot');
});

test('弧の長さは 0〜1 に丸める（文字と丸める前の値は届いた値のまま）', () => {
  const m = rateView(rl({ fiveHour: 1.2, sevenDay: null }), NOW).five;
  assert.equal(m.ratio, 1);
  assert.equal(m.text, '120%');
  assert.equal(m.value, 1.2);
});

/* ------------------------------------------------------------ レールの輪 */

/** rateView を通してから輪の形にする（画面と同じ順で呼ぶ） */
const ring = (over = {}, now = NOW) => ringView(rateView(rl(over), now));

test('輪: 出すものが無ければ null（輪ごと出さない）', () => {
  assert.equal(ringView(null), null);
  assert.equal(ring({ fiveHour: null, sevenDay: null }), null);
});

test('輪: 両方読めたら外（5時間）と内（7日）を持ち、真ん中は高いほうの数', () => {
  const r = ring();
  assert.deepEqual(r.five, { value: 0.37, ratio: 0.37, text: '37%', tone: '' });
  assert.deepEqual(r.seven, { value: 0.72, ratio: 0.72, text: '72%', tone: '' });
  // 真ん中は % を付けない。12px で「100%」は内側の輪に収まらないため（% は吹き出しと読み上げが持つ）
  assert.equal(r.peak, '72');
  assert.equal(ring({ fiveHour: 0.91, sevenDay: 0.4 }).peak, '91');
});

test('輪: 片方しか読めなければ、もう片方は null（溝だけ残して弧を描かない）', () => {
  const gone = ring({ resetsAt: SEC(NOW - 1000) });
  assert.equal(gone.five, null, '空いた5時間枠は描かない');
  assert.deepEqual(gone.seven, { value: 0.72, ratio: 0.72, text: '72%', tone: '' });
  assert.equal(gone.peak, '72');

  const onlyFive = ring({ sevenDay: null });
  assert.equal(onlyFive.seven, null);
  assert.equal(onlyFive.peak, '37');
});

test('輪: 0 は 0 として持つ（読めなかったとは別物）', () => {
  const r = ring({ fiveHour: 0, sevenDay: null });
  assert.deepEqual(r.five, { value: 0, ratio: 0, text: '0%', tone: '' });
  assert.equal(r.seven, null);
  assert.equal(r.peak, '0');
});

test('輪: 色の段は rateView のものを引き継ぐ', () => {
  const r = ring({ fiveHour: RATE_WARN, sevenDay: RATE_HOT });
  assert.equal(r.five.tone, 'warn');
  assert.equal(r.seven.tone, 'hot');
});

test('輪: 真ん中の数は丸める前の値で比べる（どちらも 100% を超えたとき）', () => {
  // 弧の長さは 0〜1 に丸まるので、ratio だけで比べると高いほうを取り違える
  assert.equal(ring({ fiveHour: 1.2, sevenDay: 1.05 }).peak, '120');
});

test('輪: 古い観測は stale を立て、吹き出しに何分前かを出す', () => {
  const fresh = ring();
  assert.equal(fresh.stale, false);

  const old = ring({ at: NOW - 12 * 60_000 });
  assert.equal(old.stale, true);
  assert.match(old.label, /12分前/);
});

test('輪: 名前（読み上げと吹き出し）に「枠の使用率」と両方の % と測った時刻を入れる', () => {
  const r = ring();
  assert.match(r.label, /^枠の使用率/);
  assert.match(r.label, /5時間\s*37%/);
  assert.match(r.label, /7日\s*72%/);
  assert.match(r.label, /測ったのは/);
  assert.match(r.label, /5時間枠が空くのは/);
});

test('輪: 読めていない枠は、名前の中でもそう言う（0% と書かない）', () => {
  const r = ring({ sevenDay: null });
  assert.doesNotMatch(r.label, /7日\s*0%/);
  assert.match(r.label, /7日\s*読めていません/);

  const gone = ring({ resetsAt: SEC(NOW - 1000) });
  assert.match(gone.label, /5時間枠は空いたはず/);
  assert.doesNotMatch(gone.label, /空くのは/);
});
