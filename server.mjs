#!/usr/bin/env node
/**
 * ClaudeDeck のサーバ。
 *
 * 外部パッケージは使わない。node:http だけで静的配信・JSON API・SSE を行う。
 *
 * listen は 127.0.0.1 のみに固定する。
 * 会話ログには業務内容が入るため、社内ネットからは見えてはいけない。
 */
import http from 'node:http';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { listSessions, sortRows, summarizeRows } from './src/view/sessions.mjs';
import { getSessionDetail } from './src/view/detail.mjs';
import { listArchive, parseArchiveQuery } from './src/view/archive.mjs';
import { getRawEntry } from './src/view/entry.mjs';
import { getSubagentDetail } from './src/view/subagent.mjs';
import { getSessionBaseline, getSessionUsage, listUsage, parseUsageQuery } from './src/view/usage.mjs';
import { focusTerminal } from './src/os/focus.mjs';
import { claudeInfo, killTreeSync, probeClaude } from './src/os/claude.mjs';
import { createNotifier, FLUSH_MS } from './src/notify/index.mjs';
import { loadNotifyConfig } from './src/notify/config.mjs';
import { validateSettings, writeSettings } from './src/notify/settings.mjs';
import { createRunner } from './src/run/index.mjs';
import { mergeRuns } from './src/run/ledger.mjs';
import {
  allowedModes, runDirsFromEnv, BYPASS_MODE, DEFAULT_PERMISSION_MODE, PERMISSION_MODE_LABELS,
  EFFORTS, DEFAULT_BUDGET_USD, BUDGET_MIN_USD, BUDGET_MAX_USD, PROMPT_MAX,
} from './src/run/spec.mjs';
import { loadUpdateState, parseUpdateState } from './src/update/state.mjs';
import { loadStartupState, parseStartupState } from './src/startup/state.mjs';
import { isTrustedWrite } from './src/shared/origin.mjs';
import { VERSION } from './src/shared/appinfo.mjs';
import {
  resolvePortFile, hasPortFileFlag, writePortFile, removePortFile,
} from './src/shared/portfile.mjs';
import { sessionsDir, projectsDir, configDir } from './src/read/paths.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 4317;
/** 書き込みの本文の上限。設定は小さい JSON しか来ない。 */
const BODY_MAX = 8 * 1024;
/**
 * 実行の窓口だけの上限。
 *
 * **全体（BODY_MAX）を上げない。** 1本の定数を上げると、緩めた覚えのない口まで緩む。
 * 指示文は PROMPT_MAX（64,000 文字）まで受けるので、日本語（UTF-8 で1文字3バイト）でも
 * 最悪 192KB。他の項目を足してここに収まる。
 */
const RUN_BODY_MAX = 256 * 1024;

/**
 * 実際に listen できたポート。
 *
 * 埋まっていると +1 してずらすので、起動前には決まらない。
 * 書き込みの門番が host と origin を照合するのに要る。
 */
let boundPort = 0;
/** 取りこぼし対策の定期確認。fs.watch が効かない環境でもこれで動く。 */
const POLL_MS = 2000;
/** 変更通知が連続で飛んでくるのをまとめる。 */
const DEBOUNCE_MS = 250;

const argv = process.argv.slice(2);
const args = new Set(argv);
const noOpen = args.has('--no-open');
/**
 * 実ポートを置いておく紙の場所。
 *
 * ランチャと autostart.mjs は `--port-file <path>` で明示してくる。
 */
const portFile = resolvePortFile(argv);
/**
 * その紙を書く役目かどうか。
 *
 * `--port-file` を渡された起動だけが書き、畳むときに消す。
 * 渡されていない起動（開発側の `npm start`）は場所こそ同じだが、触らない。
 *
 * 紙は1枚しかないので、触る主体を絞らないと2本立ったときに取り合う。
 * 実際に踏んだ形は「インストール版が 4317 で動いているのに紙だけ消えている」で、
 * 開発側を Ctrl+C したときの後始末が、相手の紙を巻き添えにしていた。
 * 起動側は /api/health で裏を取るので無事だったが、
 * PID を紙から読む `ClaudeDeck.exe --stop` は止められなくなる。
 */
const writesPortFile = hasPortFileFlag(argv);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** public 配下のファイルを返す。パスは外に出られないよう正規化してから確認する。 */
async function serveStatic(res, pathname) {
  let rel;
  try {
    rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    // decodeURIComponent は壊れた %（/%ZZ など）で URIError を投げる。
    // ここを素通ししていたころは、その例外が拾われずにプロセスごと落ちていた。
    // GET なので書き込みの門番を通らず、他所のページの <img src> だけで撃てる
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad request');
    return;
  }
  const target = path.resolve(publicDir, rel);
  if (target !== publicDir && !target.startsWith(publicDir + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const data = await fsp.readFile(target);
    res.writeHead(200, {
      'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'content-length': data.length,
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
}

/* ---------------------------------------------------------------- 一覧の配信 */

const clients = new Set();
/**
 * 回答待ちを Slack へ知らせる係。
 *
 * 設定が無ければ全部が空振りになるので、有効かどうかをここで分岐しない。
 * 起動時に1回だけ設定を読む（毎秒の経路で fs を叩かないため）。
 */
const notifier = createNotifier();
/**
 * 画面から起こしたセッションの係。
 *
 * 一覧（`view/`）とは別の経路。合流させるのは `refresh()` の仕事で、
 * ここは「起こす・書く・止める」と速報の配り先だけを持つ。
 */
const runner = createRunner();
let lastPayload = null;
let lastSerialized = '';
let refreshTimer = null;
let refreshing = false;
let pendingRefresh = false;

async function computeSessions() {
  const { rows, meta } = await listSessions();
  return { rows, meta };
}

/**
 * 一覧に、この画面から起こしたぶんを重ねる。**ここが合成の場所。**
 *
 * `view/` と `run/` はお互いを import しない決まりなので、混ぜられるのはサーバーだけ。
 * 合流しないと、headless で起こしたセッションが走っている最中に「返信待ち」と出る
 * （登録簿に `status` のキーが無く、`deriveState` の2段目・3段目が効かないため）。
 *
 * **`computeSessions()` の中でやらない。** あちらは `allowedRunDirs()` も呼んでいて、
 * 合成行の cwd が起こせる場所の候補として跳ね返る形になる。読む口ごとにここを通す。
 *
 * 数え直しも要る。画面の上のバーは `meta.counts` しか見ていない。
 *
 * @param {{rows:Array<object>, meta:object}} payload `computeSessions()` の結果
 * @returns {{rows:Array<object>, meta:object}} 同じオブジェクト（その場で書き換える）
 */
function withRuns(payload) {
  try {
    payload.rows = sortRows(mergeRuns(payload.rows, runner.rows(), payload.meta.now));
    Object.assign(payload.meta, summarizeRows(payload.rows));
  } catch { /* 見送る。合流できなくても一覧そのものは出す */ }
  return payload;
}

/**
 * 一覧を作り直し、前回と違えば SSE で push する。
 *
 * 同時に何本も走らないよう直列化する。走っている間に来た要求は1回にまとめる。
 */
async function refresh(force = false) {
  if (refreshing) {
    pendingRefresh = true;
    return;
  }
  refreshing = true;
  try {
    // 実行の時計はここ1つ。`run/index.mjs` に setInterval を置かない。
    // 一覧が読めなかったときも沈黙の判定だけは進むよう、compute より先に呼ぶ。
    // try/catch は notifier と同じ理由で必須（実行側のバグで画面を空白にしない）
    try { runner.tick(); } catch { /* 見送る */ }

    // 合流は通知（observe）より**前**に置く。あとに置くと、走っている最中のものを
    // 「返信待ち」のまま見て、「回答待ちです」と Slack へ誤報を送ることになる
    const payload = withRuns(await computeSessions());

    // 通知は一覧より格下。ここで落とすと下の catch が broadcast('error') を出し、
    // 通知側のバグで画面が空白になる。この try/catch は任意ではなく必須
    try { notifier.observe(payload.rows, payload.meta.now); } catch { /* 見送る */ }

    // idleMs と now は毎回変わるので、差分判定からは外す。
    // これを入れると内容が同じでも毎回 push してしまう
    const serialized = JSON.stringify(payload.rows.map((r) => ({
      ...r,
      idleMs: undefined,
      lastActivityAt: undefined,
    })));

    lastPayload = payload;
    if (force || serialized !== lastSerialized) {
      lastSerialized = serialized;
      broadcast('sessions', payload);
    }
  } catch (err) {
    broadcast('error', { message: String(err?.message ?? err) });
  } finally {
    refreshing = false;
    if (pendingRefresh) {
      pendingRefresh = false;
      queueRefresh(0);
    }
  }
}

function queueRefresh(delay = DEBOUNCE_MS) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh();
  }, delay);
}

function broadcast(event, data) {
  if (clients.size === 0) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
}

function handleStream(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  clients.add(res);

  if (lastPayload) {
    res.write(`event: sessions\ndata: ${JSON.stringify(lastPayload)}\n\n`);
  } else {
    refresh(true);
  }

  // 経過時間の表示を進めるため、変化が無くても定期的に現在時刻だけ送る
  const tick = setInterval(() => {
    try {
      res.write(`event: tick\ndata: ${JSON.stringify({ now: Date.now() })}\n\n`);
    } catch {
      /* close 側で片付ける */
    }
  }, 1000);

  const close = () => {
    clearInterval(tick);
    clients.delete(res);
  };
  req.on('close', close);
  req.on('error', close);
}

/* -------------------------------------------------------------- 前面に出す */

/**
 * 一覧に出ている稼働中セッションの PID だけを前面化の対象にする。
 *
 * 任意の PID を受け取れる作りにしない。ローカル専用でも、
 * 外から叩かれたときに無関係なプロセスを触らせないため。
 */
async function handleFocus(res, pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    sendJson(res, 400, { ok: false, reason: 'PID が不正です' });
    return;
  }
  try {
    const rows = lastPayload?.rows ?? (await computeSessions()).rows;
    const known = rows.some((r) => r.alive && r.pid === pid);
    if (!known) {
      sendJson(res, 404, { ok: false, reason: 'そのPIDは稼働中のセッションにありません' });
      return;
    }
    sendJson(res, 200, await focusTerminal(pid));
  } catch (err) {
    sendJson(res, 500, { ok: false, reason: String(err?.message ?? err) });
  }
}

/* -------------------------------------------------------------- 書き込み口 */

/**
 * 本文を JSON として読む。上限を超えたら受け取らずに切る。
 *
 * 上限を引数にしてあるのは、実行の窓口だけ大きく受けるため。
 * **全体（BODY_MAX）を上げない。** 1本の定数を上げると、
 * 緩めた覚えのない口（設定の保存など）まで一緒に緩む。
 *
 * @param {object} req リクエスト
 * @param {number} [limit] 受け取るバイト数の上限
 * @returns {Promise<object>} 本文が空なら {}
 */
function readJsonBody(req, limit = BODY_MAX) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        // ここで req.destroy() を呼ぶと、断りの 400 を書く前に接続が切れる。
        // 溜めるのをやめて捨てるだけにして、応答は呼び側に書かせる
        req.resume();
        reject(new Error('本文が大きすぎます'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('本文が JSON ではありません'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 通知の設定を保存して、その場で効かせる。
 *
 * @param {object} req リクエスト
 * @param {object} res レスポンス
 */
async function handleSaveSettings(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { ok: false, reason: String(err?.message ?? err) });
    return;
  }

  const checked = validateSettings(body);
  if (!checked.ok) {
    sendJson(res, 400, { ok: false, reason: checked.error });
    return;
  }

  try {
    writeSettings(checked.patch);
    // 書いたものを読み直して渡す。丸めや既定の反映を1箇所（config.mjs）に任せる
    notifier.applyConfig(loadNotifyConfig());
  } catch (err) {
    sendJson(res, 500, { ok: false, reason: `設定を保存できませんでした: ${err?.message ?? err}` });
    return;
  }

  sendJson(res, 200, { ok: true, settings: notifier.settings() });
}

/**
 * テスト送信。送れなくてもリクエスト自体は成功なので 200 で返す。
 *
 * @param {object} res レスポンス
 */
async function handleTestNotify(res) {
  try {
    const r = await notifier.sendTest();
    sendJson(res, 200, { ...r, settings: notifier.settings() });
  } catch (err) {
    sendJson(res, 500, { ok: false, reason: String(err?.message ?? err) });
  }
}

/**
 * 外から行儀よく止める。更新のときにランチャが使う。
 *
 * 応答を書き終えてから畳む。ここで即 exit すると、
 * 止めた側には「応答が無い」としか分からず、
 * 止まったのか届かなかったのかを区別できない。
 *
 * @param {object} res レスポンス
 */
function handleQuit(res) {
  sendJson(res, 200, { ok: true, pid: process.pid });
  // 応答が相手に届く間を置いてから畳む
  setTimeout(() => shutdown(0), 100);
}

/**
 * 更新の状態を読む。
 *
 * 書いているのは C# ランチャ（launcher/Updates.cs）で、ここは読むだけ。
 * 判断をこちらに持ってくると、server.mjs の uncaughtException が
 * 失敗を握り潰して「画面は元気なのに何も変わらない」に化ける。
 *
 * loadUpdateState は自分で try を持っているが、
 * 置き場所の解決だけは環境変数しだいで投げうる。
 * ここで投げると 500 になり、更新が見えないだけのはずが窓口ごと落ちる。
 *
 * @returns {object} src/update/state.mjs の parseUpdateState の戻り
 */
function readUpdate() {
  try {
    return loadUpdateState({ version: VERSION });
  } catch {
    // 紙が読めないのと同じ扱いにする。形は parseUpdateState に作らせて、
    // 「読めなかったときの形」を2箇所に書かない
    return parseUpdateState(null, { version: VERSION });
  }
}

/**
 * 自動起動の様子を読む。
 *
 * 書いているのは C# ランチャ（launcher/Startup.cs）で、ここは読むだけ。
 * 登録・解除の口はこちらに作らない。スタブは子の終了コードを伝えない（実測）ので、
 * 押した結果を返せず、いつも「できました」と言うことになる。
 * 入切は ClaudeDeck.exe --install-startup / --uninstall-startup の役目。
 *
 * readUpdate と同じく、置き場所の解決だけは環境変数しだいで投げうる。
 * ここで投げると /api/health ごと 500 になり、
 * 「生きているかの最短の確認」が自動起動の都合で使えなくなる。
 *
 * @returns {object} src/startup/state.mjs の parseStartupState の戻り
 */
function readStartup() {
  try {
    return loadStartupState();
  } catch {
    // 紙が読めないのと同じ扱いにする。形は parseStartupState に作らせて、
    // 「読めなかったときの形」を2箇所に書かない
    return parseStartupState(null, {});
  }
}

/**
 * 更新を当てられる起動のされ方か。
 *
 * 判断の材料は環境変数1つだけ。ランチャが node を立てるときに置いていく。
 * リポジトリから npm start したときは無いので、更新の窓口は正直に断る。
 *
 * 紙（update.json）は %LOCALAPPDATA% で共用なので、
 * 入れた版が「新しい版があります」と書いた紙を、開発中の npm start が読むことがある。
 * そのとき当てられない理由は紙の中には無い。ここで環境から見るしかない。
 *
 * @returns {string|null} ランチャの場所。当てられないときは null
 */
function launcherPath() {
  const p = process.env.CLAUDE_DECK_LAUNCHER;
  return typeof p === 'string' && p.trim() ? p : null;
}

/**
 * 当てる作業が走っている見込みの終わり。0 は「走っていない」。
 *
 * 札を立てっぱなしにしない。ランチャが「新しい版は無かった」と判断して
 * 何もせず終わることがあり、そのとき誰も札を降ろせない。
 * 画面の見張りと同じ 120 秒で自然に切れるようにして、
 * 見張りが諦めた時点でもう一度押せる状態に戻す。
 */
let applyGuardUntil = 0;
const APPLY_GUARD_MS = 120000;

/**
 * 更新を当てる。ランチャを起こして、あとは任せる。
 *
 * ここで作業そのものをしない。node 自身が更新の対象（runtime\node.exe ごと
 * 差し替わる）なので、自分を置き換える手続きを自分の中に持たせない。
 *
 * 成否は spawn の結果をそのまま返す。**作業前に {ok:true} を書かない。**
 * 書いてしまうと、ランチャが起きていないのに画面が「更新しています」を出し、
 * 120 秒黙ってから時間切れになる。原因が spawn だったことは誰にも分からない。
 *
 * @param {object} res レスポンス
 */
function handleApplyUpdate(res) {
  const launcher = launcherPath();
  if (!launcher) {
    sendJson(res, 409, {
      ok: false,
      reason: 'この起動の仕方では更新できません（インストールした ClaudeDeck から起動してください）',
    });
    return;
  }

  const now = Date.now();
  if (now < applyGuardUntil) {
    sendJson(res, 409, { ok: false, reason: 'すでに更新を始めています', state: 'applying' });
    return;
  }
  applyGuardUntil = now + APPLY_GUARD_MS;

  // 自分の PID を渡す。ランチャは /api/quit で止めるのを先に試し、
  // それでも残っていたときの最後の保険としてこれを使う
  const argv = ['--apply-update', '--wait-pid', String(process.pid)];
  let child;
  try {
    // detached にするのが要点。ランチャはこのサーバーを殺してから作業するので、
    // 親の寿命に縛られていると自分の足場ごと消える
    child = spawn(launcher, argv, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (err) {
    applyGuardUntil = 0;
    sendJson(res, 500, { ok: false, reason: `更新を始められませんでした: ${err?.message ?? err}` });
    return;
  }

  // spawn と error はどちらか片方だけが必ず来る。両方待てば起動の成否が確定する。
  // 実行ファイルが無いときは同期では投げず、error にだけ来る
  let settled = false;
  child.once('spawn', () => {
    if (settled) return;
    settled = true;
    sendJson(res, 202, { ok: true, state: 'applying', pid: child.pid ?? null });
  });
  child.once('error', (err) => {
    if (settled) return;
    settled = true;
    applyGuardUntil = 0;
    sendJson(res, 500, { ok: false, reason: `更新を始められませんでした: ${err?.message ?? err}` });
  });
}

/* ------------------------------------------ 実行（画面から起こすセッション） */

/** 実行の速報を受け取っている窓。一覧の `clients` とは別に持つ。 */
const runClients = new Set();
/** 前回配った台帳の姿。同じなら配らない（一覧の差分判定と同じ作法）。 */
let lastRunRows = '';

/**
 * 実行の SSE を、つないでいる窓すべてへ配る。
 *
 * @param {string} event イベント名
 * @param {object} data 中身
 * @returns {void}
 */
function runBroadcast(event, data) {
  if (runClients.size === 0) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of runClients) {
    try {
      res.write(frame);
    } catch {
      runClients.delete(res);
    }
  }
}

/**
 * 台帳の姿が変わっていれば配る。
 *
 * 行は多くても3本なので毎回組んでよい。変わっていないのに配らないのは、
 * 一覧の差分判定と同じ理由（画面側の作り直しを無駄に走らせない）。
 *
 * @param {boolean} [force] 変わっていなくても配る
 * @returns {void}
 */
function pushRunRows(force = false) {
  const rows = runner.rows();
  const serialized = JSON.stringify(rows);
  if (!force && serialized === lastRunRows) return;
  lastRunRows = serialized;
  runBroadcast('runs', { rows, stats: runner.stats() });
}

// 購読は**サーバーに1本**だけ。窓は runClients を出入りするだけにしてある。
// 窓ごとに購読すると、閉じ忘れたぶんが listeners に静かに溜まる
runner.subscribe((events) => {
  runBroadcast('run', { events });
  pushRunRows();
});

/**
 * 起こしてよいフォルダ。
 *
 * 任意の文字列を受けない。許すのは2つだけ。
 * - 一覧に出ている cwd（＝このマシンで Claude Code が実際に動いたことのあるフォルダ）
 * - `CLAUDE_DECK_RUN_DIRS`（`;` 区切り）で明示的に足したフォルダ
 *
 * 書き込みの門番はブラウザ越しの攻撃を止めるが、**この機能の被害は
 * 「コードが実行される」という質の違うもの**なので、万一そこを抜けて届いても
 * 影響がその人の普段の作業フォルダに留まる形にしておく。
 * 配下かどうかの判定そのものは run/spec.mjs の resolveCwd にある。
 *
 * @returns {string[]} 許可するフォルダ
 */
function allowedRunDirs() {
  const dirs = new Set(runDirsFromEnv());
  for (const row of lastPayload?.rows ?? []) {
    if (typeof row?.cwd === 'string' && row.cwd) dirs.add(row.cwd);
  }
  return [...dirs];
}

/**
 * いま動いているセッションの ID。
 *
 * 続きを起こす（`--resume`）ときの門番の材料。同じセッションへ2本当てると
 * 会話ログが壊れるので、動いていないことを確かめてからでないと通さない。
 *
 * **一覧をまだ一度も読めていないときは `null` を返す。**
 * 空の Set を返すと「誰も動いていない」と読まれて、ちょうど動いている
 * セッションへ2本目が当たる。0 と不明を分けるのと同じ扱い。
 *
 * @returns {Set<string>|null} 動いているセッションの ID。分からなければ null
 */
function liveSessionIds() {
  if (!lastPayload) return null;
  const ids = new Set();
  for (const row of lastPayload.rows ?? []) {
    if (row?.alive && typeof row.sessionId === 'string' && row.sessionId) ids.add(row.sessionId);
  }
  return ids;
}

/**
 * セッションを1本起こす。
 *
 * 断る理由が5つある（掴めていない 503 / 指定が不正 400 / もう動いている 409 /
 * 本数と間隔 429 / 起こせなかった 500）。**どれで断ったかは run/index.mjs が status で返す。**
 * ここで理由の文字列を見て分岐させない。
 *
 * @param {object} req リクエスト
 * @param {object} res レスポンス
 */
async function handleRunStart(req, res) {
  let body;
  try {
    body = await readJsonBody(req, RUN_BODY_MAX);
  } catch (err) {
    sendJson(res, 400, { ok: false, reason: String(err?.message ?? err) });
    return;
  }

  const r = runner.start(body, {
    allowedDirs: allowedRunDirs(),
    liveSessions: liveSessionIds(),
  });
  // 断られた場合も台帳が動いていることがある（spawn に失敗した run は failed で残る）
  pushRunRows();
  if (!r.ok) {
    sendJson(res, r.status, { ok: false, reason: r.reason, run: r.row ?? null });
    return;
  }
  sendJson(res, r.status, { ok: true, runId: r.runId, run: r.row });
}

/**
 * 動いている run に続きの指示を送る。
 *
 * @param {object} req リクエスト
 * @param {object} res レスポンス
 * @param {string} runId 実行の識別子
 */
async function handleRunInput(req, res, runId) {
  let body;
  try {
    body = await readJsonBody(req, RUN_BODY_MAX);
  } catch (err) {
    sendJson(res, 400, { ok: false, reason: String(err?.message ?? err) });
    return;
  }

  const r = runner.input(runId, body?.prompt ?? body?.text);
  pushRunRows();
  if (!r.ok) {
    sendJson(res, r.status, { ok: false, reason: r.reason, run: r.row ?? null });
    return;
  }
  sendJson(res, r.status, { ok: true, run: r.row });
}

/**
 * 許可要求に答える。
 *
 * **本文の上限は既定の `BODY_MAX`（8KB）。`RUN_BODY_MAX` を渡さない。**
 * 来るのは `requestId` と選んだラベルだけで、質問の全文はサーバーが原文を持っている。
 * 長い理由を書きたいときは `/input` で送る。
 *
 * 断る番号は `run/index.mjs` が決める（理由の文字列で振り分けない）。
 *
 * @param {object} req リクエスト
 * @param {object} res レスポンス
 * @param {string} runId 実行の識別子
 */
async function handleRunAnswer(req, res, runId) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { ok: false, reason: String(err?.message ?? err) });
    return;
  }

  const r = runner.answer(runId, body?.requestId, body);
  // 答えると許可待ちが消えるので、一覧の行も変わる
  pushRunRows();
  if (!r.ok) {
    sendJson(res, r.status, { ok: false, reason: r.reason, run: r.row ?? null });
    return;
  }
  sendJson(res, r.status, { ok: true, run: r.row });
}

/**
 * 止める。3段階（stdin を閉じる → taskkill /T → taskkill /T /F）は os/claude.mjs の中。
 *
 * @param {object} res レスポンス
 * @param {string} runId 実行の識別子
 */
async function handleRunStop(res, runId) {
  try {
    const r = await runner.stop(runId);
    pushRunRows();
    if (!r.ok) {
      sendJson(res, r.status, { ok: false, reason: r.reason, run: r.row ?? null });
      return;
    }
    sendJson(res, r.status, { ok: true, run: r.row, closed: r.closed ?? null });
  } catch (err) {
    sendJson(res, 500, { ok: false, reason: String(err?.message ?? err) });
  }
}

/**
 * モデル・思考量・権限モードを替えて続きを起こす。
 *
 * **画面から2手（停止 → 起動）にしない。** あいだが空くと、前の子がまだ畳まれないうちに
 * 次が起きて、同じ会話ログに2つのプロセスが書きうる。`run/index.mjs` の中で
 * `close` を待ってから起こすので、この窓口の1手にまとめてある。
 *
 * @param {object} req リクエスト
 * @param {object} res レスポンス
 * @param {string} runId 実行の識別子
 */
async function handleRunSwitch(req, res, runId) {
  let body;
  try {
    // 切り替えにも指示文が要る（空 stdin では `system/init` すら出ない。実測）ので、
    // 入力と同じ上限を渡す
    body = await readJsonBody(req, RUN_BODY_MAX);
  } catch (err) {
    sendJson(res, 400, { ok: false, reason: String(err?.message ?? err) });
    return;
  }

  try {
    const r = await runner.switch(runId, body, body?.prompt ?? body?.text);
    pushRunRows();
    if (!r.ok) {
      sendJson(res, r.status, { ok: false, reason: r.reason, run: r.row ?? null });
      return;
    }
    sendJson(res, r.status, { ok: true, run: r.row, changed: r.changed });
  } catch (err) {
    sendJson(res, 500, { ok: false, reason: String(err?.message ?? err) });
  }
}

/**
 * 実行専用の SSE。
 *
 * **`/api/stream` に相乗りさせない。** あちらは全タブが常時つないでいる一覧の経路で、
 * 差分判定つき・1秒 tick 付き。1ターンで数百行出る実行の速報を混ぜると、
 * 一覧の更新が実行の量に引きずられる。性質も寿命も違う。
 *
 * @param {object} req リクエスト
 * @param {object} res レスポンス
 * @param {number} from この `seq` より後の速報を、つないだ直後に流し直す
 */
function handleRunStream(req, res, from) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  runClients.add(res);

  // 切れていたあいだの穴は、つないだその場で埋める。
  // missed は落として渡せなかった件数。**黙って詰めない**
  const back = runner.events(from);
  try {
    res.write(`event: runs\ndata: ${JSON.stringify({
      rows: runner.rows(),
      stats: runner.stats(),
      from: back.from,
      nextSeq: back.nextSeq,
      missed: back.missed,
    })}\n\n`);
    if (back.events.length > 0) {
      res.write(`event: run\ndata: ${JSON.stringify({ events: back.events })}\n\n`);
    }
  } catch { /* close 側で片付ける */ }

  // 実行が無いあいだは無言になるので、生きていることだけ伝える。
  // 一覧のような1秒 tick は要らない（経過時間をここから描かない）
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch { /* close 側で片付ける */ }
  }, 25000);

  const close = () => {
    clearInterval(ping);
    runClients.delete(res);
  };
  req.on('close', close);
  req.on('error', close);
}

/**
 * GET と HEAD 以外は、すべてここを通す。
 *
 * 127.0.0.1 で listen していても、それは守りにならない。
 * 利用者が開いた任意のページから、そのブラウザ経由でここへ POST できるため。
 * 判断は src/shared/origin.mjs に純関数で置いてある。
 *
 * @param {object} req リクエスト
 * @param {object} res レスポンス
 * @param {string} pathname パス
 * @param {URL} url クエリを読む用
 */
function handleWrite(req, res, pathname, url) {
  const gate = isTrustedWrite(req.headers, boundPort);
  if (!gate.ok) {
    sendJson(res, gate.status, { ok: false, reason: gate.reason });
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405).end('method not allowed');
    return;
  }

  if (pathname === '/api/focus') {
    handleFocus(res, Number(url.searchParams.get('pid')));
    return;
  }
  if (pathname === '/api/settings/notify') {
    handleSaveSettings(req, res);
    return;
  }
  if (pathname === '/api/settings/notify/test') {
    handleTestNotify(res);
    return;
  }
  if (pathname === '/api/quit') {
    handleQuit(res);
    return;
  }
  if (pathname === '/api/update/apply') {
    handleApplyUpdate(res);
    return;
  }
  if (pathname === '/api/runs') {
    handleRunStart(req, res);
    return;
  }
  // 完全一致（/api/runs）より後ろに置く。こちらのほうが具体的だが、
  // 上は同じ文字列との一致なので取り違えは起きない
  const runPost = pathname.match(/^\/api\/runs\/([\w-]{1,64})\/(input|stop|switch|answer)$/);
  if (runPost) {
    if (runPost[2] === 'input') handleRunInput(req, res, runPost[1]);
    else if (runPost[2] === 'switch') handleRunSwitch(req, res, runPost[1]);
    else if (runPost[2] === 'answer') handleRunAnswer(req, res, runPost[1]);
    else handleRunStop(res, runPost[1]);
    return;
  }

  sendJson(res, 404, { ok: false, reason: 'そのような窓口はありません' });
}

/* ------------------------------------------------------------------ 監視 */

const watchers = [];

/** 変更を検知したら一覧を作り直す。失敗しても致命ではない（ポーリングが残る）。 */
function watch(dir, recursive) {
  try {
    const w = fs.watch(dir, { recursive, persistent: false }, () => queueRefresh());
    w.on('error', () => {});
    watchers.push(w);
    return true;
  } catch {
    return false;
  }
}

function startWatching() {
  const okSessions = watch(sessionsDir, false);
  const okProjects = watch(projectsDir, true);
  setInterval(() => queueRefresh(0), POLL_MS).unref?.();
  return { okSessions, okProjects };
}

/* ------------------------------------------------------------------ 起動 */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  const { pathname } = url;

  // 読み取り以外はすべて門番を通す。窓の前面化も設定の保存も同じ扱いにする
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    handleWrite(req, res, pathname, url);
    return;
  }

  if (pathname === '/api/sessions') {
    // SSE と同じものを返す。ここで合流を通さないと、押し出しでは実行中に見えるのに
    // 1回引いたときだけ「返信待ち」に見える、という食い違いが生まれる
    computeSessions().then(
      (payload) => sendJson(res, 200, withRuns(payload)),
      (err) => sendJson(res, 500, { error: String(err?.message ?? err) }),
    );
    return;
  }

  // 書庫。一覧と違って毎秒引かれるものではないので、その場で作って返す（push はしない）
  if (pathname === '/api/archive') {
    listArchive(parseArchiveQuery(url.searchParams)).then(
      (payload) => sendJson(res, 200, payload),
      (err) => sendJson(res, 500, { error: String(err?.message ?? err) }),
    );
    return;
  }

  // セッションを跨いだ数値。書庫と同じくその場で作って返す（push はしない）。
  //
  // ログを全文読むので、一番重い窓口。上限（USAGE_SCAN_MAX）で切って、
  // 切ったことは meta.scanLimited で正直に返す
  if (pathname === '/api/usage') {
    listUsage(parseUsageQuery(url.searchParams)).then(
      (payload) => sendJson(res, 200, payload),
      (err) => sendJson(res, 500, { error: String(err?.message ?? err) }),
    );
    return;
  }

  // 原文の1行。詳細より露出量が多いので、entry.mjs 側で鍵らしい値を伏せて長さを切る。
  // 下の detailMatch は末尾 $ で閉じていて / を含まないので構造上ぶつからないが、
  // 読み手が順序を気にしないで済むよう、具体的なほうを手前に置く
  const entryMatch = /^\/api\/sessions\/([\w.-]{1,80})\/entry\/([\w-]{1,80})$/.exec(pathname);
  if (entryMatch) {
    getRawEntry(entryMatch[1], entryMatch[2], { agentId: url.searchParams.get('agent') }).then(
      (raw) => {
        if (!raw) sendJson(res, 404, { error: 'その行が見つかりません' });
        else sendJson(res, 200, raw);
      },
      (err) => sendJson(res, 500, { error: String(err?.message ?? err) }),
    );
    return;
  }

  // サブエージェント1件の記録。これも detailMatch より手前に置く（具体的なほうから）。
  //
  // ここの [\w-]{1,64} は入口の粗いふるいであって、安全の根拠ではない。
  // 開くファイルは readdir が返した名前だけで、リクエストの文字列をパスに連結しない。
  // 理由は view/subagent.mjs の getSubagentDetail の JSDoc に書いてある
  const agentMatch = /^\/api\/sessions\/([\w.-]{1,80})\/subagents\/([\w-]{1,64})$/.exec(pathname);
  if (agentMatch) {
    getSubagentDetail(agentMatch[1], agentMatch[2]).then(
      (payload) => {
        if (!payload) sendJson(res, 404, { error: 'その記録が見つかりません' });
        else sendJson(res, 200, payload);
      },
      (err) => sendJson(res, 500, { error: String(err?.message ?? err) }),
    );
    return;
  }

  // いつもと比べてどうか。usage より手前に置く（長いほうから並べる、この並びの決まり）。
  //
  // 数値そのものと分けてある。こちらは直近24本を全文 parse するので実測 400〜700ms 掛かり、
  // 混ぜると数値の表示そのものが遅くなる。画面は先に数値を出し、遅れて差を書き足す
  const baselineMatch = /^\/api\/sessions\/([\w.-]{1,80})\/usage\/baseline$/.exec(pathname);
  if (baselineMatch) {
    getSessionBaseline(baselineMatch[1]).then(
      (payload) => {
        if (!payload) sendJson(res, 404, { error: 'そのセッションが見つかりません' });
        else sendJson(res, 200, payload);
      },
      (err) => sendJson(res, 500, { error: String(err?.message ?? err) }),
    );
    return;
  }

  // そのセッションが何にトークンを使ったか。これも detailMatch より手前（具体的なほうから）。
  //
  // 詳細の応答に混ぜず別立てにしてある。/api/sessions/:id はセッションを開くたび毎回走るので、
  // ここに集計を足すと、数値を見ない人まで詳細を開く速度が落ちる
  const usageMatch = /^\/api\/sessions\/([\w.-]{1,80})\/usage$/.exec(pathname);
  if (usageMatch) {
    getSessionUsage(usageMatch[1]).then(
      (payload) => {
        if (!payload) sendJson(res, 404, { error: 'そのセッションが見つかりません' });
        else sendJson(res, 200, payload);
      },
      (err) => sendJson(res, 500, { error: String(err?.message ?? err) }),
    );
    return;
  }

  const detailMatch = /^\/api\/sessions\/([\w.-]{1,80})$/.exec(pathname);
  if (detailMatch) {
    getSessionDetail(detailMatch[1]).then(
      (detail) => {
        if (!detail) sendJson(res, 404, { error: 'そのセッションが見つかりません' });
        else sendJson(res, 200, detail);
      },
      (err) => sendJson(res, 500, { error: String(err?.message ?? err) }),
    );
    return;
  }

  if (pathname === '/api/stream') {
    handleStream(req, res);
    return;
  }

  // 画面から起こしたぶんの台帳。まだ会話ログが無い時期でも、ここには最初から出ている
  if (pathname === '/api/runs') {
    sendJson(res, 200, { rows: runner.rows(), stats: runner.stats() });
    return;
  }

  // 取りこぼしの穴埋め。SSE が切れているあいだに出た速報をここで拾う。
  // 完全一致なので、下の runMatch（:id）とはぶつからない
  if (pathname === '/api/runs/events') {
    sendJson(res, 200, runner.events(Number(url.searchParams.get('from'))));
    return;
  }

  // 実行専用の SSE。/api/stream には相乗りさせない（理由は handleRunStream に）
  if (pathname === '/api/runs/stream') {
    handleRunStream(req, res, Number(url.searchParams.get('from')));
    return;
  }

  // 起こすフォームが開いたときに1回だけ引く。ここを毎秒更新しない。
  //
  // **完全一致なので runMatch より手前に置く。** 下の正規表現は
  // `/api/runs/options` にも当たるので、順番を入れ替えると
  // 「そんな実行はありません」と 404 を返すようになる。
  //
  // **モデルの候補は返さない。** spec.mjs が許可リストを持たない方針なので、
  // ここで一覧を作ると同じ古さを別の場所に増やすことになる。画面は自由入力にして
  // 「空欄なら CLI の既定」と書く。
  if (pathname === '/api/runs/options') {
    sendJson(res, 200, {
      // 並べ直してから返す。allowedRunDirs() は Set の挿入順なので、
      // 一覧の並びが変わるたびに選択肢の順が動く（押す場所が毎回変わって使いにくい）
      cwds: allowedRunDirs().sort((a, b) => a.localeCompare(b)),
      // 語彙は spec.mjs のものをそのまま渡す。日本語も向こうに持たせてあるので、
      // 語を1つ増やすときに直すのは spec.mjs だけで済む（STATE_LABELS と同じ方針）。
      // bypassPermissions は CLAUDE_DECK_RUN_ALLOW_BYPASS が立っているときだけ混ざる
      modes: allowedModes().map((value) => ({
        value,
        label: PERMISSION_MODE_LABELS[value] ?? value,
        danger: value === BYPASS_MODE,
      })),
      defaultMode: DEFAULT_PERMISSION_MODE,
      efforts: EFFORTS,
      budget: { default: DEFAULT_BUDGET_USD, min: BUDGET_MIN_USD, max: BUDGET_MAX_USD },
      promptMax: PROMPT_MAX,
      // 掴めていなければフォームの時点で分かるようにする。押してから 503 で断るより早い。
      // **path と source は載せない。** 画面に出す用が無いのに、あると
      // ブラウザの履歴やスクリーンショットにローカルのパスが乗る
      claude: (({ ok, state, label, version, reason }) => (
        { ok, state, label, version, reason }
      ))(claudeInfo()),
      // 上限に達していれば、押す前に分かる
      runs: runner.stats(),
    });
    return;
  }

  const runMatch = /^\/api\/runs\/([\w-]{1,64})$/.exec(pathname);
  if (runMatch) {
    const run = runner.get(runMatch[1]);
    if (!run) sendJson(res, 404, { error: 'その実行は見つかりません' });
    else sendJson(res, 200, run);
    return;
  }

  // 設定モーダルが開いたときに1回だけ引く。生の Webhook URL は入らない
  if (pathname === '/api/settings/notify') {
    sendJson(res, 200, notifier.settings());
    return;
  }

  // 更新の状態。画面が読み込み時と30分ごとに引く。
  // そのつど紙を読み直してよい程度の頻度なので、起動時に1回だけ持つ形にはしない
  // （持つと、ランチャが裏で書き換えても画面が古いまま固まる）
  if (pathname === '/api/update') {
    // canApply だけは紙の中身ではなく、いまの起動のされ方の話。
    // だから parseUpdateState には持たせず、ここで足す。
    // これが無いと画面は押してみるまで分からず、押せない場所に更新ボタンが出る
    sendJson(res, 200, { ...readUpdate(), canApply: Boolean(launcherPath()) });
    return;
  }

  if (pathname === '/api/health') {
    // 自動起動されたサーバーの設定を確かめる唯一の手段。
    // notify.target はマスク済みしか入っていない（notify/index.mjs の health）
    const update = readUpdate();
    sendJson(res, 200, {
      ok: true, version: VERSION, configDir, clients: clients.size, notify: notifier.health(),
      // 画面からセッションを起こすための土台。掴めていなければここで分かる。
      // 起動直後は state:'checking'（ok は null。0 と不明を分けるのと同じ扱い）
      claude: claudeInfo(),
      // 数だけ。行そのものは /api/runs。裏で立っているサーバーが何本抱えているかを
      // ここから確かめられるようにしておく（自動起動されたぶんは画面が無くても動く）
      runs: runner.stats(),
      // 短い形だけ載せる。全部入りは /api/update
      update: { state: update.state, available: update.available },
      // こちらは丸ごと。自動起動には専用の窓口が無いので、短くすると見る手段が消える。
      // 設定の画面もここから1行を組む
      startup: readStartup(),
    });
    return;
  }

  // 他の非同期の窓口と同じく、失敗の受け皿を必ず付ける。
  // async 関数の拒否を拾わないと unhandled rejection になり、Node がプロセスを殺す
  serveStatic(res, pathname).catch(() => {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('server error');
  });
});

/**
 * そのポートを使っているのが ClaudeDeck 自身かどうかを尋ねる。
 *
 * @param {number} port 確かめるポート
 */
async function askRunning(port) {
  try {
    const res = await fetch(`http://${HOST}:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.ok ? body : null;
  } catch {
    // 別のものが使っている、または応答しない
    return null;
  }
}

/** ポートが埋まっていたら少しずつずらして探す。 */
function listen(port, attemptsLeft = 12) {
  server.once('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      // 自動起動でもう動いていることがある。二重に立てても監視が二重になるだけなので、
      // 相手が ClaudeDeck なら画面を開くだけにする
      const running = await askRunning(port);
      if (running) {
        const url = `http://${HOST}:${port}/`;
        console.log('ClaudeDeck はすでに起動しています');
        console.log(`  ${url}`);
        if (!noOpen) openBrowser(url);
        process.exit(0);
      }

      if (attemptsLeft > 0) {
        listen(port + 1, attemptsLeft - 1);
        return;
      }
    }
    console.error(`起動できませんでした: ${err.message}`);
    process.exit(1);
  });

  server.listen(port, HOST, () => {
    const url = `http://${HOST}:${port}/`;
    // 書き込みの門番が host と origin を照合するのに要る。決まってから入れる
    boundPort = server.address()?.port ?? port;

    // 実ポートが決まってから置く。外から 4317 決め打ちで探されないように。
    // 書けなくてもサーバーは動くべきなので、失敗を致命扱いにしない
    let portFileError = null;
    if (writesPortFile) {
      try {
        writePortFile(portFile, {
          port: boundPort,
          pid: process.pid,
          url: `http://${HOST}:${boundPort}/`,
          version: VERSION,
          startedAt: Date.now(),
        });
      } catch (err) {
        portFileError = err?.message ?? String(err);
      }
    }

    const w = startWatching();
    console.log('ClaudeDeck');
    console.log(`  ${url}`);
    console.log(`  読み取り元: ${configDir}`);
    if (!w.okProjects) console.log('  （ファイル監視が使えないため定期確認のみで動きます）');
    if (portFileError) console.log(`  （実ポートを書き出せませんでした: ${portFileError}）`);
    // 通知の行は有効なときと、書き間違えているときだけ出る。設定していなければ黙る
    const notifyLine = notifier.banner();
    if (notifyLine) console.log(`  ${notifyLine}`);
    console.log('  終了するには Ctrl+C');

    // 深いリンクに使う。ポートはずれることがあるので、決まってから渡す
    notifier.setBaseUrl(url);
    // 送信は refresh() とは別の時計で回す。flush は refresh を呼ばず、待たない
    setInterval(() => { notifier.flush(); }, FLUSH_MS).unref();

    // claude CLI を1回だけ探して版を読む。結果は /api/health の claude に出る。
    // 掴めなくてもダッシュボードとしては動くので、待たないし致命扱いにもしない。
    // probeClaude は必ず解決するが、約束どおり受け皿は付けておく
    probeClaude().catch(() => {});

    refresh(true);
    if (!noOpen) openBrowser(url);
  });
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* 開けなくても URL は表示済み */
  }
}

/*
 * 最後の受け皿。「未知の形で落ちない」を、拾い漏らした例外にも効かせる。
 *
 * Node 18 以降は拾われなかった例外・拒否でプロセスが終わる。
 * このアプリでそれが起きると、画面が死ぬだけでなく通知も黙って止まる。
 * 「返事待ちに気づけない」を埋めるための道具が、気づけないまま止まるのがいちばん困る。
 *
 * 一般には「状態が壊れたまま走らせるな」で終了が正しい。
 * ここで生かすほうを選べるのは、読み取り専用のローカル画面で、
 * 壊れて困る書き込み中の状態を持たないため（設定の保存だけが例外で、
 * そちらは一時ファイルへ書いてから rename している）。
 */
for (const [event, label] of [['uncaughtException', '想定外の例外'], ['unhandledRejection', '拾われなかった失敗']]) {
  process.on(event, (err) => {
    console.error(`${label}: ${err?.stack ?? err}`);
    console.error('  （落とさずに続けます）');
  });
}

const port = Number(process.env.CLAUDE_DECK_PORT) || DEFAULT_PORT;
listen(port);

/** 畳んでいる最中かどうか。Ctrl+C の連打や、quit と signal の重なりで二重に走らせない。 */
let shuttingDown = false;

/**
 * 行儀よく畳む。
 *
 * 入口は3つ（Ctrl+C・SIGTERM・POST /api/quit）あるが、やることは同じなのでここに寄せる。
 *
 * @param {number} [code] 終了コード
 */
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const w of watchers) {
    try { w.close(); } catch { /* すでに閉じている */ }
  }

  // 起こした子を畳みにいく。**待たない。**
  // `stopClaude` の3段（stdin を閉じる → taskkill /T → taskkill /T /F）は最長5秒かかるが、
  // 下の 500ms より長く待つと Ctrl+C がすぐ効かなくなる。
  // 1段目の stdin を閉じるところまでは同期で始まり、行儀のよい相手はそれで終わる（実測 close code=0）。
  // 5秒に間に合わなかったぶんは、下の process.on('exit') が木ごと落とす
  runner.shutdown().catch(() => { /* 畳む途中の失敗は見送る */ });

  // 助言として置いた紙なので、畳めるときは消しておく。
  // 消し損ねても読む側は /api/health で裏を取る作りなので、そこは致命にならない。
  // 自分が置いたときだけ消す。置いていない紙は他のサーバーのものなので触らない
  if (writesPortFile) removePortFile(portFile);

  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 500);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => shutdown(0));
}

/**
 * 最後の後始末。畳みきれなかった子を、木ごと落とす。
 *
 * ここは**同期しか走らない。** `runner.shutdown()` は `await` を含むので、
 * このハンドラから呼んでも何もしないまま終わる。だから PID だけ受け取って
 * `killTreeSync`（`taskkill /T /F` の同期版）に任せる。
 *
 * 行儀を捨てるのは、ここへ来る時点でサーバーの寿命が尽きているため。
 * 上の `shutdown()` で 500ms 以内に畳めた子は `livePids()` に残らないので、
 * ここに残るのは Bash などを掴んだまま応じなかった子だけになる（実測でその子は3段目まで要った）。
 *
 * **`claude.exe` は孫を作る**（Bash ツール）。`child.kill()` では親しか落ちず、
 * 孫が画面にもタスクマネージャの見えるところにも出ないまま走り続ける。
 */
process.on('exit', () => {
  let pids;
  try { pids = runner.livePids(); } catch { return; }
  for (const pid of pids) {
    try { killTreeSync(pid); } catch { /* もう居ない・権限が足りない */ }
  }
});
