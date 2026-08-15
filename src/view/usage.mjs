/**
 * 数値を組み立てる。1セッションぶんと、複数セッションを跨いだぶんの2つ。
 *
 * 詳細（detail.mjs）と同じくログを全文読むが、**詳細の応答には足さない。**
 * `/api/sessions/:id` はセッションを開くたび毎回走るので、
 * そこに集計を足すと、数値を見ない人まで詳細を開く速度が落ちる。
 *
 * この経路は一覧（毎秒走る）には**原理的に載らない。**
 * 一覧は readTail（尾 64KB）しか読まないが、usage は先頭から積む必要がある。
 * 「重いから載せない」ではなく「載せられない」ので、
 * うっかり毎秒経路に混ざる事故が構造的に起きない。
 */
import { readRegistry } from '../read/registry.mjs';
import { indexTranscripts, readAll, readAllOnce } from '../read/transcript.mjs';
import { listSubagents, readSubagentLog } from '../read/subagents.mjs';
import { extractMeta } from '../parse/meta.mjs';
import { buildUsage, percentile } from '../parse/usage.mjs';

/**
 * 横断集計で開くファイルの上限。
 *
 * `view/archive.mjs` の ARCHIVE_SCAN_MAX（120）より**小さくしてある。**
 * あちらは行の頭だけを読むが、こちらは全文を JSON.parse するので
 * 1件あたりの重さが2桁違う（実測で全204件の走査が 2.5〜3.3 秒）。
 *
 * 超えたぶんは 400 で断らずに切り詰め、切ったことを scanLimited で正直に返す。
 */
export const USAGE_SCAN_MAX = 60;

/** 横断集計で一度に開くファイルの数。 */
const READ_CONCURRENCY = 4;

/** 何も指定しなかったときに見るセッションの数。 */
const LIMIT_DEFAULT = 30;

/** ツール別・スキル別で返す上限。1本ぶん（24 / 12）より広く取る。 */
const TOOLS_MAX = 30;
const SKILLS_MAX = 20;

const DAY_MS = 24 * 60 * 60 * 1000;
/** モデル名の文字数上限。長すぎる値は意味を持たないので頭だけ見る。 */
const TEXT_MAX = 200;

/**
 * 「直近の中央値」を出すために開くセッションの数。
 *
 * **10 では足りなかった。** 実測（2026-08-15・212本）で、直近10本のうち
 * `claude-opus-5` は2本しかなく、比べる相手が揃わずに毎回 null になっていた。
 * 直近には短いセッションが固まって並ぶことがあり、そこが古いモデルだと丸ごと外れる。
 *
 * 24 まで広げると同じモデルが8本入る。しかも**時間はほとんど増えない**（412ms → 669ms）。
 * 大きいログ（39MB・42MB）が直近に2本あって、10本の時点で既にそこを払い終えているため。
 * つまりここの重さは本数ではなく「大きいログに当たるかどうか」で決まる。
 *
 * その 400〜700ms を本体（`getSessionUsage`）には載せられないので、
 * baseline は `getSessionBaseline` として窓口ごと分けてある。
 */
const BASELINE_SCAN = 24;

/**
 * 中央値を出すのに最低限ほしい本数。
 *
 * 2本の中央値は「2つの平均」でしかなく、真ん中と呼べるものではない。
 * 足りなければ baseline ごと null にする。**推測で 0 を書かない。**
 */
const BASELINE_MIN = 3;

/**
 * 集計結果だけを持つ専用の memo。
 *
 * **read/cache.mjs は使わない。** あちらは 240件の LRU で、
 * 全文（1本で最大 42MB）を載せると一覧の tail: memo が全部追い出される。
 * ここに入るのは数百バイトの数値の塊だけなので、300件持っても数MBに収まる。
 *
 * 印は既存と同じ `size:mtimeMs`。会話ログは追記しか起きないので、
 * 印が同じなら中身も同じと言い切れる。
 */
const CACHE_MAX = 300;
const cache = new Map();

/**
 * memo から取る。取れたものは末尾へ動かして「最近使った」印にする。
 *
 * @param {string} key
 * @returns {object|undefined}
 */
function memoGet(key) {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

/**
 * memo へ入れる。溢れたら、いちばん長く触っていないものから捨てる。
 *
 * @param {string} key
 * @param {object} value
 */
function memoSet(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_MAX) {
    // Map は挿入順を保つので、先頭がいちばん古く触ったもの
    cache.delete(cache.keys().next().value);
  }
}

/**
 * ログ1本を読んで集計する。memo に載るのはここが返す形。
 *
 * 見出し（title / cwd）も一緒に持つ。entries はもう手元にあるので、
 * ここで extractMeta を通すぶんの追加コストはディスク読みに比べれば誤差になる。
 * 横断集計の表がセッションを名前で指せるようになるのは、この1回のおかげ。
 *
 * @param {string} sessionId
 * @param {{file: string, projectDir: string, mtimeMs: number}} transcript 索引の1件
 * @param {{shared?: boolean}} [options] shared: true なら read/cache.mjs の memo も使う
 * @returns {Promise<object>}
 */
async function usageForTranscript(sessionId, transcript, { shared = false } = {}) {
  // 横断集計では共有 memo を避ける（理由は read/transcript.mjs:readAllOnce）。
  // 1本だけ引くときは詳細ビューと同じ memo に乗せたほうが、両方開いても1回しか読まない
  const log = shared ? await readAll(transcript.file) : await readAllOnce(transcript.file);

  // logSize が 0 は「読めなかった＝不明」なので、印にせず毎回組み直す。
  // 0 と不明を分ける原則を、キャッシュの印にも同じように当てる
  const key = log.size > 0 ? `${sessionId}:${log.size}:${log.mtimeMs}` : null;
  if (key) {
    const hit = memoGet(key);
    if (hit) return hit;
  }

  const meta = extractMeta(log.entries);
  const value = {
    id: sessionId,
    logSize: log.size,
    mtimeMs: log.mtimeMs || transcript.mtimeMs || null,
    projectDir: transcript.projectDir,
    // 一覧・書庫と同じ組み方。cwd が読めていればその末尾、駄目なら置き場所のフォルダ名
    project: meta.cwd ? meta.cwd.split(/[\\/]/).filter(Boolean).pop() : transcript.projectDir,
    title: meta.title ?? meta.lastPrompt ?? meta.lastUserPrompt ?? null,
    usage: buildUsage(log.entries),
  };
  if (key) memoSet(key, value);
  return value;
}

/**
 * サブエージェントぶんの消費をまとめる。
 *
 * 親ログには子の消費が入っていない（実測: 204ファイル全走査で、親に isSidechain の
 * assistant 行は1件も無い）。だから足しても二重計上にならない。
 * 逆に言うと、ここを出さないと「Task を投げたぶん」がどこにも現れない。
 *
 * **`listSubagents` に memo を掛けない**（read/subagents.mjs の禁止事項）。
 * 代わりに、返ってきた refs の size と mtimeMs から印を作って集計結果だけを memo する。
 * ファイルが太れば size が変わるので、走っている最中でも表示が固まらない。
 *
 * @param {string} sessionId
 * @param {string} transcriptFile 親ログの実パス
 * @returns {Promise<object|null>} 1件も使っていなければ null（節ごと出さない）
 */
async function subUsageFor(sessionId, transcriptFile) {
  const { refs, readError } = await listSubagents(transcriptFile, sessionId);
  if (!refs.length) {
    // 読めなかったことは伝える。0 件と「読めなかった」を同じ見た目にしない
    return readError ? { agents: 0, requests: 0, ite: 0, truncated: 0, readError: true } : null;
  }

  const mark = refs
    .map((r) => `${r.agentId}:${r.size}:${r.mtimeMs}`)
    .sort()
    .join('|');
  const key = `sub:${sessionId}:${mark}`;
  const hit = memoGet(key);
  if (hit) return hit;

  let requests = 0;
  let ite = 0;
  let truncated = 0;
  const logs = await pooled(refs, READ_CONCURRENCY, (ref) =>
    readSubagentLog(ref).catch(() => null));

  for (const log of logs) {
    if (!log) continue;
    // 子ログは全行が isSidechain: true。sidechain を立てないと1件も拾えない
    const u = buildUsage(log.entries, { sidechain: true });
    requests += u.requests;
    ite += u.totals.ite;
    // 大きいログは頭だけしか読んでいない。過少集計を黙って出さない
    if (log.truncated) truncated += 1;
  }

  const value = { agents: refs.length, requests, ite, truncated, readError: false };
  memoSet(key, value);
  return value;
}

/**
 * 読み終えた束から「直近の中央値」を出す。**ディスクを触らない。**
 *
 * **同じモデルのものだけを見る。** キャッシュ命中率は最小長がモデル別なので、
 * 混ぜた中央値と比べると構造の差を行動の差と読んでしまう。
 * ite や文脈量にモデル差は無いが、比較の相手を指標ごとに変えるほうが分かりにくい。
 *
 * @param {object[]} recs usageForTranscript の戻りの配列（自分は含めない）
 * @param {string|null} model 比べたいモデル
 * @returns {object|null} 標本が足りなければ null
 */
export function baselineFrom(recs, model) {
  if (!model) return null;

  const same = recs.filter((r) => r?.usage?.model === model && r.usage.requests > 0);
  if (same.length < BASELINE_MIN) return null;

  /** 取れた値だけを昇順に並べて真ん中を採る。取れないものは数に入れない */
  const med = (pick) => {
    const vals = [];
    for (const r of same) {
      const v = pick(r.usage);
      if (typeof v === 'number' && Number.isFinite(v)) vals.push(v);
    }
    return percentile(vals.sort((a, b) => a - b), 0.5);
  };

  return {
    model,
    sessions: same.length,
    ite: med((u) => u.totals.ite),
    contextLast: med((u) => u.context.last),
    hitRate: med((u) => u.cache.hitRate),
    compactCount: med((u) => u.compact.count),
  };
}

/**
 * 直近のセッションを開いて中央値を出す。上の baselineFrom を包む薄い殻。
 *
 * **自分は含めない。** 自分を入れると、極端な1本が自分自身の比較対象を引き寄せて差が縮む。
 *
 * @param {string} sessionId 比べる本人。除外するために要る
 * @param {Map<string, object>} index indexTranscripts の戻り。呼び出し元が既に持っている
 * @param {string|null} model
 * @returns {Promise<object|null>}
 */
async function baselineFor(sessionId, index, model) {
  if (!model) return null;

  const all = [];
  for (const [id, rec] of index) {
    if (id === sessionId) continue;
    all.push({ sessionId: id, file: rec.file, projectDir: rec.projectDir, mtimeMs: rec.mtimeMs });
  }

  all.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const scan = all.slice(0, BASELINE_SCAN);

  const read = await pooled(scan, READ_CONCURRENCY, (rec) =>
    usageForTranscript(rec.sessionId, rec).catch(() => null));

  const base = baselineFrom(read.filter(Boolean), model);
  // 何本を開いたうえでの中央値か。画面が言うのは開いた数ではなく揃った数（sessions）だが、
  // 「24本見て3本しか同じモデルが無かった」を後から知れるように、両方持たせておく
  return base ? { ...base, scanned: scan.length } : null;
}

/**
 * セッション1本の数値。
 *
 * ログがまだ書かれていないセッション（起こした直後など）でも null にはしない。
 * 「まだ何も使っていない」は測れた事実なので、0 件の集計をそのまま返す。
 * null を返すのは、登録簿にもログにも居ないときだけ。
 *
 * @param {string} sessionId
 * @returns {Promise<object|null>} 見つからなければ null
 */
export async function getSessionUsage(sessionId) {
  if (!sessionId) return null;

  const [{ entries: registryEntries }, index] = await Promise.all([
    readRegistry(),
    indexTranscripts(),
  ]);

  const registry = registryEntries.find((e) => e.sessionId === sessionId) ?? null;
  const transcript = index.get(sessionId) ?? null;
  if (!registry && !transcript) return null;

  if (!transcript) {
    return { id: sessionId, logSize: 0, ...buildUsage([]), sub: null };
  }

  const rec = await usageForTranscript(sessionId, transcript, { shared: true });

  // 本体を読み終えてから足す。失敗しても数値そのものは出す。
  // 実測で 20〜65ms（5体 3.7MB で 64ms）なので、ここに残して困らない
  const sub = await subUsageFor(sessionId, transcript.file).catch(() => null);

  // 応答の形は1本ぶんのまま。memo が余分に持っている見出しはここでは出さない
  return { id: sessionId, logSize: rec.logSize, ...rec.usage, sub };
}

/**
 * 「直近の中央値」だけを返す。**窓口を分けてある。**
 *
 * getSessionUsage に混ぜていた時期があるが、実測で 400〜700ms 掛かった
 * （直近24本を全文 parse する。大きいログに当たると一気に伸びる）。
 * 本体は 1.0〜1.5秒なので、混ぜると体感が5割増しになる。
 *
 * 分けたので、画面は数値を先に出してから、遅れて差を書き足せる。
 * 比べる相手がいないのは異常ではないので、そのときも 404 にはせず
 * `baseline: null` を返す。**「まだ読めていない」と「比べる相手がいない」を分ける。**
 *
 * @param {string} sessionId
 * @returns {Promise<object|null>} セッションが見つからなければ null（＝404）
 */
export async function getSessionBaseline(sessionId) {
  if (!sessionId) return null;

  const index = await indexTranscripts();
  const transcript = index.get(sessionId) ?? null;
  if (!transcript) return null;

  const rec = await usageForTranscript(sessionId, transcript, { shared: true });
  const baseline = await baselineFor(sessionId, index, rec.usage.model).catch(() => null);
  return { id: sessionId, model: rec.usage.model, baseline };
}

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

/** 文字列のパラメータ。空白だけなら null にする（「指定なし」と同じ扱い） */
function textOf(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  return t.slice(0, TEXT_MAX);
}

/**
 * クエリ文字列を、丸めた形の指定に直す。
 *
 * fs を触らないのでそのままテストできる。`view/archive.mjs` と同じ作法。
 *
 * @param {URLSearchParams} params
 * @returns {{limit: number, days: number|null, model: string|null}}
 */
export function parseUsageQuery(params) {
  const get = (key) => (params && typeof params.get === 'function' ? params.get(key) : null);

  return {
    limit: intOf(get('limit'), LIMIT_DEFAULT, 1, USAGE_SCAN_MAX),
    // 既定は期間で絞らない。新しい順に limit 件を見るので、期間は絞り込みの追加でしかない
    days: get('days') === null ? null : intOf(get('days'), null, 1, 3650),
    model: textOf(get('model')),
  };
}

/**
 * 並列度を決めて順に走らせる。
 *
 * **60本を Promise.all にしない。** 1本が最大 42MB あるので、
 * 全部を同時に開くと読んだ文字列と entries[] が同時に生きて数百MB〜GBに膨れる。
 * 4本ずつなら、終わったものから捨てられる。
 *
 * @param {any[]} items
 * @param {number} limit 同時に走らせる数
 * @param {(item: any, index: number) => Promise<any>} worker
 * @returns {Promise<any[]>} items と同じ並びの結果
 */
async function pooled(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;

  const run = async () => {
    for (;;) {
      // JS は await のあいだしか切り替わらないので、この2行のあいだに割り込まれない
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

/**
 * ツール別の消費を、セッションを跨いで足す。
 *
 * max は「1回で最大どれだけ積まれたか」なので、足さずに大きいほうを採る。
 * avg は足した後の合計から出し直す（セッションごとの平均を平均しない）。
 *
 * @param {object[]} list 各セッションの usage
 * @returns {object[]}
 */
function mergeTools(list) {
  const byTool = new Map();
  for (const usage of list) {
    for (const t of usage.tools ?? []) {
      const rec = byTool.get(t.tool) ?? { tool: t.tool, calls: 0, tokens: 0, max: 0 };
      rec.calls += t.calls;
      rec.tokens += t.tokens;
      if (t.max > rec.max) rec.max = t.max;
      byTool.set(t.tool, rec);
    }
  }

  return [...byTool.values()]
    .map((r) => ({ ...r, avg: r.calls > 0 ? Math.round(r.tokens / r.calls) : null }))
    .sort((a, b) => b.tokens - a.tokens || a.tool.localeCompare(b.tool))
    .slice(0, TOOLS_MAX);
}

/**
 * スキル別の消費を、セッションを跨いで足す。
 *
 * **標本が小さい。** 全ログを走査してもスキルは 12種・82件しかなく、
 * うち6種は n=1 だった（実測）。1回しか呼んでいないものを並べて
 * 「このスキルは重い」と読めてしまわないよう、
 * 呼んだ回数（runs）と、使ったセッションの数（sessions）を必ず一緒に返す。
 * 順位から外すかどうかの線引きは画面側で引く。
 *
 * @param {object[]} list 各セッションの usage
 * @returns {object[]}
 */
function mergeSkills(list) {
  const byName = new Map();
  for (const usage of list) {
    for (const s of usage.skills ?? []) {
      const rec = byName.get(s.skill) ?? { skill: s.skill, runs: 0, requests: 0, ite: 0, sessions: 0 };
      rec.runs += s.runs;
      rec.requests += s.requests;
      rec.ite += s.ite;
      rec.sessions += 1;
      byName.set(s.skill, rec);
    }
  }

  return [...byName.values()]
    .map((r) => ({ ...r, avg: r.runs > 0 ? Math.round(r.ite / r.runs) : null }))
    .sort((a, b) => b.ite - a.ite || a.skill.localeCompare(b.skill))
    .slice(0, SKILLS_MAX);
}

/**
 * 使ったモデルの内訳を、セッションを跨いで足す。
 *
 * @param {object[]} list 各セッションの usage
 * @returns {{model: string|null, models: {model: string, requests: number}[]}}
 */
function mergeModels(list) {
  const counts = new Map();
  for (const usage of list) {
    for (const m of usage.models ?? []) {
      counts.set(m.model, (counts.get(m.model) ?? 0) + m.requests);
    }
  }
  const models = [...counts.entries()]
    .map(([model, requests]) => ({ model, requests }))
    .sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model));
  return { model: models[0]?.model ?? null, models };
}

/**
 * 表に出すセッション1行。
 *
 * ログの絶対パスは載せない。詳細は sessionId だけで開ける。
 *
 * @param {object} rec usageForTranscript の戻り
 * @returns {object}
 */
function publicRow(rec) {
  const u = rec.usage;
  return {
    sessionId: rec.id,
    project: rec.project,
    title: rec.title,
    model: u.model,
    // そのセッションの中でモデルが混ざっているか。混ざっていれば命中率は読めない
    mixed: (u.models?.length ?? 0) > 1,
    requests: u.requests,
    ite: u.totals.ite,
    contextLast: u.context.last,
    contextPeak: u.context.peak,
    hitRate: u.cache.hitRate,
    logSize: rec.logSize,
    mtimeMs: rec.mtimeMs,
  };
}

/**
 * 読み終えたセッションの束を1つに束ねる。**ディスクを触らない。**
 *
 * 判断をここに全部集めてあるので、ファイルを用意せずにテストできる。
 * 下の listUsage は「読んで、絞って、これを呼ぶ」だけの薄い殻。
 *
 * **モデルでは絞らない。** プランでは「最頻モデルを自動で選び、混在集計は返さない」
 * としていたが、それだとスキルの標本（実測で12種82件・うち6種が n=1）がモデルで割れて、
 * スキル同士の比較がまるごと成立しなくなる。
 *
 * モデルまたぎで比べられないのは**キャッシュ命中率の1つだけ**なので、
 * 制約はそこへ直接当てる。混ざっているあいだ hitRate は null にして、
 * 何が混ざっているか（models）を一緒に返す。絞りたい人は model= で絞れる。
 *
 * @param {object[]} recs usageForTranscript の戻りの配列
 * @returns {object}
 */
export function aggregateUsage(recs) {
  const list = recs.map((r) => r.usage);

  const totals = { in: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, out: 0, ite: 0 };
  let requests = 0;
  for (const u of list) {
    requests += u.requests;
    for (const key of Object.keys(totals)) totals[key] += u.totals[key];
  }

  const { model, models } = mergeModels(list);
  // **モデルが混ざっていたら命中率は出さない。** 最小長がモデル別（Opus5=512 /
  // Opus4.7=2048 / Opus4.6・Haiku4.5=4096）で、未満だとエラーも出さずに黙って
  // キャッシュされない。混ぜて平均すると、行動の差と構造の差が見分けられなくなる。
  // null は「出せない」。0 と分けるので、画面はそのまま「—」を出せばよい
  const cacheBase = totals.cacheRead + totals.in + totals.cacheWrite5m + totals.cacheWrite1h;
  const hitRate = models.length === 1 && cacheBase > 0 ? totals.cacheRead / cacheBase : null;

  return {
    sessions: recs.length,
    requests,
    totals,
    model,
    models,
    cache: { hitRate },
    tools: mergeTools(list),
    skills: mergeSkills(list),
    // 実消費の多い順。いま見て効くのは「どれが重かったか」なので、新しい順にはしない
    rows: recs.map(publicRow).sort((a, b) => b.ite - a.ite),
  };
}

/**
 * 複数セッションを跨いだ数値。
 *
 * 新しい順に上限まで開いて、aggregateUsage に渡すだけ。
 * ここでやる判断は「どれを開くか」と「どれを表から外すか」の2つに絞ってある。
 *
 * @param {object} q parseUsageQuery の戻り
 * @param {number} now
 * @returns {Promise<object>}
 */
export async function listUsage(q, now = Date.now()) {
  const index = await indexTranscripts();

  const all = [];
  for (const [sessionId, rec] of index) {
    all.push({ sessionId, file: rec.file, projectDir: rec.projectDir, mtimeMs: rec.mtimeMs });
  }

  let candidates = all;
  if (q.days) {
    const from = now - q.days * DAY_MS;
    candidates = candidates.filter((r) => r.mtimeMs >= from);
  }

  // 新しい順に上限まで。古いものから切るのは、いまの使い方を見る場所だから
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const scan = candidates.slice(0, q.limit);
  const scanLimited = candidates.length > scan.length;

  const read = await pooled(scan, READ_CONCURRENCY, (rec) =>
    usageForTranscript(rec.sessionId, rec).catch(() => null));

  // 読めなかったものは黙って落とす。書き込み途中のファイルもここに来る
  let recs = read.filter(Boolean);
  // 要求が1件も無いもの（/clear の残骸など）は表から外す。0 が並ぶ行は読む時間を取るだけ
  const empty = recs.filter((r) => !r.usage.requests).length;
  recs = recs.filter((r) => r.usage.requests > 0);

  if (q.model) {
    // 主に使ったモデルで絞る。セッションの中でモデルが混ざっていることはあるので、
    // 絞っても models が1つになるとは限らない（hitRate はそこを見て決める）
    recs = recs.filter((r) => r.usage.model === q.model);
  }

  return {
    ...aggregateUsage(recs),
    limit: q.limit,
    days: q.days,
    filterModel: q.model,
    meta: {
      now,
      indexed: all.length,
      // 何件のファイルを開いたか。打ち切ったかどうかも正直に返す
      scanned: scan.length,
      scanLimited,
      scanMax: USAGE_SCAN_MAX,
      // 開いたが表に出なかったもの。合計が思ったより小さいときの説明になる
      empty,
    },
  };
}
