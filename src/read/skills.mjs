/**
 * 会話ログが使ったスキルの索引。
 *
 * ── なぜ索引が要るのか ──────────────────────────────────────
 *
 * 書庫の検索は末尾 64KB しか読まない（`readTail`）。そこにスキルは**1件も写らない**。
 * スキルは作業の入口で呼ぶのでログの先頭に出るが、ログは 1MB から 15MB あり、
 * 末尾 64KB はその 0.4% にも届かないため。
 *
 * 実測（2026-09-04・新しい 60 本）。
 *
 *   スキルを使っていた           10 本
 *   末尾 64KB で1つでも拾えた     0 本 … 0%
 *
 * 「中身も探す」を押しても同じで、あれも読む範囲は末尾 64KB のまま。
 * つまり**いまの読み方の延長では、スキルで探す道がまったく作れない。**
 *
 * ── なら全文を読むのか ──────────────────────────────────────
 *
 * 読むが、`JSON.parse` は全行に掛けない。スキルを拾うだけなら文字列で先に振るえる。
 *
 *   if (!line.includes('"Skill"')) continue;   // ここで大半が落ちる
 *   JSON.parse(line);                          // 残った行だけ
 *
 * 実測（同じ日・445 本 / 614 MB）。
 *
 *   1 MB あたり            10 ms
 *   全 445 本を1回舐める    約 6.1 秒
 *
 * 6 秒なら索引にできる。**立ち上げの裏で1回だけ走らせる**（画面を出す前に待たせない）。
 * 2回目以降は、大きさと更新時刻が変わったものだけ読み直す。
 * 会話ログは追記しか起きないので、印が同じなら中身も同じ（`read/cache.mjs` と同じ考え）。
 *
 * ── 置き場所 ────────────────────────────────────────────────
 *
 * `%LOCALAPPDATA%\ClaudeDeck\skills.json`。**`~/.claude` には書かない。**
 * 場所の決め方は `shared/appdata.mjs` の1箇所に寄せてある。
 *
 * 索引が無くても書庫は動く（スキルで絞れないだけ）。だから読めない・書けないは
 * すべて黙って諦める。ここで throw すると、絞り込み1つのために画面が落ちる。
 */
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { appDataFile } from '../shared/appdata.mjs';
import { indexTranscripts } from './transcript.mjs';
import { toolUses } from '../parse/entries.mjs';

/** 索引の形の版。読めない版だったら作り直す */
const INDEX_VERSION = 1;

/** この文字列を含まない行は JSON にしない。ここで大半が落ちる */
const NEEDLE = '"Skill"';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 環境変数がどれも無いときの控え。アプリ直下（`.gitignore` 済み） */
const FALLBACK = path.join(HERE, '..', '..');

/**
 * 索引の置き場所。
 *
 * @param {object} [env] テストから差し替えられるように引数にしてある
 */
export function skillIndexPath(env = process.env) {
  return appDataFile('skills.json', FALLBACK, env);
}

/**
 * 会話ログ1本から、使ったスキルを拾う。
 *
 * 全行を `JSON.parse` しない。文字列で振るってから残った行だけ解く。
 *
 * @param {string} file 会話ログの絶対パス
 * @returns {Promise<string[]>} 出てきた順ではなく、名前順に並べた重複なしの一覧
 */
export async function scanSkills(file) {
  const found = new Set();
  let rl = null;
  try {
    rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes(NEEDLE)) continue;
      try {
        for (const tu of toolUses(JSON.parse(line))) {
          if (tu.name === 'Skill' && tu.input?.skill) found.add(tu.input.skill);
        }
      } catch {
        /* 書き込み途中の行。飛ばして進む（未知の形で落ちない） */
      }
    }
  } catch {
    /* 消えた・読めない。索引に載らないだけで、行そのものは書庫に出る */
  } finally {
    rl?.close();
  }
  // 並びを決めておくと、印が同じなら書き出す中身も同じになり、無駄な保存が減る
  return [...found].sort();
}

/**
 * 読み込んだ索引が使える形か確かめる。
 *
 * **判断だけ。I/O を持たない**（`parseUpdateState` と `loadUpdateState` を分けたのと同じ）。
 *
 * @param {unknown} raw JSON.parse したもの
 * @returns {{entries: object}} 使えなければ空の索引
 */
export function parseSkillIndex(raw) {
  if (!raw || typeof raw !== 'object') return { entries: {} };
  if (raw.version !== INDEX_VERSION) return { entries: {} };
  if (!raw.entries || typeof raw.entries !== 'object') return { entries: {} };
  return { entries: raw.entries };
}

/**
 * ある行が索引の中身と食い違っていないか。
 *
 * 印は大きさと更新時刻の2つ。会話ログは追記しか起きないので、
 * どちらも同じなら中身も同じとみなせる。
 *
 * **`0` と「不明」を分ける。** `size` が取れていない行は必ず読み直す。
 *
 * @param {object|undefined} rec 索引の1件
 * @param {{size: number, mtimeMs: number}} stat いまのファイルの印
 */
export function isFresh(rec, stat) {
  if (!rec || !Array.isArray(rec.skills)) return false;
  if (!stat?.size || !stat?.mtimeMs) return false;
  return rec.size === stat.size && rec.mtimeMs === stat.mtimeMs;
}

/* ── ここから I/O ────────────────────────────────────────────── */

/** 読み込んだ索引。プロセスの中で1つだけ持つ */
let cache = null;
/** いま作っている最中か。二重に走らせない */
let building = null;
/** 画面へ出す進み具合 */
let state = { built: false, at: null, total: 0, scanned: 0, kinds: 0, error: null };

/** 索引をディスクから読む。無ければ空 */
async function readIndex() {
  try {
    const text = await fs.readFile(skillIndexPath(), 'utf8');
    return parseSkillIndex(JSON.parse(text));
  } catch {
    return { entries: {} };
  }
}

/** 索引を書く。一時ファイルへ書いてから rename する（途中で落ちても壊れたものを残さない） */
async function writeIndex(index) {
  const target = skillIndexPath();
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    const body = { version: INDEX_VERSION, builtAt: Date.now(), entries: index.entries };
    await fs.writeFile(tmp, `${JSON.stringify(body)}\n`, 'utf8');
    await fs.rename(tmp, target);
  } catch {
    /* 書けなくても動く。次の立ち上げでまた作りに行くだけ */
  }
}

/**
 * 索引を作る（または追いつかせる）。
 *
 * **立ち上げの裏で1回だけ呼ぶ。** 画面を出す前に待たせない。
 * 走っている最中にもう一度呼ばれたら、同じ約束を返す（二重に舐めない）。
 *
 * @param {object} [opts]
 * @param {(done: number, total: number) => void} [opts.onProgress] 進み具合
 * @returns {Promise<{entries: object}>}
 */
export function buildSkillIndex({ onProgress = null } = {}) {
  if (building) return building;
  building = (async () => {
    try {
      const index = cache ?? await readIndex();
      const transcripts = await indexTranscripts();
      const next = {};
      let scanned = 0;
      let done = 0;

      for (const [sessionId, rec] of transcripts) {
        const prev = index.entries[sessionId];
        if (isFresh(prev, rec)) {
          // 印が同じなら読み直さない。追記しか起きないログなので中身も同じ
          next[sessionId] = prev;
        } else {
          next[sessionId] = {
            size: rec.size,
            mtimeMs: rec.mtimeMs,
            skills: await scanSkills(rec.file),
          };
          scanned++;
        }
        done++;
        onProgress?.(done, transcripts.size);
      }

      cache = { entries: next };
      const kinds = new Set();
      for (const rec of Object.values(next)) for (const s of rec.skills) kinds.add(s);
      state = {
        built: true,
        at: Date.now(),
        total: transcripts.size,
        scanned,
        kinds: kinds.size,
        error: null,
      };
      // 1本も読み直していないなら、書き出す中身も前と同じ。保存を省く
      if (scanned > 0) await writeIndex(cache);
      return cache;
    } catch (err) {
      state = { ...state, built: false, error: err.message };
      // 索引が無くても書庫は動く。スキルで絞れないだけ
      cache = cache ?? { entries: {} };
      return cache;
    } finally {
      building = null;
    }
  })();
  return building;
}

/**
 * 索引を引く。**作りには行かない。**
 *
 * まだできていなければ空を返す。書庫の応答をここで待たせると、
 * 立ち上げ直後の1回だけ 6 秒かかる窓口ができてしまう。
 *
 * @returns {{entries: object}}
 */
export function skillIndex() {
  return cache ?? { entries: {} };
}

/** そのセッションが使ったスキル。索引に無ければ null（「使っていない」ではなく「見ていない」） */
export function skillsOf(sessionId) {
  const rec = skillIndex().entries[sessionId];
  return Array.isArray(rec?.skills) ? rec.skills : null;
}

/**
 * 索引の様子。画面に「まだ作っている」と出すために要る。
 *
 * **黙って空の候補を出さない。** 使っていないのか、まだ読めていないのかが
 * 区別できなくなる（0 と不明を分けるのと同じ）。
 */
export function skillIndexState() {
  return { ...state, building: building !== null };
}
