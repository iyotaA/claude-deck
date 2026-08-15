/**
 * claude CLI を掴む側のテスト。
 *
 * 実物の claude.exe は叩かない。入っているかどうかが環境で変わり、テストの前提にできない。
 * 代わりに「ファイルの有無を見る関数」と「spawn」を外から差し替えて、分岐を全部通す。
 *
 * ここで一番大事なのは**行の割り方**。stdout はチャンクで届き、行の切れ目とは無関係に割れる。
 * ここが狂うと、届いているのに1行も読めない・日本語が化ける、という形で壊れる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  LINE_MAX, CLAUDE_STATE_LABELS,
  resolveClaudeBin, parseClaudeVersion, createLineSplitter, probeClaude, claudeInfo,
} from '../src/os/claude.mjs';

/** 実測した置き場所。 */
const BIN = 'C:\\Users\\me\\.local\\bin\\claude.exe';

/** 「この一覧にあるものだけ実在する」を作る。 */
const only = (...files) => {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return (f) => set.has(String(f).toLowerCase());
};

/** 何も無い。 */
const none = () => false;

/*
 * 実行ファイルを探す
 */

test('環境変数で指した場所を最優先で使う', () => {
  const got = resolveClaudeBin({
    env: { CLAUDE_DECK_CLAUDE_BIN: 'C:\\tools\\claude.exe', PATH: 'C:\\bin' },
    platform: 'win32',
    exists: only('C:\\tools\\claude.exe', 'C:\\bin\\claude.exe'),
  });
  assert.equal(got.path, 'C:\\tools\\claude.exe');
  assert.equal(got.source, 'env');
});

test('環境変数で指した場所が無ければ、黙って次へ落ちない', () => {
  // 落とすと「指定したのに違うものが動いている」になる。いちばん気づきにくい
  const got = resolveClaudeBin({
    env: { CLAUDE_DECK_CLAUDE_BIN: 'C:\\tools\\claude.exe', PATH: 'C:\\bin' },
    platform: 'win32',
    exists: only('C:\\bin\\claude.exe'),
  });
  assert.equal(got.path, null);
  assert.equal(got.source, 'none');
  assert.match(got.reason, /CLAUDE_DECK_CLAUDE_BIN/);
});

test('環境変数の引用符は剥がす', () => {
  const got = resolveClaudeBin({
    env: { CLAUDE_DECK_CLAUDE_BIN: '"C:\\Program Files\\claude.exe"' },
    platform: 'win32',
    exists: only('C:\\Program Files\\claude.exe'),
  });
  assert.equal(got.path, 'C:\\Program Files\\claude.exe');
});

test('.cmd と .bat は環境変数で指されても使わない', () => {
  // 実行に shell:true が要り、引数がシェルの構文として解釈される。引用符の穴が開く
  for (const f of ['C:\\tools\\claude.cmd', 'C:\\tools\\claude.BAT']) {
    const got = resolveClaudeBin({
      env: { CLAUDE_DECK_CLAUDE_BIN: f }, platform: 'win32', exists: () => true,
    });
    assert.equal(got.path, null, `弾く: ${f}`);
    assert.match(got.reason, /\.cmd/);
  }
});

test('PATH を順に見て、最初に見つかったものを使う', () => {
  const got = resolveClaudeBin({
    env: { PATH: 'C:\\a;C:\\b' },
    platform: 'win32',
    exists: only('C:\\a\\claude.exe', 'C:\\b\\claude.exe'),
  });
  assert.equal(got.path, 'C:\\a\\claude.exe');
  assert.equal(got.source, 'path');
});

test('PATH の中の .cmd は飛ばして先を見る', () => {
  const got = resolveClaudeBin({
    env: { PATH: 'C:\\a;C:\\b' },
    platform: 'win32',
    // 実在はするが .cmd なので採らない。exe を探して先へ進む
    exists: only('C:\\a\\claude.cmd', 'C:\\b\\claude.exe'),
  });
  assert.equal(got.path, 'C:\\b\\claude.exe');
});

test('Path でも path でも読む', () => {
  // 環境変数名の大小は環境によってまちまち
  for (const key of ['PATH', 'Path', 'path']) {
    const got = resolveClaudeBin({
      env: { [key]: 'C:\\a' }, platform: 'win32', exists: only('C:\\a\\claude.exe'),
    });
    assert.equal(got.path, 'C:\\a\\claude.exe', `キー: ${key}`);
  }
});

test('PATH の要素の引用符と空白は落とす', () => {
  const got = resolveClaudeBin({
    env: { PATH: ' "C:\\Program Files\\x" ;C:\\a' },
    platform: 'win32',
    exists: only('C:\\Program Files\\x\\claude.exe'),
  });
  assert.equal(got.path, 'C:\\Program Files\\x\\claude.exe');
});

test('PATH に無ければ既定の置き場所を見る', () => {
  const got = resolveClaudeBin({
    env: { USERPROFILE: 'C:\\Users\\me', PATH: 'C:\\a' },
    platform: 'win32',
    exists: only(BIN),
  });
  assert.equal(got.path, BIN);
  assert.equal(got.source, 'home');
});

test('どこにも無ければ理由を付けて none', () => {
  const got = resolveClaudeBin({ env: { PATH: 'C:\\a' }, platform: 'win32', exists: none });
  assert.equal(got.path, null);
  assert.equal(got.source, 'none');
  assert.ok(got.reason);
});

test('環境変数が丸ごと空でも落ちない', () => {
  assert.equal(resolveClaudeBin({ env: {}, platform: 'win32', exists: none }).path, null);
});

test('posix では : で割り、拡張子の無い名前を見る', () => {
  const got = resolveClaudeBin({
    env: { PATH: '/usr/bin:/home/me/.local/bin' }, platform: 'linux', exists: only('/home/me/.local/bin/claude'),
  });
  assert.equal(got.path, '/home/me/.local/bin/claude');
});

test('posix では HOME を見る', () => {
  const got = resolveClaudeBin({
    env: { HOME: '/home/me' }, platform: 'linux', exists: only('/home/me/.local/bin/claude'),
  });
  assert.equal(got.source, 'home');
});

/*
 * 版の読み取り
 */

test('実物の出力から版だけ取る', () => {
  // 実測 2026-08-12: "2.1.228 (Claude Code)"
  assert.equal(parseClaudeVersion('2.1.228 (Claude Code)\n'), '2.1.228');
});

test('括弧の中が変わっても読める', () => {
  // 将来の表記変更で読めなくなる形にしない
  assert.equal(parseClaudeVersion('3.0.0 (Something Else)'), '3.0.0');
  assert.equal(parseClaudeVersion('3.0.0'), '3.0.0');
});

test('前置きが付いていても読める', () => {
  assert.equal(parseClaudeVersion('claude version 2.1.228'), '2.1.228');
});

test('プレリリースの版も読む', () => {
  assert.equal(parseClaudeVersion('2.2.0-beta.1 (Claude Code)'), '2.2.0-beta.1');
});

test('読めなければ null。空文字にしない', () => {
  for (const v of ['', 'unknown', null, undefined, 42]) {
    assert.equal(parseClaudeVersion(v), null, `値: ${v}`);
  }
});

/*
 * 起動時のプローブ
 */

/** 偽の子プロセス。close を呼ぶまで終わらない。 */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; };
  return child;
}

test('版が読めたら ok。path と source も残る', async () => {
  const child = fakeChild();
  const p = probeClaude({
    env: { PATH: 'C:\\a' },
    platform: 'win32',
    exists: only('C:\\a\\claude.exe'),
    spawnFn: (file, args) => {
      assert.equal(file, 'C:\\a\\claude.exe');
      assert.deepEqual(args, ['--version']);
      return child;
    },
  });

  child.stdout.write('2.1.228 (Claude Code)\n');
  child.emit('close', 0);

  const got = await p;
  assert.equal(got.state, 'ok');
  assert.equal(got.ok, true);
  assert.equal(got.version, '2.1.228');
  assert.equal(got.path, 'C:\\a\\claude.exe');
  assert.equal(got.source, 'path');
  assert.equal(got.label, CLAUDE_STATE_LABELS.ok, '日本語はサーバー側から返す');
});

test('claudeInfo は同期で読める', () => {
  // /api/health を同期のまま保つための窓口。ここで await が要る形にしない
  const got = claudeInfo();
  assert.equal(typeof got.state, 'string');
  assert.ok('ok' in got && 'version' in got && 'label' in got);
});

test('見つからなければ missing。spawn しない', async () => {
  let spawned = false;
  const got = await probeClaude({
    env: {}, platform: 'win32', exists: none, spawnFn: () => { spawned = true; return fakeChild(); },
  });
  assert.equal(got.state, 'missing');
  assert.equal(got.ok, false);
  assert.equal(spawned, false, '探して無いのに起こさない');
  assert.ok(got.reason);
});

test('終了コードが 0 でなければ error', async () => {
  const child = fakeChild();
  const p = probeClaude({
    env: { PATH: 'C:\\a' }, platform: 'win32', exists: only('C:\\a\\claude.exe'), spawnFn: () => child,
  });
  child.emit('close', 1);

  const got = await p;
  assert.equal(got.state, 'error');
  assert.equal(got.ok, false);
  assert.equal(got.path, 'C:\\a\\claude.exe', '掴めてはいるので場所は残す');
  assert.match(got.reason, /1/);
});

test('0 で終わっても版が読めなければ error', async () => {
  const child = fakeChild();
  const p = probeClaude({
    env: { PATH: 'C:\\a' }, platform: 'win32', exists: only('C:\\a\\claude.exe'), spawnFn: () => child,
  });
  child.stdout.write('???\n');
  child.emit('close', 0);

  const got = await p;
  assert.equal(got.state, 'error');
  assert.equal(got.version, null);
});

test("'error' が来たら error。close と二重に確定しない", async () => {
  const child = fakeChild();
  const p = probeClaude({
    env: { PATH: 'C:\\a' }, platform: 'win32', exists: only('C:\\a\\claude.exe'), spawnFn: () => child,
  });
  child.emit('error', new Error('ENOENT'));
  child.emit('close', 0);

  const got = await p;
  assert.equal(got.state, 'error');
  assert.match(got.reason, /ENOENT/);
});

test('spawn が同期で投げても落ちない', async () => {
  const got = await probeClaude({
    env: { PATH: 'C:\\a' },
    platform: 'win32',
    exists: only('C:\\a\\claude.exe'),
    spawnFn: () => { throw new Error('EACCES'); },
  });
  assert.equal(got.state, 'error');
  assert.match(got.reason, /EACCES/);
});

test('チャンクに割れて届いても版が読める', async () => {
  const child = fakeChild();
  const p = probeClaude({
    env: { PATH: 'C:\\a' }, platform: 'win32', exists: only('C:\\a\\claude.exe'), spawnFn: () => child,
  });
  child.stdout.write('2.1');
  child.stdout.write('.228 (Claude');
  child.stdout.write(' Code)\n');
  child.emit('close', 0);

  assert.equal((await p).version, '2.1.228');
});

/*
 * 行の割り方（stdout はチャンクで届く）
 */

test('1チャンクに複数行', () => {
  const s = createLineSplitter();
  assert.deepEqual(s.push('a\nb\nc\n'), ['a', 'b', 'c']);
});

test('1行が複数チャンクに割れる', () => {
  const s = createLineSplitter();
  assert.deepEqual(s.push('{"ty'), []);
  assert.deepEqual(s.push('pe":"a'), []);
  assert.deepEqual(s.push('ssistant"}\n'), ['{"type":"assistant"}']);
});

test('行の途中で終わった分は次のチャンクとつながる', () => {
  const s = createLineSplitter();
  assert.deepEqual(s.push('a\nb'), ['a']);
  assert.deepEqual(s.push('c\n'), ['bc']);
});

test('空行は落とす', () => {
  // parse/stream.mjs が「空行は呼ぶ側で落としてから渡すこと」と決めている。その責任がここ
  const s = createLineSplitter();
  assert.deepEqual(s.push('a\n\n\n  \nb\n'), ['a', 'b']);
});

test('CRLF でも行の中身は変わらない', () => {
  const s = createLineSplitter();
  assert.deepEqual(s.push('a\r\nb\r\n'), ['a', 'b']);
});

test('日本語がチャンクの境目で割れても、文字としては壊れない', () => {
  // 呼ぶ側が setEncoding('utf8') を呼んでいる前提。ここへは文字列で届く
  const s = createLineSplitter();
  assert.deepEqual(s.push('直し'), []);
  assert.deepEqual(s.push('ました\n'), ['直しました']);
});

test('flush で最後の1行が取れる', () => {
  const s = createLineSplitter();
  s.push('a\nb');
  assert.deepEqual(s.flush(), ['b']);
  assert.deepEqual(s.flush(), [], '2回目は空');
});

test('flush するものが無ければ空', () => {
  const s = createLineSplitter();
  s.push('a\n');
  assert.deepEqual(s.flush(), []);
});

test('長すぎる行は捨てて、次の改行から読み直す', () => {
  const s = createLineSplitter({ max: 10 });
  assert.deepEqual(s.push('aaaaaaaaaaaaaaaaaaaa'), [], 'まだ改行が来ていない');
  assert.deepEqual(s.push('aaaa\nok\n'), ['ok'], '改行で再同期して次の行から読める');
  assert.equal(s.dropped, 1, '捨てた数は数える。黙って捨てない');
});

test('1チャンクに収まった長い行も捨てる', () => {
  const s = createLineSplitter({ max: 10 });
  assert.deepEqual(s.push('aaaaaaaaaaaaaaa\nok\n'), ['ok']);
  assert.equal(s.dropped, 1);
});

test('捨てている途中で閉じたら、その分は諦める', () => {
  const s = createLineSplitter({ max: 10 });
  s.push('aaaaaaaaaaaaaaa');
  assert.deepEqual(s.flush(), []);
  assert.equal(s.dropped, 1);
});

test('捨てた数は外から書き換えられない', () => {
  const s = createLineSplitter({ max: 10 });
  s.push('aaaaaaaaaaaaaaa\n');
  assert.equal(s.dropped, 1);
  try { s.dropped = 99; } catch { /* strict mode では投げる */ }
  assert.equal(s.dropped, 1);
});

test('文字列でないものを食わせても落ちない', () => {
  const s = createLineSplitter();
  for (const v of [null, undefined, 42, {}, '']) {
    assert.deepEqual(s.push(v), [], `値: ${v}`);
  }
});

test('既定の上限は 4MB', () => {
  // 大きな tool_result が1行で来る。ここを小さくすると、まともな応答まで捨て始める
  assert.equal(LINE_MAX, 4 * 1024 * 1024);
});
