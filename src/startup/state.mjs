/**
 * 自動起動の様子を読む。
 *
 * 書くのは C# ランチャ（launcher/Startup.cs）だけ、読むのはここだけ。
 * 向きは C#（書く）→ startup.json → Node（読む）→ 画面 の一方通行で、
 * src/update/state.mjs とまったく同じ形にしてある。
 *
 * レジストリを Node から直接見れば紙を1枚減らせるが、そうすると
 * 「どこに何を登録したか」の知識が C# と Node の2箇所に生きることになる。
 * 片方が必ず古くなるので、そういう形は作らない。
 *
 * ここに登録・解除の口は作らない。押した結果を返せないため。
 * スタブ（<install>\ClaudeDeck.exe）は子の終了コードを伝えない（実測）ので、
 * 画面から叩いても成否が分からず、いつも「できました」と言うことになる。
 * 入切は ClaudeDeck.exe --install-startup / --uninstall-startup の役目。
 *
 * 判断（parseStartupState）と読み取り（loadStartupState）を分けてある。
 * 前者が純関数なので、状態の読み替えだけをテストできる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appDataFile } from '../shared/appdata.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
/** 環境変数がどれも無いときの控え。アプリ直下に置く */
const appRoot = path.resolve(here, '..', '..');

/**
 * 状態の日本語。画面はこれを引くだけにして、日本語を持たない。
 *
 * 上の4つはランチャが書くもの、下の2つはここで足すもの。
 * ランチャ側のコンソール用の文言は launcher/Startup.cs の Describe が持つ。
 * 同じ意味を2箇所に書いているので、片方を直したらもう片方も見る。
 *
 * foreign は「値はあるが自分たちの場所を指していない」。
 * ランチャは見つけたときに書き直しを試みるので、ここまで残っているのは直せなかったもの。
 */
export const STARTUP_LABELS = {
  on: 'ログオン時に起動します',
  off: 'ログオン時には起動しません',
  foreign: '別の場所が登録されています',
  'not-installed': 'この起動の仕方では登録できません',

  idle: 'まだ調べていません',
  unknown: '状態が分かりません',
};

/**
 * 旧方式（スタートアップフォルダの ClaudeDeck.lnk）の様子。
 *
 * 消さずに改名して残すので、利用者はいつでも戻せる。
 * active は「残っているが触っていない」で、入れて使っていないときにだけ出る。
 */
export const LEGACY_LABELS = {
  none: '残っていません',
  active: '残っています',
  disabled: '無効にしました',
  failed: '無効にできませんでした',

  unknown: '分かりません',
};

/**
 * 状態に対応する日本語を引く。
 *
 * 知らない状態が来ても、状態そのものは通したまま言い方だけ落とす。
 * ランチャが先に新しい状態を書くようになったとき、
 * ここが勝手に unknown へ潰すと「読めませんでした」と嘘をつくことになる。
 *
 * @param {string} state 状態の語
 * @returns {string} 画面に出す1行
 */
export function startupLabel(state) {
  return STARTUP_LABELS[state] || STARTUP_LABELS.unknown;
}

/**
 * 旧方式の様子に対応する日本語を引く。
 *
 * @param {string} legacy 旧方式の語
 * @returns {string} 画面に出す1行
 */
export function legacyLabel(legacy) {
  return LEGACY_LABELS[legacy] || LEGACY_LABELS.unknown;
}

/**
 * 文字列として使える値だけを取り出す。
 *
 * @param {*} v 元の値
 * @returns {string|null} 使えなければ null
 */
function str(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t || null;
}

/**
 * 時刻として使える値だけを取り出す。
 *
 * 0 は「1970年」ではなく「書かれていない」の意味で来るので落とす。
 * 0 と不明を分ける決まりの、ここでの形。
 *
 * @param {*} v 元の値
 * @returns {number|null} 使えなければ null
 */
function stamp(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * startup.json の中身を、画面へ渡せる形に整える。純関数。
 *
 * ランチャが書く状態は4つ（on / off / foreign / not-installed）。
 * ここで足すのが2つ。
 *
 *  - idle    … 紙がまだ無い（ランチャを通さずに起動した）
 *  - unknown … 読めない・形が違う
 *
 * update.json と違って版の照合はしない。
 * 登録先はスタブの絶対パスで、更新しても動かないので古くなりようが無い。
 * ずれたときはランチャが通常起動のたびに直す（Startup.Sync）。
 *
 * 紙が無いことを「登録されていない」と読み替えない。
 * 読み替えると、npm start で起こしたときに毎回「登録されていません」と出て、
 * 実際には登録されているのに解除を勧めることになる。
 *
 * @param {object|null} raw startup.json をパースしたもの。読めなければ null
 * @param {object} [opts]
 * @param {boolean} [opts.missing] 紙がまだ無いか
 * @param {string|null} [opts.path] 紙の置き場所。診断のときに人へ見せる
 * @returns {object} state / label / legacy / legacyLabel / checkedAt / error / path
 */
export function parseStartupState(raw, { missing = false, path: file = null } = {}) {
  const base = {
    legacy: 'unknown',
    legacyLabel: legacyLabel('unknown'),
    checkedAt: null,
    error: null,
    path: file,
  };

  if (missing) return { ...base, state: 'idle', label: startupLabel('idle') };

  const state = raw && typeof raw === 'object' ? str(raw.state) : null;
  if (!state) return { ...base, state: 'unknown', label: startupLabel('unknown') };

  const legacy = str(raw.legacy) || 'unknown';

  return {
    ...base,
    state,
    label: startupLabel(state),
    legacy,
    legacyLabel: legacyLabel(legacy),
    checkedAt: stamp(raw.checkedAt),
    error: str(raw.error),
  };
}

/**
 * startup.json を1回だけ読んで、parseStartupState に渡す薄い殻。
 *
 * 無いこと（ランチャを通していない）と読めないこと（壊れている）を分ける。
 * どちらも同じ扱いにすると、壊れた紙をいつまでも「まだ調べていません」と出し続ける。
 *
 * @param {object} [opts]
 * @param {object} [opts.env] 環境変数
 * @returns {object} parseStartupState の戻り
 */
export function loadStartupState({ env = process.env } = {}) {
  const file = startupStatePath(env);
  let raw = null;
  let missing = false;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // 無いのは正常（ランチャ以外から起動したときは誰も書かない）。
    // 壊れているのは異常なので、そちらは unknown として画面に出す
    missing = err?.code === 'ENOENT';
  }
  return parseStartupState(raw, { missing, path: file });
}

/**
 * 自動起動の記録の置き場所。launcher/Paths.cs の StartupFile と同じ場所を指す。
 *
 * @param {object} [env] 環境変数
 * @returns {string}
 */
export function startupStatePath(env = process.env) {
  return appDataFile('startup.json', appRoot, env);
}
