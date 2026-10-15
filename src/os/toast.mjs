/**
 * Windows の通知（トースト）を1枚出す。**薄い殻。判断を持たない。**
 *
 * 何を出すか（XML）と差出人（AppId）は呼ぶ側が決める（`notify/toast.mjs` と `notify/index.mjs`）。
 * ここは `scripts/toast.ps1` を起こして結果を返すだけ。`os/focus.mjs` と同じ形。
 *
 * プロジェクト内の import はゼロ（`os/` の約束）。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// src/os/ から2段上がってリポジトリの直下に戻る。
// 配布物では scripts/toast.ps1 を許可リスト（release.ps1 の $APP_INCLUDE）で入れている
const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'toast.ps1',
);

/** PowerShell が返事をしないまま居座らないための上限。WinRT の読み込みで1〜2秒かかる */
const TIMEOUT_MS = 10000;

/**
 * トーストを1枚出す。**投げない。** 失敗も `{ ok: false, reason }` で返す。
 *
 * @param {string} xml トーストの XML（notify/toast.mjs が組んだもの）
 * @param {string} appId 差出人の AppUserModelID
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export function showToast(xml, appId) {
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: false, reason: 'Windows の通知は Windows でのみ使えます' });
  }

  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };

    // 本文は base64 で渡す。素の引数や標準入力だと、5.1 は OEM のコードページで読んで化ける
    const b64 = Buffer.from(xml, 'utf8').toString('base64');
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath, '-XmlB64', b64, '-AppId', appId,
    ], { windowsHide: true });

    const timer = setTimeout(() => {
      ps.kill();
      finish({ ok: false, reason: 'PowerShell が時間内に終わりませんでした' });
    }, TIMEOUT_MS);

    let out = '';
    ps.stdout.on('data', (d) => { out += d; });
    ps.on('error', (e) => finish({ ok: false, reason: String(e?.message ?? e) }));
    ps.on('close', (code) => {
      const text = out.trim();
      if (code === 0 && text.startsWith('OK')) {
        finish({ ok: true });
        return;
      }
      // 「NG <理由>」の形で返ってくる。取れなければ終了コードだけ言う
      const why = text.startsWith('NG') ? text.slice(2).trim() : '';
      finish({ ok: false, reason: why || `PowerShell が終了コード ${code} で終わりました` });
    });
  });
}
