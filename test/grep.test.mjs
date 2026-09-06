/**
 * 本文の検索（`src/read/grep.mjs`）のうち**判断だけ**。
 *
 * ディスクを触る `grepTranscript` は薄い殻なので触らない（`read/CLAUDE.md` の方針）。
 * ここで固定するのは2つ。
 *
 *  - どの行から人が読む文字列を取り出すか（`readableOf`）
 *  - 当たった場所をどう切り出すか（`snippetOf`）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readableOf, snippetOf } from '../src/read/grep.mjs';

/* ── readableOf ──────────────────────────────────────── */

test('文字列の content をそのまま読む', () => {
  assert.equal(readableOf({ message: { content: 'こんにちは' } }), 'こんにちは');
});

test('配列の content から text を集める', () => {
  const entry = { message: { content: [
    { type: 'text', text: '一つ目' },
    { type: 'text', text: '二つ目' },
  ] } };
  assert.equal(readableOf(entry), '一つ目\n二つ目');
});

test('プランの本文を読む', () => {
  // **いちばん探したいものが入る。** 承認を求めている本文そのもので、
  // 「あのとき何を決めたか」を辿る手がかりになる
  const entry = { message: { content: [
    { type: 'tool_use', name: 'ExitPlanMode', input: { plan: '# やること\n- あれ' } },
  ] } };
  assert.equal(readableOf(entry), '# やること\n- あれ');
});

test('ツールの引数と結果は読まない', () => {
  // ツール結果は数MBになることがあり、そこに当たっても
  // 「どこで当たったか」の役に立たない
  const entry = {
    toolUseResult: { stdout: 'さがしもの' },
    message: { content: [
      { type: 'tool_use', name: 'Bash', input: { command: 'echo さがしもの' } },
    ] },
  };
  assert.equal(readableOf(entry), null);
});

test('読むものが無ければ null', () => {
  for (const v of [null, undefined, {}, { message: {} }, { message: { content: [] } },
    { message: { content: 42 } }, { message: { content: [{ type: 'image' }] } }]) {
    assert.equal(readableOf(v), null, `${JSON.stringify(v)} が null にならない`);
  }
});

test('壊れた行でも落ちない', () => {
  // ログの形は公開仕様ではない。未知のキー・欠けたキーが来る
  assert.equal(readableOf({ message: { content: [{ type: 'text' }] } }), null);
  assert.equal(readableOf({ message: { content: [null, { type: 'text', text: 'a' }] } }), 'a');
});

/* ── snippetOf ───────────────────────────────────────── */

test('当たった場所の前後を切り出す', () => {
  const text = 'a'.repeat(200) + 'さがしもの' + 'b'.repeat(200);
  const s = snippetOf(text, 'さがしもの');
  assert.ok(s.includes('さがしもの'), '当たった語が入っていない');
  assert.ok(s.startsWith('…'), '前を切ったなら … を付ける');
  assert.ok(s.endsWith('…'), '後ろを切ったなら … を付ける');
});

test('短い本文は切らない', () => {
  assert.equal(snippetOf('みじかい本文です', 'かい'), 'みじかい本文です');
});

test('大小を無視して当てる', () => {
  // needle は呼ぶ側が小文字にして渡す約束。本文の側はそのまま
  assert.ok(snippetOf('Hello World', 'world').includes('World'));
});

test('改行と連続する空白は1つに潰す', () => {
  // カードの1行に収める。行の形そのものは、開いて読めばいい
  assert.equal(snippetOf('あ\n\nい\t う', 'い'), 'あ い う');
});

test('当たらなければ null', () => {
  assert.equal(snippetOf('本文', 'ない語'), null);
  assert.equal(snippetOf('', 'x'), null);
  assert.equal(snippetOf(null, 'x'), null);
  assert.equal(snippetOf('本文', ''), null, '空の検索語では当たらない');
  assert.equal(snippetOf('本文', null), null);
});

test('長さの上限を守る', () => {
  const text = 'x'.repeat(500) + 'ねらい' + 'y'.repeat(500);
  const s = snippetOf(text, 'ねらい', 40);
  // 前後の … は上限の外（切ったことを示す印なので、本文の予算とは別）
  assert.ok(s.replace(/^…|…$/g, '').length <= 40, `長すぎる: ${s.length}`);
});

test('当たりが先頭にあるときは前に … を付けない', () => {
  const s = snippetOf('ねらい' + 'z'.repeat(300), 'ねらい');
  assert.ok(!s.startsWith('…'), '切っていないのに … が付いている');
  assert.ok(s.endsWith('…'), '後ろは切れている');
});
