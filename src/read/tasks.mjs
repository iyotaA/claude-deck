/**
 * セッションの TODO を読む。
 *
 * `~/.claude/tasks/<セッションID>/<番号>.json` に1件1ファイルで入っている。
 *   {"id":"1","subject":"…","description":"…","activeForm":"…",
 *    "status":"in_progress","blocks":[],"blockedBy":[]}
 *
 * `.lock` と `.highwatermark` は中身が TODO ではないので読まない。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { tasksDir } from './paths.mjs';

const STATUS_LABELS = {
  pending: '未着手',
  in_progress: '進行中',
  completed: '完了',
  cancelled: '取り消し',
  blocked: '待ち',
};

/** 進行中を上に、完了を下に。同じ状態なら番号順。 */
const STATUS_ORDER = ['in_progress', 'blocked', 'pending', 'completed', 'cancelled'];

/**
 * @param {string} sessionId
 * @returns {Promise<{items: Array, counts: object}>}
 */
export async function readTasks(sessionId) {
  const empty = { items: [], counts: {} };
  if (!sessionId) return empty;

  const dir = path.join(tasksDir, sessionId);
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return empty;
  }

  const items = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    let raw;
    try {
      raw = await fs.readFile(path.join(dir, name), 'utf8');
    } catch {
      continue;
    }
    let task;
    try {
      task = JSON.parse(raw);
    } catch {
      // 書き込み途中の可能性があるので黙って飛ばす
      continue;
    }
    items.push({
      id: String(task.id ?? name.replace(/\.json$/, '')),
      subject: typeof task.subject === 'string' ? task.subject : '(件名なし)',
      description: typeof task.description === 'string' ? task.description : null,
      activeForm: typeof task.activeForm === 'string' ? task.activeForm : null,
      status: typeof task.status === 'string' ? task.status : 'pending',
      statusLabel: STATUS_LABELS[task.status] ?? task.status ?? '不明',
      blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy : [],
    });
  }

  items.sort((a, b) => {
    const s = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
    if (s !== 0) return s;
    return Number(a.id) - Number(b.id) || a.id.localeCompare(b.id);
  });

  const counts = {};
  for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1;

  return { items, counts };
}
