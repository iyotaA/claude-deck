/**
 * 画面から保存した設定（config.json）を読み書きする1枚。
 *
 * 置き場所は `%LOCALAPPDATA%\ClaudeDeck\config.json`。
 * **`~/.claude` 配下には何があっても書かない。**
 *
 * ここに寄せてあるのは、この紙を使う人が2人いるため。
 *
 *  - `notify/`（通知の設定）
 *  - `run/dirs.mjs`（起こしてよいフォルダ）
 *
 * **`run/` から `notify/` を import させないための場所**でもある。
 * パス解決も原子的な書き込みも、以前は `notify/` の中にだけあった。
 * そこへ `run/` が手を伸ばすと層の向きが崩れるので、どちらからも使える `shared/` に置く。
 * `shared/` からは他の層を import しない（見るのは `appdata.mjs` だけ）。
 *
 * 判断は1つも持たない。**中身の意味を知っているのは呼ぶ側**で、
 * ここがやるのは「1枚の JSON を安全に読む・安全に置き換える」だけ。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appDataFile } from './appdata.mjs';
import { isPlainObject } from './objects.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
/** 環境変数がどれも無いときの控え。アプリ直下に置く */
const appRoot = path.resolve(here, '..', '..');

/**
 * 設定ファイルの置き場所。診断のときに人へ見せる。
 *
 * @param {object} [env] 環境変数。テストから差し替えられるように引数にしてある
 * @returns {string} 例: C:\Users\me\AppData\Local\ClaudeDeck\config.json
 */
export function configFilePath(env = process.env) {
  return appDataFile('config.json', appRoot, env);
}

/**
 * 設定ファイルを読む。
 *
 * **無いことも壊れていることも異常にしない。** 設定していないだけの状態が普通にあるし、
 * 書き込み途中の紙を読むこともある。読めなければ「設定なし」として進む。
 *
 * @param {object} [env] 環境変数
 * @returns {object|null} パースした中身。読めなければ null
 */
export function readConfigFile(env = process.env) {
  try {
    const file = JSON.parse(fs.readFileSync(configFilePath(env), 'utf8'));
    // 配列や数値が来たら「読めなかった」と同じ扱いにする（節を足す先が無い）
    return isPlainObject(file) ? file : null;
  } catch {
    return null;
  }
}

/**
 * 設定ファイルを丸ごと置き換える。
 *
 * 一時ファイルへ書いてから rename する。途中で落ちても壊れたファイルを残さない。
 * フォルダはここで作る（`appdata.mjs` は場所を決めるだけ、を守る）。
 *
 * **投げる。** 保存できなかったことは画面に出す必要がある（黙って消えるのが最悪）。
 * 呼ぶ側が受け止めて、理由を返す。
 *
 * @param {object} next 書き戻す全体
 * @param {object} [env] 環境変数
 * @returns {string} 書いたファイルのパス
 */
export function writeConfigFile(next, env = process.env) {
  const target = configFilePath(env);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);
  return target;
}
