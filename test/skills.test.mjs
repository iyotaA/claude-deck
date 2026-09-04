/**
 * スキルの索引のうち、**判断の部分だけ**のテスト。
 *
 * `scanSkills` と `buildSkillIndex` はディスクを読むのでここでは触らない
 * （read 層にテストを置かない方針。`archive.test.mjs` と同じ）。
 * 代わりに「壊れた索引を読んでも落ちない」「印が同じなら読み直さない」を固定する。
 *
 * この2つが崩れると、静かに壊れる。前者は立ち上げのたびに例外が出て索引が作れなくなり、
 * 後者は毎回 614 MB を舐め直すことになる（実測で 6 秒。気づきにくい遅さ）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkillIndex, isFresh, skillIndexPath } from '../src/read/skills.mjs';

test('読める索引はそのまま通す', () => {
  const raw = { version: 1, builtAt: 1, entries: { abc: { size: 10, mtimeMs: 20, skills: ['x'] } } };
  assert.deepEqual(parseSkillIndex(raw).entries.abc.skills, ['x']);
});

test('未知の形は空の索引へ落とす（落ちない）', () => {
  // 版が違う＝形が変わっている見込み。読まずに作り直す
  assert.deepEqual(parseSkillIndex({ version: 99, entries: { a: 1 } }).entries, {});
  // 壊れた JSON を読んだあとに来るものたち
  assert.deepEqual(parseSkillIndex(null).entries, {});
  assert.deepEqual(parseSkillIndex('文字列').entries, {});
  assert.deepEqual(parseSkillIndex([]).entries, {});
  assert.deepEqual(parseSkillIndex({ version: 1 }).entries, {});
  assert.deepEqual(parseSkillIndex({ version: 1, entries: 'ちがう' }).entries, {});
});

test('印が両方そろって一致したときだけ読み直さない', () => {
  const rec = { size: 100, mtimeMs: 200, skills: [] };
  assert.equal(isFresh(rec, { size: 100, mtimeMs: 200 }), true);
  // 追記されれば大きさが動く
  assert.equal(isFresh(rec, { size: 101, mtimeMs: 200 }), false);
  // 中身が同じでも書き直されていれば読む
  assert.equal(isFresh(rec, { size: 100, mtimeMs: 999 }), false);
});

test('0 と「不明」を分ける。印が取れていない行は必ず読み直す', () => {
  const rec = { size: 100, mtimeMs: 200, skills: [] };
  // size が 0（読めなかった）を「一致」に倒すと、その行は永久に読まれない
  assert.equal(isFresh(rec, { size: 0, mtimeMs: 200 }), false);
  assert.equal(isFresh(rec, { size: 100, mtimeMs: 0 }), false);
  assert.equal(isFresh(rec, {}), false);
  assert.equal(isFresh(rec, null), false);
});

test('スキルの一覧を持たない行は、読んだことにしない', () => {
  const stat = { size: 100, mtimeMs: 200 };
  // 途中で書き換わって skills が消えた索引。空配列（＝使っていない）とは別もの
  assert.equal(isFresh({ size: 100, mtimeMs: 200 }, stat), false);
  assert.equal(isFresh({ size: 100, mtimeMs: 200, skills: null }, stat), false);
  assert.equal(isFresh({ size: 100, mtimeMs: 200, skills: [] }, stat), true);
  assert.equal(isFresh(undefined, stat), false);
});

test('索引は ~/.claude ではなく ClaudeDeck の書き込み先に置く', () => {
  const p = skillIndexPath({ LOCALAPPDATA: 'C:\\tmp\\local' });
  assert.match(p, /ClaudeDeck/);
  assert.match(p, /skills\.json$/);
  // 読み取り専用として扱う場所へ書かない
  assert.doesNotMatch(p, /\.claude[\\/]/);
});
