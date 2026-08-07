/**
 * 画面から来た設定の検証と併合のテスト。
 *
 * ここが本丸。利用者の入力を受けてディスクへ書く唯一の場所なので、
 * 「変えない」と「消す」の取り違え、他のキーの巻き込みを潰しておく。
 *
 * 実際の書き込み（writeSettings）はテストしない。
 * read/ の薄い殻と同じ割り切りで、判断だけを純関数に切り出してある。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSettings, validateSettings } from '../src/notify/settings.mjs';

const OK_URL = 'https://hooks.slack.com/services/T00ABCDEF/B11CDEFGH/xyz123abc456';

/**
 * 検証を通して差分だけを取り出す。落ちたら例外にする。
 *
 * @param {*} body 受け取った JSON
 * @returns {object}
 */
function patchOf(body) {
  const r = validateSettings(body);
  assert.equal(r.ok, true, r.error);
  return r.patch;
}

// --- Webhook URL ---
//
// 入力欄は常に空で開き、いまの値は placeholder にマスクで出す。
// なので「キーが無い＝変えない」「空文字＝消す」で表せる。

test('キーが無ければ URL に触らない', () => {
  const patch = patchOf({ settleSec: 10 });
  assert.equal('slackWebhookUrl' in patch, false);
});

test('空文字は消す指示', () => {
  assert.equal(patchOf({ slackWebhookUrl: '' }).slackWebhookUrl, '');
  assert.equal(patchOf({ slackWebhookUrl: null }).slackWebhookUrl, '');
});

test('前後の空白は落として入れる', () => {
  assert.equal(patchOf({ slackWebhookUrl: `  ${OK_URL} ` }).slackWebhookUrl, OK_URL);
});

test('hooks.slack.com 以外は断る', () => {
  const r = validateSettings({ slackWebhookUrl: 'https://evil.example.com/hook/x' });
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test('断った URL は応答に含めない', () => {
  // 別サービスの鍵を貼り間違えている可能性がある
  const r = validateSettings({ slackWebhookUrl: 'https://example.com/hook/very-secret-token' });
  assert.ok(!JSON.stringify(r).includes('very-secret-token'));
});

test('文字列でない URL は断る', () => {
  assert.equal(validateSettings({ slackWebhookUrl: 42 }).ok, false);
  assert.equal(validateSettings({ slackWebhookUrl: { url: OK_URL } }).ok, false);
});

test('http は断る', () => {
  assert.equal(validateSettings({ slackWebhookUrl: 'http://hooks.slack.com/services/a/b/c' }).ok, false);
});

// --- 数値 ---

test('0 は通す', () => {
  // 返信待ちの 0 は「通知しない」という明示の指定
  assert.equal(patchOf({ idleMin: 0 }).idleMin, 0);
});

test('負の数は断る', () => {
  assert.equal(validateSettings({ settleSec: -1 }).ok, false);
});

test('数にならない値は断る', () => {
  for (const v of ['すぐ', NaN, Infinity, null, {}, []]) {
    assert.equal(validateSettings({ settleSec: v }).ok, false, String(v));
  }
});

test('数字の文字列は受ける', () => {
  // 入力欄から来るのは文字列
  assert.equal(patchOf({ settleSec: '15' }).settleSec, 15);
});

test('上限を超えたら断る', () => {
  // サーバーが黙って丸めると、画面には入れた値が残って食い違う
  assert.equal(validateSettings({ settleSec: 601 }).ok, false);
  assert.equal(validateSettings({ idleMin: 1441 }).ok, false);
  assert.equal(validateSettings({ remindMin: 1441 }).ok, false);
});

test('上限ちょうどは通す', () => {
  assert.equal(patchOf({ settleSec: 600 }).settleSec, 600);
});

test('小数は丸める', () => {
  assert.equal(patchOf({ settleSec: 6.4 }).settleSec, 6);
});

test('キーが無い数値には触らない', () => {
  const patch = patchOf({ detail: 'none' });
  assert.deepEqual(Object.keys(patch), ['detail']);
});

// --- 質問文の扱い ---

test('full と none だけ受ける', () => {
  assert.equal(patchOf({ detail: 'none' }).detail, 'none');
  assert.equal(patchOf({ detail: 'FULL' }).detail, 'full');
  assert.equal(validateSettings({ detail: 'すこし' }).ok, false);
});

// --- 通知する状態 ---

test('知っている状態だけ受ける', () => {
  const patch = patchOf({ states: { 'awaiting-reply': false, 'needs-coffee': true } });
  assert.deepEqual(patch.states, { 'awaiting-reply': false });
});

test('真偽値でない値は断る', () => {
  assert.equal(validateSettings({ states: { 'awaiting-reply': 'off' } }).ok, false);
});

test('状態の形が違えば断る', () => {
  assert.equal(validateSettings({ states: ['awaiting-reply'] }).ok, false);
  assert.equal(validateSettings({ states: 'none' }).ok, false);
});

// --- 本文そのもの ---

test('本文の形が違えば断る', () => {
  for (const body of [null, undefined, 'x', 42, ['a']]) {
    assert.equal(validateSettings(body).ok, false, String(body));
  }
});

test('空の本文は何も変えない差分になる', () => {
  assert.deepEqual(patchOf({}), {});
});

test('知らないキーは黙って落とす', () => {
  assert.deepEqual(patchOf({ これから足すやつ: true }), {});
});

// --- 併合 ---

test('知らないキーを残す', () => {
  // config.json はこの機能だけのものではない
  const next = mergeSettings({ theme: 'dark', notify: { よそのキー: 1 } }, { settleSec: 3 });
  assert.equal(next.theme, 'dark');
  assert.equal(next.notify.よそのキー, 1);
  assert.equal(next.notify.settleSec, 3);
});

test('触っていない項目は持ち越す', () => {
  const next = mergeSettings({ notify: { slackWebhookUrl: OK_URL, idleMin: 5 } }, { settleSec: 3 });
  assert.equal(next.notify.slackWebhookUrl, OK_URL);
  assert.equal(next.notify.idleMin, 5);
});

test('空文字の URL はキーごと落とす', () => {
  // 残すと、環境変数の初期値まで空文字に負けて効かなくなる
  const next = mergeSettings({ notify: { slackWebhookUrl: OK_URL } }, { slackWebhookUrl: '' });
  assert.equal('slackWebhookUrl' in next.notify, false);
});

test('状態は上書きではなく重ねる', () => {
  const before = { notify: { states: { 'needs-answer': false, 'awaiting-reply': true } } };
  const next = mergeSettings(before, { states: { 'awaiting-reply': false } });
  assert.deepEqual(next.notify.states, { 'needs-answer': false, 'awaiting-reply': false });
});

test('元のファイルが無くても組める', () => {
  const next = mergeSettings(null, { settleSec: 3 });
  assert.deepEqual(next, { notify: { settleSec: 3 } });
});

test('元のファイルが壊れた形でも落ちない', () => {
  for (const file of ['いろいろ', 42, ['a'], { notify: 'いろいろ' }, { notify: ['a'] }]) {
    const next = mergeSettings(file, { settleSec: 3 });
    assert.equal(next.notify.settleSec, 3);
  }
});

test('元のファイルを書き換えない', () => {
  // 読み込んだものを直に触ると、書き込みに失敗したときに食い違う
  const before = { notify: { idleMin: 5 } };
  mergeSettings(before, { idleMin: 9, states: { 'awaiting-reply': false } });
  assert.deepEqual(before, { notify: { idleMin: 5 } });
});
