/**
 * C# ランチャ・PowerShell と Node のあいだの約束を固定するテスト。
 *
 * ここに並ぶのは「文字列だけで繋がっていて、片側を変えても何のエラーも出ないもの」。
 * 壊れ方が静かなので、網が無いと気づけない。
 * 実測で1度踏んでいる（起動経路の語がずれて相乗りの判断が黙って無効になり、
 * 原因を掴むのに netstat からプロセスの親まで辿ることになった）。
 *
 * **なぜソースの字を直に読むのか。**
 * C# と Node は別言語なので定数を共有できない。
 * import で確かめられるのは Node 側の半分だけで、それでは
 * 「両方を同時に直したか」が見えない。ここで見たいのは片側だけ直った状態なので、
 * 両側のソースを開いて同じ字が在ることを確かめる。
 *
 * **素の includes で見てはいけない。** 最初そう書いて空振りした。
 * `startedBy` を `startedByX` に変えても通ってしまう（前方が一致するため）し、
 * 説明文に同じ語が出てくると、実装から消えても在ることになる。
 * だからコメントを落として（`code`）、単語の切れ目まで見る（`has`）。
 *
 * **この形は行の移動に弱い。** 落ちたときは「壊した」ではなく
 * 「両側を見比べろ」の合図として読む。
 * 消してよいのは、その約束そのものを無くしたときだけ。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VIA_LAUNCHER, VIA_MANUAL } from '../src/shared/portclaim.mjs';
import { configFilePath } from '../src/shared/configfile.mjs';
import { resolvePortFile } from '../src/shared/portfile.mjs';
import { ratePath } from '../src/run/rate.mjs';
import { updateStatePath } from '../src/update/state.mjs';
import { startupStatePath } from '../src/startup/state.mjs';
import { skillIndexPath } from '../src/read/skills.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * リポジトリからの相対パスでソースを読む。
 *
 * @param {string} rel リポジトリ直下からの相対パス
 * @returns {string} 中身
 */
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/**
 * コメントを落としたソース。
 *
 * このリポジトリは説明が厚く、実装から消した語がコメントに残る。
 * それを拾うと「消したのに通る」になるので、見る前に落とす。
 *
 * @param {string} rel リポジトリ直下からの相対パス
 * @returns {string} コメントを除いた中身
 */
function code(rel) {
  return src(rel)
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/?\*|#)/.test(line))
    .map((line) => line.replace(/\s\/\/.*$/, ''))
    .join('\n');
}

/**
 * 空白を落としたソース。
 *
 * `path.join()` の引数は折り返して書かれていることがあり、
 * 改行の入り方で見え方が変わってしまう。段数だけを見たいのでここで潰す。
 *
 * @param {string} rel リポジトリ直下からの相対パス
 * @returns {string} 空白を1つも含まない中身
 */
function packed(rel) {
  return src(rel).replace(/\s+/g, '');
}

/**
 * 語の切れ目まで見て、その字が在るかを答える。
 *
 * `includes` だと `startedBy` が `startedByX` にも当たってしまい、
 * 改名を検出できない。ここが空振りするとテスト全体が飾りになる。
 *
 * **末尾が単語文字の字にだけ使う。** `'ClaudeDeckApp'` のようにクォートで
 * 終わる字に使うと、後ろに語が続くことを求めてしまって必ず外れる。
 * 囲まれている字は前後が確定しているので、素の `includes` で足りる。
 *
 * @param {string} text 探す先
 * @param {string} token 探す字（正規表現ではなくそのままの文字列）
 * @returns {boolean}
 */
function has(text, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}\\b`).test(text);
}

/** 環境変数を1つも持たない env。紙の場所の解決を既定へ倒すために使う。 */
const NO_ENV = {};

// ---------------------------------------------------------------------------
// GET /api/health のフィールド
// ---------------------------------------------------------------------------
//
// 画面だけでなく、ランチャ（C#）と旧方式の自動起動（PowerShell）が読む。
// ok が true でないとランチャは「動いていない」と判断し、二重起動を試みて
// 10秒でタイムアウトする。startedBy が欠けると相乗りの判断が無効になる。

test('/api/health が返すフィールドは、ランチャが読むぶんを欠かさない', () => {
  const server = code('server.mjs');
  const health = server.slice(server.indexOf("pathname === '/api/health'"));

  for (const key of ['ok: true', 'version:', 'configDir,', 'clients:', 'startedBy:']) {
    assert.ok(health.includes(key), `/api/health の応答に ${key} が無い`);
  }
});

test('ランチャ（C#）が /api/health から読むキーは5つ。名前を変えない', () => {
  const cs = code('launcher/ServerProcess.cs');

  for (const key of ['"ok"', '"version"', '"configDir"', '"clients"', '"startedBy"']) {
    assert.ok(cs.includes(key), `ServerProcess.cs が ${key} を読まなくなっている`);
  }
});

test('旧方式の自動起動（PowerShell）も /api/health を見ている', () => {
  assert.ok(has(code('scripts/autostart.ps1'), '/api/health'), 'autostart.ps1 が /api/health を叩かなくなっている');
});

// ---------------------------------------------------------------------------
// POST /api/quit
// ---------------------------------------------------------------------------
//
// 画面からは一度も叩かれない外部専用の窓口。
// 更新の前にサーバーを止められないと、node.exe がファイルを掴んだまま
// Velopack の差し替えが転ぶ。

test('POST /api/quit は外部（C# と PowerShell）から叩かれる。窓口を消さない', () => {
  assert.ok(code('server.mjs').includes("'/api/quit'"), 'server.mjs から /api/quit が消えている');
  assert.ok(has(code('launcher/ServerProcess.cs'), '/api/quit'), 'C# 側の /api/quit が消えている');
  assert.ok(has(code('scripts/autostart.ps1'), '/api/quit'), 'PowerShell 側の /api/quit が消えている');
});

test('外部からの /api/quit は content-type で門番を通る。条件を厳しくしない', () => {
  // origin.mjs が content-type を必須にしているので、C# も PowerShell も
  // application/json を名乗っている。ここに origin ヘッダの必須化などを足すと、
  // ブラウザを持たない2つの呼び出しが真っ先に落ちる
  assert.ok(has(code('launcher/ServerProcess.cs'), 'application/json'));
  assert.ok(has(code('scripts/autostart.ps1'), 'application/json'));
});

// ---------------------------------------------------------------------------
// サーバーを起こす argv
// ---------------------------------------------------------------------------

test('ランチャが渡す --no-open と --port-file を、Node 側が受け続ける', () => {
  const cs = code('launcher/ServerProcess.cs');
  assert.ok(has(cs, '--no-open'), 'C# が --no-open を渡さなくなっている');
  assert.ok(has(cs, '--port-file'), 'C# が --port-file を渡さなくなっている');

  assert.ok(has(code('server.mjs'), '--no-open'), 'server.mjs が --no-open を見なくなっている');
  assert.ok(code('src/shared/portfile.mjs').includes("'--port-file'"), 'portfile.mjs の旗の名前が変わっている');
});

test('旧方式の自動起動も同じ2つの旗で起こす', () => {
  const mjs = code('scripts/autostart.mjs');
  assert.ok(has(mjs, '--no-open'));
  assert.ok(has(mjs, '--port-file'));
});

test('更新の再起動でやり取りする旗の名前を変えない', () => {
  // server.mjs がランチャを --apply-update --wait-pid <pid> で起こし、
  // Velopack が新しいランチャを --restarted で起こす。
  // **旧版のランチャが新版を --restarted で起こす**ので、
  // 新版が受けなくなると更新の直後にサーバーが立たない
  const server = code('server.mjs');
  assert.ok(has(server, '--apply-update'), 'server.mjs が --apply-update を組まなくなっている');
  assert.ok(has(server, '--wait-pid'), 'server.mjs が --wait-pid を組まなくなっている');

  const program = code('launcher/Program.cs');
  for (const flag of ['--apply-update', '--wait-pid', '--restarted', '--background']) {
    assert.ok(has(program, flag), `Program.cs が ${flag} を受けなくなっている`);
  }
  assert.ok(has(code('launcher/Updates.cs'), '--restarted'), 'Velopack へ渡す --restarted が消えている');
});

// ---------------------------------------------------------------------------
// 環境変数
// ---------------------------------------------------------------------------

test('CLAUDE_DECK_LAUNCHER を両側が同じ名前で見ている', () => {
  // これが無いと canApply が常に false になり、更新ボタンが永久に押せない
  assert.ok(has(code('launcher/ServerProcess.cs'), 'CLAUDE_DECK_LAUNCHER'));
  assert.ok(has(code('server.mjs'), 'CLAUDE_DECK_LAUNCHER'));
});

test('CLAUDE_DECK_PORT を両側が同じ名前で見ている', () => {
  // 更新の再起動で番号を戻す口。無いと、開いたままの窓が復帰しない
  assert.ok(has(code('launcher/ServerProcess.cs'), 'CLAUDE_DECK_PORT'));
  assert.ok(has(code('server.mjs'), 'CLAUDE_DECK_PORT'));
});

// ---------------------------------------------------------------------------
// 起動経路の語
// ---------------------------------------------------------------------------

test('起動経路の語は manual と launcher。C# が文字列で照合する', () => {
  assert.equal(VIA_MANUAL, 'manual');
  assert.equal(VIA_LAUNCHER, 'launcher');
  // ずれてもエラーは出ない。ただ相乗りの判断が効かなくなるだけなので、ここで留める
  assert.ok(code('launcher/ServerProcess.cs').includes('"manual"'), 'C# 側の manual が消えている');
});

// ---------------------------------------------------------------------------
// %LOCALAPPDATA%\ClaudeDeck\ の紙
// ---------------------------------------------------------------------------
//
// ここは更新でもアンインストールでも掃除されない。
// 名前を変えると旧ファイルが永久に残り、消すコードを誰も持っていない。

test('紙の名前は6つ。改名すると旧ファイルが永久に残る', () => {
  const at = (p) => path.basename(p);

  assert.equal(at(configFilePath(NO_ENV)), 'config.json');
  assert.equal(at(resolvePortFile([], NO_ENV)), 'port.json');
  assert.equal(at(ratePath(NO_ENV)), 'rate.json');
  assert.equal(at(updateStatePath(NO_ENV)), 'update.json');
  assert.equal(at(startupStatePath(NO_ENV)), 'startup.json');
  assert.equal(at(skillIndexPath(NO_ENV)), 'skills.json');
});

test('C# 側も同じ3つの紙を同じ名前で見ている', () => {
  const paths = code('launcher/Paths.cs');
  for (const name of ['"port.json"', '"update.json"', '"startup.json"']) {
    assert.ok(paths.includes(name), `Paths.cs が ${name} を見なくなっている`);
  }
});

test('置き場所の名前は ClaudeDeck。3箇所が同時に変わらないと壊れる', () => {
  // Node・C#・PowerShell がそれぞれ独立に組み立てている。
  // 別言語なので共通化はできない。3つ揃っていることだけ確かめる
  assert.ok(code('src/shared/appdata.mjs').includes("'ClaudeDeck'"));
  assert.ok(code('launcher/Paths.cs').includes('"ClaudeDeck"'));
  assert.ok(code('scripts/autostart.ps1').includes("'ClaudeDeck'"));
});

// ---------------------------------------------------------------------------
// 紙の中のキー名
// ---------------------------------------------------------------------------

test('config.json のキー名を変えない。移行コードが1行も無い', () => {
  // 改名すると Slack の Webhook と「起こしてよいフォルダ」の登録が黙って消える。
  // 設定していないのと同じ状態に戻るので、利用者は気づけない
  const config = code('src/notify/config.mjs');
  for (const key of ['slackWebhookUrl', 'settleSec', 'idleMin', 'remindMin', 'detail', 'states']) {
    assert.ok(has(config, `notify.${key}`), `config.json の notify.${key} を読まなくなっている`);
  }

  const dirs = code('src/run/dirs.mjs');
  assert.ok(has(dirs, 'run?.dirs') || has(dirs, 'run.dirs'), 'config.json の run.dirs を読まなくなっている');
});

test('update.json の requested と prevPort を両側が使う', () => {
  // requested は更新のあとの版の照合、prevPort は開いたままの窓の復帰に使う。
  // 消すと「当てたと言ったのに何も起きていない」を捕まえる網が無くなる
  const cs = code('launcher/Updates.cs');
  assert.ok(cs.includes('"requested"'), 'C# が requested を読み書きしなくなっている');
  assert.ok(cs.includes('"prevPort"'), 'C# が prevPort を読み書きしなくなっている');

  assert.ok(has(code('src/update/state.mjs'), 'raw.requested'), 'Node が requested を読まなくなっている');
});

// ---------------------------------------------------------------------------
// 配布物の許可リスト
// ---------------------------------------------------------------------------

test('配布物の許可リストが、実行時に要るものを欠かさない', () => {
  // $APP_INCLUDE はトップレベルの名前だけの許可リスト。
  // src/ と public/ の中は丸ごとコピーされるので、そちらの改名はここに現れない。
  // 逆に、ここに並ぶ名前を動かすと release がその場で止まる（それが狙いの形）
  const ps1 = src('scripts/release.ps1');
  const list = ps1.slice(ps1.indexOf('$APP_INCLUDE'), ps1.indexOf('$APP_INCLUDE') + 600);

  for (const name of ["'server.mjs'", "'cli.mjs'", "'package.json'", "'src'", "'public'"]) {
    assert.ok(list.includes(name), `$APP_INCLUDE から ${name} が消えている`);
  }
  // 実行時にしか要らないので忘れやすい2つ
  assert.ok(list.includes('focus.ps1'), '窓の前面化に要る focus.ps1 が配布物から外れている');
  assert.ok(list.includes('slack-webhook-setup.html'), 'README から案内している手引きが配布物から外れている');
});

test('パック名とリポジトリの URL を変えない。既存の更新が永久に止まる', () => {
  // 既存インストールの Update.exe は ClaudeDeckApp の releases を探す。
  // 変えると、いま使っている人の手元で更新が二度と当たらなくなる
  // クォートで囲まれた字は has を通さない（末尾が単語文字でないと語の切れ目を見られない）。
  // 囲まれている時点で前後が確定しているので、素の includes で足りる
  const ps1 = code('scripts/release.ps1');
  assert.ok(ps1.includes("'ClaudeDeckApp'"), 'パック名が変わっている');
  assert.ok(ps1.includes("'ClaudeDeck.exe'"), '窓口の exe 名が変わっている');

  // URL は release.ps1（上げ先）と Updates.cs（取得元）の2箇所にある。
  // 片方だけ変えると片道になる
  const url = 'github.com/iyotaA/claude-deck';
  assert.ok(has(ps1, url), 'release.ps1 の上げ先が変わっている');
  assert.ok(has(code('launcher/Updates.cs'), url), 'Updates.cs の取得元が変わっている');
});

// ---------------------------------------------------------------------------
// 実行時に効く相対パス
// ---------------------------------------------------------------------------
//
// release.ps1 は src/ と public/ の中を見ないので、ここがずれても
// 配布物を組む時点では気づけない。実行して初めて壊れる。

test('src/os/focus.mjs から scripts/focus.ps1 への段数が合っている', () => {
  const focus = packed('src/os/focus.mjs');
  const rel = focus.includes("'..','..','scripts','focus.ps1'") || focus.includes('../../scripts/focus.ps1');
  assert.ok(rel, 'focus.ps1 への相対パスの形が変わっている。段数を数え直すこと');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'focus.ps1')), 'scripts/focus.ps1 が無い');
});

test('src/shared/appinfo.mjs から package.json への段数が合っている', () => {
  // 版が読めないと /api/health の version が null になり、
  // update.json の stale の判定も効かなくなる
  const info = packed('src/shared/appinfo.mjs');
  const rel = info.includes("'..','..','package.json'") || info.includes('../../package.json');
  assert.ok(rel, 'package.json への相対パスの形が変わっている。段数を数え直すこと');
});

test('server.mjs から public への向きが変わっていない', () => {
  const server = code('server.mjs');
  assert.ok(server.includes("'public'") || server.includes('./public'), '静的配信の根が変わっている');
  assert.ok(fs.existsSync(path.join(ROOT, 'public', 'index.html')), 'public/index.html が無い');
});
