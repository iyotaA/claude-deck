/**
 * ツール呼び出しを一行で説明する。
 *
 * 「何をしようとしたのか」が分かればよい。引数の全体を見せる場所ではない。
 *
 * もとは state.mjs（一覧の「何を待っているか」）と digest.mjs（詳細の時系列）に
 * 別実装があり、Bash の優先順まで食い違っていた。同じものを2つ持つ理由が無いのでまとめた。
 *
 * まとめるときに揃えた2点:
 *
 *  - Bash / PowerShell は description を優先する。
 *    どちらも人が読むための一行で、description があるならそれが一番分かりやすい。
 *    無ければ command に落ちるので、表示が消えることはない
 *  - Skill の引数は括弧で囲む。スキル名との境目が分かるようにするため
 */
import { oneLine } from './text.mjs';

/** 一行説明の長さの上限。これ以上あっても読まないため。 */
export const MAX_DETAIL = 400;

/**
 * 長く走ってもおかしくないツール。
 *
 * 入れる基準は「**長さがツール自身では決まらないもの**」だけ。
 * 外のコマンド・ネットワーク・別のエージェントに時間を握られているものが対象で、
 * 「たまに遅い」を理由に足していくとリストが判定の役に立たなくなる。
 *
 * 実測（上位10ログ・7,432往復）。
 *
 * | 群 | n | ≥15s | ≥60s |
 * |---|---|---|---|
 * | ここに入っているもの | 3,798 | 258 | 59 |
 * | 入っていないもの | 3,608 | 43 | **0** |
 *
 * 入れなかったもの。数字だけ残しておく（次に足す候補の順になる）。
 *
 *  - `Grep` … 596件中19件が15秒超・最大27秒。入れれば短い側の15秒超が 43 → 24 に減る
 *  - `ToolSearch` … 最大8秒
 *  - `Skill` … 最大1.8秒
 *  - `TaskCreate` / `TaskUpdate` / `TaskStop` … p90 < 300ms。だから `Task*` を前置で拾わない
 *
 * `Monitor` は実測3件と薄いが、条件が満たされるまで待つ道具なので入れてある。
 */
export const LONG_RUNNING_TOOLS = new Set([
  'Bash', 'PowerShell', 'Task', 'Agent', 'TaskOutput', 'WebSearch', 'WebFetch', 'Monitor',
]);

/**
 * そのツールは長く走ってもおかしくないか。
 *
 * `mcp__` は前置で拾う。名前をこちらが知らないまま増えるうえ、
 * 全部が別プロセスかネットワーク越しなので、個別に測る意味が無い。
 *
 * @param {string|null} name ツール名
 */
export function isLongRunningTool(name) {
  if (typeof name !== 'string') return false;
  return LONG_RUNNING_TOOLS.has(name) || name.startsWith('mcp__');
}

/**
 * @param {string} name ツール名
 * @param {object|null} input そのツールへの入力
 * @param {number} max 説明の最大の長さ
 * @returns {string|null} 説明できる材料が無ければ null
 */
export function describeTool(name, input, max = MAX_DETAIL) {
  const it = input ?? {};
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return oneLine(it.description || it.command, max);
    case 'Edit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
      return oneLine(it.file_path, max);
    case 'Grep':
      return oneLine(it.pattern ? `${it.pattern}${it.path ? ` in ${it.path}` : ''}` : null, max);
    case 'Glob':
      return oneLine(it.pattern, max);
    case 'Skill':
      return oneLine(it.skill ? `${it.skill}${it.args ? ` (${it.args})` : ''}` : null, max);
    case 'Agent':
    case 'Task':
      return oneLine(it.description, max);
    case 'AskUserQuestion': {
      // 何を聞かれて止まっているのかが知りたい情報。1問目だけで足りる
      const q = Array.isArray(it.questions) ? it.questions[0] : null;
      return oneLine(q?.question, max);
    }
    case 'ExitPlanMode':
      // 入力は {plan} だけ。既定の枝は description / file_path / command / url を見るので
      // すべて undefined になり、プラン承認待ちの「何を待っているか」が空だった
      return oneLine(it.plan, max);
    case 'WebFetch':
      return oneLine(it.url, max);
    default:
      return oneLine(it.description || it.file_path || it.command || it.url, max);
  }
}
