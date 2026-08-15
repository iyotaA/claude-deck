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
 * **書くのは `--port-file` を渡された起動だけ**（hasPortFileFlag）。
 * 紙は1枚しかないので、同じマシンで2本立つと後から立ったほうが上書きし、
 * 先に止めたほうが消す。実際に踏んだ（インストール版が動いているのに紙だけ消えた）。
 * 開発側の `npm start` は紙を必要としない（ポートはコンソールに出る）ので、
 * 書く主体を「場所を明示してきた起動」に絞れば、取り合いそのものが起きなくなる。
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
 * argv から `--port-file` の値を取り出す。
 *
 * 場所を決めるのと「明示されたか」を見るのとで、同じ走査を2回書かないための土台。
 * 書き分けると必ず片方が古くなり、「場所は決まったのに書かれない」形で食い違う。
 *
 * @param {string[]} argv process.argv.slice(2) 相当
 * @returns {string|null} 値。書き間違い（次が別のフラグ・値が空・最後で値が無い）は null
 */
function findPortFileArg(argv) {
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

    if (value !== null && value.trim()) return value.trim();
  }
  return null;
}

/**
 * どこへ書くかを決める。
 *
 * ランチャは起動時に `--port-file` で場所を明示する。
 * これが無いと、パスを決める規則が Node 側と C# 側の2箇所に生きることになる。
 * 引数が無ければ既定の場所を返すが、**そこへ書くかどうかは別の話**（hasPortFileFlag を見る）。
 *
 * @param {string[]} [argv] process.argv.slice(2) 相当
 * @param {object} [env] 環境変数。テストから差し替えられるように引数にしてある
 * @param {string} [fallbackRoot] 環境変数がどれも無いときの親
 * @returns {string} 絶対パス
 */
export function resolvePortFile(argv = [], env = process.env, fallbackRoot = APP_ROOT) {
  const explicit = findPortFileArg(argv);
  if (explicit !== null) return path.resolve(explicit);
  return appDataFile('port.json', fallbackRoot, env);
}

/**
 * 紙を書く役目を負った起動かどうか。
 *
 * 真になるのは `--port-file` で場所を明示された起動だけ（ランチャと autostart.mjs）。
 * 偽のときは書かないし、畳むときも消さない。
 * 開発側の `npm start` をここに落とすことで、インストール版が置いた紙を
 * 上書きしたり巻き添えで消したりしなくなる。
 *
 * 書き間違い（`--port-file` の後ろに値が無い等）は偽。
 * resolvePortFile が既定へ落ちるのと歩調が揃う。
 *
 * @param {string[]} [argv] process.argv.slice(2) 相当
 * @returns {boolean}
 */
export function hasPortFileFlag(argv = []) {
  return findPortFileArg(argv) !== null;
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
