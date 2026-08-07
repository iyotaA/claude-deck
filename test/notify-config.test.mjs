/**
 * 通知の設定のテスト。
 *
 * 見ているのは優先順（画面が先）と、URL の検証。
 * 実際のファイル読み取り（loadNotifyConfig）はテストしない。
 * read/ の薄い殻と同じ割り切りで、判断だけを純関数に切り出してある。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNotifyConfig } from '../src/notify/config.mjs';

const OK_URL = 'https://hooks.slack.com/services/T00ABCDEF/B11CDEFGH/xyz123abc456';
const OK_URL2 = 'https://hooks.slack.com/services/T22ZZZZZZ/B33YYYYYY/aaa000bbb111';

test('設定がどこにも無ければ、黙って無効になる', () => {
  const c = parseNotifyConfig({ env: {}, file: null });
  assert.equal(c.enabled, false);
  assert.equal(c.source, 'none');
  // エラーも警告も出さない。summary.mjs の「鍵が無ければ黙る」と同じ扱い
  assert.equal(c.error, null);
  assert.equal(c.urlMasked, null);
});

test('環境変数だけで有効になる', () => {
  const c = parseNotifyConfig({ env: { CLAUDE_DECK_SLACK_WEBHOOK: OK_URL } });
  assert.equal(c.enabled, true);
  assert.equal(c.source, 'env');
  assert.equal(c.url, OK_URL);
  assert.ok(c.urlMasked.endsWith('/****'));
});

test('設定ファイルだけでも有効になる', () => {
  const c = parseNotifyConfig({ env: {}, file: { notify: { slackWebhookUrl: OK_URL } } });
  assert.equal(c.enabled, true);
  assert.equal(c.source, 'config');
});

test('両方あれば画面（設定ファイル）が勝つ', () => {
  // 環境変数は「まだ画面で設定していないとき」の初期値に格下げしてある
  const c = parseNotifyConfig({
    env: { CLAUDE_DECK_SLACK_WEBHOOK: OK_URL },
    file: { notify: { slackWebhookUrl: OK_URL2 } },
  });
  assert.equal(c.url, OK_URL2);
  assert.equal(c.source, 'config');
});

test('負けている環境変数が立っていることは伝える', () => {
  // 黙って勝つと「設定したのに効かない」と同じ迷い方になる
  const c = parseNotifyConfig({
    env: { CLAUDE_DECK_SLACK_WEBHOOK: OK_URL, CLAUDE_DECK_NOTIFY_IDLE: '9' },
    file: { notify: { slackWebhookUrl: OK_URL2, idleMin: 3 } },
  });
  assert.equal(c.envSet.webhook, true);
  assert.equal(c.envSet.idle, true);
  assert.equal(c.sources.webhook, 'config');
  assert.equal(c.sources.idle, 'config');
});

test('環境変数しか無ければ、そこから来たと伝える', () => {
  const c = parseNotifyConfig({ env: { CLAUDE_DECK_NOTIFY_IDLE: '9' } });
  assert.equal(c.sources.idle, 'env');
  assert.equal(c.idleSettleMs, 9 * 60_000);
});

test('どちらにも無ければ none', () => {
  const c = parseNotifyConfig({ env: {} });
  assert.equal(c.sources.idle, 'none');
  assert.equal(c.sources.detail, 'none');
  assert.equal(c.envSet.remind, false);
});

test('前後の空白は落とす', () => {
  const c = parseNotifyConfig({ env: { CLAUDE_DECK_SLACK_WEBHOOK: `  ${OK_URL}  ` } });
  assert.equal(c.url, OK_URL);
});

test('空文字の環境変数は「無い」として扱う', () => {
  // set CLAUDE_DECK_SLACK_WEBHOOK= のように空で立っていることがある
  const c = parseNotifyConfig({
    env: { CLAUDE_DECK_SLACK_WEBHOOK: '' },
    file: { notify: { slackWebhookUrl: OK_URL2 } },
  });
  assert.equal(c.source, 'config');
  assert.equal(c.url, OK_URL2);
});

test('hooks.slack.com 以外は弾く', () => {
  // タイポで別のホストへ業務内容を POST する事故を機能で防ぐ
  const c = parseNotifyConfig({ env: { CLAUDE_DECK_SLACK_WEBHOOK: 'https://evil.example.com/x' } });
  assert.equal(c.enabled, false);
  assert.ok(c.error);
});

test('弾いた URL は戻り値のどこにも出さない', () => {
  // 別サービスの鍵を貼り間違えている可能性がある
  const c = parseNotifyConfig({
    env: { CLAUDE_DECK_SLACK_WEBHOOK: 'https://example.com/hook/very-secret-token' },
  });
  assert.ok(!JSON.stringify(c).includes('very-secret-token'));
  assert.equal(c.url, null);
  assert.equal(c.urlMasked, null);
});

test('http は弾く', () => {
  const c = parseNotifyConfig({ env: { CLAUDE_DECK_SLACK_WEBHOOK: 'http://hooks.slack.com/services/a/b/c' } });
  assert.equal(c.enabled, false);
});

test('似せたホストも弾く', () => {
  for (const url of [
    'https://hooks.slack.com.evil.example.com/x',
    'https://evil.example.com/hooks.slack.com/x',
  ]) {
    assert.equal(parseNotifyConfig({ env: { CLAUDE_DECK_SLACK_WEBHOOK: url } }).enabled, false, url);
  }
});

test('落ち着き待ちの既定は6秒', () => {
  assert.equal(parseNotifyConfig({ env: {} }).settleMs, 6000);
});

test('落ち着き待ちは環境変数で変えられる', () => {
  assert.equal(parseNotifyConfig({ env: { CLAUDE_DECK_NOTIFY_SETTLE: '15' } }).settleMs, 15_000);
});

test('落ち着き待ちに 0 を入れると即時になる', () => {
  // 空文字と 0 を取り違えないこと。Number('') は 0 になる
  assert.equal(parseNotifyConfig({ env: { CLAUDE_DECK_NOTIFY_SETTLE: '0' } }).settleMs, 0);
});

test('落ち着き待ちは設定ファイルからも読める', () => {
  assert.equal(parseNotifyConfig({ env: {}, file: { notify: { settleSec: 3 } } }).settleMs, 3000);
});

test('数にならない値は既定に落とす', () => {
  assert.equal(parseNotifyConfig({ env: { CLAUDE_DECK_NOTIFY_SETTLE: 'すぐ' } }).settleMs, 6000);
  assert.equal(parseNotifyConfig({ env: { CLAUDE_DECK_NOTIFY_SETTLE: '-5' } }).settleMs, 6000);
});

test('大きすぎる値は丸める', () => {
  assert.equal(parseNotifyConfig({ env: { CLAUDE_DECK_NOTIFY_SETTLE: '99999' } }).settleMs, 600_000);
  assert.equal(parseNotifyConfig({ env: { CLAUDE_DECK_NOTIFY_REMIND: '99999' } }).remindMs, 1440 * 60_000);
});

test('放置リマインドの既定は無効', () => {
  assert.equal(parseNotifyConfig({ env: {} }).remindMs, 0);
});

test('放置リマインドは分で入れる', () => {
  assert.equal(parseNotifyConfig({ env: { CLAUDE_DECK_NOTIFY_REMIND: '30' } }).remindMs, 30 * 60_000);
});

test('質問文の既定は載せる', () => {
  assert.equal(parseNotifyConfig({ env: {} }).detail, 'full');
});

test('none にすると質問文を落とす', () => {
  assert.equal(parseNotifyConfig({ env: { CLAUDE_DECK_NOTIFY_DETAIL: 'none' } }).detail, 'none');
  assert.equal(parseNotifyConfig({ env: { CLAUDE_DECK_NOTIFY_DETAIL: 'NONE' } }).detail, 'none');
});

test('知らない値は full に倒す', () => {
  assert.equal(parseNotifyConfig({ env: { CLAUDE_DECK_NOTIFY_DETAIL: 'すこし' } }).detail, 'full');
});

test('設定ファイルが壊れた形でも落ちない', () => {
  // 未知のキー・想定外の型が来ても、黙って飛ばして進む
  for (const file of [{}, { notify: null }, { notify: 'いろいろ' }, { notify: { slackWebhookUrl: 42 } }]) {
    const c = parseNotifyConfig({ env: {}, file });
    assert.equal(c.enabled, false);
    assert.equal(c.settleMs, 6000);
  }
});

test('知らないキーは無視する', () => {
  const c = parseNotifyConfig({
    env: {},
    file: { notify: { slackWebhookUrl: OK_URL, これから足すやつ: true }, theme: 'dark' },
  });
  assert.equal(c.enabled, true);
});

// --- 返信待ちの落ち着き待ち（idleMin） ---
//
// 質問待ちは Claude Code が質問中の行をディスクに書かないため観測できない。
// 実際に鳴るのは返信待ちの経路なので、既定を切ってしまうと通知が丸ごと効かない。

test('返信待ちの落ち着き待ちは既定2分', () => {
  const c = parseNotifyConfig({ env: {} });
  assert.equal(c.idleSettleMs, 120_000);
});

test('返信待ちの落ち着き待ちは環境変数で変えられる', () => {
  assert.equal(parseNotifyConfig({ env: { CLAUDE_DECK_NOTIFY_IDLE: '5' } }).idleSettleMs, 300_000);
});

test('返信待ちの落ち着き待ちは 0 で無効にできる', () => {
  assert.equal(parseNotifyConfig({ env: { CLAUDE_DECK_NOTIFY_IDLE: '0' } }).idleSettleMs, 0);
});

test('返信待ちの落ち着き待ちも設定ファイルが環境変数より先', () => {
  const c = parseNotifyConfig({
    env: { CLAUDE_DECK_NOTIFY_IDLE: '3' },
    file: { notify: { idleMin: 30 } },
  });
  assert.equal(c.idleSettleMs, 30 * 60_000);
});

test('設定ファイルの 0 は「無い」ではない', () => {
  // 0 は「返信待ちを通知しない」という明示の指定。環境変数に落としてはいけない
  const c = parseNotifyConfig({
    env: { CLAUDE_DECK_NOTIFY_IDLE: '5' },
    file: { notify: { idleMin: 0 } },
  });
  assert.equal(c.idleSettleMs, 0);
  assert.equal(c.sources.idle, 'config');
});

test('空で立っている環境変数は 0 と読まない', () => {
  // set X= の形。Number('') は 0 になるので、素通しすると無効化してしまう
  const c = parseNotifyConfig({ env: { CLAUDE_DECK_NOTIFY_IDLE: '' } });
  assert.equal(c.idleSettleMs, 120_000);
});

test('返信待ちの落ち着き待ちは上限で丸める', () => {
  const c = parseNotifyConfig({ env: { CLAUDE_DECK_NOTIFY_IDLE: '99999' } });
  assert.equal(c.idleSettleMs, 1440 * 60 * 1000);
});

// --- 止めるスイッチ ---
//
// 優先順を反転したことで、環境変数から通知を止める手段が無くなった。
// config.json に URL が入っている限り、環境変数を空にしても止まらないため。
// 規則は「環境変数は値を上書きできないが、機能ごと止めることはできる」。

test('CLAUDE_DECK_NOTIFY_OFF は設定ファイルの URL にも勝つ', () => {
  const c = parseNotifyConfig({
    env: { CLAUDE_DECK_NOTIFY_OFF: '1' },
    file: { notify: { slackWebhookUrl: OK_URL } },
  });
  assert.equal(c.enabled, false);
  assert.equal(c.off, true);
  assert.ok(c.error);
});

test('止めているときは生の URL を持たせない', () => {
  // 持たせると、止めているつもりで送れてしまう
  const c = parseNotifyConfig({
    env: { CLAUDE_DECK_NOTIFY_OFF: '1' },
    file: { notify: { slackWebhookUrl: OK_URL } },
  });
  assert.equal(c.url, null);
  // 何が保存されているかは見せてよい
  assert.ok(c.urlMasked.endsWith('/****'));
});

test('0・false・空文字では止まらない', () => {
  for (const v of ['', '0', 'false', 'no', ' ']) {
    const c = parseNotifyConfig({
      env: { CLAUDE_DECK_NOTIFY_OFF: v },
      file: { notify: { slackWebhookUrl: OK_URL } },
    });
    assert.equal(c.enabled, true, JSON.stringify(v));
    assert.equal(c.off, false, JSON.stringify(v));
  }
});

// --- 通知する状態 ---

test('状態の既定は全部入り', () => {
  const c = parseNotifyConfig({ env: {} });
  assert.deepEqual(c.states, {
    'needs-answer': true,
    'needs-plan-approval': true,
    'needs-approval': true,
    'awaiting-reply': true,
  });
});

test('状態は設定ファイルから切れる', () => {
  const c = parseNotifyConfig({ env: {}, file: { notify: { states: { 'awaiting-reply': false } } } });
  assert.equal(c.states['awaiting-reply'], false);
  // 触っていないものは既定のまま
  assert.equal(c.states['needs-answer'], true);
});

test('知らない状態名は落とす', () => {
  const c = parseNotifyConfig({ env: {}, file: { notify: { states: { 'needs-coffee': false } } } });
  assert.equal('needs-coffee' in c.states, false);
});
