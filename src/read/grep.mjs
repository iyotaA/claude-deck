/**
 * 会話ログの本文を探す。**索引を持たない。そのつど舐める。**
 *
 * ## なぜ要るか
 *
 * 書庫の検索が見ていたのは `sessionId` / `projectDir` / `title` / `cwd` の4つだけで、
 * 「中身も探す」を押しても読む範囲は末尾 64KB のまま（タイトルを埋めるだけ）だった。
 * **本文は1文字も検索対象になっていなかった。**
 *
 * このアプリの目的の1つは「そのセッションで自分が何を判断したか」を辿ることなので、
 * 探す動線がタイトル頼みだと、いちばん要る場面で使えない。
 *
 * ## なぜ索引を作らないか
 *
 * スキルの索引（`skills.mjs`）と同じ形にもできるが、あちらは
 * 「いつ作り直すか」という問題を抱えている（起動時に1回きりで、
 * 起動後に生まれたセッションが絞り込みに出ない、という不具合を実際に踏んだ）。
 *
 * 本文の索引はスキル名より遥かに大きく、鮮度の問題も同じだけ抱える。
 * **逐次で舐めれば、いまディスクにあるものをそのまま見る**ので、鮮度の話が消える。
 * 遅ければあとから索引を足せる ―― 窓口の形を先に決めておけば、画面は触らずに済む。
 *
 * ## 速さの根拠
 *
 * 全行を `JSON.parse` しない。**検索語そのものを前フィルタに使う。**
 * 会話ログの日本語は生の UTF-8 で入っている（`\u` エスケープではない。実測）ので、
 * 素の `includes` がそのまま効く。
 *
 * `skills.mjs` の同じ機構で 1MB あたり 10ms、全 445 本 614MB を 6.1 秒（実測）。
 * あちらの前フィルタ（`"Skill"`）より検索語のほうが当たりにくいので、これより速い。
 */
import { createReadStream } from 'node:fs';
import readline from 'node:readline';

import { oneLine } from '../shared/text.mjs';

/** 1本のログから拾う抜き書きの数。これ以上あっても読まない。 */
export const HITS_PER_LOG = 3;

/** 抜き書き1つの長さ。 */
const SNIPPET_MAX = 160;

/**
 * 行から人が読む文字列を取り出す。
 *
 * **`JSON.parse` した結果から拾う。** 生の行をそのまま出すと、
 * `uuid` や `requestId` やツールの引数まで混ざって読めない。
 *
 * 見るのは3つだけ ―― ユーザーの指示・Claude の言葉・プランの本文。
 * ツール結果（`toolUseResult`）は数MBになることがあり、
 * そこに当たっても「どこで当たったか」の役に立たない。
 *
 * @param {object} entry パース済みの1行
 * @returns {string|null} 読ませる文字列。無ければ null
 */
export function readableOf(entry) {
  const content = entry?.message?.content;

  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;

  const parts = [];
  for (const c of content) {
    if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    // プランは承認を求めている本文そのもの。**いちばん探したいものが入る**
    else if (c?.type === 'tool_use' && c?.name === 'ExitPlanMode' && typeof c.input?.plan === 'string') {
      parts.push(c.input.plan);
    }
  }
  return parts.length ? parts.join('\n') : null;
}

/**
 * 当たった場所の前後を抜き書きにする。
 *
 * **判断だけ。純関数。** 当たりの位置から前後を切って、1行に潰す。
 *
 * @param {string} text 本文
 * @param {string} needle 探した語（小文字化済み）
 * @param {number} max 抜き書きの長さ
 * @returns {string|null} 当たらなければ null
 */
export function snippetOf(text, needle, max = SNIPPET_MAX) {
  if (typeof text !== 'string' || !needle) return null;
  const at = text.toLowerCase().indexOf(needle);
  if (at === -1) return null;

  // 当たりを真ん中あたりに置く。前を少し多めに取ると、文の途中から始まりにくい
  const before = Math.floor((max - needle.length) / 3);
  const from = Math.max(0, at - before);
  const cut = text.slice(from, from + max);
  const head = from > 0 ? '…' : '';
  const tail = from + max < text.length ? '…' : '';
  const flat = oneLine(cut, max);
  return flat ? `${head}${flat}${tail}` : null;
}

/**
 * ログ1本を舐めて、当たった抜き書きを返す。
 *
 * **投げない。** 消えた・読めないログは「当たらなかった」として扱う
 * （検索の途中で1本読めないだけで、結果ごと落とすほうが困る）。
 *
 * @param {string} file 会話ログの絶対パス
 * @param {string} needle 探す語。**小文字にして渡すこと**
 * @param {{max?: number}} [opts] max: 拾う抜き書きの数
 * @returns {Promise<{hits: string[], scanned: boolean}>} scanned: 最後まで読めたか
 */
export async function grepTranscript(file, needle, { max = HITS_PER_LOG } = {}) {
  const hits = [];
  if (!needle) return { hits, scanned: false };

  let rl = null;
  let scanned = false;
  try {
    rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      // **前フィルタ。** ここで大半の行が落ちるので `JSON.parse` まで届かない。
      // 大文字小文字を無視するため、行のほうも小文字にしてから見る
      // （`toLowerCase()` は文字列を1本作るが、`JSON.parse` よりずっと安い）
      if (!line.toLowerCase().includes(needle)) continue;

      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; /* 書き込み途中の行。飛ばして進む */
      }

      const text = readableOf(entry);
      const snip = snippetOf(text, needle);
      // **本文に無ければ数えない。** 前フィルタは行そのものを見ているので、
      // `uuid` や置き場所のパスに当たっただけの行がここへ来る
      if (!snip) continue;

      hits.push(snip);
      if (hits.length >= max) break;
    }
    scanned = true;
  } catch {
    /* 消えた・読めない。当たらなかったものとして扱う */
  } finally {
    rl?.close();
  }
  return { hits, scanned };
}
