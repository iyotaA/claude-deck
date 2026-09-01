/**
 * 起こしてよいフォルダの登録（src/run/dirs.mjs）。
 *
 * 見るのは判断だけ。実在するかを見る `dirExists` と、
 * 紙を読み書きする `loadRunDirs` / `saveRunDirs` はディスクを触るので入れない
 * （`notify-settings.test.mjs` が `writeSettings` を見ていないのと同じ理由）。
 *
 * ここは**許可リストをブラウザから書き足せるようにした関所**なので、
 * 断るべきものを断れているかを中心に見る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN_DIRS_MAX, checkRunDir, parseRunDirs, addRunDir, removeRunDir, mergeRunDirs,
} from '../src/run/dirs.mjs';

const WIN = { platform: 'win32' };
const POSIX = { platform: 'linux' };

/* ------------------------------------------------------------- checkRunDir */

test('絶対パスはそのまま通る', () => {
  assert.deepEqual(checkRunDir('C:\\work\\demo', WIN), { ok: true, dir: 'C:\\work\\demo' });
});

test('前後の空白と末尾の区切りは落とす', () => {
  assert.equal(checkRunDir('  C:\\work\\demo\\  ', WIN).dir, 'C:\\work\\demo');
});

test('.. は畳んでから受ける', () => {
  assert.equal(checkRunDir('C:\\work\\demo\\..\\lib', WIN).dir, 'C:\\work\\lib');
});

test('スラッシュ区切りでも win32 の形に直す', () => {
  assert.equal(checkRunDir('C:/work/demo', WIN).dir, 'C:\\work\\demo');
});

test('空・文字列でないものは断る', () => {
  for (const v of ['', '   ', null, undefined, 5, {}, []]) {
    assert.equal(checkRunDir(v, WIN).ok, false, `値: ${JSON.stringify(v)}`);
  }
});

test('相対パスは断る', () => {
  const got = checkRunDir('work\\demo', WIN);
  assert.equal(got.ok, false);
  assert.match(got.reason, /絶対パス/);
});

test('- で始まる値は断る', () => {
  // argv のフラグとして読まれる形。spec.mjs と同じ関所を通す
  assert.equal(checkRunDir('--model', WIN).ok, false);
  assert.equal(checkRunDir('-C:\\work', WIN).ok, false);
});

test('ドライブ直下は断る（win32）', () => {
  for (const v of ['C:\\', 'C:/', 'D:\\']) {
    const got = checkRunDir(v, WIN);
    assert.equal(got.ok, false, `値: ${v}`);
    assert.match(got.reason, /直下/);
  }
});

test('ルート直下は断る（posix）', () => {
  const got = checkRunDir('/', POSIX);
  assert.equal(got.ok, false);
  assert.match(got.reason, /直下/);
});

test('直下の1つ下は通る', () => {
  assert.equal(checkRunDir('C:\\work', WIN).ok, true);
  assert.equal(checkRunDir('/work', POSIX).ok, true);
});

/* ------------------------------------------------------------ parseRunDirs */

test('run.dirs が無ければ空', () => {
  assert.deepEqual(parseRunDirs(null, 'win32'), []);
  assert.deepEqual(parseRunDirs({}, 'win32'), []);
  assert.deepEqual(parseRunDirs({ run: {} }, 'win32'), []);
});

test('配列でない run.dirs は空にする（落ちない）', () => {
  assert.deepEqual(parseRunDirs({ run: { dirs: 'C:\\work' } }, 'win32'), []);
  assert.deepEqual(parseRunDirs({ run: { dirs: 5 } }, 'win32'), []);
});

test('文字列でないもの・相対パスは黙って落とす', () => {
  const got = parseRunDirs({ run: { dirs: ['C:\\work', 'rel\\path', 5, null, ''] } }, 'win32');
  assert.deepEqual(got, ['C:\\work']);
});

test('重複は落とす。win32 は大小を区別しない', () => {
  const got = parseRunDirs({ run: { dirs: ['C:\\work', 'c:\\WORK', 'C:\\work\\'] } }, 'win32');
  assert.deepEqual(got, ['C:\\work']);
});

test('posix では大小を区別する', () => {
  const got = parseRunDirs({ run: { dirs: ['/work', '/WORK'] } }, 'linux');
  assert.deepEqual(got, ['/work', '/WORK']);
});

test('上限を超えたぶんは読まない', () => {
  const dirs = Array.from({ length: RUN_DIRS_MAX + 5 }, (_, i) => `C:\\work\\d${i}`);
  assert.equal(parseRunDirs({ run: { dirs } }, 'win32').length, RUN_DIRS_MAX);
});

/* -------------------------------------------------------------- addRunDir */

test('空の一覧に足せる', () => {
  assert.deepEqual(addRunDir([], 'C:\\work', WIN), { ok: true, dirs: ['C:\\work'] });
});

test('足したら名前順に並ぶ', () => {
  const got = addRunDir(['C:\\b'], 'C:\\a', WIN);
  assert.deepEqual(got.dirs, ['C:\\a', 'C:\\b']);
});

test('同じものは足せない', () => {
  const got = addRunDir(['C:\\work'], 'C:\\work', WIN);
  assert.equal(got.ok, false);
  assert.match(got.reason, /登録済み/);
});

test('大小違いも同じものとして断る（win32）', () => {
  assert.equal(addRunDir(['C:\\Work'], 'c:\\work', WIN).ok, false);
});

test('登録済みフォルダの配下は足せない', () => {
  // 足しても使える範囲は1ミリも増えない（resolveCwd が配下を通すため）
  const got = addRunDir(['C:\\work'], 'C:\\work\\demo\\src', WIN);
  assert.equal(got.ok, false);
  assert.match(got.reason, /配下/);
});

test('似た名前の別フォルダは配下ではない', () => {
  // startsWith で見ていたら C:\work2 が C:\work の子に見える
  assert.equal(addRunDir(['C:\\work'], 'C:\\work2', WIN).ok, true);
});

test('上限まで入っていたら断る', () => {
  const dirs = Array.from({ length: RUN_DIRS_MAX }, (_, i) => `C:\\work\\d${i}`);
  const got = addRunDir(dirs, 'C:\\other', WIN);
  assert.equal(got.ok, false);
  assert.match(got.reason, new RegExp(String(RUN_DIRS_MAX)));
});

test('元の配列を書き換えない', () => {
  const list = ['C:\\work'];
  addRunDir(list, 'C:\\other', WIN);
  assert.deepEqual(list, ['C:\\work']);
});

/* ----------------------------------------------------------- removeRunDir */

test('登録したものを消せる', () => {
  assert.deepEqual(removeRunDir(['C:\\a', 'C:\\b'], 'C:\\a', WIN), { ok: true, dirs: ['C:\\b'] });
});

test('大小違いでも消える（win32）', () => {
  assert.deepEqual(removeRunDir(['C:\\Work'], 'c:\\work', WIN).dirs, []);
});

test('無いものを消そうとしたら断る', () => {
  const got = removeRunDir(['C:\\a'], 'C:\\b', WIN);
  assert.equal(got.ok, false);
  assert.match(got.reason, /登録されていません/);
});

test('配下を渡しても親は消えない', () => {
  // 消すのは登録したそのものだけ。配下から消せると、消したつもりの範囲がずれる
  assert.equal(removeRunDir(['C:\\work'], 'C:\\work\\demo', WIN).ok, false);
});

/* ------------------------------------------------------------ mergeRunDirs */

test('知らないキーを残す', () => {
  const file = { notify: { slackWebhookUrl: 'https://hooks.slack.com/x' }, other: 1 };
  const got = mergeRunDirs(file, ['C:\\work']);
  assert.deepEqual(got, {
    notify: { slackWebhookUrl: 'https://hooks.slack.com/x' },
    other: 1,
    run: { dirs: ['C:\\work'] },
  });
});

test('run の中の知らないキーも残す', () => {
  const got = mergeRunDirs({ run: { keep: true, dirs: ['C:\\old'] } }, ['C:\\new']);
  assert.deepEqual(got.run, { keep: true, dirs: ['C:\\new'] });
});

test('紙が無い・壊れていても組める', () => {
  assert.deepEqual(mergeRunDirs(null, []), { run: { dirs: [] } });
  assert.deepEqual(mergeRunDirs('こわれている', []), { run: { dirs: [] } });
  assert.deepEqual(mergeRunDirs({ run: 'こわれている' }, ['C:\\a']), { run: { dirs: ['C:\\a'] } });
});
