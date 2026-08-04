/**
 * 稼働中セッションの登録簿を読む。
 *
 * ~/.claude/sessions/<PID>.json の中身（実測）:
 *   {"pid":26796,"sessionId":"3f30...","cwd":"C:\\Users\\me\\work",
 *    "startedAt":1785750043110,"version":"2.1.220","kind":"interactive",
 *    "entrypoint":"cli","name":"sandbox-9c","nameSource":"derived",
 *    "status":"busy","updatedAt":...,"statusUpdatedAt":...}
 *
 * 未知のキーや未知の status が増えても落ちないこと。
 *
 * updatedAt を「生きているかの目安」に使ってはいけない。
 * 実測すると、いま動いているセッションでも updatedAt が1時間前のままだった。
 * 定期的に打ち直される値ではなく、状態が変わったときだけ書かれる。
 * 古さで終了扱いにすると、稼働中のセッションを一覧から消してしまう。
 * 生死の判定は PID の存在確認だけで行う。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { sessionsDir } from './paths.mjs';

/**
 * プロセスが生きているか。
 *
 * シグナル 0 は「送らずに存在確認だけする」の意味。Windows でも動く。
 * EPERM は「居るが触れない」なので生存扱い。
 *
 * PID が使い回されると死んだセッションを生存と誤判定しうるが、
 * 外れても一覧に古い行が1つ残るだけなので、ここは単純さを取る。
 */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/**
 * 登録簿を全部読む。
 *
 * @returns {Promise<{entries: Array, readErrors: number}>}
 *   entries は sessionId を持つものだけ。alive を付けて返す。
 */
export async function readRegistry() {
  let names;
  try {
    names = await fs.readdir(sessionsDir);
  } catch {
    // Claude Code のバージョンが古いと sessions ディレクトリ自体が無い
    return { entries: [], readErrors: 0 };
  }

  const entries = [];
  let readErrors = 0;

  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(sessionsDir, name), 'utf8');
      const rec = JSON.parse(raw);
      if (!rec || typeof rec.sessionId !== 'string') continue;

      entries.push({
        pid: typeof rec.pid === 'number' ? rec.pid : Number(path.basename(name, '.json')),
        sessionId: rec.sessionId,
        cwd: typeof rec.cwd === 'string' ? rec.cwd : null,
        name: typeof rec.name === 'string' ? rec.name : null,
        nameSource: rec.nameSource ?? null,
        status: typeof rec.status === 'string' ? rec.status : null,
        kind: rec.kind ?? null,
        entrypoint: rec.entrypoint ?? null,
        version: rec.version ?? null,
        startedAt: typeof rec.startedAt === 'number' ? rec.startedAt : null,
        updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : null,
        statusUpdatedAt: typeof rec.statusUpdatedAt === 'number' ? rec.statusUpdatedAt : null,
      });
    } catch {
      // 書き込み途中のファイルを読むと壊れた JSON になる。次の巡回で拾えるので黙って飛ばす
      readErrors += 1;
    }
  }

  for (const entry of entries) {
    entry.alive = isAlive(entry.pid);
  }

  return { entries, readErrors };
}
