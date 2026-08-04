/**
 * 書庫のクエリ解釈のテスト。
 *
 * listArchive はディスクを読むのでここでは触らない（read 層にテストを置かない方針）。
 * 代わりに「変な値が来ても 400 を返さず黙って既定へ丸める」ところだけを固定する。
 * URL は人が手で書き換える場所なので、壊れるより丸まるほうが親切。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArchiveQuery, ARCHIVE_SCAN_MAX } from '../src/view/archive.mjs';

/** クエリ文字列から指定を作る。 */
const parse = (search) => parseArchiveQuery(new URLSearchParams(search));

test('何も指定しなければ既定になる', () => {
  const q = parse('');
  assert.equal(q.page, 1);
  assert.equal(q.per, 30);
  assert.equal(q.sort, 'recent');
  assert.equal(q.q, null);
  assert.equal(q.deep, false);
  assert.equal(q.project, null);
  // 書庫は古いものを見に戻る場所なので、既定では期間で絞らない
  assert.equal(q.days, null);
});

test('ページと件数は範囲に丸める', () => {
  // 0 ページは存在しない。1 に寄せる
  assert.equal(parse('page=0').page, 1);
  assert.equal(parse('page=-5').page, 1);
  assert.equal(parse('page=7').page, 7);
  // 1回の応答が大きくなりすぎないよう上限を持たせる
  assert.equal(parse('per=999').per, 50);
  assert.equal(parse('per=0').per, 1);
  assert.equal(parse('per=10').per, 10);
});

test('数値でない値は既定に落とす', () => {
  assert.equal(parse('page=abc').page, 1);
  assert.equal(parse('per=').per, 30);
});

test('知らない並び順は既定に落とす', () => {
  assert.equal(parse('sort=size').sort, 'size');
  assert.equal(parse('sort=oldest').sort, 'oldest');
  // 400 は返さない。読めない値は既定と同じ扱いにする
  assert.equal(parse('sort=whatever').sort, 'recent');
});

test('検索語は前後の空白を落とし、空なら検索語なしにする', () => {
  assert.equal(parse('q=%20%20deck%20%20').q, 'deck');
  assert.equal(parse('q=%20%20').q, null);
  assert.equal(parse('q=').q, null);
});

test('長すぎる検索語は頭だけ見る', () => {
  assert.equal(parse(`q=${'a'.repeat(500)}`).q.length, 200);
});

test('深い検索は 1 のときだけ有効にする', () => {
  assert.equal(parse('deep=1').deep, true);
  assert.equal(parse('deep=0').deep, false);
  assert.equal(parse('deep=true').deep, false);
});

test('期間は指定があったときだけ効く', () => {
  assert.equal(parse('days=7').days, 7);
  assert.equal(parse('days=0').days, 1);
  assert.equal(parse('days=99999').days, 3650);
  // キーそのものが無ければ「絞らない」
  assert.equal(parse('sort=recent').days, null);
});

test('深い検索で中身を読む上限を公開している', () => {
  // read/cache.mjs の LRU が 240 件しか持たないので、一覧の memo を押し出さない値にしてある
  assert.equal(ARCHIVE_SCAN_MAX, 120);
});
