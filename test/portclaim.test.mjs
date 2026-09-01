/**
 * ポートの取り合いの決め方のテスト。
 *
 * ここを間違えると、入れた版を起動したのに画面が開発サーバーを映し、
 * 更新ボタンが押せなくなる（実測で踏んだ形。src/shared/portclaim.mjs の冒頭に経緯がある）。
 * 逆に倒しすぎると、古いインストール版が動いている手元で二重に立ち上がる。
 * 4通りしかないので全部通す。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidePortClash, VIA_LAUNCHER, VIA_MANUAL } from '../src/shared/portclaim.mjs';

test('ランチャ経由の自分は、手で立てた相手に譲らずずらす', () => {
  assert.equal(decidePortClash({ mine: VIA_LAUNCHER, theirs: VIA_MANUAL }), 'shift');
});

test('相手もランチャ経由なら譲る。二重に立てる意味がない', () => {
  assert.equal(decidePortClash({ mine: VIA_LAUNCHER, theirs: VIA_LAUNCHER }), 'yield');
});

test('相手の経路が不明（startedBy を返さない古い版）なら譲る。manual に倒さない', () => {
  assert.equal(decidePortClash({ mine: VIA_LAUNCHER, theirs: null }), 'yield');
  assert.equal(decidePortClash({ mine: VIA_LAUNCHER, theirs: undefined }), 'yield');
});

test('手で立てた自分は、相手が何であれ譲る', () => {
  assert.equal(decidePortClash({ mine: VIA_MANUAL, theirs: VIA_LAUNCHER }), 'yield');
  assert.equal(decidePortClash({ mine: VIA_MANUAL, theirs: VIA_MANUAL }), 'yield');
  assert.equal(decidePortClash({ mine: VIA_MANUAL, theirs: null }), 'yield');
});

test('未知の値が来ても落ちない。譲る側へ倒す', () => {
  assert.equal(decidePortClash({ mine: 'ずれた値', theirs: VIA_MANUAL }), 'yield');
  assert.equal(decidePortClash({ mine: VIA_LAUNCHER, theirs: 'ずれた値' }), 'yield');
  assert.equal(decidePortClash({ mine: null, theirs: null }), 'yield');
});

test('経路の語は固定。ランチャ側（C#）が文字列で照合するので変えられない', () => {
  assert.equal(VIA_LAUNCHER, 'launcher');
  assert.equal(VIA_MANUAL, 'manual');
});
