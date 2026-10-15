/**
 * 今日のまとめ。その日に動いたセッションの「決めたこと」と「書き換えたファイル」を1枚に並べる。
 *
 * 日報や引き継ぎの下書きに使う。詳細を1本ずつ開いて拾い直す手間を、ここで1回にまとめる。
 *
 * ── 一覧の経路には載らない ──────────────────────────────────
 *
 * 決めたことも書き換えたファイルも、詳細と同じ全文の読み（`buildDigest`）からしか出ない。
 * 一覧は末尾 64KB しか読まないので、**載せられない**（数値と同じ理由）。
 * だから開いたときにだけ走る窓口にして、`server.mjs` で重い GET として合流（`coalesce`）させる。
 *
 * ── その日の行だけで digest を組み直す ──────────────────────
 *
 * `buildDigest` が返す `files` には時刻が無い。全文の digest から拾うと、
 * 3日前に書き換えたファイルまで「今日」に並ぶ。
 * だから**その日の時刻を持つ行だけ**を抜き出してから `buildDigest` に通す。
 * 呼び出しと結果は同じ日のうちに来るので、ほとんどの往復は割れない
 * （日付を跨いだ往復だけが片側を失う。そのぶん判断が1つ落ちることはあるが、増えることは無い）。
 *
 * 見出し（題・置き場所）は全文の meta から取る。その日の行だけだと、
 * 最初の指示が前の日にあるセッションの題が取れない。
 *
 * ── memo ────────────────────────────────────────────────────
 *
 * `view/usage.mjs` と同じく専用の memo に**結果だけ**を載せる（`read/cache.mjs` は使わない。
 * 全文を載せると一覧の memo が追い出される）。印は `size:mtimeMs` に日の始まりを足したもの。
 */
import { indexTranscripts, readAllOnce } from '../read/transcript.mjs';
import { readRegistry } from '../read/registry.mjs';
import { extractMeta } from '../parse/meta.mjs';
import { buildDigest } from '../parse/digest.mjs';
import { isMainline, timestampOf } from '../parse/entries.mjs';
import { oneLine, projectNameOf } from '../shared/text.mjs';
import { createLru } from '../shared/lru.mjs';
import { getter, intOf } from './query.mjs';

/**
 * 開くログの上限。`USAGE_SCAN_MAX` と同じ 60 ―― 1本あたりの重さ（全文 parse）が同じなので。
 * 実測でふつうの1日が 38 本（初回 577ms、2回目は memo で 18ms）。
 * こちらは「その日に動いたもの全部」なので、上限に当たったら切ったことを返す。
 */
export const TODAY_SCAN_MAX = 60;

/** 何日前まで遡れるか。画面の選択肢（きょう〜6日前）と同じ */
export const TODAY_AGO_MAX = 6;

/** 1本あたりに出すファイルの上限。超えたぶんは数（`filesOmitted`）で返す */
const FILES_MAX = 30;

/** 1本あたりに出す決めたことの上限。超えたぶんは数（`decisionsOmitted`）で返す */
const DECISIONS_MAX = 20;

const cache = createLru(200);

/**
 * クエリを丸める。変な値は 400 にせず既定（きょう）へ戻す。
 *
 * @param {URLSearchParams|null} params
 * @returns {{ago: number}}
 */
export function parseTodayQuery(params) {
  const get = getter(params);
  return { ago: intOf(get('ago'), 0, 0, TODAY_AGO_MAX) };
}

/**
 * その日の窓（地方時の 0 時から次の 0 時まで）。
 *
 * **地方時で切る。** UTC で切ると、日本時間の朝 9 時までの作業が前の日に積まれる
 * （数値の日ごとの推移と同じ理由）。夏時間のある地域でも日付を1つずつ動かすので 23/25 時間の日を正しく扱える。
 *
 * @param {number} now
 * @param {number} ago 何日前か
 * @returns {{from: number, to: number, day: string}}
 */
export function dayWindow(now, ago) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ago);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
  return { from: start.getTime(), to: end.getTime(), day };
}

/**
 * 選んだ答えを「何について: 何を選んだか」の1件にする。
 * 自由入力（Other）は選択肢に当たらないので、書いた文をそのまま使う。
 *
 * @param {object} answer pickAnswers の1件
 * @returns {{topic: string|null, choice: string}|null} 答えが無ければ null
 */
function decisionOf(answer) {
  // 「(Recommended)」は選ぶときの目印で、決めた中身ではない。日報に写すと邪魔なので外す
  const labels = (answer?.chosenOptions ?? [])
    .map((o) => String(o.label ?? '').replace(/\s*\(Recommended\)\s*$/i, ''))
    .filter(Boolean);
  const choice = labels.length ? labels.join('、') : oneLine(answer?.chosen, 160);
  if (!choice) return null;
  const topic = answer.header || oneLine(answer.question, 60) || null;
  return { topic, choice };
}

/**
 * ログ1本の、その日のぶんをまとめる。fs を触らないのでそのままテストできる。
 *
 * @param {Array} entries 会話ログの全行
 * @param {{from: number, to: number}} win その日の窓
 * @returns {object|null} その日に本流の行が1つも無ければ null
 */
export function summarizeDay(entries, win) {
  const day = entries.filter((e) => {
    const at = timestampOf(e);
    return at !== null && at >= win.from && at < win.to;
  });
  // サブエージェントの行だけが動いた日は「その日に動いた」と言わない
  if (!day.some(isMainline)) return null;

  const digest = buildDigest({ entries: day });
  const decisions = [];
  for (const it of digest.items) {
    if (it.kind !== 'answer') continue;
    for (const a of it.answers ?? []) {
      const d = decisionOf(a);
      if (d) decisions.push({ ...d, at: it.at ?? null });
    }
  }
  const plansApproved = digest.items.filter((it) => it.kind === 'plan' && it.approved).length;

  return {
    firstAt: digest.stats.firstAt,
    lastAt: digest.stats.lastAt,
    prompts: digest.stats.prompts ?? 0,
    decisions: decisions.slice(0, DECISIONS_MAX),
    decisionsTotal: decisions.length,
    // 切ったことは黙らない。0 のときもキーを出す
    decisionsOmitted: Math.max(0, decisions.length - DECISIONS_MAX),
    plansApproved,
    files: digest.files.slice(0, FILES_MAX).map((f) => ({ path: f.path, count: f.count, tools: f.tools })),
    filesTotal: digest.files.length,
    filesOmitted: Math.max(0, digest.files.length - FILES_MAX),
  };
}

/**
 * 1本を読んでまとめる。memo に載るのはここが返す形。
 *
 * @param {string} sessionId
 * @param {{file: string, projectDir: string, size?: number, mtimeMs: number}} transcript 索引の1件
 * @param {{from: number, to: number}} win
 * @returns {Promise<object|null>}
 */
async function dayForTranscript(sessionId, transcript, win) {
  // size が 0（＝不明）なら印を作らない。不明のまま焼き付くと取り直す機会が消える
  const stamp = (size, mtimeMs) => (size > 0 ? `${sessionId}:${size}:${mtimeMs}:${win.from}` : null);
  const pre = stamp(transcript.size ?? 0, transcript.mtimeMs);
  if (pre) {
    const hit = cache.get(pre);
    if (hit !== undefined) return hit;
  }

  const log = await readAllOnce(transcript.file);
  const sum = summarizeDay(log.entries, win);
  let value = null;
  if (sum) {
    const meta = extractMeta(log.entries);
    value = {
      sessionId,
      title: meta.title ?? meta.lastPrompt ?? meta.lastUserPrompt ?? null,
      cwd: meta.cwd ?? null,
      project: projectNameOf(meta.cwd, transcript.projectDir),
      ...sum,
    };
  }
  // その日に動いていなかった（null）ことも覚える。次に引いたとき読み直さずに済む
  const key = stamp(log.size, log.mtimeMs);
  if (key) cache.set(key, value);
  return value;
}

/**
 * まとめを組む。
 *
 * @param {{ago: number}} q parseTodayQuery の戻り
 * @param {number} now
 */
export async function listToday(q, now = Date.now()) {
  const win = dayWindow(now, q.ago);
  const [index, { entries: registry }] = await Promise.all([indexTranscripts(), readRegistry()]);
  const alive = new Set(registry.filter((r) => r.alive === true).map((r) => r.sessionId));

  // その日より前に最後に書かれたログは、その日に動いていない。読まずに落とす。
  // 逆（その日より後に書かれた）は、その日にも動いていたかを読まないと分からない
  const candidates = [...index]
    .filter(([, rec]) => rec.mtimeMs >= win.from)
    .sort((a, b) => b[1].mtimeMs - a[1].mtimeMs);
  const scan = candidates.slice(0, TODAY_SCAN_MAX);

  const found = await Promise.all(scan.map(async ([id, rec]) => {
    try {
      return await dayForTranscript(id, rec, win);
    } catch {
      // 読めない1本で全体を落とさない（書き込み途中・消えた直後）
      return null;
    }
  }));

  const rows = found.filter(Boolean)
    .map((r) => ({ ...r, alive: alive.has(r.sessionId) }))
    // 新しく動いたものを上に。日報は「最後に何をしていたか」から思い出すことが多い
    .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0) || a.sessionId.localeCompare(b.sessionId));

  const paths = new Set();
  for (const r of rows) for (const f of r.files) paths.add(f.path);

  return {
    day: win.day,
    ago: q.ago,
    from: win.from,
    to: win.to,
    rows,
    totals: {
      sessions: rows.length,
      projects: new Set(rows.map((r) => r.project)).size,
      decisions: rows.reduce((n, r) => n + r.decisionsTotal, 0),
      // 出したぶんだけで数える（切ったぶんのパスは知らない）。切ったかどうかは行の filesOmitted が言う
      files: paths.size,
      // **動いていた時間は出さない。** 最初の行から最後の行までを足すと、開いたまま放っておいた
      // 時間まで入る（実測でふつうの1日が「のべ 18時間」になった）。行の時刻（10:51–18:46）は出す
    },
    meta: {
      now,
      candidates: candidates.length,
      scanned: scan.length,
      scanLimited: candidates.length > scan.length,
      scanMax: TODAY_SCAN_MAX,
    },
  };
}
