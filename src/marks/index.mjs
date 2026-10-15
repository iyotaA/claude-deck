/**
 * ピン留めとメモ。`%LOCALAPPDATA%\ClaudeDeck\marks.json` の紙1枚。
 *
 * 気になるセッションを作業台の上に留め、ひとことメモを付ける（UI レビューの段8）。
 * 終わったあとも「明日 PR を出す」のような約束を忘れないためのもの。
 *
 * **`~/.claude` には書かない**（読み取り専用の約束）。書き先は `shared/appdata.mjs` が決める。
 * **紙の名前（marks.json）は凍結。** 変えると古い紙が永久に残り、付けたピンが黙って消える
 * （ルートの CLAUDE.md の凍結の表）。設定（config.json。生の Webhook 入り）とは分けてある
 * ―― ピンを付け外しするたびに設定の紙を書き直さないため。
 *
 * 分け方は `update/` `startup/` と同じ。**判断（純関数）と I/O（薄い殻）を分ける。**
 * `parseMarks` / `applyMark` / `validateMark` / `withMarks` / `keepIds` は I/O を持たず、
 * 時刻も外から受ける（test/marks.test.mjs）。`loadMarks` / `saveMarks` だけがファイルを触る。
 *
 * どの層も import しない（`shared/` だけ）。一覧へ混ぜるのは `server.mjs` の `refresh()`
 * （実行中のセッションを混ぜる `mergeRuns` と同じ場所）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appDataFile } from '../shared/appdata.mjs';
import { isPlainObject } from '../shared/objects.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..', '..');

/** 紙の名前。**凍結。** */
export const MARKS_FILE = 'marks.json';

/** メモの長さ（字）。1行のひとこと（作者の判断 2026-10-15） */
export const MEMO_MAX = 200;

/**
 * 持てる件数の上限。ピンかメモのどちらかが付いているセッションの数。
 * 上限で黙って捨てない ―― 断って理由を言う（validateMark の呼び手が応答する）
 */
export const MARKS_MAX = 200;

/** セッション ID の形。/api/reveal と同じ決まり */
const SESSION_ID = /^[\w-]{1,64}$/;

/**
 * 紙を読める形にする。**壊れた紙・知らない形で落ちない。** 読めない項目は黙って捨てる。
 *
 * @param {unknown} file JSON.parse した紙。読めなければ null
 * @returns {Map<string, {pinned: boolean, memo: string|null, at: number}>}
 */
export function parseMarks(file) {
  const out = new Map();
  const sessions = isPlainObject(file) && isPlainObject(file.sessions) ? file.sessions : {};
  for (const [id, raw] of Object.entries(sessions)) {
    if (!SESSION_ID.test(id) || !isPlainObject(raw)) continue;
    const pinned = raw.pinned === true;
    const memo = cleanMemo(raw.memo);
    // どちらも無いものは持たない（付けて外したぶんの残骸）
    if (!pinned && memo === null) continue;
    out.set(id, { pinned, memo, at: Number.isFinite(raw.at) ? raw.at : 0 });
    if (out.size >= MARKS_MAX) break;
  }
  return out;
}

/**
 * メモを1行に整える。空なら null（消す）。長さは呼ぶ側（validateMark）が先に確かめる
 * @param {unknown} v
 * @returns {string|null}
 */
function cleanMemo(v) {
  if (typeof v !== 'string') return null;
  const one = v.replace(/\s+/g, ' ').trim();
  return one ? one.slice(0, MEMO_MAX) : null;
}

/**
 * 画面から来た指定を確かめる。**キーが無い＝触らない**（設定の窓口と同じ作法）。
 *
 * @param {unknown} body `{ sessionId, pinned?, memo? }`
 * @returns {{ok: true, sessionId: string, patch: {pinned?: boolean, memo?: string|null}}
 *          | {ok: false, error: string}}
 */
export function validateMark(body) {
  if (!isPlainObject(body)) return { ok: false, error: '指定の形が違います' };
  const { sessionId } = body;
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    return { ok: false, error: 'セッションの指定が不正です' };
  }
  const patch = {};
  if ('pinned' in body) {
    if (typeof body.pinned !== 'boolean') return { ok: false, error: 'ピンは true か false で入れてください' };
    patch.pinned = body.pinned;
  }
  if ('memo' in body) {
    if (body.memo !== null && typeof body.memo !== 'string') {
      return { ok: false, error: 'メモは文字で入れてください' };
    }
    // 長すぎるものは切らずに断る。黙って切ると、書いた末尾が消えたことに気づけない
    if (typeof body.memo === 'string' && body.memo.replace(/\s+/g, ' ').trim().length > MEMO_MAX) {
      return { ok: false, error: `メモは ${MEMO_MAX} 字までです` };
    }
    patch.memo = cleanMemo(body.memo);
  }
  if (!('pinned' in patch) && !('memo' in patch)) {
    return { ok: false, error: '変えるもの（pinned か memo）がありません' };
  }
  return { ok: true, sessionId, patch };
}

/**
 * 1件を変えた新しい集合を返す。**元を変えない。**
 *
 * ピンもメモも無くなったら消す。上限を超える新しい1件は断る（`full: true`）。
 *
 * @param {Map} marks いまの集合
 * @param {string} sessionId 変える相手
 * @param {{pinned?: boolean, memo?: string|null}} patch validateMark の patch
 * @param {number} now いまの時刻
 * @returns {{marks: Map, mark: object|null, full: boolean}}
 */
export function applyMark(marks, sessionId, patch, now) {
  const next = new Map(marks);
  const prev = next.get(sessionId) ?? { pinned: false, memo: null, at: 0 };
  const mark = {
    pinned: 'pinned' in patch ? patch.pinned : prev.pinned,
    memo: 'memo' in patch ? patch.memo : prev.memo,
    at: now,
  };
  if (!mark.pinned && mark.memo === null) {
    next.delete(sessionId);
    return { marks: next, mark: null, full: false };
  }
  if (!marks.has(sessionId) && marks.size >= MARKS_MAX) {
    return { marks, mark: prev.pinned || prev.memo ? prev : null, full: true };
  }
  next.set(sessionId, mark);
  return { marks: next, mark, full: false };
}

/**
 * 一覧の行にピンとメモを載せる。**行を変えずに写しを返す。**
 * 合成の場所は server.mjs の refresh()（mergeRuns と同じ考え）。
 *
 * @param {Array<object>} rows 一覧の行
 * @param {Map} marks
 * @returns {Array<object>}
 */
export function withMarks(rows, marks) {
  if (!marks || marks.size === 0) return rows;
  return rows.map((row) => {
    const m = marks.get(row.sessionId);
    return m ? { ...row, pinned: m.pinned, memo: m.memo } : row;
  });
}

/**
 * 古くても一覧に入れるセッション。**ピンを付けたものだけ。**
 * メモだけのものは入れない（作業台に残すと決めたのはピンのほう。作者の判断 2026-10-15）
 *
 * @param {Map} marks
 * @returns {Set<string>}
 */
export function keepIds(marks) {
  const out = new Set();
  for (const [id, m] of marks ?? []) if (m.pinned) out.add(id);
  return out;
}

/**
 * 紙の場所。
 * @param {object} [env] 環境変数
 * @returns {string}
 */
export function marksPath(env = process.env) {
  return appDataFile(MARKS_FILE, appRoot, env);
}

/**
 * 紙を読む。無い・壊れているときは空。**投げない。**
 * @param {object} [env]
 * @returns {Map}
 */
export function loadMarks(env = process.env) {
  try {
    return parseMarks(JSON.parse(fs.readFileSync(marksPath(env), 'utf8')));
  } catch {
    return new Map();
  }
}

/**
 * 紙を書く。一時ファイル → rename（読む側が書きかけを掴まない。config.json と同じ作法）。
 * 失敗は投げる（呼ぶ側が応答で理由を返す）。
 *
 * @param {Map} marks
 * @param {object} [env]
 * @returns {string} 書いた場所
 */
export function saveMarks(marks, env = process.env) {
  const target = marksPath(env);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const sessions = {};
  for (const [id, m] of marks) sessions[id] = { pinned: m.pinned, memo: m.memo, at: m.at };
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ sessions }, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);
  return target;
}
