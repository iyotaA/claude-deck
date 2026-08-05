/**
 * 承認したプランのファイルを読む。
 *
 * 会話ログには「そのとき提出した本文」が入っているが、ファイルは別に残っていて
 * あとから書き換わりうる。ここは「いまディスクに何が書かれているか」を取る役。
 *
 * 開くパスはログに書かれていた文字列＝外部入力なので、必ず plans ディレクトリの
 * 中を指していることを確かめてから開く。
 * 判断（純関数）と I/O（薄い殻）を分けてあるので、検証の側だけテストできる。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { plansDir } from './paths.mjs';

/**
 * プランファイルの上限。
 *
 * 実測した最大は 14,170 バイト。256KB あれば十分に余裕がある。
 * 上限を置くのは、間違って巨大なファイルを指されたときに画面が固まらないようにするため
 */
const MAX_BYTES = 256 * 1024;

/**
 * ログに書かれていたパスが plans ディレクトリの中を指しているか確かめる。
 *
 * server.mjs の静的配信も同じことをしているが、あちらは startsWith で比べている。
 * ここではそれが使えない。filePath はログが書いた文字列で、ドライブレターが
 * `c:` と `C:` で揺れうる。Windows は大文字小文字を区別しないので、
 * startsWith だと正しいパスまで弾いてしまう。
 * path.relative は win32 実装が大小を無視して比較するのでこちらを使う。
 *
 * fs を触らない純関数なのでテストできる。
 *
 * @param {string} filePath ログから拾ったパス
 * @param {string} [root] 許す範囲。既定は ~/.claude/plans
 * @returns {string|null} 絶対パス。範囲外・.md 以外・値が無ければ null
 */
export function resolvePlanPath(filePath, root = plansDir) {
  if (typeof filePath !== 'string' || !filePath.trim()) return null;

  let target;
  try {
    target = path.resolve(filePath.trim());
  } catch {
    return null;
  }

  const rel = path.relative(root, target);
  // 空（root 自身）・上へ出る・別ドライブ（relative が絶対パスを返す）はすべて外
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (path.extname(target).toLowerCase() !== '.md') return null;
  return target;
}

/**
 * プランファイルの中身と更新時刻を読む。
 *
 * 落ちない。無い・大きすぎる・読めないは、それぞれ理由を添えた形で返す。
 * プランの系譜が出ないだけで、詳細ビュー全体は読めるままにする。
 *
 * @param {string} filePath ログから拾ったパス
 * @param {object} [opts]
 * @param {string} [opts.root] 許す範囲。テストから差し替える口
 * @returns {Promise<{text: string|null, chars: number|null, mtimeMs: number|null, size: number|null, reason: string|null}>}
 */
export async function readPlanFile(filePath, { root = plansDir } = {}) {
  const miss = (reason) => ({ text: null, chars: null, mtimeMs: null, size: null, reason });

  const target = resolvePlanPath(filePath, root);
  if (!target) return miss('outside');

  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    return miss('missing');
  }
  // ディレクトリを指されても開かない
  if (!stat.isFile()) return miss('missing');
  if (stat.size > MAX_BYTES) {
    return { text: null, chars: null, mtimeMs: stat.mtimeMs, size: stat.size, reason: 'too-large' };
  }

  let text;
  try {
    text = await fs.readFile(target, 'utf8');
  } catch {
    return miss('unreadable');
  }

  return { text, chars: text.length, mtimeMs: stat.mtimeMs, size: stat.size, reason: null };
}
