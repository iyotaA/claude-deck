/**
 * プランの系譜のテスト。
 *
 * ここで守りたいのは2つ。
 * ログ由来のパスで plans ディレクトリの外を開かないこと。
 * そして mtime だけを根拠に「書き換わった」と言い切らないこと。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlanPath } from '../src/read/plans.mjs';
import { comparePlanBody, buildPlanLineage } from '../src/view/plans.mjs';
import { T0, call, result } from './helpers.mjs';
import { buildDigest } from '../src/parse/digest.mjs';

const ROOT = 'C:\\Users\\me\\.claude\\plans';

test('plans の中の .md だけを通す', () => {
  assert.equal(
    resolvePlanPath('C:\\Users\\me\\.claude\\plans\\foo.md', ROOT),
    'C:\\Users\\me\\.claude\\plans\\foo.md',
  );
  // 下の階層も範囲の中
  assert.equal(
    resolvePlanPath('C:\\Users\\me\\.claude\\plans\\sub\\bar.md', ROOT),
    'C:\\Users\\me\\.claude\\plans\\sub\\bar.md',
  );
});

test('ドライブレターの大小が違っても弾かない', () => {
  // filePath はログが書いた文字列で c: と C: が揺れうる。startsWith だと正しいパスまで落ちる。
  // ドライブレターは渡された形のまま返る（Windows はどちらでも同じファイルを開ける）
  assert.equal(
    resolvePlanPath('c:\\Users\\me\\.claude\\plans\\foo.md', ROOT),
    'c:\\Users\\me\\.claude\\plans\\foo.md',
  );
});

test('plans の外を指すパスは開かない', () => {
  const outside = [
    'C:\\Users\\me\\.claude\\plans\\..\\.credentials.json',
    'C:\\Users\\me\\.claude\\plans\\..\\..\\secret.md',
    'D:\\other\\plan.md',
    'C:\\Users\\me\\.claude\\plansX\\foo.md',
  ];
  for (const p of outside) {
    assert.equal(resolvePlanPath(p, ROOT), null, `${p} を通してしまっている`);
  }
});

test('.md 以外と値が無いものは開かない', () => {
  // 拡張子で絞るのは、範囲の中にある他の種類のファイルまで読み出さないため
  assert.equal(resolvePlanPath('C:\\Users\\me\\.claude\\plans\\foo.txt', ROOT), null);
  assert.equal(resolvePlanPath('C:\\Users\\me\\.claude\\plans\\foo', ROOT), null);
  assert.equal(resolvePlanPath(ROOT, ROOT), null);
  assert.equal(resolvePlanPath('', ROOT), null);
  assert.equal(resolvePlanPath('   ', ROOT), null);
  assert.equal(resolvePlanPath(null, ROOT), null);
  assert.equal(resolvePlanPath(42, ROOT), null);
});

test('本文が一致すれば same、違えば differs', () => {
  assert.equal(comparePlanBody('# 手順\n1. やる', 12, '# 手順\n1. やる').verdict, 'same');
  assert.equal(comparePlanBody('# 手順\n1. やる', 12, '# 手順\n2. やらない').verdict, 'differs');
});

test('改行コードと末尾の改行の違いは一致とみなす', () => {
  // ディスクのファイルは末尾に改行が付き、改行コードも環境で変わる。そこだけ吸収する
  const got = comparePlanBody('# 手順\n1. やる', 12, '# 手順\r\n1. やる\r\n');
  assert.equal(got.verdict, 'same');
  assert.equal(got.partial, false);
});

test('インデントの違いは一致とみなさない', () => {
  // プランの本文は行頭の空白に意味があるので、空白を潰した比較はしない
  assert.equal(comparePlanBody('- a\n  - b', 8, '- a\n- b').verdict, 'differs');
});

test('どちらかの本文が取れないときは言い切らない', () => {
  // 「一致しない」と書くと、読めなかっただけなのに書き換えられたように見える
  assert.equal(comparePlanBody('# 手順', 5, null).verdict, 'unknown');
  assert.equal(comparePlanBody(null, null, '# 手順').verdict, 'unknown');
});

test('切られた本文は頭だけ比べ、その旨を返す', () => {
  const head = 'あ'.repeat(50);
  const same = comparePlanBody(`${head}…（以下省略）`, 9000, `${head}いろは`);
  assert.equal(same.verdict, 'same');
  // 全部を比べたわけではないことを隠さない
  assert.equal(same.partial, true);

  const differs = comparePlanBody(`${head}…（以下省略）`, 9000, 'ぜんぜん違う本文');
  assert.equal(differs.verdict, 'differs');
  assert.equal(differs.partial, true);
});

test('字数は生の長さ同士で比べる', () => {
  // 提出もディスクも末尾が改行の本文。正規化後の長さで比べると片方だけ1字短くなり、
  // 「31,862 字と 31,862 字」なのに一致しないことになる
  const body = `${'あ'.repeat(99)}\n`;
  assert.equal(comparePlanBody(body, 100, body).charsMatch, true);

  // 一致しない字数は differs の根拠にしない（CRLF 保存なら行数のぶん増える）
  const crlf = comparePlanBody('# 手順\n1. やる', 12, '# 手順\r\n1. やる\r\n');
  assert.equal(crlf.charsMatch, false);
  assert.equal(crlf.verdict, 'same');
});

test('切られた本文で字数まで一致していたら、そう書く', () => {
  const head = 'あ'.repeat(50);
  const disk = `${head}いろは`;
  // 提出は 24,000 字で切られていても、切る前の長さが分かれば頭＋字数で裏が取れる
  const got = comparePlanBody(`${head}…（以下省略）`, disk.length, disk);
  assert.equal(got.partial, true);
  assert.equal(got.charsMatch, true);
});

test('プランの提出が無ければ系譜は出さない', async () => {
  const digest = buildDigest({ entries: [] });
  // 材料が無いときは何も出さない。空の枠を出すと「調べたが無かった」に見える
  assert.equal(await buildPlanLineage(digest), null);
});

test('承認待ちのプランは、ファイル名が出ない理由をそのまま伝える', async () => {
  const digest = buildDigest({ entries: [call('ExitPlanMode', { plan: '# 手順' }, { id: 'p1' })] });
  const lineage = await buildPlanLineage(digest, { root: ROOT });
  assert.equal(lineage.state, 'pending');
  assert.equal(lineage.fileKnown, false);
  assert.equal(lineage.disk, null);
  // mtime 最新のファイルを当てる推測はしない。他のセッションのプランを取り違えるため
  assert.deepEqual(lineage.notes, ['承認されるまでファイル名はログに出ません']);
});

test('ファイルが見つからないときは、それだけを言う', async () => {
  const digest = buildDigest({
    entries: [
      call('ExitPlanMode', { plan: '# 手順' }, { id: 'p1' }),
      result('p1', {
        ms: 100,
        text: 'User has approved your plan.',
        structured: { filePath: `${ROOT}\\nowhere.md` },
      }),
    ],
  });
  const lineage = await buildPlanLineage(digest, { root: ROOT });
  assert.equal(lineage.state, 'approved');
  assert.equal(lineage.fileKnown, true);
  assert.equal(lineage.planName, 'nowhere.md');
  assert.equal(lineage.verdict, 'unknown');
  // 読めなかったことと、書き換わったことを混ぜない
  assert.deepEqual(lineage.notes, ['プランのファイルが今は見つかりません']);
  assert.equal(lineage.changedAfterSubmit, null);
});

test('同じファイルを複数の提出が共有していたら添える', async () => {
  const shared = `${ROOT}\\shared.md`;
  const submit = (id, ms) => [
    call('ExitPlanMode', { plan: `# 手順 ${id}` }, { id, ms }),
    result(id, {
      ms: ms + 100,
      text: 'User has approved your plan.',
      structured: { filePath: shared },
    }),
  ];
  const digest = buildDigest({ entries: [...submit('p1', 0), ...submit('p2', 60_000)] });
  const lineage = await buildPlanLineage(digest, { root: ROOT });
  // あとの提出で本文が上書きされている。実測でも1ファイルを3提出が共有していた例がある
  assert.equal(lineage.sharedWithinSession, true);
  assert.ok(lineage.notes.includes('このセッションの複数の提出が同じファイルを指しています'));
  // 見るのは最後の1件だけ
  assert.equal(lineage.at, T0 + 60_000);
});

test('提出前の編集は書かれているときだけ添える', async () => {
  const make = (structured) => buildDigest({
    entries: [
      call('ExitPlanMode', { plan: '# 手順' }, { id: 'p1' }),
      result('p1', { ms: 100, text: 'User has approved your plan.', structured }),
    ],
  });

  const edited = await buildPlanLineage(make({ filePath: `${ROOT}\\a.md`, planWasEdited: true }), { root: ROOT });
  assert.ok(edited.notes.includes('提出前にプランを編集しています'));

  // planWasEdited は true のときだけ書かれる。キーが無いことを「編集なし」と読み替えない
  const unknown = await buildPlanLineage(make({ filePath: `${ROOT}\\a.md` }), { root: ROOT });
  assert.equal(unknown.edited, null);
  assert.equal(unknown.notes.includes('提出前にプランを編集しています'), false);
});
