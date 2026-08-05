/**
 * サブエージェントの記録を数え上げる。
 *
 * 実測した置き場所（提案書は <sessionId>/ 直下と書いていたが、実際は2階層深い）:
 *
 *   ~/.claude/projects/<スラッグ化した cwd>/
 *     <sessionId>.jsonl                  親のログ
 *     <sessionId>/
 *       subagents/
 *         agent-<agentId>.jsonl          サブエージェントのログ
 *         agent-<agentId>.meta.json      メタ 139 バイト
 *       tool-results/                    触らない
 *     memory/                            触らない
 *
 * ディレクトリは**親ログの実パスから作る**。slugifyCwd は不可逆変換なので
 * そこから組み立てない、という禁止と同じ理屈。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { readAll, readHead } from './transcript.mjs';

/**
 * サブエージェントのログを全文読む上限。
 *
 * 実測した最大は 2.63MB（148ファイル合計 12.8MB）なので、現状は全件が収まる。
 * 超えたら先頭だけ読む。13MB 級なのは親ログのほうで、そちらは readAll が今日すでに丸読みしている
 */
const SUBAGENT_MAX_BYTES = 4 * 1024 * 1024;

/** 名前の前後。両方を条件にするのは、将来 subagents/ に別の種類が増えても拾わないため。 */
const PREFIX = 'agent-';
const SUFFIX = '.jsonl';

/**
 * .meta.json から読むキー。
 *
 * 実測148件で agentType / description / toolUseId / spawnDepth の4つは常にあり、
 * model は22件、parentAgentId は4件だけだった。任意キーとして扱う
 * （入れ子でも parentAgentId が書かれないことがあるので、無いことを根拠に深さを決めない）
 */
function pickMeta(json) {
  if (!json || typeof json !== 'object') return {};
  return {
    agentType: typeof json.agentType === 'string' ? json.agentType : null,
    description: typeof json.description === 'string' ? json.description : null,
    toolUseId: typeof json.toolUseId === 'string' ? json.toolUseId : null,
    spawnDepth: typeof json.spawnDepth === 'number' ? json.spawnDepth : null,
    model: typeof json.model === 'string' ? json.model : null,
    parentAgentId: typeof json.parentAgentId === 'string' ? json.parentAgentId : null,
  };
}

/**
 * そのセッションのサブエージェント記録を数え上げる。
 *
 * 読むのは `<セッションID>/subagents/` 直下だけ。非再帰。
 * 同じ階層にある memory/ と tool-results/ には触らない。
 *
 * **memo を掛けない。** 印に使えるのはディレクトリの mtime だが、NTFS は
 * ファイルが増えたときは変わるのに、既存ファイルが太ったときは変わらない。
 * 走っているサブエージェントの size が固まって、表示が伸びなくなる。
 * コストは readdir 1回 ＋ stat 最大20 ＋ 150バイトの read 最大20。
 * 同じ経路の indexTranscripts が毎回およそ290回 stat しているので誤差の範囲。
 * staleness のバグを買うより、40回の syscall を払うほうが安い。
 *
 * @param {string|null} transcriptFile 親ログの実パス
 * @param {string} sessionId セッションID
 * @returns {Promise<{refs: Array<object>, readError: string|null}>} 無ければ空配列
 */
export async function listSubagents(transcriptFile, sessionId) {
  if (!transcriptFile || !sessionId) return { refs: [], readError: null };

  const dir = path.join(path.dirname(transcriptFile), sessionId, 'subagents');
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    // 1件もサブエージェントを使っていないセッションではディレクトリ自体が無い。
    // それは「読めなかった」ではないので、断り書きを出さずに空で返す
    if (err?.code === 'ENOENT') return { refs: [], readError: null };
    return { refs: [], readError: String(err?.message ?? err) };
  }

  const refs = [];
  for (const name of names) {
    if (!name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) continue;
    const file = path.join(dir, name);

    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const agentId = name.slice(PREFIX.length, -SUFFIX.length);
    if (!agentId) continue;

    // メタは無くても行は出す（ログさえあれば「開く」は成り立つ）
    let meta = {};
    try {
      meta = pickMeta(JSON.parse(await fs.readFile(`${file.slice(0, -SUFFIX.length)}.meta.json`, 'utf8')));
    } catch {
      meta = pickMeta(null);
    }

    refs.push({ agentId, file, size: stat.size, mtimeMs: stat.mtimeMs, ...meta });
  }

  return { refs, readError: null };
}

/**
 * サブエージェントのログを読む。
 *
 * 大きいものは先頭だけにする。末尾ではなく先頭を選ぶ理由は readHead の JSDoc にある。
 *
 * @param {object} ref listSubagents が返した1件
 * @returns {Promise<{entries: Array, parseErrors: number, truncated: boolean, size: number, mtimeMs: number}>}
 */
export async function readSubagentLog(ref) {
  if (!ref?.file) return { entries: [], parseErrors: 0, truncated: false, size: 0, mtimeMs: 0 };
  if (ref.size > SUBAGENT_MAX_BYTES) return readHead(ref.file, SUBAGENT_MAX_BYTES);
  const log = await readAll(ref.file);
  return { ...log, truncated: false };
}
