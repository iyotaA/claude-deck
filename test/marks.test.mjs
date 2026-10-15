/**
 * ピン留めとメモ（src/marks/index.mjs）の判断だけを見る。紙の読み書き（loadMarks / saveMarks）は
 * 触らない（read/ と同じ割り切り。判断を純関数に切り出してある）。
 *
 * 守りたいのは4つ。壊れた紙で落ちないこと・長いメモを黙って切らないこと・
 * 付けて外したら残骸を残さないこと・上限で黙って捨てないこと。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMarks, validateMark, applyMark, withMarks, keepIds, MEMO_MAX, MARKS_MAX, MARKS_FILE,
} from '../src/marks/index.mjs';

test('紙の名前は凍結（変えると古い紙が残り、付けたピンが黙って消える）', () => {
  assert.equal(MARKS_FILE, 'marks.json');
});

test('壊れた紙・知らない形でも落ちない', () => {
  assert.equal(parseMarks(null).size, 0);
  assert.equal(parseMarks([]).size, 0);
  assert.equal(parseMarks({ sessions: 'x' }).size, 0);
  const m = parseMarks({ sessions: {
    ok: { pinned: true, memo: '明日 PR', at: 5 },
    'bad id!': { pinned: true },
    empty: { pinned: false, memo: '  ' },
    weird: 'x',
  } });
  assert.deepEqual([...m.keys()], ['ok']);
  assert.deepEqual(m.get('ok'), { pinned: true, memo: '明日 PR', at: 5 });
});

test('指定は キーが無い＝触らない。型が違えば断る', () => {
  assert.deepEqual(validateMark({ sessionId: 'a', pinned: true }), { ok: true, sessionId: 'a', patch: { pinned: true } });
  assert.equal(validateMark({ sessionId: 'a', pinned: 'true' }).ok, false);
  assert.equal(validateMark({ sessionId: 'a b', pinned: true }).ok, false);
  assert.equal(validateMark({ sessionId: 'a' }).ok, false, '変えるものが無い');
  assert.equal(validateMark(null).ok, false);
});

test('メモは1行に整え、空は消す指示。長すぎれば切らずに断る', () => {
  assert.deepEqual(validateMark({ sessionId: 'a', memo: ' 明日\n PR ' }).patch, { memo: '明日 PR' });
  assert.deepEqual(validateMark({ sessionId: 'a', memo: '' }).patch, { memo: null });
  assert.deepEqual(validateMark({ sessionId: 'a', memo: null }).patch, { memo: null });
  const long = validateMark({ sessionId: 'a', memo: 'あ'.repeat(MEMO_MAX + 1) });
  assert.equal(long.ok, false);
  assert.match(long.error, new RegExp(`${MEMO_MAX}`));
});

test('付けて、片方だけ変えて、外したら残骸を残さない', () => {
  let { marks } = applyMark(new Map(), 'a', { pinned: true }, 1);
  assert.deepEqual(marks.get('a'), { pinned: true, memo: null, at: 1 });
  ({ marks } = applyMark(marks, 'a', { memo: 'メモ' }, 2));
  assert.deepEqual(marks.get('a'), { pinned: true, memo: 'メモ', at: 2 }, 'ピンは残る');
  ({ marks } = applyMark(marks, 'a', { pinned: false }, 3));
  assert.equal(marks.get('a').memo, 'メモ', 'メモだけでも残る');
  const r = applyMark(marks, 'a', { memo: null }, 4);
  assert.equal(r.marks.has('a'), false);
  assert.equal(r.mark, null);
});

test('元の集合を変えない', () => {
  const before = new Map([['a', { pinned: true, memo: null, at: 1 }]]);
  applyMark(before, 'b', { pinned: true }, 2);
  assert.equal(before.size, 1);
});

test('上限を超える新しい1件は断る（黙って捨てない）。いま居るものは変えられる', () => {
  const full = new Map();
  for (let i = 0; i < MARKS_MAX; i += 1) full.set(`s${i}`, { pinned: true, memo: null, at: 0 });
  assert.equal(applyMark(full, 'new', { pinned: true }, 1).full, true);
  assert.equal(applyMark(full, 's0', { memo: 'x' }, 1).full, false);
});

test('一覧の行に載せ、古くても残すのはピンだけ', () => {
  const marks = new Map([
    ['a', { pinned: true, memo: 'A', at: 1 }],
    ['b', { pinned: false, memo: 'B', at: 1 }],
  ]);
  const rows = withMarks([{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }], marks);
  assert.deepEqual(rows[0], { sessionId: 'a', pinned: true, memo: 'A' });
  assert.deepEqual(rows[1], { sessionId: 'b', pinned: false, memo: 'B' });
  assert.deepEqual(rows[2], { sessionId: 'c' }, '付いていない行はそのまま');
  assert.deepEqual([...keepIds(marks)], ['a']);
});
