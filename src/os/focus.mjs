/**
 * 「このセッションのターミナルを前面に出す」。
 *
 * 窓を前面へ出すところまでをやり、打つのは本人に任せる。
 * 一覧で赤を見つけて押せば、そのまま答えられる状態になるのが狙い。
 *
 * ここで**手を出さないもの**を書いておく。芯は今も変わっていない。
 *
 * - 対話版のターミナルへ打鍵を流し込まない
 * - `~/.claude` の中のファイルを書き換えて指示を差し込まない
 *
 * どちらも非公開の仕組みに乗ることになり、向こうが形を変えた日に黙って壊れる。
 *
 * 一方で「アプリからセッションを起こす」ことそのものは os/claude.mjs でやるようになった
 * （`claude -p --input-format stream-json`）。あれは**公開されている CLI の入口**なので、
 * 上の禁じ手には当たらない。注入ではなく、正面から起こして話しかけている。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// src/os/ から2段上がってリポジトリの直下に戻る。
// 階層を動かしたときにここが最初に壊れるが、実行するまで気づけない
const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'focus.ps1',
);

/** PowerShell が返事をしないまま居座らないための上限。 */
const TIMEOUT_MS = 8000;

/**
 * タブで複数セッションを抱えるターミナル。
 *
 * この手のターミナルは何タブ開いていても窓は1つなので、
 * 窓を前面に出せてもどのタブが出るかは選べない。
 * 前面化できた＝目的のセッションが見えている、とは言えないため画面で断る必要がある。
 */
const TABBED_APPS = new Set(['windowsterminal', 'wt', 'code', 'devenv', 'alacritty', 'tabby']);

/**
 * @param {number} pid Claude Code のプロセスID
 * @returns {Promise<{ok: boolean, detail?: string, app?: string, tabbed?: boolean, reason?: string}>}
 */
export function focusTerminal(pid) {
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: false, reason: 'この機能は Windows でのみ使えます' });
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return Promise.resolve({ ok: false, reason: 'PID が不正です' });
  }

  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };

    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath, '-TargetPid', String(pid),
    ], { windowsHide: true });

    let out = '';
    let err = '';
    ps.stdout.on('data', (d) => { out += d; });
    ps.stderr.on('data', (d) => { err += d; });

    ps.on('error', (e) => finish({ ok: false, reason: String(e?.message ?? e) }));

    ps.on('close', (code) => {
      const text = out.trim();
      if (code === 0 && text.startsWith('OK')) {
        // 「OK <プロセス名> <PID>」の形で返ってくる
        const detail = text.slice(2).trim();
        const app = detail.split(/\s+/)[0] ?? '';
        finish({ ok: true, detail, app, tabbed: TABBED_APPS.has(app.toLowerCase()) });
      } else if (text === 'NOWINDOW') {
        finish({ ok: false, reason: '窓を持つターミナルが見つかりませんでした' });
      } else {
        finish({ ok: false, reason: err.trim() || text || `終了コード ${code}` });
      }
    });

    const timer = setTimeout(() => {
      try { ps.kill(); } catch { /* すでに終わっている */ }
      finish({ ok: false, reason: '応答がありませんでした' });
    }, TIMEOUT_MS);
    ps.on('close', () => clearTimeout(timer));
  });
}
