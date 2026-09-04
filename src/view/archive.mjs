/**
 * 書庫（終了したものも含む全セッション）の一覧。
 *
 * 一覧（listSessions）は 24 時間より古いものを落とす。ボールの所在を見る場所なので、
 * もう誰も待っていないセッションを混ぜると読む量だけが増えるため。
 * その代わり「あのとき何を決めたか」を見に戻る経路が無くなっていた。ここがその経路。
 *
 * 材料は indexTranscripts だけ。登録簿は見ない（書庫に出るものは動いていない）。
 *
 * ── 検索が2段になっている理由 ──────────────────────────────
 *
 * indexTranscripts が持つのは file / projectDir / size / mtimeMs の4つだけで、
 * タイトルはファイルを開かないと分からない。全件のタイトルを毎回引くと、
 * 300 ファイルの環境で 300 回の末尾読みが走る。
 *
 *  - 既定 … 検索語は sessionId と置き場所のフォルダ名にだけ当てる。
 *           ファイルを読むのは、そのページに出る分（最大 50 件）だけ
 *  - deep=1 … 新しい順に ARCHIVE_SCAN_MAX 件までタイトルを引いて、そこも探す
 *
 * ARCHIVE_SCAN_MAX を 120 に抑えているのは read/cache.mjs の LRU が全体で
 * 240 件しか持たないため。ここを 300 にすると深い検索1回で一覧（毎秒走る）の
 * memo を押し出し、次の更新で全ファイルを読み直すことになる。
 */
import { indexTranscripts, readTail } from '../read/transcript.mjs';
import { countSubagents } from '../read/subagents.mjs';
import { skillIndex, skillIndexState } from '../read/skills.mjs';
import { extractMeta } from '../parse/meta.mjs';

/** 深い検索で中身を読む上限。理由はファイル冒頭のコメントに書いてある。 */
export const ARCHIVE_SCAN_MAX = 120;

const PER_DEFAULT = 30;
const PER_MAX = 50;
/** 並び順の候補。知らない値が来たら既定へ丸める（400 は返さない）。 */
const SORTS = new Set(['recent', 'oldest', 'size']);
/** 検索語と絞り込みの文字数上限。長すぎる語は意味を持たないので頭だけ見る。 */
const TEXT_MAX = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 数値のパラメータを範囲に収める。
 *
 * 変な値で 400 を返さない。URL を手で書き換えて壊れるより、黙って既定へ丸めるほうが親切。
 *
 * @param {string|null} raw クエリの生の値
 * @param {number} fallback 取れなかったときの値
 * @param {number} min 下限
 * @param {number} max 上限
 */
function intOf(raw, fallback, min, max) {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 文字列のパラメータ。空白だけなら null にする（「検索語なし」と同じ扱い） */
function textOf(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  return t.slice(0, TEXT_MAX);
}

/**
 * クエリ文字列を、丸めた形の指定に直す。
 *
 * fs を触らないのでそのままテストできる。
 *
 * @param {URLSearchParams} params
 * @returns {{page:number, per:number, sort:string, q:string|null, deep:boolean, project:string|null, days:number|null}}
 */
export function parseArchiveQuery(params) {
  const get = (key) => (params && typeof params.get === 'function' ? params.get(key) : null);
  const sortRaw = get('sort');

  return {
    page: intOf(get('page'), 1, 1, 1000),
    per: intOf(get('per'), PER_DEFAULT, 1, PER_MAX),
    sort: SORTS.has(sortRaw) ? sortRaw : 'recent',
    q: textOf(get('q')),
    deep: get('deep') === '1',
    project: textOf(get('project')),
    // スキルは索引（read/skills.mjs）から引く。末尾 64KB には1件も写らないので、
    // ここだけ別の出どころになる
    skill: textOf(get('skill')),
    // 既定は期間で絞らない。書庫は「古いものを見に戻る」場所なので、上限を持たせる意味がない
    days: get('days') === null ? null : intOf(get('days'), null, 1, 3650),
  };
}

/**
 * その行の中身を読んでタイトルを埋める。
 *
 * 読めなかった行の title は null のままにする。「（無題）」のような文字列を作らない。
 * 読んだかどうかは read で区別できるので、画面側は「読んでいないから空」と
 * 「本当に空」を混同しない。
 *
 * サブエージェントの件数もここで数える。1ページ分（最大 50 件）にしか呼ばれないので、
 * すでに払っている末尾読みに比べれば readdir 1回は誤差。
 *
 * @param {object} row 書き換える行
 */
async function fillTitle(row) {
  try {
    const tail = await readTail(row.file);
    const meta = extractMeta(tail.entries ?? []);
    row.title = meta.title ?? meta.lastPrompt ?? meta.lastUserPrompt ?? null;
    row.cwd = meta.cwd ?? null;
    row.gitBranch = meta.gitBranch ?? null;
  } catch {
    /* 読めなくても行そのものは出す。書き込み途中のファイルもここに来る */
  }
  // 中身が読めなかった行でも件数は取れるので、try の外に置く
  row.subagentCount = row.hasSessionDir ? await countSubagents(row.file, row.sessionId) : 0;
  row.read = true;
}

/** 検索語に当たるか。読んでいない行では title が null なので、そこは当たらない */
function matches(row, needle) {
  const fields = [row.sessionId, row.projectDir, row.title, row.cwd];
  return fields.some((f) => typeof f === 'string' && f.toLowerCase().includes(needle));
}

/**
 * 書庫の行を並べ替える。**知らない語は「新しい順」に倒す**（0件にしない）。
 *
 * `logSize` は取れないことがあるので、大きさ順では 0 に倒して末尾へ寄せる。
 *
 * @param {object[]} rows 並べ替える行
 * @param {string} sort `recent` / `oldest` / `size`
 * @returns {object[]} 新しい配列（元は触らない）
 */
function sortRows(rows, sort) {
  const sorted = [...rows];
  if (sort === 'oldest') sorted.sort((a, b) => a.mtimeMs - b.mtimeMs);
  else if (sort === 'size') sorted.sort((a, b) => (b.logSize ?? 0) - (a.logSize ?? 0));
  else sorted.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sorted;
}

/**
 * 画面に渡す形。
 *
 * ログの絶対パスは載せない。詳細は sessionId だけで開けるので、要らないものは出さない。
 */
function publicRow(row) {
  return {
    sessionId: row.sessionId,
    // cwd が読めていればその末尾。読んでいなければ置き場所のフォルダ名で代える。
    // slugifyCwd は不可逆なのでパスには戻せないが、見出しには使える
    project: row.cwd ? row.cwd.split(/[\\/]/).filter(Boolean).pop() : row.projectDir,
    projectDir: row.projectDir,
    title: row.title,
    cwd: row.cwd,
    gitBranch: row.gitBranch,
    logSize: row.logSize,
    mtimeMs: row.mtimeMs,
    // まだ読んでいない行では null のまま。「使っていない」ではなく「見ていない」
    subagentCount: row.subagentCount,
    // 索引から引いたもの。索引がまだ無ければ null（同じく「見ていない」）
    skills: row.skills,
    read: row.read,
  };
}

/**
 * 置き場所の候補を作る。画面の絞り込みが選ぶ形なので、候補はサーバが渡す。
 *
 * ── 表示名をどう出すか ─────────────────────────────────────
 *
 * 索引がタダで持っているのは `projectDir`（スラッグ）だけで、これは不可逆。
 * `C--Users-wwaiyota-ClaudeWookspace-sandbox-claude-deck` の `-` は
 * 区切りかフォルダ名の一部かを**区別できない**（`claude-deck` がまさにそれ）。
 * だから機械的な整形では元のフォルダ名に戻せない。
 *
 * そこで**グループごとに、いちばん新しい1本だけ末尾を読む**。cwd が取れれば
 * その末尾のフォルダ名を出し、読めなければスラッグのまま出す（0 と不明を分けるのと同じ）。
 * 読むのは種類の数だけ（実測 445 本に対して 19 種）で、`readTail` は memo に乗るので
 * 2回目以降はほぼタダ。書庫は開いたときだけ引く窓口なので、毎秒には載らない。
 *
 * @param {object[]} all 絞り込む前の全行
 * @returns {Promise<object[]>} 件数の多い順。`{ dir, label, n }`
 */
async function buildProjects(all) {
  /** @type {Map<string, {dir: string, n: number, newest: object}>} */
  const byDir = new Map();
  for (const r of all) {
    const cur = byDir.get(r.projectDir);
    if (!cur) byDir.set(r.projectDir, { dir: r.projectDir, n: 1, newest: r });
    else {
      cur.n++;
      if (r.mtimeMs > cur.newest.mtimeMs) cur.newest = r;
    }
  }

  const list = [...byDir.values()];
  await Promise.all(list.map(async (g) => {
    try {
      const tail = await readTail(g.newest.file);
      const cwd = extractMeta(tail.entries ?? []).cwd;
      // 末尾のフォルダ名だけを出す。フルパスは画面の札に収まらないし、
      // 置き場所の絞り込みに要るのは「どのプロジェクトか」だけ
      g.label = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : g.dir;
    } catch {
      // 読めなくても候補からは落とさない。スラッグのままでも選べるほうがいい
      g.label = g.dir;
    }
  }));

  // 多い順。同数なら名前順にして、引くたびに並びが揺れないようにする
  list.sort((a, b) => b.n - a.n || a.label.localeCompare(b.label, 'ja'));
  return list.map((g) => ({ dir: g.dir, label: g.label, n: g.n }));
}

/**
 * スキルの候補を作る。
 *
 * 置き場所（`buildProjects`）と違ってファイルを開かない。材料は索引だけで、
 * それは立ち上げの裏で作ってある（`read/skills.mjs`）。
 *
 * **索引がまだ無いときは空を返す。** ここで作りに行くと、
 * 立ち上げ直後の1回だけ 6 秒かかる窓口ができる。まだ無いことは
 * `meta.skillIndex` で画面へ伝わるので、あちらが「作成中」と出す。
 *
 * @param {object[]} all 絞り込む前の全行
 * @returns {{skill: string, n: number}[]} 使った本数の多い順
 */
function buildSkills(all) {
  const count = new Map();
  for (const r of all) {
    if (!Array.isArray(r.skills)) continue;
    for (const s of r.skills) count.set(s, (count.get(s) ?? 0) + 1);
  }
  // 多い順。同数なら名前順にして、引くたびに並びが揺れないようにする
  return [...count.entries()]
    .map(([skill, n]) => ({ skill, n }))
    .sort((a, b) => b.n - a.n || a.skill.localeCompare(b.skill));
}

/**
 * 書庫の一覧を作る。
 *
 * @param {object} q parseArchiveQuery の戻り
 * @param {number} now
 */
export async function listArchive(q, now = Date.now()) {
  const index = await indexTranscripts();
  // 索引は**作りには行かない。** まだできていなければ空で進む。
  // ここで待たせると、立ち上げ直後の1回だけ 6 秒かかる窓口ができる
  const skills = skillIndex();

  const all = [];
  for (const [sessionId, rec] of index) {
    all.push({
      sessionId,
      file: rec.file,
      projectDir: rec.projectDir,
      logSize: rec.size,
      mtimeMs: rec.mtimeMs,
      title: null,
      cwd: null,
      gitBranch: null,
      // 索引がタダで持ってきた印。これが false なら数えに行かない
      hasSessionDir: rec.hasSessionDir === true,
      subagentCount: null,
      // 索引にあれば配列、無ければ null。ファイルは開かない（索引は立ち上げの裏で作る）
      skills: Array.isArray(skills.entries[sessionId]?.skills)
        ? skills.entries[sessionId].skills
        : null,
      read: false,
    });
  }

  let rows = all;
  if (q.days) {
    const from = now - q.days * DAY_MS;
    rows = rows.filter((r) => r.mtimeMs >= from);
  }
  if (q.project) {
    const p = q.project.toLowerCase();
    // 画面は選ぶ形なので、渡ってくるのは正確なスラッグ。**完全一致を先に見る。**
    // 短いスラッグが長いスラッグの一部になっている環境で、部分一致だけだと
    // 選んだ覚えのない置き場所まで混ざる。
    // 当たらなければ今までどおり部分一致へ落とす（`?project=` を手で書くぶんのため）
    const exact = rows.filter((r) => r.projectDir.toLowerCase() === p);
    rows = exact.length ? exact : rows.filter((r) => r.projectDir.toLowerCase().includes(p));
  }

  if (q.skill) {
    // 索引が無い（まだ作っている）あいだは絞れない。**全件を返さない。**
    // 絞ったつもりで全部出ると、選んだ覚えのないものを見ることになる
    rows = rows.filter((r) => Array.isArray(r.skills) && r.skills.includes(q.skill));
  }

  const needle = q.q ? q.q.toLowerCase() : null;
  let scanned = 0;
  let scanLimited = false;

  if (needle && q.deep) {
    // 新しい順に上限まで読む。古いものから切るのは、探しているものが新しい側にある確率が高いため
    const byRecent = sortRows(rows, 'recent');
    const scan = byRecent.slice(0, ARCHIVE_SCAN_MAX);
    scanLimited = byRecent.length > scan.length;
    await Promise.all(scan.map((r) => fillTitle(r)));
    scanned += scan.length;
    rows = scan.filter((r) => matches(r, needle));
  } else if (needle) {
    rows = rows.filter((r) => matches(r, needle));
  }

  rows = sortRows(rows, q.sort);

  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / q.per));
  // 絞り込みで件数が減ると、指定のページが存在しなくなる。空を返すより最後のページを出す
  const page = Math.min(q.page, pages);
  const start = (page - 1) * q.per;
  const shown = rows.slice(start, start + q.per);

  // そのページに出る分だけ中身を読む。深い検索で既に読んだ行は読み直さない
  const need = shown.filter((r) => !r.read);
  await Promise.all(need.map((r) => fillTitle(r)));
  scanned += need.length;

  // 置き場所の候補。**絞り込む前の全行から作る。**
  // 期間で絞ったあとの行から作ると、期間を変えるたびに候補が消えて選び直せなくなる
  const projects = await buildProjects(all);
  // スキルの候補も同じ考えで、絞り込む前の全行から。索引にあるものだけが出る
  const skillOptions = buildSkills(all);

  return {
    rows: shown.map(publicRow),
    total,
    page,
    pages,
    per: q.per,
    sort: q.sort,
    q: q.q,
    deep: q.deep,
    meta: {
      now,
      indexed: all.length,
      // 画面の絞り込みが選ぶ形なので、候補はこちらが渡す
      projects,
      skills: skillOptions,
      // 索引がまだできていないことを画面へ伝える。**黙って空の候補を出さない**
      // （使っていないのか、まだ読めていないのかが区別できなくなる）
      skillIndex: skillIndexState(),
      // 何件のファイルを開いたか。打ち切ったかどうかも正直に返す
      scanned,
      scanLimited,
      scanMax: ARCHIVE_SCAN_MAX,
    },
  };
}
