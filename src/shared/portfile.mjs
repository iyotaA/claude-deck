/**
 * いま何番で動いているかを外へ置いておく紙。
 *
 * ポートは埋まっていたら +1 してずらす作りなので、4317 とは限らない。
 * 外から叩きたい側（C# ランチャ・autostart.ps1）は、番号を当てずっぽうで探すか、
 * どこかに書いてあるものを読むかのどちらかになる。書いておくほうを採る。
 *
 * ただし **これは真実ではなく助言**。
 * 異常終了すると消し損ねた紙がそのまま残るので、
 * 読む側は必ず GET /api/health で裏を取ること（紙だけを信じない）。
 *
 * 場所の決め方は appdata.mjs のまま。あちらは「パスを決めるだけの純関数」と決めてあるので、
 * 実際に書く・消すの I/O はこちらに置く。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appDataFile } from './appdata.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
/** 環境変数がどれも無いときの落ちどころ。src/shared/ から2つ上。 */
const APP_ROOT = path.join(here, '..', '..');
/** 引数の名前。`--port-file <path>` と `--port-file=<path>` の両方を受ける。 */
const FLAG = '--port-file';

/**
 * どこへ書くかを決める。
 *
 * ランチャは起動時に `--port-file` で場所を明示する。
 * これが無いと、パスを決める規則が Node 側と C# 側の2箇所に生きることになる。
 * 引数が無ければ従来どおり既定の場所に書くので、npm start も autostart もそのまま動く。
 *
 * @param {string[]} [argv] process.argv.slice(2) 相当
 * @param {object} [env] 環境変数。テストから差し替えられるように引数にしてある
 * @param {string} [fallbackRoot] 環境変数がどれも無いときの親
 * @returns {string} 絶対パス
 */
export function resolvePortFile(argv = [], env = process.env, fallbackRoot = APP_ROOT) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (typeof arg !== 'string') continue;

    let value = null;
    if (arg === FLAG) {
      // 次の要素が値。ただし `--port-file --no-open` のような書き間違いは値として取らない
      const next = argv[i + 1];
      if (typeof next === 'string' && !next.startsWith('--')) value = next;
    } else if (arg.startsWith(`${FLAG}=`)) {
      value = arg.slice(FLAG.length + 1);
    }

    if (value !== null && value.trim()) return path.resolve(value.trim());
  }
  return appDataFile('port.json', fallbackRoot, env);
}

/**
 * 実ポートを書き出す。
 *
 * 一時ファイル → rename。notify/settings.mjs と同じ作法。
 * 読む側が書き込み途中の欠けた JSON を掴むことがなくなる。
 *
 * 呼ぶ側で try/catch すること。ここが書けなくてもサーバーは動くべきなので、
 * 書けないことを致命扱いにしない。
 *
 * @param {string} file 書き先
 * @param {{port:number, pid:number, url:string, version:string|null, startedAt:number}} info 中身
 * @returns {string} 書いたパス
 */
export function writePortFile(file, info) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/**
 * 畳むときに消す。
 *
 * 無ければ何もしない。消せなくても何もしない（畳む途中で投げると後始末が止まる）。
 *
 * @param {string} file 消すパス
 */
export function removePortFile(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // 無い・既に消えている・掴まれている。どれでも畳む邪魔をしない
  }
}
