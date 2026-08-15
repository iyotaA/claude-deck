/**
 * ログオン時に、サーバーだけを窓を出さずに起動する。
 *
 * スタートアップに置くショートカットは、このファイルを指す。
 * ここから server.mjs を切り離して起動し、自分はすぐ終わる。
 * 直接サーバーを起動すると黒い窓が残り、ログオンのたびに邪魔になるため。
 *
 * 窓が無いぶん、画面に出ていた文字の行き先が無くなる。
 * そのため %LOCALAPPDATA%\ClaudeDeck\autostart.log に書き出す。
 * ~/.claude 配下には書かない（読み取り専用として扱う）。
 *
 * 使い方:
 *   node scripts/autostart.mjs        サーバーを裏で起動する
 *   scripts/autostart.ps1             ログオン時の自動起動を設定する
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appDataDir, appDataFile } from '../src/shared/appdata.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const serverFile = path.join(appDir, 'server.mjs');

// 場所の決め方は appdata.mjs に寄せてある。設定ファイルも同じところを使う
const logDir = appDataDir(appDir);
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, 'autostart.log');

// 実ポートを置く紙の場所。
// server.mjs は --port-file を渡された起動だけが紙を書く作りなので、ここで明示する。
// 渡さないと autostart.ps1 の -Action stop / status がポートと PID を拾えなくなる
const portFile = appDataFile('port.json', appDir);

// 毎回書き直す。追記のままだと際限なく伸びる
const log = fs.openSync(logFile, 'w');
fs.writeSync(log, `${new Date().toLocaleString()} 起動します\n  ${serverFile}\n`);

// windowsHide で窓を作らせない。detached と unref で、この処理が終わっても残るようにする
const child = spawn(process.execPath, [serverFile, '--no-open', '--port-file', portFile], {
  cwd: appDir,
  detached: true,
  windowsHide: true,
  stdio: ['ignore', log, log],
});

child.on('error', (err) => {
  fs.writeSync(log, `起動できませんでした: ${err.message}\n`);
  fs.closeSync(log);
  process.exit(1);
});

child.unref();
// 子は自分用に複製した書き込み口を持つので、こちらは閉じてよい
fs.closeSync(log);
console.log(`ClaudeDeck を裏で起動しました (PID ${child.pid})`);
console.log(`  記録: ${logFile}`);
