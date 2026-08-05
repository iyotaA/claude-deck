/**
 * 「あなたが何を選んだか」をログから引く。
 *
 * このアプリの目的の半分がここに乗っている。選んだラベルと、その選択肢の説明を残せれば、
 * あとから読み返したときに判断の理由がそのまま出る。
 *
 * 実測で分かった大事な形（公開仕様が無いので、このコメントが唯一の記録になる）:
 *
 *  AskUserQuestion の「選んだ答え」の出どころは2つあり、どちらも実在する。
 *
 *   1. toolUseResult.answers … {質問文: 選んだラベル} の辞書。素直に引ける
 *   2. tool_result の本文 … 次の形で埋まっている
 *
 *      Your questions have been answered: "質問"="選んだラベル" selected preview:
 *      …（選択肢のプレビュー本文）…
 *      , "質問2"="選んだラベル2". You can now continue with these answers in mind.
 *
 *  手元のログで数えると 1 は 65 回、2 は 134 回。
 *  つまり半分近くは answers を持たない古い版なので、本文からの抽出は
 *  「念のため」ではなく必須の経路になる。1 を優先し、無ければ 2 に落とす。
 *
 *  2 の経路は質問文を鍵に該当位置だけを読む（本文はプレビューが挟まって崩れているので
 *  全体をパースできない）。この鍵の作り方には弱点があり、質問文に " が含まれると引けない。
 *  1 を先に見る理由がこれ。
 *
 *  引けたラベルを options[].label と照合すれば、その選択肢の description まで出せる。
 *  description は「その選択が何を意味していたか」の説明なので、
 *  あとから読み返したときに判断の理由がそのまま残る。
 *
 *  複数選択（multiSelect: true）の値も数えた。実測3本すべて ", " 連結の文字列で、
 *  配列は0件。将来配列に変わっても読めるように normalizeAnswer で吸収する。
 *
 * 却下に添えたコメントの取り出し（denialNote）も同じ性格の仕事なので、ここに置く。
 * どちらも「あなたが何を言ったか」を機械的な定型文の中から拾う処理。
 */
import { clip, oneLine } from '../../shared/text.mjs';
import { LIMIT } from './limits.mjs';

/**
 * 却下されたときに機械的に入る英文。
 *
 * 中身は毎回同じで読む価値がないのに長いため、時系列を埋めてしまう。
 * 取り除いて、あとに何か残ればそれだけを出す（自分が添えたコメントがそこに来る）。
 */
const DENIAL_NOISE = [
  /The user doesn't want to proceed with this tool use\./g,
  /The tool use was rejected \([^)]*\)\./g,
  /STOP what you are doing and wait for the user to tell you how to proceed\./g,
  /Note: The user's next message may contain a correction or preference\.[\s\S]*?future sessions\./g,
  /The user doesn't want to take this action right now\./g,
  /Permission (?:for this action was denied|to use \S+ was denied)[^.]*\./g,
  /Tool use was rejected[^.]*\./g,
];

/**
 * 却下に添えたコメントだけを取り出す。
 *
 * oneLine ではなく clip を使う。ここは「なぜ止めたか」を自分の言葉で書いた場所なので、
 * 箇条書きや行分けに意味がある。受け側は white-space: pre-wrap で出す
 *
 * @param {unknown} text tool_result の本文
 */
export function denialNote(text) {
  let t = typeof text === 'string' ? text : '';
  for (const re of DENIAL_NOISE) t = t.replace(re, '');
  return clip(t, LIMIT.feedback);
}

/**
 * 選んだ答えを1つの文字列に寄せる。
 *
 * 実測では複数選択でも ", " 連結の文字列で来る（配列は0件）。
 * 将来配列に変わっても読めるように、ここで配列を吸収しておく。
 * 逆に文字列は分割しない。ラベル自体に ", " が入っていると壊れるため
 *
 * @param {unknown} raw ログから読んだ生の値
 * @returns {string|null} 空なら null
 */
function normalizeAnswer(raw) {
  if (typeof raw === 'string') return raw.trim() || null;
  if (Array.isArray(raw)) {
    const parts = raw.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  }
  return null;
}

/**
 * tool_result の本文から、その質問の答えを引く（古い版のログ用の経路）。
 *
 * @param {string} question 質問文。これが鍵になる
 * @param {string} text tool_result の本文
 * @returns {string|null} 引けなければ null
 */
function chosenFromText(question, text) {
  if (!question || typeof text !== 'string') return null;
  const needle = `"${question}"="`;
  const at = text.indexOf(needle);
  if (at === -1) return null;
  const rest = text.slice(at + needle.length);
  const end = rest.indexOf('"');
  return normalizeAnswer(end === -1 ? rest.slice(0, 300) : rest.slice(0, end));
}

/**
 * 質問ごとに「何を選んだか」と「その選択肢の説明」を組む。
 *
 * @param {object} input AskUserQuestion への入力（質問と選択肢の控え）
 * @param {object|null} result 対応する tool_result（未回答なら null）
 * @returns {Array} 質問と同じ順の配列
 */
export function pickAnswers(input, result) {
  const text = typeof result?.text === 'string' ? result.text : '';
  const dict = result?.structured?.answers;
  const hasDict = Boolean(dict) && typeof dict === 'object' && !Array.isArray(dict);
  const out = [];

  for (const q of input?.questions ?? []) {
    const question = typeof q?.question === 'string' ? q.question : '';
    const options = Array.isArray(q?.options) ? q.options : [];

    // 辞書が第一候補。質問文に " が入っていても引ける
    const chosen = (hasDict ? normalizeAnswer(dict[question]) : null)
      ?? chosenFromText(question, text);

    // 選択肢のラベルと突き合わせる。合えばその description が判断の根拠になる。
    // 「Other」で自由入力した場合はどれにも合わないので、そのまま文字列として残す。
    // 含有判定にしているのは複数選択のため。", " 連結の文字列でも複数件が自然に当たる
    const picked = options.filter((o) => chosen && typeof o?.label === 'string'
      && (chosen === o.label || chosen.includes(o.label)));

    out.push({
      question,
      header: typeof q?.header === 'string' ? q.header : null,
      multiSelect: q?.multiSelect === true,
      chosen,
      // preview は大きいので落とす。label と description だけ持つ。
      // description は切らない。選んだ理由そのものなので改行ごと残す
      chosenOptions: picked.map((o) => ({ label: o.label, description: o.description ?? null })),
      freeText: Boolean(chosen) && picked.length === 0,
      otherOptions: options
        .filter((o) => !picked.includes(o))
        .map((o) => ({ label: o.label ?? '', description: oneLine(o.description, 200) })),
    });
  }

  return out;
}
