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
import { listSessions } from './src/view/sessions.mjs';
import { getSessionDetail } from './src/view/detail.mjs';
import { listArchive, parseArchiveQuery } from './src/view/archive.mjs';
import { getRawEntry } from './src/view/entry.mjs';
import { focusTerminal } from './src/os/focus.mjs';
import { sessionsDir, projectsDir, configDir } from './src/read/paths.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 4317;
/** 取りこぼし対策の定期確認。fs.watch が効かない環境でもこれで動く。 */
const POLL_MS = 2000;
/** 変更通知が連続で飛んでくるのをまとめる。 */
const DEBOUNCE_MS = 250;

const args = new Set(process.argv.slice(2));
const noOpen = args.has('--no-open');

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
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
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
    const payload = await computeSessions();
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

  // 窓を前面に出すのだけが POST。読み取り以外の操作はこれ1つに閉じている
  if (req.method === 'POST' && pathname === '/api/focus') {
    handleFocus(res, Number(url.searchParams.get('pid')));
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('method not allowed');
    return;
  }

  if (pathname === '/api/sessions') {
    computeSessions().then(
      (payload) => sendJson(res, 200, payload),
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

  if (pathname === '/api/health') {
    sendJson(res, 200, { ok: true, configDir, clients: clients.size });
    return;
  }

  serveStatic(res, pathname);
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
    const w = startWatching();
    console.log('ClaudeDeck');
    console.log(`  ${url}`);
    console.log(`  読み取り元: ${configDir}`);
    if (!w.okProjects) console.log('  （ファイル監視が使えないため定期確認のみで動きます）');
    console.log('  終了するには Ctrl+C');
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

const port = Number(process.env.CLAUDE_DECK_PORT) || DEFAULT_PORT;
listen(port);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const w of watchers) {
      try { w.close(); } catch { /* すでに閉じている */ }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500);
  });
}
