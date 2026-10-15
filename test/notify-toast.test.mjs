/**
 * Windows の通知（トースト）に何を出すか（src/notify/toast.mjs）。
 *
 * 判断だけを見る。PowerShell を起こす殻（src/os/toast.mjs）はテストしない
 * （os/focus.mjs と同じ扱い。実物で確かめる）。
 *
 * 守りたいのは3つ。ログ由来の文字を必ず逃がすこと・押した先がランチャの有無で
 * 正しく分かれること・「質問文を載せない」設定を守ること。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeXml, toastLaunchUrl, buildToastXml, buildRestXml, PROTOCOL, TOAST_APP_ID,
} from '../src/notify/toast.mjs';

const item = (over = {}) => ({
  sessionId: 'sess-a',
  project: 'claude-deck',
  stateLabel: '承認待ち',
  tool: 'Bash',
  detail: 'npm test',
  idleMs: 1000,
  ...over,
});

test('XML の文字を逃がす（ログ由来の本文で XML を壊さない）', () => {
  assert.equal(escapeXml(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;');
  assert.equal(escapeXml(null), '');
});

test('押した先：ランチャ経由なら claude-deck://open、無ければ baseUrl', () => {
  assert.equal(toastLaunchUrl({ sessionId: 'a b', viaLauncher: true }), `${PROTOCOL}://open?session=a%20b`);
  assert.equal(toastLaunchUrl({ sessionId: 'x', baseUrl: 'http://127.0.0.1:4317/' }), 'http://127.0.0.1:4317/?session=x');
  // まとめの1枚（セッションを指さない）
  assert.equal(toastLaunchUrl({ baseUrl: 'http://127.0.0.1:4317/' }), 'http://127.0.0.1:4317/');
  assert.equal(toastLaunchUrl({ viaLauncher: true }), `${PROTOCOL}://open`);
  // baseUrl がまだ無い（listen 前）なら行き先なし
  assert.equal(toastLaunchUrl({ sessionId: 'x' }), null);
});

test('凍結の名前を変えていない（ランチャが同じ名前で登録する）', () => {
  assert.equal(PROTOCOL, 'claude-deck');
  assert.equal(TOAST_APP_ID, 'ClaudeDeck');
});

test('1行目は「状態 ― 題名」、2行目は「置き場所 · ツール: 中身」', () => {
  const xml = buildToastXml(item(), { title: '冊①のレビュー', launchUrl: 'claude-deck://open?session=sess-a' });
  assert.match(xml, /<text>承認待ち ― 冊①のレビュー<\/text>/);
  assert.match(xml, /<text>claude-deck · Bash: npm test<\/text>/);
  assert.match(xml, /launch="claude-deck:\/\/open\?session=sess-a" activationType="protocol"/);
  assert.match(xml, /<action content="開く" activationType="protocol" arguments="claude-deck:\/\/open\?session=sess-a"\/>/);
});

test('本文の記号は逃がされ、XML として壊れない', () => {
  const xml = buildToastXml(item({ detail: 'echo "<x>" && rm' }), { title: 'A & B' });
  assert.match(xml, /A &amp; B/);
  assert.match(xml, /echo &quot;&lt;x&gt;&quot; &amp;&amp; rm/);
  assert.doesNotMatch(xml, /<x>/);
});

test('質問文を載せない設定（detail: none）ならツール名だけ', () => {
  const xml = buildToastXml(item(), { detail: 'none' });
  assert.match(xml, /<text>claude-deck · Bash<\/text>/);
  assert.doesNotMatch(xml, /npm test/);
});

test('待っているツールが無い（返信待ち）なら待ちの長さを出す', () => {
  const xml = buildToastXml(item({ stateLabel: '返信待ち', tool: null, detail: null }), { waitText: '5分 待っています' });
  assert.match(xml, /<text>claude-deck · 5分 待っています<\/text>/);
});

test('行き先が無ければ launch もボタンも付けない（押しても何も起きないだけ）', () => {
  const xml = buildToastXml(item(), { launchUrl: null });
  assert.doesNotMatch(xml, /launch=/);
  assert.doesNotMatch(xml, /<actions>/);
});

test('題名は長ければ切る（右下は3行ほどしか見えない）', () => {
  const xml = buildToastXml(item(), { title: 'あ'.repeat(200) });
  const head = xml.match(/<text>([^<]*)<\/text>/)[1];
  assert.ok(head.length < 100, `1行目が長すぎる: ${head.length}`);
  assert.ok(head.endsWith('…'));
});

test('まとめの1枚は件数を言う', () => {
  assert.match(buildRestXml(4, null), /ほか 4 件の待ちがあります/);
});
