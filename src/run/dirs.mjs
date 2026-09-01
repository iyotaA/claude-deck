/**
 * 起こしてよいフォルダを、画面から足したり消したりする。
 *
 * これまで許可リストの出どころは2つだけだった。
 *
 *  - `CLAUDE_DECK_RUN_DIRS`（`;` 区切りの環境変数）
 *  - 一覧に出ている cwd（＝このマシンで Claude Code が実際に動いたフォルダ）
 *
 * つまり**まだ一度も走らせていないフォルダは、画面から起こせない。**
 * 足すには環境変数を書いてサーバーを立て直すしかなく、自動起動で裏に立っている版では
 * それができない。そこを埋めるための3つ目の出どころ。
 *
 * ## これは許可リストをブラウザから書き足せるようにするもの
 *
 * `run/spec.mjs` 冒頭のとおり、この機能の被害は「表示が変わる」ではなく
 * **コードが実行される**。その範囲を絞っていたのが cwd の許可リストなので、
 * そこへ書き込む口を開ける以上、歯止めは自前で持つ。
 *
 *  - 窓口は書き込み口の門番（`shared/origin.mjs`）の内側にだけ置く（`server.mjs`）
 *  - **実在するフォルダしか登録させない**（`dirExists`）。打ち間違いをその場で返す
 *  - **ドライブ直下（`C:\` / `/`）は断る。** 通すとマシン全体が許可リストに入る
 *  - 件数に上限（`RUN_DIRS_MAX`）を置く
 *
 * 「配下かどうか」の判定は**1行も書き足さない。** `spec.mjs` の `resolveCwd()` を
 * そのまま呼ぶ（門番と同じ判断で「もう登録済み」を見る）。2つ書くと必ず片方が古くなる。
 *
 * ## 判断と I/O を分ける
 *
 * `run/rate.mjs` と同じ形。純関数（`checkRunDir` / `parseRunDirs` / `addRunDir` /
 * `removeRunDir` / `mergeRunDirs`）と、薄い殻（`dirExists` / `loadRunDirs` / `saveRunDirs`）。
 * 紙そのものの読み書きは `shared/configfile.mjs` が持つ（通知の設定と同じ1枚）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { readConfigFile, writeConfigFile } from '../shared/configfile.mjs';
import { resolveCwd } from './spec.mjs';

/**
 * 登録できる件数の上限。
 *
 * 押し間違いで積み上がるのを止めるためだけの数。20 も並べば、
 * 起こすフォームの選択肢としては既に多すぎる。
 */
export const RUN_DIRS_MAX = 20;

/**
 * 文字列として受け取り、前後の空白を落とす。
 *
 * @param {*} v 何か
 * @returns {string} 文字列でなければ空文字
 */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * その環境の path。テストから win32 と posix の両方を通せるようにしてある。
 *
 * @param {string} platform 'win32' など
 * @returns {object} path.win32 か path.posix
 */
function pathFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * 見分けるための鍵。win32 は大小を区別しない。
 *
 * @param {string} dir 正規化済みの絶対パス
 * @param {string} platform 'win32' など
 * @returns {string}
 */
function keyOf(dir, platform) {
  return platform === 'win32' ? dir.toLowerCase() : dir;
}

/**
 * 画面から来たフォルダの形を確かめる。純関数。**実在するかはここでは見ない。**
 *
 * 断る理由は日本語で返す。画面はそれをそのまま出すので、
 * 「登録できません」だけで終わらせない（何を直せばいいのか分かる文にする）。
 *
 * @param {*} raw 画面から来た値
 * @param {object} [opts]
 * @param {string} [opts.platform] 'win32' など
 * @returns {{ok:true, dir:string}|{ok:false, reason:string}}
 */
export function checkRunDir(raw, { platform = process.platform } = {}) {
  const p = pathFor(platform);
  const value = str(raw);

  if (!value) return { ok: false, reason: '作業フォルダが指定されていません' };
  // `-` 始まりは argv でフラグとして読まれる形。ここへ来る値がそのまま
  // `--cwd` に使われるわけではないが、許可リストに置く値は spec.mjs と同じ関所を通す
  if (value.startsWith('-') || !p.isAbsolute(value)) {
    return { ok: false, reason: '作業フォルダは絶対パスで指定してください' };
  }

  // 末尾の区切りと '..' はここで畳まれる
  const dir = p.resolve(value);

  // ドライブ直下は断る。`C:\` を通すと、その1件で全部が許可リストに入る
  if (p.dirname(dir) === dir) {
    return { ok: false, reason: 'ドライブの直下は登録できません（1つ下のフォルダを指定してください）' };
  }

  return { ok: true, dir };
}

/**
 * 紙（config.json）の `run.dirs` を読む。純関数。
 *
 * **未知の形で落ちない。** 配列でない・文字列でない・絶対パスでない・重複しているものは
 * 黙って落とす。手で書き換えられる紙なので、読む側が全部受け止める。
 *
 * @param {*} file 読み込んだ config.json。無ければ null
 * @param {string} [platform] 'win32' など
 * @returns {string[]} 正規化済みの絶対パス
 */
export function parseRunDirs(file, platform = process.platform) {
  const p = pathFor(platform);
  const raw = file?.run?.dirs;
  if (!Array.isArray(raw)) return [];

  const seen = new Set();
  const dirs = [];
  for (const item of raw) {
    const value = str(item);
    if (!value || !p.isAbsolute(value)) continue;
    const dir = p.resolve(value);
    const key = keyOf(dir, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push(dir);
    if (dirs.length >= RUN_DIRS_MAX) break;
  }
  return dirs;
}

/**
 * 並べ直す。名前順。
 *
 * 使った順にすると、作業しているあいだに並びが動いて押す場所が毎回変わる
 * （`server.mjs` の `allowedRunDirs()` を並べ直しているのと同じ理由）。
 *
 * @param {string[]} dirs
 * @returns {string[]} 新しい配列
 */
function sorted(dirs) {
  return [...dirs].sort((a, b) => a.localeCompare(b));
}

/**
 * 1つ足す。純関数。**実在するかはここでは見ない**（呼ぶ側が `dirExists` で確かめる）。
 *
 * 既に入っているかの判定に `resolveCwd()` を使うのが要点。
 * あれは「許可したフォルダの配下か」を見る関所そのものなので、
 * **登録済みのフォルダの子を足そうとしたときも断れる**（足しても何も増えないため）。
 *
 * @param {string[]} list いまの一覧
 * @param {string} dir `checkRunDir` を通した絶対パス
 * @param {object} [opts]
 * @param {string} [opts.platform] 'win32' など
 * @returns {{ok:true, dirs:string[]}|{ok:false, reason:string}}
 */
export function addRunDir(list, dir, { platform = process.platform } = {}) {
  const current = Array.isArray(list) ? list : [];

  const covered = resolveCwd(dir, { allowedDirs: current, platform });
  if (covered.ok) {
    return { ok: false, reason: 'そのフォルダは登録済みです（登録したフォルダの配下も使えます）' };
  }

  if (current.length >= RUN_DIRS_MAX) {
    return { ok: false, reason: `登録できるのは ${RUN_DIRS_MAX} 件までです（先に何か消してください）` };
  }

  return { ok: true, dirs: sorted([...current, dir]) };
}

/**
 * 1つ消す。純関数。
 *
 * **配下では消せない。** 消すのは登録したそのものだけで、
 * `C:\work\a` を渡して `C:\work` を消せる形にはしない。
 *
 * @param {string[]} list いまの一覧
 * @param {string} dir `checkRunDir` を通した絶対パス
 * @param {object} [opts]
 * @param {string} [opts.platform] 'win32' など
 * @returns {{ok:true, dirs:string[]}|{ok:false, reason:string}}
 */
export function removeRunDir(list, dir, { platform = process.platform } = {}) {
  const current = Array.isArray(list) ? list : [];
  const key = keyOf(dir, platform);
  const dirs = current.filter((d) => keyOf(d, platform) !== key);

  if (dirs.length === current.length) {
    return { ok: false, reason: 'そのフォルダは登録されていません' };
  }
  return { ok: true, dirs };
}

/**
 * 紙に書き戻す形を組む。純関数。
 *
 * **知らないキーは残す。** config.json はこの機能だけのものではない
 * （通知の設定が同じ紙に入っている）。`notify/settings.mjs` の `mergeSettings` と同じ作法。
 *
 * @param {*} file 読み込んだ config.json。無ければ null
 * @param {string[]} dirs 書き込む一覧
 * @returns {object} 書き戻す全体
 */
export function mergeRunDirs(file, dirs) {
  const base = file && typeof file === 'object' && !Array.isArray(file) ? file : {};
  const run = base.run && typeof base.run === 'object' && !Array.isArray(base.run) ? base.run : {};
  return { ...base, run: { ...run, dirs: [...dirs] } };
}

/**
 * 実在するフォルダか。薄い殻。**投げない。**
 *
 * ファイルを指していたら偽。読めないとき（権限が無いなど）も偽で返す。
 * 「登録できたのに起こせない」を作らないための確認なので、
 * 確かめられなかったものは通さない側に倒す。
 *
 * @param {string} dir 絶対パス
 * @returns {boolean}
 */
export function dirExists(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 紙から一覧を読む。薄い殻。
 *
 * @param {object} [env] 環境変数
 * @returns {string[]}
 */
export function loadRunDirs(env = process.env) {
  return parseRunDirs(readConfigFile(env), process.platform);
}

/**
 * 紙へ一覧を書く。薄い殻。
 *
 * **投げる。** 保存できなかったことは画面に出す必要がある
 * （`rate.json` と違って、これは人が入れた設定で、黙って消えるのがいちばん困る）。
 *
 * @param {string[]} dirs 書き込む一覧
 * @param {object} [env] 環境変数
 * @returns {string} 書いたファイルのパス
 */
export function saveRunDirs(dirs, env = process.env) {
  return writeConfigFile(mergeRunDirs(readConfigFile(env), dirs), env);
}
