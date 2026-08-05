/**
 * 原文を返す口の、伏せ字と長さ切りのテスト。
 *
 * getRawEntry のディスク読み取りは実物で確かめる（read/ 側と同じ扱い）。
 * ここで固めるのは判断のほう、つまり「何を伏せて、どこで切るか」だけ。
 * この口は詳細ビューより露出量が多いので、緩んだら気づけるようにしておく。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeEntry } from '../src/view/entry.mjs';

test('鍵らしい名前のキーは中身を見ずに伏せる', () => {
  const s = sanitizeEntry({ authToken: 'abc', api_key: 'x', Cookie: 'y', text: 'ふつうの本文' });
  // 型も長さも出さない。「あった」ことだけが分かればいい
  assert.equal(s.value.authToken, '（伏せました）');
  assert.equal(s.value.api_key, '（伏せました）');
  // 大文字小文字は問わない。キーの書き方は場所によって揺れる
  assert.equal(s.value.Cookie, '（伏せました）');
  // 無関係なキーは触らない
  assert.equal(s.value.text, 'ふつうの本文');
  assert.equal(s.masked, true);
});

test('鍵らしい名前でも、値が数なら伏せない', () => {
  // assistant の行はどれも usage.input_tokens を持っていて、これが token に当たる。
  // 全部伏せると原文の中身が消え、masked がほぼ全行で立って断り書きが効かなくなる
  const s = sanitizeEntry({ usage: { input_tokens: 12, cache_read_input_tokens: 0, ok: true } });
  assert.deepEqual(s.value.usage, { input_tokens: 12, cache_read_input_tokens: 0, ok: true });
  assert.equal(s.masked, false);
});

test('鍵らしい名前で入れ物が来たら、中に降りずに伏せる', () => {
  // 中を歩くと、値の形やキーの並びから何が入っていたかが読めてしまう
  const s = sanitizeEntry({ credentials: { user: 'a', token: 'b' }, tokens: ['x'] });
  assert.equal(s.value.credentials, '（伏せました）');
  assert.equal(s.value.tokens, '（伏せました）');
  assert.equal(s.masked, true);
});

test('鍵の形をした値は、キー名が無害でも伏せる', () => {
  const s = sanitizeEntry({ command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrst" x' });
  // command の中に書かれていると、キー名では拾えない
  assert.ok(s.value.command.includes('（伏せました）'));
  // 当たった部分だけ差し替える。行ごと消すと前後の文脈まで読めなくなる
  assert.ok(s.value.command.startsWith('curl -H '));
  assert.equal(s.masked, true);
});

test('sk- や ghp_ や xoxb- の形も拾う', () => {
  const s = sanitizeEntry([
    'key=sk-abcdefghijklmnopqrstuvwx',
    'ghp_abcdefghijklmnopqrstuvwxyz01',
    'xoxb-1234567890-abcdef',
  ]);
  for (const line of s.value) assert.ok(line.includes('（伏せました）'));
});

test('同じ形が何度も出てきても全部伏せる', () => {
  // g 付きの正規表現を使い回すので、lastIndex を戻し忘れると2つ目以降が抜ける
  const s = sanitizeEntry({ text: 'sk-aaaaaaaaaaaaaaaaaaaa と sk-bbbbbbbbbbbbbbbbbbbb' });
  assert.equal(s.value.text, '（伏せました） と （伏せました）');
});

test('鍵が無ければ masked は立たない', () => {
  const s = sanitizeEntry({ text: 'ただの本文', n: 3, ok: true, nothing: null });
  assert.equal(s.masked, false);
  assert.equal(s.truncated, false);
  // 数値・真偽値・null はそのまま通す。原文の形を変えない
  assert.deepEqual(s.value, { text: 'ただの本文', n: 3, ok: true, nothing: null });
});

test('長い文字列は切って、切ったことを伝える', () => {
  const s = sanitizeEntry({ text: 'あ'.repeat(20050) });
  // 巨大な tool_result は1行で数MBになる。そのまま返すと画面が固まる
  assert.equal(s.value.text.length, 20000 + '…（以下省略）'.length);
  assert.equal(s.truncated, true);
});

test('深すぎる入れ子は省略する', () => {
  let deep = 'おく';
  for (let i = 0; i < 14; i += 1) deep = { next: deep };

  const s = sanitizeEntry(deep);
  assert.equal(s.truncated, true);
  // 12 段まで降りて、その先は文字で置き換える
  let node = s.value;
  for (let i = 0; i < 12; i += 1) node = node.next;
  assert.equal(node, '（深すぎるため省略）');
});
