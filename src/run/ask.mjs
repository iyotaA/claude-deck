/**
 * 許可要求カードの組み立て。
 *
 * CLI が `can_use_tool` で聞いてきたものを、画面に出せる形へ畳む。
 * 逆向き（選んだ札から `updatedInput` を組む）もここ。
 *
 * **状態を1バイトも触らない純粋な変換。** もとは `run/ledger.mjs` に同居していたが、
 * あちらは「いつ状態が変わるか」を決める器で、こちらは「どう見せるか」だけを決める。
 * データの向きも寿命も違うので分けた。
 *
 * 分けたことで `buildQuestionInput` の export が自然になった
 * （前は「テストのため」だけの理由で外に出ていた）。
 *
 * 呼ぶのは `ledger.mjs` の2箇所だけ ―― 要求を受け取ったとき（`takeAsk`）と、
 * 答えを組むとき（`answer`）。
 */
import { clip, oneLine } from '../shared/text.mjs';
import { isPlainObject } from '../shared/objects.mjs';

/** 要求カードに載せる本文の上限。プランの全文がここに入る。 */
export const ASK_BODY_MAX = 8000;

/** 本文の中の値1つぶんの上限。これが無いと `Write` の `content` だけで枠を使い切る。 */
const ASK_VALUE_MAX = 3000;

/** 質問文の上限。`askBody`（文字列に畳む側）と `askQuestions`（機械が読む側）で同じ値を使う。 */
const ASK_Q_MAX = 200;

/** 選択肢の札の上限。質問の見出し（`header`）にも同じ長さを使う。 */
const ASK_LABEL_MAX = 120;

/** 選択肢の説明の上限。 */
const ASK_DESC_MAX = 200;

/**
 * 行に載せる質問と選択肢の件数の上限。
 *
 * 実測では質問2件・選択肢3件が普通だが、上限が無いと
 * 向こうが何件返してきても行が太る。**画面が描ける量で切る。**
 */
const ASK_QUESTIONS_MAX = 8;

/** 同上、1問あたりの選択肢の件数。 */
const ASK_OPTIONS_MAX = 12;

/**
 * 選んだ答え1つぶんの上限。
 *
 * **超えたら切らずに断る。** 切ると、人が書いた自由記述が黙って途中で終わった形で
 * Claude へ渡ることになる。長い指示は `/input` で送るほうが正しい。
 */
const ASK_ANSWER_MAX = 2000;

/**
 * JSON にできないものが来ても落ちない `JSON.stringify`。
 *
 * 読んでいるのは Claude Code の内部データなので、想定した形が来るとは限らない。
 *
 * @param {*} v 何か
 * @returns {string|null} 文字にできなければ null
 */
function safeJson(v) {
  try {
    const s = JSON.stringify(v);
    return typeof s === 'string' ? s : null;
  } catch {
    return null;
  }
}

/**
 * 要求カードに出す本文を組む。
 *
 * 段としてはここで**文字列1本に畳む。** 選択肢を機械が読む形は後で足す。
 * 畳まずに置くと、`Write` の `content`（数MBになりうる）が行に載って、
 * 一覧の押し出しのたびに JSON へ焼かれることになる。
 *
 * @param {string|null} toolName ツール名
 * @param {object|null} input CLI が渡してきた引数の原文
 * @returns {string|null} 出すものが無ければ null
 */
export function askBody(toolName, input) {
  if (!isPlainObject(input)) return null;

  // プランは本文そのものが読みたいもの。Markdown のまま渡す（画面が mdView で描く）
  if (toolName === 'ExitPlanMode') return clip(input.plan, ASK_BODY_MAX);

  if (toolName === 'AskUserQuestion') {
    const lines = [];
    for (const q of Array.isArray(input.questions) ? input.questions : []) {
      const head = oneLine(q?.question, ASK_Q_MAX);
      if (head) lines.push(head);
      for (const o of Array.isArray(q?.options) ? q.options : []) {
        const label = oneLine(o?.label, ASK_LABEL_MAX);
        if (!label) continue;
        const desc = oneLine(o?.description, ASK_DESC_MAX);
        lines.push(desc ? `  - ${label} — ${desc}` : `  - ${label}`);
      }
    }
    if (lines.length > 0) return clip(lines.join('\n'), ASK_BODY_MAX);
    // 読めなければ下の「キー: 値」へ落とす。**null で返さない。**
    // 版が変わって形が違ったときに、何を訊かれているのか一切見えなくなる
  }

  // 知らないツールは引数を「キー: 値」で並べる。
  // **1つの値に枠を使い切らせない。** `content` が先頭に来ると `file_path` が見えなくなる
  const parts = [];
  for (const [k, v] of Object.entries(input)) {
    const val = clip(typeof v === 'string' ? v : safeJson(v), ASK_VALUE_MAX);
    if (val) parts.push(`${k}: ${val}`);
  }
  return parts.length > 0 ? clip(parts.join('\n\n'), ASK_BODY_MAX) : null;
}

/**
 * 質問を、画面が選択肢として組み直せる形にする。
 *
 * `askBody` が文字列1本に畳むのに対し、こちらは**機械が読む形**を返す。
 * 画面がラジオとチェックボックスを組むのに要る。
 * 両方を行に載せると同じ中身を2回持つことになるので、
 * **これが組めたときは `body` を持たない**（`takeAsk` がそう分ける）。
 *
 * ## 鍵は質問文ではなく番号
 *
 * 答えは `{番号: 選んだ札}` で受け取る。質問文を鍵にしない理由は2つ。
 *
 * - ここで質問文を `ASK_Q_MAX` で**切っている。** 切った文字列を鍵にすると、
 *   200字を超える質問では画面が送ってきた鍵が原文と一致せず、
 *   何を選んでも「答えていない質問があります」で永久に詰まる
 * - 同じ質問文が2件来たときに鍵が潰れる
 *
 * 番号は `input.questions` の添字そのもの。**質問文が空のものを落とすと添字がずれる**ので、
 * 落とした後の並び順ではなく元の添字を `key` として持ち回る。
 *
 * @param {object|null} input `AskUserQuestion` への引数の原文
 * @returns {Array<object>|null} 組めなければ null
 */
export function askQuestions(input) {
  const src = Array.isArray(input?.questions) ? input.questions : [];
  const out = [];

  for (let i = 0; i < src.length && i < ASK_QUESTIONS_MAX; i += 1) {
    const q = src[i];
    // 質問文が空のものは落とす。答えの辞書はこれを鍵にするので、
    // 鍵にできないものを載せると、画面で選べても答えが組めない
    const question = oneLine(q?.question, ASK_Q_MAX);
    if (!question) continue;

    const options = [];
    const opts = Array.isArray(q?.options) ? q.options : [];
    for (let j = 0; j < opts.length && j < ASK_OPTIONS_MAX; j += 1) {
      const label = oneLine(opts[j]?.label, ASK_LABEL_MAX);
      if (!label) continue;
      // 説明は無いことがある。null のまま持つ（空文字に丸めない）
      options.push({ label, description: oneLine(opts[j]?.description, ASK_DESC_MAX) });
    }

    out.push({
      key: i,
      question,
      header: oneLine(q?.header, ASK_LABEL_MAX),
      multiSelect: q?.multiSelect === true,
      options,
    });
  }

  return out.length > 0 ? out : null;
}

/**
 * 選んだ札を、重複を落とした並びにする。
 *
 * 文字列でも配列でも受ける。**文字列は分割しない**（札そのものに `', '` が
 * 入っていると壊れる）。読む側の `normalizeAnswer`（`parse/digest/answers.mjs`）と
 * 同じ吸収を、逆向きにやっている。
 *
 * @param {unknown} raw 画面から来た値
 * @returns {Array<string>} 空なら空配列
 */
function pickLabels(raw) {
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const v of list) {
    const s = typeof v === 'string' ? v.trim() : '';
    // 同じ札が2回来ても1回にする
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * 選んだ内容から、`AskUserQuestion` に返す `updatedInput` を組む。
 *
 * **台帳の外へ export しているのはテストのため。** 質問と選択肢の対応の検証が
 * いちばん間違えやすく、状態機械を動かさずに全分岐を通したい。
 *
 * 複数選択は `', '` 連結の文字列に倒す。読む側（`parse/digest/answers.mjs`）に
 * 「実測3本すべて `', '` 連結の文字列で、配列は0件」という記録があるので、
 * **書く側もそれに合わせる。** 形を2つにすると、自分で書いたログを自分で読めなくなる。
 *
 * ## 札が選択肢に無くても断らない
 *
 * 画面には「その他（自分で書く）」がある。読む側も
 * `freeText`（どの選択肢にも合わなかった答え）を一人前の値として扱っている。
 * だから**選択肢との照合はしない。** ここで弾くと自由記述の道が塞がる。
 *
 * @param {object} pending 未応答の要求1件（`input` と `questions` を持つ）
 * @param {unknown} choices 画面から来た `{番号: 札 | [札…]}`
 * @returns {{ok:boolean, reason?:string, updatedInput?:object}}
 */
export function buildQuestionInput(pending, choices) {
  const input = pending?.input;
  const src = Array.isArray(input?.questions) ? input.questions : null;
  if (!src || src.length === 0) return { ok: false, reason: 'この要求は選択肢では答えられません' };
  if (!isPlainObject(choices)) {
    return { ok: false, reason: '選んだ内容が読めません' };
  }

  const asked = Array.isArray(pending.questions) ? pending.questions : [];
  if (asked.length === 0) return { ok: false, reason: 'この要求は選択肢では答えられません' };

  const answers = {};
  for (const q of asked) {
    // 辞書の鍵は**原文の質問文。** 画面へ出したものは切ってあるので使えない
    const orig = src[q.key];
    const key = typeof orig?.question === 'string' ? orig.question : '';
    if (!key) return { ok: false, reason: '質問文が読めないものが混ざっています' };

    const picked = pickLabels(choices[q.key]);
    if (picked.length === 0) {
      return { ok: false, reason: `答えていない質問があります（${oneLine(q.question, 60)}）` };
    }
    if (!q.multiSelect && picked.length > 1) {
      return { ok: false, reason: `1つだけ選ぶ質問です（${oneLine(q.question, 60)}）` };
    }

    const value = picked.join(', ');
    if (value.length > ASK_ANSWER_MAX) {
      return {
        ok: false,
        reason: `答えが長すぎます（${ASK_ANSWER_MAX} 文字まで。長いものは指示として送ってください）`,
      };
    }
    answers[key] = value;
  }

  // 知らないキーは足さない。**原文をそのまま広げる**ので、
  // `questions` 以外の項目が増えた版でも落とさずに返せる
  return { ok: true, updatedInput: { ...input, answers } };
}

/**
 * 「今後も許可」で撃つモードを、CLI が付けてきた助言から拾う。
 *
 * 実測（2026-08-25・claude 2.1.243）で `Write` の要求に付いてきた形はこれ。
 *
 * ```json
 * [{"type":"setMode","mode":"acceptEdits","destination":"session"}]
 * ```
 *
 * **`destination` が `session` のものだけ拾う。** 設定ファイルへ書く行き先が来た日に
 * そのまま通すと、`~/.claude` 配下へ書き込まない約束を破ることになる。
 * 助言が無いツールもある（`ExitPlanMode` には付かなかった）ので、
 * 取れなければ null。**0 と不明を分けるのと同じで、無いものを既定値で埋めない。**
 *
 * @param {*} suggestions `permission_suggestions` の中身
 * @returns {string|null} 撃つモード。無ければ null
 */
export function suggestModeOf(suggestions) {
  if (!Array.isArray(suggestions)) return null;
  for (const s of suggestions) {
    if (s?.type !== 'setMode' || s?.destination !== 'session') continue;
    if (typeof s.mode === 'string' && s.mode) return s.mode;
  }
  return null;
}

/**
 * 何を聞かれているのかを、速報の文に使う語にする。
 *
 * @param {string} kind `askKindOf` の戻り
 * @param {string|null} tool ツール名
 * @returns {string} 「プラン」「質問」「Bash」
 */
export function askWhat(kind, tool) {
  if (kind === 'plan') return 'プラン';
  if (kind === 'question') return '質問';
  return tool ?? 'ツール';
}

/**
 * 未応答の要求を、一覧の行に載せる形にする。
 *
 * **`input`（原文）を落とす。** 行は押し出しのたびに JSON へ焼かれるので、
 * 質問の原文まで載せると毎回そのぶんを文字列化することになる。
 * 原文が要るのは答えを組むときだけで、それは台帳の中で済む。
 *
 * @param {object} p pending の1件
 * @returns {object} 画面へ出す形
 */
export function askRow(p) {
  return {
    id: p.id,
    kind: p.kind,
    tool: p.tool,
    detail: p.detail,
    // `body` と `questions` は**どちらか片方だけ入る。** 同じ中身を2回載せない
    body: p.body,
    questions: p.questions,
    suggestMode: p.suggestMode,
    at: p.at,
  };
}
