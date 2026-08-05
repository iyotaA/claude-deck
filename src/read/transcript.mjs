/**
 * 会話ログ（1セッション1ファイルの JSONL）を読む。
 *
 * 一覧のために全文を読むと大きいプロジェクトで重くなるので、
 * 末尾だけを読む経路と全文を読む経路を分けている。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { projectsDir } from './paths.mjs';
import { memo, stampOf } from './cache.mjs';

/** 末尾読みの初期サイズ。ツール結果1件で数十KB行くことがあるので、足りなければ広げる。 */
const TAIL_START_BYTES = 64 * 1024;
const TAIL_MAX_BYTES = 2 * 1024 * 1024;
/** 末尾読みで最低これだけの行が取れていれば状態判定に足りる。 */
const TAIL_MIN_ENTRIES = 6;

/** 1行ずつ JSON.parse する。壊れた行は数えて飛ばす。 */
function parseLines(lines) {
  const entries = [];
  let parseErrors = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      parseErrors += 1;
    }
  }
  return { entries, parseErrors };
}

/**
 * projects 配下を走査して sessionId から会話ログを引ける索引を作る。
 *
 * スラッグ化された cwd は不可逆なので、パスから逆算せずに実ファイルを探す。
 * sessionId はファイル名そのものなので一意に決まる。
 *
 * @returns {Promise<Map<string, {file: string, projectDir: string, size: number, mtimeMs: number}>>}
 */
export async function indexTranscripts() {
  const index = new Map();

  let projectNames;
  try {
    projectNames = await fs.readdir(projectsDir);
  } catch {
    return index;
  }

  for (const projectName of projectNames) {
    const dir = path.join(projectsDir, projectName);
    let names;
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }

    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      let stat;
      try {
        stat = await fs.stat(file);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;

      const sessionId = name.slice(0, -'.jsonl'.length);
      const prev = index.get(sessionId);
      // 同じ sessionId が複数プロジェクトに出た場合は新しい方を採る（cwd 移動後の再開など）
      if (prev && prev.mtimeMs >= stat.mtimeMs) continue;

      index.set(sessionId, {
        file,
        projectDir: projectName,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  return index;
}

/**
 * ログの末尾だけを読む。
 *
 * バイト位置で切るので先頭行は途中から始まりうる。その行は捨てる。
 * 途中で切れたマルチバイト文字も、その捨てる行に含まれるので影響しない。
 *
 * 行が少なすぎたら窓を倍にして読み直す（巨大なツール結果1件で埋まる場合の対策）。
 */
export async function readTail(file) {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return { entries: [], parseErrors: 0, truncated: false, size: 0, mtimeMs: 0 };
  }

  return memo(`tail:${file}`, stampOf(stat), async () => {
    let handle;
    try {
      handle = await fs.open(file, 'r');
    } catch {
      return { entries: [], parseErrors: 0, truncated: false, size: stat.size, mtimeMs: stat.mtimeMs };
    }

    try {
      let want = TAIL_START_BYTES;
      let result = null;

      while (true) {
        const length = Math.min(want, stat.size);
        const position = stat.size - length;
        const buf = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buf, 0, length, position);

        let text = buf.subarray(0, bytesRead).toString('utf8');
        const truncated = position > 0;
        if (truncated) {
          // 先頭の欠けた行を落とす
          const nl = text.indexOf('\n');
          text = nl === -1 ? '' : text.slice(nl + 1);
        }

        const parsed = parseLines(text.split('\n'));
        result = { ...parsed, truncated, size: stat.size, mtimeMs: stat.mtimeMs };

        const enough = parsed.entries.length >= TAIL_MIN_ENTRIES;
        if (enough || length >= stat.size || want >= TAIL_MAX_BYTES) break;
        want = Math.min(want * 4, TAIL_MAX_BYTES);
      }

      return result;
    } finally {
      await handle.close();
    }
  });
}

/**
 * ログの先頭だけを読む。readTail の鏡像。
 *
 * バイト位置で切るので末尾の行が途中で終わりうる。その行は捨てる。
 * 途中で切れたマルチバイト文字も、その捨てる行に含まれるので影響しない
 * （readTail は先頭を落とすが、こちらは末尾を落とす）。
 *
 * 末尾ではなく先頭を読むのは、サブエージェントのログを開く目的が
 * 「どうやって結論に至ったか」だから。結論（最終報告）は親ログの結果に既に入っている。
 * 先頭には受けた指示と最初の調査が入っていて、そちらのほうが価値がある。
 *
 * @param {string} file 読むファイル
 * @param {number} cap 読む上限バイト数
 * @returns {Promise<{entries: Array, parseErrors: number, truncated: boolean, size: number, mtimeMs: number}>}
 */
export async function readHead(file, cap) {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return { entries: [], parseErrors: 0, truncated: false, size: 0, mtimeMs: 0 };
  }

  return memo(`head:${cap}:${file}`, stampOf(stat), async () => {
    let handle;
    try {
      handle = await fs.open(file, 'r');
    } catch {
      return { entries: [], parseErrors: 0, truncated: false, size: stat.size, mtimeMs: stat.mtimeMs };
    }

    try {
      const length = Math.min(cap, stat.size);
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buf, 0, length, 0);

      let text = buf.subarray(0, bytesRead).toString('utf8');
      const truncated = length < stat.size;
      if (truncated) {
        // 末尾の欠けた行を落とす
        const nl = text.lastIndexOf('\n');
        text = nl === -1 ? '' : text.slice(0, nl);
      }

      const parsed = parseLines(text.split('\n'));
      return { ...parsed, truncated, size: stat.size, mtimeMs: stat.mtimeMs };
    } finally {
      await handle.close();
    }
  });
}

/** ログを全文読む。詳細ビューを開いたときだけ呼ぶ。 */
export async function readAll(file) {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return { entries: [], parseErrors: 0, size: 0, mtimeMs: 0 };
  }

  return memo(`all:${file}`, stampOf(stat), async () => {
    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      return { entries: [], parseErrors: 0, size: stat.size, mtimeMs: stat.mtimeMs };
    }
    const parsed = parseLines(raw.split('\n'));
    return { ...parsed, size: stat.size, mtimeMs: stat.mtimeMs };
  });
}
