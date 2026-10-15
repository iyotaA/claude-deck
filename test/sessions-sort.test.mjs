/**
 * 一覧の並び順（sortRows）のテスト。
 *
 * 守りたいのは「同じ状態の中では並びが動かない」こと。
 * 前は動きが新しい順（idleMs）だったので、2本が同時に動いていると
 * 2秒ごとの push のたびに上下が入れ替わり、押そうとした行が直前に動いていた。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortRows } from '../src/view/sessions.mjs';

/** 並べたあとの sessionId の並び。 */
const ids = (rows) => sortRows(rows).map((r) => r.sessionId);

test('状態の順が先に効く（ボールの所在で上下する作りは変わらない）', () => {
  const rows = [
    { sessionId: 'run', state: 'running', startedAt: 1, idleMs: 0 },
    { sessionId: 'ask', state: 'needs-answer', startedAt: 9, idleMs: 0 },
    { sessionId: 'end', state: 'ended', startedAt: null, idleMs: 0 },
    { sessionId: 'reply', state: 'awaiting-reply', startedAt: 5, idleMs: 0 },
  ];
  assert.deepEqual(ids(rows), ['ask', 'reply', 'run', 'end']);
});

test('動いているものは、同じ状態の中で始めた順に並ぶ', () => {
  const rows = [
    { sessionId: 'b', state: 'running', startedAt: 200, idleMs: 10 },
    { sessionId: 'a', state: 'running', startedAt: 100, idleMs: 5000 },
  ];
  assert.deepEqual(ids(rows), ['a', 'b']);
});

test('idleMs が入れ替わっても、同じ状態のあいだは並びが動かない', () => {
  // 2秒ごとの push を2回ぶん。どちらが直近に動いたかだけが入れ替わる
  const first = [
    { sessionId: 'a', state: 'running', startedAt: 100, idleMs: 0 },
    { sessionId: 'b', state: 'running', startedAt: 200, idleMs: 1500 },
  ];
  const second = [
    { sessionId: 'b', state: 'running', startedAt: 200, idleMs: 0 },
    { sessionId: 'a', state: 'running', startedAt: 100, idleMs: 1800 },
  ];
  assert.deepEqual(ids(first), ids(second));
});

test('状態が変わったときだけ並びが動く', () => {
  const before = [
    { sessionId: 'a', state: 'running', startedAt: 100 },
    { sessionId: 'b', state: 'running', startedAt: 200 },
  ];
  const after = [
    { sessionId: 'a', state: 'running', startedAt: 100 },
    { sessionId: 'b', state: 'needs-approval', startedAt: 200 },
  ];
  assert.deepEqual(ids(before), ['a', 'b']);
  assert.deepEqual(ids(after), ['b', 'a']);
});

test('開始時刻が取れないものは、0 ではなく末尾へ寄せる', () => {
  const rows = [
    { sessionId: 'unknown', state: 'running', startedAt: null },
    { sessionId: 'known', state: 'running', startedAt: 500 },
  ];
  assert.deepEqual(ids(rows), ['known', 'unknown']);
});

test('開始時刻が同じ・不明どうしでも、毎回同じ順を返す', () => {
  const make = () => [
    { sessionId: 'z', state: 'running', startedAt: null },
    { sessionId: 'm', state: 'running', startedAt: null },
    { sessionId: 'a', state: 'running', startedAt: null },
  ];
  assert.deepEqual(ids(make()), ['a', 'm', 'z']);
  assert.deepEqual(ids(make().reverse()), ['a', 'm', 'z']);
});

test('終了済みは今までどおり新しい順（idleMs の小さい順）', () => {
  const rows = [
    { sessionId: 'old', state: 'ended', startedAt: 1, idleMs: 90_000 },
    { sessionId: 'new', state: 'ended', startedAt: 2, idleMs: 1_000 },
    { sessionId: 'nolog', state: 'ended', startedAt: 3, idleMs: null },
  ];
  assert.deepEqual(ids(rows), ['new', 'old', 'nolog']);
});
