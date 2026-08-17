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
import {
  LINE_MAX, CLAUDE_STATE_LABELS, STOP_SOFT_MS, STOP_HARD_MS,
  resolveClaudeBin, parseClaudeVersion, createLineSplitter, probeClaude, claudeInfo,
  spawnClaude, stopClaude, killTreeSync,
} from '../src/os/claude.mjs';
import { fakeChild } from './helpers.mjs';

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
 * 起こす
 */

test('決められた実行ファイルと引数を、シェルを通さずに渡す', () => {
  let seen = null;
  const got = spawnClaude({
    bin: BIN,
    args: ['--print', '--verbose'],
    cwd: 'C:\\work\\demo',
    env: { CLAUDE_DECK_X: '1' },
    spawnFn: (file, args, opts) => { seen = { file, args, opts }; return fakeChild(); },
  });

  assert.equal(got.ok, true);
  assert.equal(got.reason, null);
  assert.equal(seen.file, BIN);
  assert.deepEqual(seen.args, ['--print', '--verbose'], '引数は組み替えない');
  assert.equal(seen.opts.cwd, 'C:\\work\\demo');
  assert.deepEqual(seen.opts.env, { CLAUDE_DECK_X: '1' });
  // 通すと引数がシェルの構文として解釈され、指示文やパスの記号が意味を持つ
  assert.equal(seen.opts.shell, false);
  assert.equal(seen.opts.windowsHide, true);
  // stdin がパイプでないと、指示文を JSON の1行として書き込めない
  assert.deepEqual(seen.opts.stdio, ['pipe', 'pipe', 'pipe']);
});

test('起こした子の出力は文字列で届く', () => {
  // 素の Buffer を toString() すると、チャンクの境目で日本語が割れる。
  // 割れた後では直せないので、受け取る前に決めておく
  const child = fakeChild();
  spawnClaude({ bin: BIN, args: [], spawnFn: () => child });

  const seen = [];
  child.stdout.on('data', (d) => seen.push(d));
  child.stdout.write('直しました\n');
  assert.deepEqual(seen, ['直しました\n']);
  assert.equal(typeof seen[0], 'string', 'Buffer ではない');
});

test('出力に data を勝手に付けない', () => {
  // 付けると流れ始めてしまい、呼ぶ側が listener を足す前の分が消える
  const child = fakeChild();
  spawnClaude({ bin: BIN, args: [], spawnFn: () => child });
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.stderr.listenerCount('data'), 0);
});

test('stdin が先に死んでも落ちない', () => {
  // 拾わないと uncaughtException になり、Node 18 以降は**サーバーごと落ちる**
  const child = fakeChild();
  spawnClaude({ bin: BIN, args: [], spawnFn: () => child });
  child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
});

test('.cmd / .bat は起こさない', () => {
  // 探す側でも弾いているが、この関数だけを別の場所から呼ばれても穴が開かないように
  for (const f of ['C:\\tools\\claude.cmd', 'C:\\tools\\claude.BAT']) {
    let spawned = false;
    const got = spawnClaude({
      bin: f, args: [], spawnFn: () => { spawned = true; return fakeChild(); },
    });
    assert.equal(got.ok, false, `弾く: ${f}`);
    assert.equal(spawned, false);
    assert.match(got.reason, /\.cmd/);
  }
});

test('実行ファイルや引数が揃っていなければ、起こさずに理由を返す', () => {
  const cases = [
    { bin: '', args: [] },
    { bin: '   ', args: [] },
    { bin: null, args: [] },
    { bin: BIN, args: null },
    { bin: BIN, args: '--print' },
  ];
  for (const c of cases) {
    let spawned = false;
    const got = spawnClaude({ ...c, spawnFn: () => { spawned = true; return fakeChild(); } });
    assert.equal(got.ok, false, JSON.stringify(c));
    assert.equal(got.child, null, '半端な子を返さない');
    assert.ok(got.reason, '理由を必ず付ける');
    assert.equal(spawned, false);
  }
});

test('起こすときに spawn が同期で投げても落ちない', () => {
  const got = spawnClaude({ bin: BIN, args: [], spawnFn: () => { throw new Error('EACCES'); } });
  assert.equal(got.ok, false);
  assert.equal(got.child, null);
  assert.match(got.reason, /EACCES/);
});

/*
 * 止める
 */

test('止める段の猶予は 3秒 → 2秒', () => {
  assert.equal(STOP_SOFT_MS, 3000);
  assert.equal(STOP_HARD_MS, 2000);
});

test('もう終わっている子には何もしない', async () => {
  for (const dead of [
    Object.assign(fakeChild(), { exitCode: 0 }),
    Object.assign(fakeChild(), { signalCode: 'SIGKILL' }),
    null,
  ]) {
    let spawned = false;
    const got = await stopClaude(dead, {
      platform: 'win32', softMs: 1, hardMs: 1,
      spawnFn: () => { spawned = true; return fakeChild(); },
    });
    assert.equal(got.closed, true);
    assert.equal(got.stage, 'already');
    assert.equal(spawned, false, 'taskkill を起こさない');
  }
});

test('まず stdin を閉じて、行儀よく終わるのを待つ', async () => {
  const child = fakeChild();
  let spawned = false;
  const p = stopClaude(child, {
    platform: 'win32', softMs: 50, hardMs: 50,
    spawnFn: () => { spawned = true; return fakeChild(); },
  });

  assert.equal(child.stdin.writableEnded, true, 'もう入力は来ないと伝える');
  child.close(0);

  const got = await p;
  assert.equal(got.closed, true);
  assert.equal(got.stage, 'stdin');
  assert.equal(got.reason, null);
  assert.equal(spawned, false, 'いきなり落としにいかない');
});

test('終わらなければ taskkill で木ごと落としにいく', async () => {
  // child.kill() は直接の子だけ。claude.exe は Bash ツールで孫を作るので /T が要る
  const child = fakeChild({ pid: 999 });
  const calls = [];
  const p = stopClaude(child, {
    platform: 'win32', softMs: 1, hardMs: 1,
    spawnFn: (file, args) => {
      calls.push([file, ...args]);
      // 段3まで来たら落ちたことにする
      if (args.includes('/F')) child.close(1);
      return fakeChild();
    },
  });

  const got = await p;
  assert.deepEqual(calls, [
    ['taskkill.exe', '/PID', '999', '/T'],
    ['taskkill.exe', '/PID', '999', '/T', '/F'],
  ], 'いきなり /F にしない。書きかけの会話ログを途中で切らないため');
  assert.equal(got.closed, true);
  assert.equal(got.stage, 'force');
});

test('win32 以外は SIGTERM → SIGKILL の順に強くする', async () => {
  const child = fakeChild();
  const got = await stopClaude(child, {
    platform: 'linux', softMs: 1, hardMs: 1,
    spawnFn: () => { throw new Error('taskkill は posix に無い'); },
  });

  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  // 「止めました」と嘘を書かない。残っているかもしれないと伝える
  assert.equal(got.closed, false);
  assert.equal(got.stage, 'force');
  assert.ok(got.reason);
});

test('pid が無い子には taskkill を起こさない', async () => {
  // spawn に失敗した子には pid が無い。渡すものが無いので何もしない
  const child = fakeChild();
  child.pid = undefined;
  let spawned = false;
  const got = await stopClaude(child, {
    platform: 'win32', softMs: 1, hardMs: 1,
    spawnFn: () => { spawned = true; return fakeChild(); },
  });
  assert.equal(spawned, false);
  assert.equal(got.closed, false);
});

test('taskkill を起こせなくても落ちない', async () => {
  const got = await stopClaude(fakeChild(), {
    platform: 'win32', softMs: 1, hardMs: 1,
    spawnFn: () => { throw new Error('taskkill.exe が無い'); },
  });
  assert.equal(got.closed, false);
  assert.equal(got.stage, 'force');
});

test("taskkill が 'error' を出しても落ちない", async () => {
  // 拾っていなければ EventEmitter が投げ、テストごと落ちる
  const child = fakeChild({ pid: 7 });
  const got = await stopClaude(child, {
    platform: 'win32', softMs: 1, hardMs: 1,
    spawnFn: () => {
      const t = fakeChild();
      // listener は spawnFn が返った直後に付く。マイクロタスクへ逃がして順番を合わせる
      queueMicrotask(() => t.emit('error', new Error('見つかりません')));
      return t;
    },
  });
  assert.equal(got.closed, false);
});

test("'error' が来たら終わり扱い。close と二重に確定しない", async () => {
  // 実行ファイルが消えた後などに来る。止めたい相手がそもそも居ない
  const child = fakeChild();
  const p = stopClaude(child, { platform: 'win32', softMs: 50, hardMs: 50 });
  child.emit('error', new Error('ENOENT'));
  child.close(0);

  const got = await p;
  assert.equal(got.closed, true);
  assert.equal(got.stage, 'stdin');
});

/*
 * 最後の後始末（同期版）
 *
 * `process.on('exit')` からは**同期しか走らない**ので、3段の `stopClaude` はそこで何もしない。
 * ここに残っているのは `shutdown()` の5秒で畳めなかった子だけなので、段を踏まずに落とす。
 */

test('同期版は段を踏まずに /F まで一気に付ける', () => {
  const calls = [];
  const got = killTreeSync(999, {
    platform: 'win32',
    spawnSyncFn: (file, args, opts) => { calls.push({ file, args, opts }); return {}; },
  });

  assert.equal(got, true);
  assert.deepEqual(calls, [{
    file: 'taskkill.exe',
    args: ['/PID', '999', '/T', '/F'],
    opts: { windowsHide: true, timeout: 3000 },
  }]);
});

test('渡せる pid が無ければ手を出さない', () => {
  for (const pid of [0, -1, NaN, Infinity, null, undefined, '999', {}]) {
    let spawned = false;
    const got = killTreeSync(pid, {
      platform: 'win32', spawnSyncFn: () => { spawned = true; return {}; },
    });
    assert.equal(got, false, `値: ${String(pid)}`);
    assert.equal(spawned, false);
  }
});

test('taskkill を起こせなくても落ちない', () => {
  // ここで投げると process.on('exit') の中なので、記録すら残らないまま終わる
  const got = killTreeSync(999, {
    platform: 'win32', spawnSyncFn: () => { throw new Error('taskkill.exe が無い'); },
  });
  assert.equal(got, true);
});

test('win32 以外は taskkill を起こさない', () => {
  let spawned = false;
  // 実在しない pid。process.kill は ESRCH を投げるが、飲み込んで進む
  const got = killTreeSync(2_147_483_647, {
    platform: 'linux', spawnSyncFn: () => { spawned = true; return {}; },
  });
  assert.equal(got, true);
  assert.equal(spawned, false);
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
