/**
 * 更新の状態を読む。
 *
 * 書くのは C# ランチャ（launcher/Updates.cs）だけ、読むのはここだけ。
 * 向きは C#（書く）→ update.json → Node（読む）→ 画面 の一方通行で、
 * read → parse → view と同じ向きにしてある。逆流させない。
 *
 * ここに更新の判断を持たせない。持たせてはいけない理由が2つある。
 *
 *  - server.mjs の uncaughtException は記録して続行する作りなので、
 *    更新の失敗が「画面は元気なのに何も変わらない」に化ける
 *  - node 自身が更新の対象（current\runtime\node.exe ごと差し替わる）
 *
 * だからこのファイルの仕事は「紙を読んで、画面に渡せる形に整える」だけ。
 * 通信もしないし、更新できるかどうかも決めない。
 *
 * 判断（parseUpdateState）と読み取り（loadUpdateState）を分けてある。
 * 前者が純関数なので、状態の読み替えだけをテストできる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appDataFile } from '../shared/appdata.mjs';
import { clip } from '../shared/text.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
/** 環境変数がどれも無いときの控え。アプリ直下に置く */
const appRoot = path.resolve(here, '..', '..');

/** 更新の説明を画面へ渡す上限。ランチャ側でも切っているが、手で書き換えられた紙に備える。 */
const NOTES_MAX = 2000;

/**
 * 状態の日本語。画面はこれを引くだけにして、日本語を持たない。
 *
 * 上の9つはランチャが書くもの、下の3つはここで足すもの。
 * ランチャ側のコンソール用の文言は launcher/Updates.cs の Describe が持つ。
 * 同じ意味を2箇所に書いているので、片方を直したらもう片方も見る。
 *
 * failed と unreachable は確認と適用の両方から書かれる。
 * だから「確認に失敗」「確認できません」と言い切ると、当てるほうで失敗したときに嘘になる。
 * unreachable は起きたこと（届かなかった）だけを言い、何をしていたかは言わない
 * （細かいことは error に入るので、そちらで伝わる）。
 */
export const UPDATE_LABELS = {
  off: '更新の確認は止めてあります',
  'not-installed': 'この起動の仕方では更新できません',
  none: '最新です',
  available: '新しい版があります',
  unreachable: 'GitHub につながりませんでした',
  failed: '更新に失敗しました',

  // ここから3つは適用（--apply-update）の道中。
  // 押してから戻るまでのあいだ、画面はこの紙だけを見て進み方を知る
  downloading: '新しい版を取り寄せています',
  applying: '入れ替えています',
  done: '入れ替えました',

  idle: 'まだ確認していません',
  stale: '更新の記録が古いようです',
  unknown: '状態が分かりません',
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
export function updateLabel(state) {
  return UPDATE_LABELS[state] || UPDATE_LABELS.unknown;
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
 * update.json の中身を、画面へ渡せる形に整える。純関数。
 *
 * ランチャが書く状態は9つ（off / not-installed / none / available /
 * unreachable / failed ＋ 当てる道中の downloading / applying / done）。
 * ここで足すのが3つ。
 *
 *  - idle    … 紙がまだ無い（一度も確認していない）
 *  - stale   … 紙はあるが、書かれたときの版といまの版が食い違う
 *  - unknown … 読めない・形が違う
 *
 * stale を available のときだけ見るのは、ほかの状態では害が無いため。
 * 「最新です」の紙が1つ前の版のものでも、次の確認で上書きされるだけで誰も困らない。
 * 対して「0.2.1 があります」の紙が古い版のときのものだと、
 * すでに 0.2.1 で動いているのに更新を勧め続けることになる。
 *
 * @param {object|null} raw update.json をパースしたもの。読めなければ null
 * @param {object} [opts]
 * @param {string|null} [opts.version] いま動いているサーバーの版
 * @param {boolean} [opts.missing] 紙がまだ無いか
 * @param {string|null} [opts.path] 紙の置き場所。診断のときに人へ見せる
 * @returns {object} state / label / current / available / requested / notes /
 *                   checkedAt / changedAt / error / path
 */
export function parseUpdateState(raw, { version = null, missing = false, path: file = null } = {}) {
  const base = {
    current: version,
    available: null,
    requested: null,
    notes: null,
    checkedAt: null,
    changedAt: null,
    error: null,
    path: file,
  };

  if (missing) return { ...base, state: 'idle', label: updateLabel('idle') };

  const state = raw && typeof raw === 'object' ? str(raw.state) : null;
  if (!state) return { ...base, state: 'unknown', label: updateLabel('unknown') };

  const known = {
    ...base,
    state,
    label: updateLabel(state),
    available: str(raw.available),
    // 当てようとした版。再起動後の照合はランチャ側でやるので、ここは運ぶだけ。
    // 画面は done のときに「何に入れ替わったか」を出すのに使う
    requested: str(raw.requested),
    notes: clip(raw.notes, NOTES_MAX),
    checkedAt: stamp(raw.checkedAt),
    changedAt: stamp(raw.changedAt),
    error: str(raw.error),
  };

  if (state !== 'available') return known;

  // 版が読めないときは食い違いを判定できない。黙って通す
  // （判定できないことを「食い違っている」と読み替えない）
  if (!version) return known;

  const checked = str(raw.current);
  if (checked === version && known.available !== version) return known;

  // 確認したときの版が違う。この紙の「新しい版がある」は当てにならないので、
  // 版そのものを落とす。残すと、すでに入れ替わっているのに勧め続けることになる
  return {
    ...known,
    state: 'stale',
    label: updateLabel('stale'),
    available: null,
    notes: null,
    error: `確認したときの版（${checked || '不明'}）といまの版（${version}）が違います`,
  };
}

/**
 * update.json を1回だけ読んで、parseUpdateState に渡す薄い殻。
 *
 * 無いこと（一度も確認していない）と読めないこと（壊れている）を分ける。
 * どちらも同じ扱いにすると、壊れた紙をいつまでも「まだ確認していません」と出し続ける。
 *
 * @param {object} [opts]
 * @param {object} [opts.env] 環境変数
 * @param {string|null} [opts.version] いま動いているサーバーの版
 * @returns {object} parseUpdateState の戻り
 */
export function loadUpdateState({ env = process.env, version = null } = {}) {
  const file = updateStatePath(env);
  let raw = null;
  let missing = false;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // 無いのは正常（ランチャ以外から起動したときは誰も書かない）。
    // 壊れているのは異常なので、そちらは unknown として画面に出す
    missing = err?.code === 'ENOENT';
  }
  return parseUpdateState(raw, { version, missing, path: file });
}

/**
 * 更新の記録の置き場所。launcher/Paths.cs の UpdateFile と同じ場所を指す。
 *
 * @param {object} [env] 環境変数
 * @returns {string}
 */
export function updateStatePath(env = process.env) {
  return appDataFile('update.json', appRoot, env);
}
