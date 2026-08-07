/**
 * Slack の応答をどう読むかのテスト。
 *
 * 実際の POST はテストしない（read/ の薄い殻と同じ割り切り）。
 * 見るのは「次にどうするか」の判断だけ。
 * ここを間違えると、直らないものを延々と投げ続けるか、直るものをすぐあきらめる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyResponse } from '../src/notify/slack.mjs';

test('2xx は成功', () => {
  for (const status of [200, 201, 204]) {
    const r = classifyResponse(status, 'ok');
    assert.equal(r.ok, true, String(status));
    assert.equal(r.retry, false);
    assert.equal(r.stop, false);
    assert.equal(r.reason, null);
  }
});

test('404 と 410 は1回で止める', () => {
  // Slack がこれを返すのは Webhook が削除・無効化されたときだけ。繰り返す意味がない
  for (const status of [404, 410]) {
    const r = classifyResponse(status, 'no_service');
    assert.equal(r.retry, false, String(status));
    assert.equal(r.stop, true);
    assert.match(r.reason, /見つかりません/);
  }
});

test('401 と 403 は設定が違うので止める', () => {
  for (const status of [401, 403]) {
    const r = classifyResponse(status, 'invalid_token');
    assert.equal(r.retry, false, String(status));
    assert.equal(r.stop, true);
  }
});

test('400 は再送しないが、機能は止めない', () => {
  // 本文の組み立てがおかしいのはこちらのバグ。1通だけの問題かもしれない
  const r = classifyResponse(400, 'invalid_payload');
  assert.equal(r.retry, false);
  assert.equal(r.stop, false);
  assert.match(r.reason, /invalid_payload/);
});

test('429 は再送する', () => {
  const r = classifyResponse(429, 'rate_limited');
  assert.equal(r.retry, true);
  assert.equal(r.stop, false);
});

test('5xx は再送する', () => {
  for (const status of [500, 502, 503]) {
    const r = classifyResponse(status, '');
    assert.equal(r.retry, true, String(status));
    assert.equal(r.stop, false);
  }
});

test('知らないステータスでも落ちず、再送も停止もしない', () => {
  const r = classifyResponse(302, '');
  assert.equal(r.ok, false);
  assert.equal(r.retry, false);
  assert.equal(r.stop, false);
  assert.match(r.reason, /想定外/);
});

test('本文が長くても理由は1行に収める', () => {
  const r = classifyResponse(400, 'あ'.repeat(500));
  assert.ok(r.reason.length < 200);
});

test('本文が空でも理由が組める', () => {
  const r = classifyResponse(401, '');
  assert.equal(typeof r.reason, 'string');
  // 空の括弧や余計な空白を出さない
  assert.ok(!r.reason.includes('  '));
});
