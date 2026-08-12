/**
 * このアプリの版。
 *
 * 出所は package.json の version 1箇所だけにする。
 * C# ランチャにも scripts/release.ps1 にも版を書き写さない。
 * 3つが同期するのではなく、2つが1つから派生する形にしておく
 * （書き写すと、必ずどれかが古くなって「入れたはずの版と違う」になる）。
 *
 * 読むのは起動時に1回だけ。返すのは /api/health と /api/update だけなので、
 * 毎回読み直す理由が無い。
 *
 * 読めなければ null を返す。'0.0.0' のような嘘の既定を置かない
 * （0 と「不明」を分ける、というこのアプリの決まりをここにも効かせる）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** src/shared/ から2つ上。リポジトリ直下、配布物では app\ の直下にあたる。 */
const PACKAGE_JSON = path.join(here, '..', '..', 'package.json');

/**
 * package.json から版を読む。
 *
 * パスを引数で受けるのは、テストから壊れたファイルを渡せるようにするため。
 *
 * @param {string} [file] 読むファイル。既定はこのアプリの package.json
 * @returns {string|null} 例: '0.2.0'。読めない・JSON でない・version が無ければ null
 */
export function readVersion(file = PACKAGE_JSON) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const version = parsed?.version;
    return typeof version === 'string' && version.trim() ? version.trim() : null;
  } catch {
    // 無い・壊れている・読めない。どれでも「不明」に倒す
    return null;
  }
}

/** 起動時に1回だけ決まる版。 */
export const VERSION = readVersion();
