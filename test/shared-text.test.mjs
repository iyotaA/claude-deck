/**
 * 文字列の小道具（`src/shared/text.mjs`）。
 *
 * **全層から使う。** `oneLine` は一覧・詳細・通知・実行の全部が通り、
 * `errText` は 32 箇所の catch が寄せてある。それなのにテストが1枚も無かった。
 *
 * このリポジトリの方針は「判断（純関数）と I/O を分けて、判断だけをテストする」で、
 * `run/` `parse/` `notify/` では徹底されている。`shared/` はその方針から
 * 漏れていただけ（意図した除外だと書いてある場所がどこにも無い）。
 *
 * 見るのは主に**境目**。長さちょうど・空・文字列でないもの・区切りの混在。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { oneLine, clip, errText, projectNameOf } from '../src/shared/text.mjs';

test('oneLine は空白と改行を1つに潰す', () => {
  assert.equal(oneLine('a  b\n\nc\t d'), 'a b c d');
  assert.equal(oneLine('  前後の空白は落とす  '), '前後の空白は落とす');
});

test('oneLine は中身が無ければ null', () => {
  // **空文字を返さない。** 呼ぶ側は `?? '（指示なし）'` のように既定へ倒すので、
  // 空文字で返すと「空という中身がある」ことになって既定に落ちない
  for (const v of ['', '   ', '\n\t ', null, undefined, 42, {}, []]) {
    assert.equal(oneLine(v), null, `${JSON.stringify(v)} が null にならない`);
  }
});

test('oneLine は max ちょうどなら切らない', () => {
  assert.equal(oneLine('abcde', 5), 'abcde');
  // 超えたら「… を含めて max」。1文字ぶん削って … を足す
  assert.equal(oneLine('abcdef', 5), 'abcd…');
  assert.equal(oneLine('abcdef', 5).length, 5);
});

test('oneLine の既定の長さは 160', () => {
  const s = 'あ'.repeat(200);
  assert.equal(oneLine(s).length, 160);
});

test('clip は改行を保つ', () => {
  // **`oneLine` と役目が違う。** 指示やプランは行の形そのものが情報になる
  assert.equal(clip('a\nb\nc', 100), 'a\nb\nc');
});

test('clip は切ったことを言う', () => {
  // 断り書きは max に含めない（本文が max 文字ぶん残る）
  assert.equal(clip('abcdef', 3), 'abc…（以下省略）');
  assert.equal(clip('abc', 3), 'abc', 'ちょうどなら切らない');
});

test('clip は中身が無ければ null', () => {
  for (const v of ['', '  \n ', null, undefined, 0, false]) {
    assert.equal(clip(v, 10), null, `${JSON.stringify(v)} が null にならない`);
  }
});

test('errText は Error でないものも1行にする', () => {
  // **投げられるものは Error とは限らない。** catch はどんな値でも受ける
  assert.equal(errText(new Error('壊れた')), '壊れた');
  assert.equal(errText('文字列を投げた'), '文字列を投げた');
  assert.equal(errText(undefined), 'undefined');
  assert.equal(errText(null), 'null');
  assert.equal(errText(42), '42');
  assert.equal(errText({ message: 'オブジェクトの message' }), 'オブジェクトの message');
});

test('errText は message が空文字でも落ちない', () => {
  // `?? ` は空文字を通すので、そのまま空文字になる。**落ちないことが要点**
  assert.equal(errText(new Error('')), '');
});

test('projectNameOf は Windows と POSIX の両方の区切りを見る', () => {
  assert.equal(projectNameOf('C:\\Git\\claude-deck'), 'claude-deck');
  assert.equal(projectNameOf('/home/me/claude-deck'), 'claude-deck');
  // 混ざったものも来る（ログの中の cwd は書いた側の都合で揺れる）
  assert.equal(projectNameOf('C:/Git\\claude-deck'), 'claude-deck');
});

test('projectNameOf は末尾の区切りを無視する', () => {
  assert.equal(projectNameOf('C:\\Git\\claude-deck\\'), 'claude-deck');
  assert.equal(projectNameOf('/home/me/x//'), 'x');
});

test('projectNameOf は取れなければ fallback を返す', () => {
  // **既定値を持たせていない。** 落とす先が呼ぶ側で違う（projectDir へ落とす／null）
  assert.equal(projectNameOf(null), null);
  assert.equal(projectNameOf('', 'そのほか'), 'そのほか');
  assert.equal(projectNameOf(42, 'そのほか'), 'そのほか');
  // 区切りしか無いものも「取れなかった」。fallback へ落とす
  assert.equal(projectNameOf('///', 'そのほか'), 'そのほか');
});
