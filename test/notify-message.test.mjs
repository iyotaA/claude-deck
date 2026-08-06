/**
 * 通知の本文とマスクのテスト。
 *
 * ここで固めたいのは2つ。
 *  - 載せてはいけないものが載らないこと
 *  - Webhook の URL が、どの出口からも生で出ないこと
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildText, escapeSlack, maskWebhook, scrubError, waitLabel } from '../src/notify/message.mjs';

const WEBHOOK = 'https://hooks.slack.com/services/T00ABCDEF/B11CDEFGH/xyz123abc456';

/**
 * watch.mjs が作る項目の形。
 *
 * @param {object} [over] 上書きしたい項目
 * @returns {object}
 */
function item(over = {}) {
  return {
    key: 'sess-a::toolu_1',
    sessionId: 'abc123',
    name: 'sandbox-9c',
    project: 'claude-deck',
    stateLabel: '質問待ち',
    tool: 'AskUserQuestion',
    detail: '通知の送り先は Slack だけでよいですか？',
    kind: 'wait',
    ...over,
  };
}

const BASE = 'http://127.0.0.1:4317/';

test('本文は4行で組む', () => {
  const text = buildText([item()], { baseUrl: BASE });
  assert.equal(text, [
    '*質問待ち* sandbox-9c（claude-deck）',
    '待っているもの: AskUserQuestion',
    '> 通知の送り先は Slack だけでよいですか？',
    '<http://127.0.0.1:4317/?session=abc123|ClaudeDeck で開く>',
  ].join('\n'));
});

test('project が取れなければ括弧ごと省く', () => {
  const text = buildText([item({ project: null })], { baseUrl: BASE });
  assert.ok(text.startsWith('*質問待ち* sandbox-9c\n'));
  // 空の括弧を出さない
  assert.ok(!text.includes('（）'));
});

test('待っているものが取れなければ2行目と3行目を省く', () => {
  const text = buildText([item({ tool: null, detail: null })], { baseUrl: BASE });
  assert.equal(text.split('\n').length, 2);
  // null という文字を絶対に出さない
  assert.ok(!text.includes('null'));
});

test('質問文が空白だけなら引用行を出さない', () => {
  const text = buildText([item({ detail: '   ' })], { baseUrl: BASE });
  assert.ok(!text.includes('\n> '));
});

test('detail を none にすると質問文を落とす', () => {
  const text = buildText([item()], { baseUrl: BASE, detail: 'none' });
  assert.ok(!text.includes('Slack だけでよいですか'));
  // 状態と待っているものは残る
  assert.ok(text.includes('待っているもの: AskUserQuestion'));
});

test('長い質問文は切る', () => {
  const text = buildText([item({ detail: 'あ'.repeat(500) })], { baseUrl: BASE });
  assert.ok(text.includes('…（以下省略）'));
  assert.ok(!text.includes('あ'.repeat(400)));
});

test('URL が決まっていなければリンク行を出さない', () => {
  const text = buildText([item()], { baseUrl: null });
  assert.ok(!text.includes('ClaudeDeck で開く'));
});

test('セッションIDは URL に入れる前にエスケープする', () => {
  const text = buildText([item({ sessionId: 'a b&c' })], { baseUrl: BASE });
  assert.ok(text.includes('?session=a%20b%26c|'));
});

test('複数件は空行で区切って1通にまとめる', () => {
  const text = buildText([
    item(),
    item({ key: 'k2', sessionId: 'def456', name: 'deck-b7', stateLabel: 'プラン承認待ち', tool: 'ExitPlanMode', detail: '# 手順' }),
  ], { baseUrl: BASE });

  assert.ok(text.includes('\n\n*プラン承認待ち* deck-b7'));
});

test('リマインドは、まだ待っていることが分かる形にする', () => {
  const text = buildText([item({ kind: 'remind' })], { baseUrl: BASE });
  assert.ok(text.startsWith('*質問待ち* sandbox-9c（claude-deck） — まだ待っています'));
});

test('捨てた通知があれば末尾で伝える', () => {
  const text = buildText([item()], { baseUrl: BASE, dropped: 3 });
  assert.ok(text.endsWith('（送れないまま捨てた通知が 3 件あります）'));
});

test('捨てた通知が無ければ何も足さない', () => {
  const text = buildText([item()], { baseUrl: BASE, dropped: 0 });
  assert.ok(!text.includes('捨てた通知'));
});

test('項目が無ければ空文字を返す', () => {
  assert.equal(buildText([], { baseUrl: BASE }), '');
  assert.equal(buildText(null, { baseUrl: BASE }), '');
});

test('mrkdwn で意味を持つ3文字を潰す', () => {
  // 送るのは会話ログ由来の文字列で、コードや不等号がふつうに入る
  assert.equal(escapeSlack('a < b && c > d'), 'a &lt; b &amp;&amp; c &gt; d');
});

test('& を先に置き換える', () => {
  // 順番を逆にすると、置き換えで作った &lt; がもう一度壊れる
  assert.equal(escapeSlack('<'), '&lt;');
  assert.equal(escapeSlack('&lt;'), '&amp;lt;');
});

test('質問文の中の記号がリンクを壊さない', () => {
  const text = buildText([item({ detail: '<https://evil|押して> でいい？' })], { baseUrl: BASE });
  assert.ok(text.includes('&lt;https://evil|押して&gt;'));
  // 自前のリンクだけが生の < > を持つ
  assert.equal(text.match(/<http:\/\/127\.0\.0\.1/g).length, 1);
});

test('Webhook の URL は末尾を伏せる', () => {
  const masked = maskWebhook(WEBHOOK);
  assert.equal(masked, 'https://hooks.slack.com/services/T00A…/B11C…/****');
  assert.ok(!masked.includes('xyz123abc456'));
});

test('services は伏せない', () => {
  // 誰の URL でも同じ固定文字列。伏せると serv… という読みにくい断片が出るだけ
  assert.ok(maskWebhook(WEBHOOK).includes('/services/'));
});

test('services が無い形でも落ちない', () => {
  const masked = maskWebhook('https://hooks.slack.com/T9/B9/secretsecret');
  assert.ok(!masked.includes('secretsecret'));
  assert.ok(masked.endsWith('/****'));
});

test('URL が無ければマスクも null', () => {
  assert.equal(maskWebhook(null), null);
  assert.equal(maskWebhook(''), null);
  assert.equal(maskWebhook(123), null);
});

test('Slack 以外の URL は中身を出さずに知らせる', () => {
  const masked = maskWebhook('https://evil.example.com/hook/secret-token');
  assert.ok(!masked.includes('secret-token'));
  assert.ok(!masked.includes('evil.example.com'));
});

test('例外の文言から URL を消す', () => {
  // fetch の失敗メッセージには URL がそのまま埋め込まれ得る
  const s = scrubError(`request to ${WEBHOOK} failed`, WEBHOOK);
  assert.ok(!s.includes('xyz123abc456'));
  assert.ok(s.includes('failed'));
});

test('設定値を知らなくても、形で拾えるものは消す', () => {
  const s = scrubError('POST https://hooks.slack.com/services/T9/B9/zzz -> 500', null);
  assert.ok(!s.includes('zzz'));
  assert.ok(s.includes('500'));
});

test('URL の中に正規表現の記号があっても壊れない', () => {
  const odd = 'https://hooks.slack.com/services/T+A/B(1)/x*y';
  assert.ok(!scrubError(`ng: ${odd}`, odd).includes('x*y'));
});

// --- 待っている長さ ---
//
// 返信待ちには待っているツールも質問文も無い。これが無いと見出し1行だけになる。

test('1分に満たない待ちは書かない', () => {
  // 「0分待っています」は情報が無いうえ、急かしているように読める
  assert.equal(waitLabel(0), null);
  assert.equal(waitLabel(59_999), null);
});

test('分で書く', () => {
  assert.equal(waitLabel(60_000), '1分');
  assert.equal(waitLabel(130_000), '2分');
  assert.equal(waitLabel(59 * 60_000), '59分');
});

test('1時間を超えたら時間と分で書く', () => {
  assert.equal(waitLabel(60 * 60_000), '1時間0分');
  assert.equal(waitLabel(95 * 60_000), '1時間35分');
});

test('取れなかった待ちは 0 と書かない', () => {
  for (const v of [null, undefined, NaN, Infinity, '3分']) assert.equal(waitLabel(v), null);
});

test('返信待ちの本文は見出しと待ち時間とリンクだけになる', () => {
  const text = buildText([{
    sessionId: 'sess-a', name: 'sandbox-9c', project: 'claude-deck',
    stateLabel: '返信待ち', tool: null, detail: null, idleMs: 130_000, kind: 'wait',
  }], { baseUrl: 'http://127.0.0.1:4317/' });

  assert.match(text, /^\*返信待ち\* sandbox-9c（claude-deck）$/m);
  assert.match(text, /^2分待っています$/m);
  // 待っているツールが無いのだから、その行は出さない
  assert.ok(!text.includes('待っているもの'));
  assert.ok(!text.includes('null'));
});
