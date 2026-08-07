/**
 * ClaudeDeck が自分のために読み書きする場所。
 *
 * ~/.claude 配下には絶対に書かない（読み取り専用として扱う）ので、
 * ログや設定はここに置く。いまのところ使うのは2つ。
 *
 *  - scripts/autostart.mjs … 自動起動のログ（窓が無いぶん文字の行き先が要る）
 *  - src/notify/config.mjs … 通知の設定ファイル
 *
 * 場所の決め方を2箇所に書くと必ず片方が古くなるので、ここに寄せる。
 *
 * 解決の順は LOCALAPPDATA を先に見る。配布先が Windows のため。
 * それ以外の環境でも落ちないように XDG_STATE_HOME と HOME を控えに置く。
 *
 * ここではディレクトリを作らない。パスを決めるだけの純関数にしておく。
 * 作るかどうかは呼ぶ側の都合（書くときだけ作りたい）で変わるため。
 */
import path from 'node:path';

/** 書き込み先のフォルダ名。 */
const APP_NAME = 'ClaudeDeck';

/**
 * 書き込み先のフォルダを決める。
 *
 * @param {string} fallback 環境変数がどれも無いときの親。呼ぶ側のアプリ直下などを渡す
 * @param {object} [env] 環境変数。テストから差し替えられるように引数にしてある
 * @returns {string} 例: C:\Users\me\AppData\Local\ClaudeDeck
 */
export function appDataDir(fallback, env = process.env) {
  const base = env.LOCALAPPDATA || env.XDG_STATE_HOME || env.HOME || fallback;
  return path.join(base, APP_NAME);
}

/**
 * 書き込み先のファイルのパスを決める。
 *
 * @param {string} name ファイル名（`autostart.log` など）
 * @param {string} fallback appDataDir と同じ
 * @param {object} [env] 環境変数
 */
export function appDataFile(name, fallback, env = process.env) {
  return path.join(appDataDir(fallback, env), name);
}
