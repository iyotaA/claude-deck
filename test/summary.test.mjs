/**
 * 詳細の先頭に出す要約のテスト。
 *
 * plainSummary は detail を受けるだけの純関数なので、digest を組まずに
 * 必要な項目だけの入れ物を渡して確かめる。
 *
 * ここで固定したいのは「見出しが誰の言葉か」の1点。
 * Claude の中間報告は自己申告なので、古い報告を現在の目的として
 * 大きく出してしまうのが一番避けたい壊れ方になる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainSummary } from '../src/view/summary.mjs';
import { T0 } from './helpers.mjs';

// digest と detail が持つ時刻は解析済みのミリ秒。ログの ISO 文字列ではない。
// ヘルパの at() は ISO を返すので、ここでは使わない
const ms = (offset) => T0 + offset;

/**
 * 要約に渡す入れ物を組む。
 *
 * @param {Array} items digest の items（kind と text と at だけ見られる）
 * @param {object} rest detail 側の項目（recap / title / waitingFor など）
 */
function detailOf(items, rest = {}) {
  return {
    digest: { items, stats: {}, compactions: [] },
    ...rest,
  };
}

test('見出しは最初の指示から作り、出どころを添える', () => {
  const s = plainSummary(detailOf([{ kind: 'prompt', at: T0, text: '構成を整理して' }]));
  assert.equal(s.headline, '構成を整理して');
  // 画面はこの値で「Claude の申告」の印を出すかどうかを決める
  assert.equal(s.headlineSource, 'prompt');
  assert.equal(s.headlineAt, null);
});

test('指示が無ければタイトルで代える', () => {
  const s = plainSummary(detailOf([], { title: '構成のリファクタリング' }));
  assert.equal(s.headline, '構成のリファクタリング');
  assert.equal(s.headlineSource, 'title');
});

test('材料が何も無ければ見出しは null。出どころも立てない', () => {
  const s = plainSummary(detailOf([]));
  assert.equal(s.headline, null);
  assert.equal(s.headlineSource, null);
});

test('最後の指示より新しい中間報告は見出しに使う', () => {
  const s = plainSummary(detailOf(
    [{ kind: 'prompt', at: T0, text: '構成を整理して' }],
    { recap: { text: '4ファイルを移して、テストを通しました', at: ms(1000) } },
  ));
  assert.equal(s.headline, '4ファイルを移して、テストを通しました');
  assert.equal(s.headlineSource, 'recap');
  // いつの申告かを画面が出せるようにする
  assert.equal(s.headlineAt, T0 + 1000);
});

test('最後の指示より古い中間報告は見出しに使わず、点に回す', () => {
  const s = plainSummary(detailOf(
    [
      { kind: 'prompt', at: T0, text: '構成を整理して' },
      { kind: 'prompt', at: ms(2000), text: 'テストも足して' },
    ],
    { recap: { text: '4ファイルを移しました', at: ms(1000) } },
  ));
  // 報告を書いたあとに指示が出ている。その報告はもう今の姿ではない
  assert.equal(s.headline, '構成を整理して');
  assert.equal(s.headlineSource, 'prompt');
  assert.equal(s.headlineAt, null);
  // 捨てはしない。「報告があった事実」まで消えるため
  const point = s.points.find((p) => p.label === 'Claude の申告');
  assert.equal(point.text, '4ファイルを移しました');
});

test('時刻の分からない中間報告は見出しに使わない', () => {
  const s = plainSummary(detailOf(
    [{ kind: 'prompt', at: T0, text: '構成を整理して' }],
    { recap: { text: '作業しました', at: null } },
  ));
  // 新しいか古いか判断できないものを、現在の姿として大きく出さない
  assert.equal(s.headlineSource, 'prompt');
});

test('指示が1件も無ければ、中間報告を見出しに使える', () => {
  const s = plainSummary(detailOf([], { recap: { text: '調査を続けています', at: ms(500) } }));
  // 比べる相手が居ないので、古いと決めつける理由が無い
  assert.equal(s.headline, '調査を続けています');
  assert.equal(s.headlineSource, 'recap');
});

test('見出しに使った中間報告は点には出さない（二重に出さない）', () => {
  const s = plainSummary(detailOf([], { recap: { text: '調査を続けています', at: ms(500) } }));
  assert.equal(s.points.filter((p) => p.label === 'Claude の申告').length, 0);
});

test('誰が作った要約かの軸は変えない', () => {
  // AI に差し替えたときの判別に使う。headlineSource とは別の軸
  assert.equal(plainSummary(detailOf([])).source, 'plain');
});

test('中間報告が無くても形は揃う', () => {
  const s = plainSummary(detailOf([{ kind: 'prompt', at: T0, text: 'やって' }]));
  assert.equal(s.headlineAt, null);
  assert.deepEqual(s.points, []);
  assert.equal(s.compacted, 0);
});
