/**
 * 通知の配線のテスト。
 *
 * watch / message / slack はそれぞれ単体で見ているので、ここで見るのは
 * 「つないだときに正しく動くか」だけ。とくに失敗したときのふるまい。
 *
 * 送信関数を差し替えて、ネットワークには一切出ない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier } from '../src/notify/index.mjs';

const T0 = 1_700_000_000_000;
const WEBHOOK = 'https://hooks.slack.com/services/T00ABCDEF/B11CDEFGH/xyz123abc456';

/** 有効な設定。落ち着き待ちも種まきも無しにして、1回の observe で確定させる。 */
const on = (over = {}) => ({
  enabled: true,
  url: WEBHOOK,
  urlMasked: 'https://hooks.slack.com/services/T00A…/B11C…/****',
  source: 'env',
  settleMs: 0,
  remindMs: 0,
  detail: 'full',
  error: null,
  ...over,
});

/**
 * 通知が見る行を組む。
 *
 * @param {string} [id] tool_use の id
 * @returns {object}
 */
function row(id = 'toolu_1') {
  return {
    sessionId: 'sess-a',
    name: 'sandbox-9c',
    project: 'claude-deck',
    state: 'needs-answer',
    stateLabel: '質問待ち',
    idleMs: 1000,
    waitingFor: { id, tool: 'AskUserQuestion', detail: 'どっちにする？' },
  };
}

/**
 * 決まった応答を返す送信関数と、呼ばれた記録を作る。
 *
 * @param {object} verdict postToSlack と同じ形
 * @returns {object} fn と calls
 */
function spy(verdict = { ok: true, retry: false, stop: false, reason: null }) {
  const calls = [];
  return {
    calls,
    fn: async (url, text) => {
      calls.push({ url, text });
      return verdict;
    },
  };
}

/**
 * 種まきを抜けた通知器を作る。
 *
 * @param {Function} post 送信関数
 * @param {object} [config] 設定
 * @returns {object}
 */
function mk(post, config = on()) {
  const n = createNotifier({ config, bootAt: 0, post });
  n.setBaseUrl('http://127.0.0.1:4317/');
  return n;
}

test('設定が無ければ observe も flush も空振りする', async () => {
  const s = spy();
  const n = createNotifier({
    config: { enabled: false, source: 'none', url: null, urlMasked: null, settleMs: 0, remindMs: 0, detail: 'full', error: null },
    bootAt: 0,
    post: s.fn,
  });

  n.observe([row()], T0);
  await n.flush(T0);

  assert.equal(s.calls.length, 0);
  assert.equal(n.health().enabled, false);
  assert.equal(n.health().state, 'off');
  assert.equal(n.banner(), null);
});

test('待ちが確定したら1通送る', async () => {
  const s = spy();
  const n = mk(s.fn);

  n.observe([row()], T0);
  await n.flush(T0);

  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].url, WEBHOOK);
  assert.match(s.calls[0].text, /\*質問待ち\* sandbox-9c（claude-deck）/);
  assert.match(s.calls[0].text, /127\.0\.0\.1:4317\/\?session=sess-a/);

  const h = n.health();
  assert.equal(h.sent, 1);
  assert.equal(h.failed, 0);
  assert.equal(h.lastOkAt, T0);
});

test('送るものが無ければ投げない', async () => {
  const s = spy();
  const n = mk(s.fn);
  await n.flush(T0);
  assert.equal(s.calls.length, 0);
});

test('404 が返ったら機能ごと止める', async () => {
  const s = spy({ ok: false, retry: false, stop: true, reason: 'Webhook が見つかりません' });
  const n = mk(s.fn);

  n.observe([row()], T0);
  await n.flush(T0);

  const h = n.health();
  assert.equal(h.state, 'disabled');
  assert.match(h.reason, /見つかりません/);
  assert.equal(h.failed, 1);

  // 止まったあとは何を見ても投げない
  n.observe([row('toolu_2')], T0 + 1000);
  await n.flush(T0 + 1000);
  assert.equal(s.calls.length, 1);
});

test('5xx は4秒後に1回だけ再送する', async () => {
  const s = spy({ ok: false, retry: true, stop: false, reason: 'Slack 側が不調です（500）' });
  const n = mk(s.fn);

  n.observe([row()], T0);
  await n.flush(T0);
  assert.equal(s.calls.length, 1);

  // 再送待ちの間は投げない
  await n.flush(T0 + 3999);
  assert.equal(s.calls.length, 1);

  await n.flush(T0 + 4000);
  assert.equal(s.calls.length, 2);

  // 2回試したらあきらめる
  await n.flush(T0 + 20_000);
  assert.equal(s.calls.length, 2);
  assert.equal(n.health().dropped, 1);
});

test('捨てた件数は、次に届いた通知の末尾で伝える', async () => {
  let verdict = { ok: false, retry: true, stop: false, reason: 'だめ' };
  const calls = [];
  const post = async (url, text) => { calls.push(text); return verdict; };
  const n = mk(post);

  n.observe([row('a')], T0);
  await n.flush(T0);
  await n.flush(T0 + 4000);
  assert.equal(n.health().dropped, 1);

  verdict = { ok: true, retry: false, stop: false, reason: null };
  n.observe([row('b')], T0 + 10_000);
  await n.flush(T0 + 10_000);

  assert.match(calls.at(-1), /捨てた通知が 1 件あります/);

  // 同じ件数を二度は書かない
  n.observe([row('c')], T0 + 20_000);
  await n.flush(T0 + 20_000);
  assert.ok(!calls.at(-1).includes('捨てた通知'));
});

test('5回続けて失敗したら止める', async () => {
  const s = spy({ ok: false, retry: false, stop: false, reason: '400 だめ' });
  const n = mk(s.fn);

  for (let i = 0; i < 5; i += 1) {
    const t = T0 + i * 10_000;
    n.observe([row(`t${i}`)], t);
    await n.flush(t);
  }

  const h = n.health();
  assert.equal(h.failed, 5);
  assert.equal(h.state, 'disabled');
  assert.match(h.reason, /5 回続けて/);
});

test('成功が挟まれば失敗の数えは戻る', async () => {
  let verdict = { ok: false, retry: false, stop: false, reason: 'だめ' };
  const n = mk(async () => verdict);

  for (let i = 0; i < 4; i += 1) {
    const t = T0 + i * 10_000;
    n.observe([row(`t${i}`)], t);
    await n.flush(t);
  }
  assert.equal(n.health().state, 'ok');

  verdict = { ok: true, retry: false, stop: false, reason: null };
  n.observe([row('good')], T0 + 100_000);
  await n.flush(T0 + 100_000);

  verdict = { ok: false, retry: false, stop: false, reason: 'だめ' };
  for (let i = 0; i < 4; i += 1) {
    const t = T0 + 200_000 + i * 10_000;
    n.observe([row(`u${i}`)], t);
    await n.flush(t);
  }
  assert.equal(n.health().state, 'ok');
});

test('送信中に呼ばれても重ねて投げない', async () => {
  let release;
  const calls = [];
  const post = async (url, text) => {
    calls.push(text);
    await new Promise((r) => { release = r; });
    return { ok: true, retry: false, stop: false, reason: null };
  };
  const n = mk(post);

  n.observe([row('a')], T0);
  const first = n.flush(T0);

  n.observe([row('b')], T0 + 100);
  await n.flush(T0 + 100);
  assert.equal(calls.length, 1);

  release();
  await first;
  assert.equal(calls.length, 1);
});

test('送信関数が例外を投げても落ちない', async () => {
  const n = mk(async () => { throw new Error('切れた'); });

  n.observe([row()], T0);
  await n.flush(T0);

  const h = n.health();
  assert.equal(h.failed, 1);
  assert.match(h.lastError, /切れた/);
});

test('health は生の URL を返さない', async () => {
  const s = spy();
  const n = mk(s.fn);
  n.observe([row()], T0);
  await n.flush(T0);

  assert.ok(!JSON.stringify(n.health()).includes('xyz123abc456'));
  assert.equal(n.health().target, 'https://hooks.slack.com/services/T00A…/B11C…/****');
});

test('起動時の1行は、有効なら出す', () => {
  assert.match(mk(spy().fn).banner(), /Slack 通知: 有効（環境変数 \/ https:\/\/hooks\.slack\.com/);
  assert.match(
    mk(spy().fn, on({ source: 'config' })).banner(),
    /設定ファイル/,
  );
});

test('URL を書き間違えているときだけ、無効の理由を出す', () => {
  const n = createNotifier({
    config: { enabled: false, source: 'env', url: null, urlMasked: null, settleMs: 0, remindMs: 0, detail: 'full', error: 'URL がおかしい' },
    bootAt: 0,
    post: spy().fn,
  });
  assert.match(n.banner(), /無効（URL がおかしい）/);
});

test('起動直後に見えていた待ちは送らない', async () => {
  // 朝ログオンするたびに昨夜からの待ちが全部飛ぶのを防ぐ
  const s = spy();
  const n = createNotifier({ config: on(), bootAt: T0, post: s.fn });
  n.setBaseUrl('http://127.0.0.1:4317/');

  n.observe([row()], T0 + 500);
  await n.flush(T0 + 500);

  assert.equal(s.calls.length, 0);
  assert.equal(n.health().skipped, 1);
});
