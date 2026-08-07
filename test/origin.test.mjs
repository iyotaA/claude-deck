/**
 * 書き込み口の門番のテスト。
 *
 * ここが通してしまうと、利用者が開いた任意のページから
 * Webhook を書き換えられる。以後の質問文がまるごとそちらへ流れる。
 * 実害のある穴なので、全分岐をここで通す。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalAuthority, isTrustedWrite } from '../src/shared/origin.mjs';

const PORT = 4317;

/**
 * ふつうに通るヘッダ。
 *
 * @param {object} [over] 上書きしたい項目
 * @returns {object}
 */
function headers(over = {}) {
  return {
    host: '127.0.0.1:4317',
    'content-type': 'application/json',
    origin: 'http://127.0.0.1:4317',
    'sec-fetch-site': 'same-origin',
    ...over,
  };
}

test('自分自身からの書き込みは通す', () => {
  assert.deepEqual(isTrustedWrite(headers(), PORT), { ok: true });
});

test('localhost でも通す', () => {
  const h = headers({ host: 'localhost:4317', origin: 'http://localhost:4317' });
  assert.equal(isTrustedWrite(h, PORT).ok, true);
});

test('文字集合つきの content-type も通す', () => {
  const h = headers({ 'content-type': 'application/json; charset=utf-8' });
  assert.equal(isTrustedWrite(h, PORT).ok, true);
});

test('大文字の content-type も通す', () => {
  const h = headers({ 'content-type': 'Application/JSON' });
  assert.equal(isTrustedWrite(h, PORT).ok, true);
});

// --- form からの送信を止める ---
//
// <form method="post"> は CORS の事前確認なしに飛ぶ。
// 名乗れる content-type は3つに限られていて、application/json は入っていない。

test('form が名乗れる content-type は断る', () => {
  for (const type of [
    'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=x',
    'text/plain',
  ]) {
    const r = isTrustedWrite(headers({ 'content-type': type }), PORT);
    assert.equal(r.ok, false, type);
    assert.equal(r.status, 415, type);
  }
});

test('content-type が無ければ断る', () => {
  const h = headers();
  delete h['content-type'];
  assert.equal(isTrustedWrite(h, PORT).status, 415);
});

// --- 他所のページからの送信を止める ---

test('他所の origin は断る', () => {
  const r = isTrustedWrite(headers({ origin: 'http://evil.example' }), PORT);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('似せた origin も断る', () => {
  for (const origin of [
    'http://127.0.0.1.evil.example:4317',
    'http://localhost.evil.example:4317',
    'https://evil.example/127.0.0.1:4317',
  ]) {
    assert.equal(isTrustedWrite(headers({ origin }), PORT).ok, false, origin);
  }
});

test('ポートが違う origin は断る', () => {
  // 同じ 127.0.0.1 でも、別のポートで動く何かは自分自身ではない
  assert.equal(isTrustedWrite(headers({ origin: 'http://127.0.0.1:8080' }), PORT).ok, false);
});

test('sandbox 化された iframe の origin: null は断る', () => {
  assert.equal(isTrustedWrite(headers({ origin: 'null' }), PORT).ok, false);
});

test('sec-fetch-site が cross-site なら断る', () => {
  for (const site of ['cross-site', 'same-site']) {
    const r = isTrustedWrite(headers({ 'sec-fetch-site': site }), PORT);
    assert.equal(r.ok, false, site);
    assert.equal(r.status, 403, site);
  }
});

test('sec-fetch-site: none は通す', () => {
  // アドレス欄に打った、ブックマークから開いた等。他所のページからではない
  assert.equal(isTrustedWrite(headers({ 'sec-fetch-site': 'none' }), PORT).ok, true);
});

// --- DNS 再バインド対策 ---
//
// 攻撃者の持つ名前を 127.0.0.1 に向けられても、host にはその名前が載る。

test('host が別の名前なら断る', () => {
  const r = isTrustedWrite(headers({ host: 'evil.example:4317' }), PORT);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('host のポートが違えば断る', () => {
  assert.equal(isTrustedWrite(headers({ host: '127.0.0.1:8080' }), PORT).ok, false);
});

test('host が無ければ断る', () => {
  const h = headers();
  delete h.host;
  assert.equal(isTrustedWrite(h, PORT).ok, false);
});

// --- 手元の道具からは origin が付かない ---

test('origin と sec-fetch-site が無くても、host と content-type が合えば通す', () => {
  // curl での診断ができなくなるので必須にしない。
  // ブラウザ経由の攻撃は content-type と host の側で止まる
  const h = { host: '127.0.0.1:4317', 'content-type': 'application/json' };
  assert.equal(isTrustedWrite(h, PORT).ok, true);
});

test('ヘッダが無くても落ちない', () => {
  assert.equal(isTrustedWrite(undefined, PORT).ok, false);
  assert.equal(isTrustedWrite(null, PORT).ok, false);
});

// --- ずれたポートで動いているとき ---

test('ずれて listen したポートで照合する', () => {
  const h = headers({ host: '127.0.0.1:4319', origin: 'http://127.0.0.1:4319' });
  assert.equal(isTrustedWrite(h, 4319).ok, true);
  // 既定のポートで来たものは、いまのポートではないので断る
  assert.equal(isTrustedWrite(headers(), 4319).ok, false);
});

// --- 権限部分の読み方 ---

test('IPv6 の形も読める', () => {
  assert.equal(isLocalAuthority('[::1]:4317', 4317), true);
  assert.equal(isLocalAuthority('[::1]:8080', 4317), false);
});

test('ポートが書かれていない形は通さない', () => {
  // 80 番で動くこのアプリは無い。書かれていないものは別物として扱う
  assert.equal(isLocalAuthority('127.0.0.1', 4317), false);
  assert.equal(isLocalAuthority('localhost', 4317), false);
});

test('文字列でなければ通さない', () => {
  for (const v of [null, undefined, 4317, {}, ['127.0.0.1:4317']]) {
    assert.equal(isLocalAuthority(v, 4317), false, String(v));
  }
});
