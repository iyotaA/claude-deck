/**
 * 画面から起こしたセッションの台帳と、状態機械。
 *
 * `notify/watch.mjs` と同じ作り方をしている。**閉じた状態を持つ純関数の器**で、
 * fs も spawn も触らず、**時刻は必ず外から `now` で受ける。**
 * だから「いつ止めるか」「いつ失敗と見なすか」の全分岐を `node:test` で通せる。
 *
 * 実際に子プロセスを起こして殺すのは `run/index.mjs` の仕事。
 * こちらが決めて、あちらが手を動かす。`parseUpdateState`（判断）と
 * `loadUpdateState`（I/O）を分けたのと同じ形。
 *
 * ## 台帳はメモリだけ。ディスクに残さない
 *
 * 子はサーバーの子なので、サーバーが死んだ時点で台帳の意味も消える。
 * 復元を試みると失敗経路（書き込み失敗・壊れた JSON・古い記録の掃除）を3つ増やして、得るものが無い。
 * **被害も残らない。** 会話ログは CLI が `~/.claude/projects/` に書いているので、
 * 再起動後も既存の一覧・書庫・詳細から普通に読め、`--resume` で続けられる。
 *
 * ## 状態
 *
 * ```
 * starting → running → waiting（result が来た＝あなたの番）
 *                   ↘ stalled（STALL_MS 沈黙）
 *                   ↘ needs-permission（許可を聞かれた＝答えるまで1行も進まない）
 * running/waiting/stalled → stopping → stopped
 *                         → failed / done
 * ```
 *
 * `stopping` はプランに無いが足してある。`stopClaude` は最大5秒かかるので、
 * そのあいだ `running` と言うのも `stopped` と言うのも嘘になる。
 *
 * ## 許可待ちを `waiting` に寄せない
 *
 * `waiting` は「1行送れば進む」状態で、`markInput()` がそれを前提に `running` へ戻す。
 * 許可待ちの run に user 行を送っても CLI は `control_response` を待ち続けるので、
 * 寄せると「送ったのに動かない」が起きる——**直したばかりのバグと同じ壊れ方の再生産になる。**
 *
 * `needs-permission` は `isRunOver` にも `isChildDone` にも**入れない。**
 * 子は生きて待っている。畳むと答える先が消える。
 * `tick()` の無音判定の射程も広げない（許可待ちの無音は正常）。代わりに
 * `PERMISSION_TIMEOUT_MS` で測り、過ぎたら**自動で断る。**
 *
 * 質問もプラン承認もツール許可も、状態はこの1つ。**3つに割らない。**
 * 遷移の組み合わせが3倍になって、得られるのは札の文言だけになる。
 * 違いは `pending.kind`（`'plan'|'question'|'tool'`）に持たせ、画面がそれで見出しを変える。
 *
 * ## 行は組まない。意図だけ積む
 *
 * NDJSON を組むのは `parse/stream.mjs`、stdin へ書くのは `run/index.mjs`。
 * こちらは送るべき意図を `outbox` へ積み、`takeOutbox()` で渡すだけにする。
 * **「判断は台帳、手を動かすのは殻」の向きをここでも崩さない。**
 *
 * だから `apply()` や `tick()` の戻り値は今までどおり「積んだ速報の配列」のまま。
 * `{events, outbox}` のような形に変えると、呼ぶ側と既存のテストが総崩れになる。
 *
 * ## 「1ターンで閉じる世界」に最初から備える
 *
 * 実測（claude 2.1.228）では stdin が開いている限り `-p` は終了しなかったが、
 * 版が変われば1往復ごとに閉じる作りになりうる。だから run の身元は
 * **`runId ⟷ sessionId`** に置き、子プロセスは**差し替え可能な部品**として持つ。
 *
 * `waiting` のまま子が終了コード0で閉じたら `done` にせず、
 * **`waiting` のまま `perTurn` を立てる。** 次の入力で `--resume` して起こし直せば、
 * どちらの世界でも画面の見え方は変わらない。
 *
 * ## `rows()` に毎秒動く値を入れない
 *
 * `server.mjs` の `refresh()` は、押し出すかどうかを JSON の文字列比較で決めていて、
 * 除外しているのは `idleMs` と `lastActivityAt` だけ。
 * だから経過時間・受信行数・トークン数のような**毎秒動く値をここに載せると毎秒 push が走る。**
 * それらは `get(runId)`（詳細を開いたときだけ引く側）に置いてある。
 *
 * ## import の向き
 *
 * `run/` は末端の層なので `view/` を import しない（`view/` からも import されない）。
 * ここが見てよいのは同じ層の `run/event.mjs` と、どこからでも使える `shared/`、
 * それに `parse/` の純関数（`stream.mjs` の `sameSessionId`、`state.mjs` の `ballOf`）だけ。
 * ID の比べ方も、どちらのボールかの決め方も自前で書かないのは、
 * **同じ判断を2箇所に置かない**ため。
 */
import { sameSessionId } from '../parse/stream.mjs';
import { ballOf, isBlocking } from '../parse/state.mjs';
import { clip, oneLine, projectNameOf } from '../shared/text.mjs';
import { askKindOf, toRunEvents } from './event.mjs';
import { isPlainObject } from '../shared/objects.mjs';

/**
 * 同時に動かせる本数。
 *
 * 手で開いている対話セッションと同じ機械を食うので、押し間違いで10本立つ形にしない。
 */
export const RUN_MAX = 3;

/** 起動の間隔。連打や再送で二重に起こさないため。 */
export const START_MIN_INTERVAL_MS = 2000;

/**
 * 沈黙したまま「実行中」に見え続けるのを防ぐしきい値。
 *
 * 許可要求で固まる形になっても、これがあれば静かに埋もれない。
 *
 * **これを超えても故障とは限らない。** 実測（2026-08-23）で5回とも圧縮（compact）の最中で、
 * 出来事の間隔が121秒あった。行が届けば `running` に戻るので台帳としては壊れていない。
 * だから延ばすのではなく、**言い方を「無音」に留める**（`quietFor` と `RUN_STATE_LABELS`）。
 * 延ばしても同じ文を遅れて出すだけで、本当に固まったものが埋もれる時間が伸びる。
 */
export const STALL_MS = 120000;

/** 速報を貯めておく件数。溢れたら古いほうから落とし、落とした数を数える。 */
export const EVENT_MAX = 1000;

/** 終わった run を残しておく件数。 */
export const HISTORY_MAX = 20;

/** 理由の文字列の上限。一覧に載る値なので短く保つ。 */
const REASON_MAX = 200;

/**
 * 1本の run が同時に抱えられる未応答の要求の数。
 *
 * 並列のツール呼び出しで複数まとめて来ることがあるので1本では足りない。
 * 超えたぶんは**その場で断る。** 放っておくと向こうが待ち続けて詰まる。
 */
export const PENDING_MAX = 8;

/**
 * 許可の答えを待つ上限。過ぎたら自動で断る。
 *
 * **ブラウザを閉じた・席を外したときの唯一の逃げ道なので消さない。**
 * 無いと、答えられないまま待つ子が残り、画面には「許可待ち」と出続ける。
 *
 * 10分にしてあるのは `STALL_MS`（2分）より十分長く、
 * `notify/` の返信待ち通知（2分）で Slack に気づいて戻ってこられる長さだから。
 */
export const PERMISSION_TIMEOUT_MS = 600000;

/**
 * 子を殺さずに替えられるもの。**キーは run と spec の項目名、`subtype` は要求の名前。**
 *
 * 3つの表（subtype・パラメタ名・日本語）に割らずに1つへまとめてある。
 * 割ると項目を1つ足すときに直す場所が3箇所になり、必ずどれかが漏れる。
 *
 * `params` のキーが項目名と揃っていないのは向こうの都合（実測。
 * `set_permission_mode` は `{mode}`、`set_model` は `{model}`）。だから `key` を持つ。
 *
 * **思考量（`set_max_thinking_tokens`）は入れていない。** 要求そのものは受け付けるが、
 * 画面が持っているのは `--effort` の語（`low`〜`max`）で、あちらが欲しいのはトークン数。
 * 対応表が `claude.exe` から読み取れず、当てずっぽうの数を撃つと
 * **黙って意図しない思考量で走る**（誤りが画面のどこにも出ない）。測れるまで入れない。
 */
export const LIVE_FIELDS = Object.freeze({
  permissionMode: { subtype: 'set_permission_mode', key: 'mode', label: '権限モード' },
  model: { subtype: 'set_model', key: 'model', label: 'モデル' },
});

/**
 * 割り込みが撃てることを CLI が名乗る印。
 *
 * `system/init` の `capabilities` に載る（実測 2.1.245 で
 * `['interrupt_receipt_v1','interrupt_cancel_queued_v1','msg_lifecycle_v1']`）。
 *
 * **名乗っていない（配列に無い）ときだけ断る。名乗り自体が無い（null）ときは撃たせる。**
 * 「不明」を「無い」と読むと、名乗る前の版で使えるはずの割り込みを永久に断ることになる。
 * 撃って通じなければ 10 秒の `liveAckTimeoutMs` が拾うので、詰まったままにはならない。
 */
export const INTERRUPT_CAP = 'interrupt_receipt_v1';

/** 控えている指示ごと取り消せることを名乗る印。名乗っていなければ頼まれても断る。 */
export const CANCEL_QUEUED_CAP = 'interrupt_cancel_queued_v1';

/**
 * 行に載せるスラッシュコマンドの上限。
 *
 * 実測 2.1.245 で 62 個（引き算のあとで 60）。**3倍の余地を取ってある。**
 * 上限を置くのは、この一覧が `rows()` に載る＝走っている本数ぶん SSE のフレームへ入るため。
 * 版が上がって桁が変わった日に、気づかないまま毎フレームが太るのを止める。
 */
export const SLASH_MAX = 200;

/**
 * 「替えました」の答えを待つ上限。過ぎたら控えを捨てる。
 *
 * **過ぎても状態は変えない。** 撃ったのに返事が無いなら、いまどちらで走っているかは
 * こちらには分からない。片方に倒して表示すると、それは推測を事実として出したことになる。
 *
 * 10秒なのは、これが「人を待つ時間」ではなく「相手のプロセスが1行返す時間」だから。
 * 無いと、版が上がって応答を返さなくなった日に画面が永久に「切り替え中」で固まる。
 */
export const LIVE_ACK_TIMEOUT_MS = 10000;

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

/** 状態の日本語。画面側に日本語を持たせないため、ここから配る（`STATE_LABELS` と同じ考え方）。 */
export const RUN_STATE_LABELS = Object.freeze({
  starting: '起動中',
  running: '実行中',
  waiting: 'あなたの番',
  // 見たのは「出力が来ていない」だけ。「応答なし」と書くと、圧縮中の正常な run を故障として報告することになる
  stalled: '無音',
  // **終端ではないし、子も生きている。** 答えるまで1行も進まないだけ。
  // だから下の OVER にも `isChildDone` にも入れない（入れると答える先がその瞬間に消える）
  'needs-permission': '許可待ち',
  // **終端ではない。** 自分で置いた上限に当たっただけで、上げれば同じ会話の続きが打てる。
  // だから下の OVER には入れない（入れると `entry.spec` が捨てられ、続ける道がその瞬間に消える）
  budget: '予算切れ',
  stopping: '停止中',
  switching: '切り替え中',
  stopped: '停止しました',
  failed: '失敗しました',
  done: '終了しました',
});

/**
 * もう動かない状態。ここから戻る道は無い。
 *
 * **「子プロセスがいない」とは別の話。** 予算切れ（`budget`）は子がいないのに終端ではない。
 * 子の有無で分けたいときは `isChildDone()` を見る。
 */
const OVER = new Set(['stopped', 'failed', 'done']);

/**
 * その run はもう終わっているか。
 *
 * `server.mjs` と `run/index.mjs` の両方が見るので export してある。
 * 語の一覧を2箇所に書くと、状態を1つ足したときに片方が古くなる。
 *
 * @param {string} state 状態
 * @returns {boolean}
 */
export function isRunOver(state) {
  return OVER.has(state);
}

/**
 * その run の子プロセスはもういないか。
 *
 * 終端の3つに `budget`（予算切れ）を足したもの。あちらは**終端ではないのに子がいない。**
 * 実測で予算超過ではプロセスが死なないので、殻（`run/index.mjs`）の側から畳む。
 * 畳んだあとも台帳には残り、上限を上げるか、そのまま送れば続きが打てる。
 *
 * 使うのは2箇所。`run/index.mjs` が畳むかどうかを決めるのと、
 * こちらが遅れて届いた行を捨てるのと。**`isRunOver` と混ぜない**
 * （混ぜると、予算切れが終端になるか、終端に届いた行が本文として並ぶかのどちらかになる）。
 *
 * @param {string} state 状態
 * @returns {boolean}
 */
export function isChildDone(state) {
  return OVER.has(state) || state === 'budget';
}

/**
 * 無音の長さを日本語にする。
 *
 * 分で言うのは 60秒以上のときだけ。分に丸めきると、テストが短い `stallMs` を
 * 差したときに「0分」と書くことになる。
 *
 * どちらも切り捨てる。`Math.round` にすると 59.9秒が「60秒」になり、
 * すぐ上の「1分」と2つの言い方が並ぶ。
 *
 * 数でないものが来たら数を書かない（0 と不明を分けるのと同じ扱い）。
 *
 * @param {number} ms 無音の長さ
 * @returns {string} 「2分」「30秒」「しばらく」
 */
export function quietFor(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'しばらく';
  if (ms >= 60000) return `${Math.floor(ms / 60000)}分`;
  return `${Math.max(1, Math.floor(ms / 1000))}秒`;
}

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
function askBody(toolName, input) {
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
function askQuestions(input) {
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
function suggestModeOf(suggestions) {
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
function askWhat(kind, tool) {
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
function askRow(p) {
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

/**
 * 台帳を1つ作る。
 *
 * @param {object} [opts] 上限のたぐい。テストから数値で確かめられるように全部外から渡せる
 * @param {number} [opts.max] 同時に動かせる本数
 * @param {number} [opts.minIntervalMs] 起動の最小間隔
 * @param {number} [opts.stallMs] 沈黙とみなすまで
 * @param {number} [opts.eventMax] 速報を貯める件数
 * @param {number} [opts.historyMax] 終わった run を残す件数
 * @param {number} [opts.pendingMax] 同時に抱えられる未応答の要求の数
 * @param {number} [opts.permissionTimeoutMs] 許可の答えを待つ上限
 * @param {number} [opts.slashMax] 行に載せるスラッシュコマンドの上限
 * @returns {object} 台帳
 */
export function createRunLedger({
  max = RUN_MAX,
  minIntervalMs = START_MIN_INTERVAL_MS,
  stallMs = STALL_MS,
  eventMax = EVENT_MAX,
  historyMax = HISTORY_MAX,
  pendingMax = PENDING_MAX,
  permissionTimeoutMs = PERMISSION_TIMEOUT_MS,
  liveAckTimeoutMs = LIVE_ACK_TIMEOUT_MS,
  slashMax = SLASH_MAX,
} = {}) {
  /** @type {Map<string, object>} runId → run */
  const runs = new Map();
  /** @type {Array<object>} 速報のリングバッファ。**run ごとではなく1本**にしてある */
  const ring = [];
  /**
   * @type {Array<object>} 送るべき意図。**行（NDJSON）にはしない。**
   *
   * 積むのは3種類。
   * `{runId, kind:'permission-response', requestId, decision}`
   * `{runId, kind:'control-error', requestId, message}`
   * `{runId, kind:'control-request', requestId, subtype, params}`
   */
  const outbox = [];

  let runSeq = 0;
  let seq = 0;
  let dropped = 0;
  let lastStartAt = null;

  /**
   * @type {object|null} 直近の枠の使用率。`{fiveHour, sevenDay, resetsAt, at}`
   *
   * **run ではなく台帳が1つだけ持つ。** アカウント共通の値なので、
   * どの実行から届いたかに意味が無い。
   * こうしておくと、その実行が `HISTORY_MAX` を超えて押し出されても数は残る。
   */
  let latestRate = null;

  /**
   * 速報を1件積む。
   *
   * `seq` を**全 run で1本**にしてあるのは、SSE の再開カーソルが1つで済むから。
   * run ごとに振ると、画面が run の数だけカーソルを持つことになる。
   * 各件に `runId` を持たせてあるので、run ごとの単調増加という性質は保たれている。
   *
   * @param {object} run 対象の run
   * @param {object} ev `toRunEvents` が作った出来事
   * @param {number} now 時刻
   * @returns {object} 積んだ記録（seq / at / runId 付き）
   */
  function pushEvent(run, ev, now) {
    const rec = { seq: ++seq, at: now, runId: run.runId, ...ev };
    ring.push(rec);
    run.counts.events += 1;
    while (ring.length > eventMax) {
      ring.shift();
      dropped += 1;
    }
    return rec;
  }

  /**
   * 台帳側から出す1行。状態が変わった理由のように、画面で見えないと困るものだけに使う。
   *
   * `starting → running` のような当たり前の遷移では出さない。
   * 状態そのものはヘッダに出るので、出すと速報がその繰り返しで埋まる。
   *
   * @param {object} run 対象の run
   * @param {string} text 本文
   * @param {number} now 時刻
   * @returns {object} 積んだ記録
   */
  function pushNote(run, text, now) {
    return pushEvent(run, { kind: 'note', text }, now);
  }

  /**
   * その状態のためだけに置いた理由を落とす。
   *
   * 残すと、行が届いて動いているのに一覧の理由が「出力が…止まっています」のままになる。
   * 予算切れも同じで、上限を上げて続けたあとに「予算の上限に達しました」が残ると、
   * **いま止まっている理由**として読まれる。
   *
   * **触るのは `stalled` と `budget` のときだけ。**
   * `waiting` の理由は前の往復の結果の話なので残す。
   *
   * @param {object} run 対象の run
   * @returns {void}
   */
  function clearStateReason(run) {
    if (run.state === 'stalled' || run.state === 'budget') run.reason = null;
  }

  /**
   * 断る意図を1件積む。
   *
   * @param {object} run 対象の run
   * @param {string} requestId どの要求へ
   * @param {string} message 理由
   * @returns {void}
   */
  function queueDeny(run, requestId, message) {
    outbox.push({
      runId: run.runId,
      kind: 'permission-response',
      requestId,
      decision: { behavior: 'deny', message },
    });
  }

  /**
   * こちらから撃つ `control_request` を積む。
   *
   * 許可への追い撃ち（`set_permission_mode`）・値の入れ替え・割り込みの3箇所が
   * 同じ形を生で書いていた。断る側（`queueDeny`）にはヘルパがあるのに
   * 撃つ側だけ無く、非対称になっていた。
   *
   * **行は組まない。** 積むのは意図だけで、stdin へ書ける形にするのは
   * `run/index.mjs` の `encodeOutbox` の仕事。
   *
   * @param {string} runId 実行の識別子
   * @param {string} requestId こちらが振った番号。応答の突き合わせに使う
   * @param {string} subtype `set_permission_mode` / `set_model` / `interrupt` など
   * @param {object} params 向こうへ渡すパラメタ。**頼まれていないキーを足さない**
   */
  function queueControl(runId, requestId, subtype, params) {
    outbox.push({ runId, kind: 'control-request', requestId, subtype, params });
  }

  /**
   * 抱えている未応答の要求を捨てる。
   *
   * **`outbox` には積まない。** 子がいない（もしくは畳むと決めた）ので書く先が無い。
   * 積むと `takeOutbox()` がそれを拾って、閉じた stdin へ書きに行くことになる。
   *
   * @param {object} run 対象の run
   * @returns {void}
   */
  function clearPending(run) {
    run.pending.clear();
    run.livePending.clear();
  }

  /**
   * 未応答の要求を1件受け取る。
   *
   * 速報は積まない（`toRunEvents` が `permission` を1件積んでいるので二重になる）。
   * ここで積むのは、断ったときのように**そうしないと見えないこと**だけ。
   *
   * @param {object} run 対象の run
   * @param {object} info `classifyStreamLine` が読んだ `can_use_tool` の中身
   * @param {string|null} detail 1行の要約（`toRunEvents` が組んだものを使い回す）
   * @param {number} now 時刻
   * @returns {Array<object>} 積んだ速報
   */
  function takeAsk(run, info, detail, now) {
    const id = typeof info.requestId === 'string' ? info.requestId : '';
    // 宛先が読めないものには答えようが無い（`stream.mjs` が既に弾いているが、ここでも見る）
    if (!id) return [];
    // 同じ id が二度来ても上書きしない。上書きすると `at` が動いて時間切れが延びる
    if (run.pending.has(id)) return [];

    // 畳むと決めたあとに届いたぶん。答える意味が無いので**その場で断る。**
    // 放っておくと向こうは待ち続け、こちらは pending を抱えたまま終端へ行く
    if (run.state === 'stopping' || run.state === 'switching') {
      queueDeny(run, id, 'この実行を止めることにしたので断りました');
      return [];
    }

    if (run.pending.size >= pendingMax) {
      queueDeny(run, id, `いちどに答えられるのは ${pendingMax} 件までです`);
      return [pushNote(run, `許可要求が ${pendingMax} 件を超えたので断りました`, now)];
    }

    const input = isPlainObject(info.input)
      ? info.input
      : null;
    const kind = askKindOf(info.toolName ?? null);
    // 選択肢の形に組めたときは、文字列に畳んだ本文を持たない。
    // 画面はこちらを見て選択肢を組む。組めなかったとき（原文の形が違う版など）は
    // `body` に落ちて、段1と同じ「本文＋断る」のカードになる
    const questions = kind === 'question' ? askQuestions(input) : null;
    run.pending.set(id, {
      id,
      kind,
      tool: info.toolName ?? null,
      detail,
      body: questions ? null : askBody(info.toolName ?? null, input),
      questions,
      suggestMode: suggestModeOf(info.suggestions),
      // **原文を持つのは質問のときだけ。** `allow` は `updatedInput` を省略でき、
      // 省略すれば CLI が元の入力をそのまま使う。だから `Write` や `Bash` の原文は要らない。
      // 持つと `content` の数MBがそのまま台帳に居座る
      input: kind === 'question' ? input : null,
      at: now,
    });
    run.state = 'needs-permission';
    return [];
  }

  /**
   * 扱えない `control_request` に、エラーで答える。
   *
   * **黙って捨ててはいけない。** 向こうは応答が来るまで永久に待つ。
   * 「未知の形で落ちない」を、ここでは「未知の形で詰まらない」まで広げている。
   *
   * @param {object} run 対象の run
   * @param {object} info `{requestId, subtype}`
   * @param {number} now 時刻
   * @returns {Array<object>} 積んだ速報
   */
  function refuseControl(run, info, now) {
    const id = typeof info.requestId === 'string' ? info.requestId : '';
    if (!id) return [];
    const sub = info.subtype || '不明';
    outbox.push({
      runId: run.runId,
      kind: 'control-error',
      requestId: id,
      message: `この画面では ${sub} を扱えません`,
    });
    return [pushNote(run, `扱えない要求（${sub}）を断りました`, now)];
  }

  /**
   * こちらが撃った要求の答えを反映する。
   *
   * **自分が返した `control_response` も stdout にそのまま echo で戻ってくる**（実測 2026-08-25）。
   * ただし向こうの `request_id` は `pending` にしか入らず、こちらが採番した id は
   * `livePending` にしか入らない。だから**採番した id と一致するかどうかだけ**で、
   * 自分のこだまと本物の応答を分けられる。合わないものは黙って捨てる。
   *
   * 受理を待ってから書き換えるのは、このアプリが全域で守っている「0 と不明を分ける」の一環。
   * **「plan のつもりが acceptEdits で走っている」は最も高くつく誤表示。**
   *
   * @param {object} run 対象の run
   * @param {object} info `{requestId, ok, error, response}`
   * @param {number} now 時刻
   * @returns {Array<object>} 積んだ速報
   */
  function takeControlResult(run, info, now) {
    const id = typeof info.requestId === 'string' ? info.requestId : '';
    const p = id ? run.livePending.get(id) : null;
    if (!p) return [];
    run.livePending.delete(id);
    if (p.kind === 'interrupt') return takeInterruptResult(run, info, now);
    const f = LIVE_FIELDS[p.field];
    if (!info.ok) {
      return [pushNote(run, `${f.label}を ${p.value} に替えられませんでした（${info.error ?? '理由不明'}）`, now)];
    }
    run[p.field] = p.value;
    // `kind` を増やさず `note` に `applied` を1つ添えてある。
    // 新しい kind を作ると画面の `bodyOf` が既定の枝に落ちて**中身の無い行**が出るし、
    // 殻（`index.mjs`）が `entry.spec` を同期するのに要るのはこの2語だけ
    return [pushEvent(run, {
      kind: 'note',
      text: `${f.label}を ${p.value} にしました`,
      applied: { field: p.field, value: p.value },
    }, now)];
  }

  /**
   * 割り込みの答えを読む。**状態は変えない。**
   *
   * 割り込みが通ってもそのターンが早く畳まれるだけで、run としては走ったまま。
   * ここで終端へ倒すと、まだ流れている行を `apply()` が「子のいない run のもの」として捨てる。
   * 止めるのは `/stop` の仕事で、これは別のこと。
   *
   * @param {object} run 対象の run
   * @param {object} info `{requestId, ok, error, response}`
   * @param {number} now 時刻
   * @returns {Array<object>} 積んだ速報
   */
  function takeInterruptResult(run, info, now) {
    if (!info.ok) {
      return [pushNote(run, `割り込めませんでした（${info.error ?? '理由不明'}）`, now)];
    }
    // 応答に控えの残り数が入ることがある（`still_queued`）。**数でなければ言わない**
    const left = typeof info.response?.still_queued === 'number' ? info.response.still_queued : null;
    return [pushNote(run, left === null
      ? '割り込みました'
      : `割り込みました（控えが ${left} 件残っています）`, now)];
  }

  /**
   * 起動の行から、向こうが名乗った機能と、使えるスラッシュコマンドを控える。**速報は積まない。**
   *
   * `init` は1本のあいだに何度も流れる（ターンごと・スラッシュコマンドでも）。
   * **配列で来たときだけ書く。** 読めない行で null に潰すと、一度は名乗っていた機能が
   * 「名乗っていない」に化けて、割り込みの札が画面から消える。
   *
   * スラッシュコマンドは `slash_commands` から `terminal_slash_commands` を引いた残り。
   * 引くほうは**対話版の画面でしか働かない**もの（実測 2.1.245 で `['doctor','color']`）で、
   * こちらから送っても何も起きない。**引き算をここでするのは、これが判断だから。**
   * `parse/` は行を読むだけにしてあり、どれが使えるかを決めるのは台帳の側。
   *
   * @param {object} run 対象の run
   * @param {object} info `initInfo` の戻り
   * @returns {void}
   */
  function takeInit(run, info) {
    if (Array.isArray(info?.capabilities)) run.capabilities = info.capabilities;
    if (Array.isArray(info?.slashCommands)) {
      const skip = new Set(info.terminalSlashCommands ?? []);
      run.slashCommands = info.slashCommands.filter((c) => !skip.has(c)).slice(0, slashMax);
    }
  }

  /**
   * 考えた量を畳む。**速報は積まない。**
   *
   * `estimated_tokens` はそのターンの累計で、1往復に何度も刻んで届く（実測で8件）。
   * だから**最新の値でただ上書きする。** ターンが替われば向こうが小さい数から数え直すので、
   * こちらで「ターンが替わったか」を判断する必要が無い（判断を持たない＝ずれない）。
   *
   * @param {object} run 対象の run
   * @param {object} info `thinkingInfo` の戻り
   * @returns {void}
   */
  function takeThinking(run, info) {
    // 取れなかったときに 0 で潰さない。前の値をそのまま残す
    if (typeof info.tokens !== 'number') return;
    run.thinking = info.tokens;
  }

  /**
   * 枠の使用率を畳む。**速報は積まない。**
   *
   * **どちらの枠も読めなかった行では上書きしない。**
   * 版が上がって `unifiedWindows` の形が変わった日に、
   * 一度は取れていた値が null で潰れて「取れていない」に見えるのを防ぐ。
   *
   * **run には持たせない。台帳に1つだけ置く。**
   * これはアカウント共通の値で、どの実行から届いたかに意味が無い。
   * run ごとに持つと画面に同じ数がいくつも並び、「この実行が使った枠」と読める。
   * 行に載って来るのは、届く道が実行の stdout しか無いという**出どころの都合**。
   *
   * **測った時刻（`at`）を一緒に持つ。**
   * 走っているものが無ければ数は古びていく。何分前の数かを言えないと、
   * 古い数を今の数の顔で出すことになる（0 と不明を分ける）。
   *
   * @param {object} info `rateLimitInfo` の戻り
   * @param {number} now いまの時刻（ms）
   * @returns {void}
   */
  function takeRateLimit(info, now) {
    if (typeof info.fiveHour !== 'number' && typeof info.sevenDay !== 'number') return;
    latestRate = {
      fiveHour: info.fiveHour ?? null,
      sevenDay: info.sevenDay ?? null,
      resetsAt: info.resetsAt ?? null,
      at: now,
    };
  }

  /**
   * 返事の無いまま時間切れになった「替えました」の控えを捨てる。
   *
   * **状態は変えない。** 撃ったのに返事が無いなら、いまどちらで走っているかは分からない。
   * 古いほうに据え置くのも新しいほうへ倒すのも、どちらも推測を事実として出すことになる。
   * だから言うのは「分からない」だけにする（`stalled` が「応答なし」と診断しないのと同じ）。
   *
   * @param {object} run 対象の run
   * @param {number} now 時刻
   * @returns {Array<object>} 積んだ速報。時間切れが無ければ空
   */
  function sweepLive(run, now) {
    if (run.livePending.size === 0) return [];
    const out = [];
    for (const [id, p] of [...run.livePending]) {
      // 時計が巻き戻ったとき（負）に捨てないよう、この向きで書く
      if (!(now - p.at >= liveAckTimeoutMs)) continue;
      run.livePending.delete(id);
      if (p.kind === 'interrupt') {
        // ここでも「届かなかった」と診断しない。**返事が無かったことだけ**を言う
        out.push(pushNote(run, '割り込みに返事がありませんでした。届いたかどうかは分かりません', now));
        continue;
      }
      const label = LIVE_FIELDS[p.field].label;
      out.push(pushNote(run, `${label}の切り替えに返事がありませんでした。いまの${label}は分かりません`, now));
    }
    return out;
  }

  /**
   * 答えの無いまま時間切れになった要求を断る。
   *
   * 落とす先は `waiting`（あなたの番）。`running` に戻すと、Claude が代わりの手を
   * 探して詰まったときに `stalled` まで2分かかる。**人が何か言わないと前に進まない**ので、
   * 待たせている側として並べるほうが正しい。
   *
   * 言うのは測ったことだけ（`stalled` と同じ扱い）。「応答なし」と診断しない。
   *
   * @param {object} run 対象の run
   * @param {number} now 時刻
   * @returns {Array<object>} 積んだ速報。時間切れが無ければ空
   */
  function sweepAsks(run, now) {
    if (run.pending.size === 0 || isChildDone(run.state)) return [];
    const out = [];
    for (const [id, p] of [...run.pending]) {
      const quiet = now - p.at;
      // 時計が巻き戻ったとき（負）や数でないときに断らないよう、この向きで書く
      if (!(quiet >= permissionTimeoutMs)) continue;
      run.pending.delete(id);
      queueDeny(run, id, `${quietFor(quiet)}答えが無かったので断りました`);
      out.push(pushNote(run, `${askWhat(p.kind, p.tool)}に${quietFor(quiet)}答えが無かったので断りました`, now));
    }
    if (out.length > 0 && run.pending.size === 0 && run.state === 'needs-permission') {
      run.state = 'waiting';
      // 沈黙の時計を戻す。戻さないと、待っていたぶんがそのまま無音として数えられて、
      // 次の `tick` で即 `stalled` に落ちる
      run.lastLineAt = now;
      run.reason = '許可の答えが無かったので断りました。続けるなら指示を送ってください';
    }
    return out;
  }

  /**
   * 終わった run が増えすぎないように古いものから落とす。
   *
   * 落とした run の速報はリングに残るが、そのうち押し出されるので放っておく。
   * ここで探して消すと、`seq` の連番に穴が空いて再開カーソルの意味が変わる。
   *
   * @returns {void}
   */
  function prune() {
    const over = [...runs.values()].filter((r) => isRunOver(r.state));
    if (over.length <= historyMax) return;
    over.sort((a, b) => a.startedAt - b.startedAt);
    for (const r of over.slice(0, over.length - historyMax)) runs.delete(r.runId);
  }

  /**
   * 一覧へ出す粗い形。**毎秒動く値を入れないこと。**
   *
   * @param {object} run 対象の run
   * @returns {object} 押し出しの差分判定を素通りしない値だけ
   */
  function toRow(run) {
    return {
      runId: run.runId,
      sessionId: run.sessionId,
      cwd: run.cwd,
      state: run.state,
      stateLabel: RUN_STATE_LABELS[run.state] ?? run.state,
      model: run.model,
      effort: run.effort,
      permissionMode: run.permissionMode,
      resume: run.resume,
      perTurn: run.perTurn,
      pid: run.pid,
      exitCode: run.exitCode,
      reason: run.reason,
      startedAt: run.startedAt,
      turns: run.turns,
      // ここまでに使った額（累計）。**`turns` と同じ `result` でしか動かない。**
      // 増えるのは往復が閉じた回だけで、そのとき `turns` も一緒に動くから、
      // 粗い行に載せても差分判定に新しい変化点を作らない（毎秒 push にならない）。
      // 行へ移したのは、実行の速報を画面から外してこの値の出口が無くなったため。
      // まだ1往復も閉じていなければ null。**0 と不明を分ける**ので 0 を書かない
      costUSD: run.costUSD,
      // 毎秒動かない（切り替えたときだけ変わる）ので粗い行に載せてよい。
      // 実行パネルの「替えて続ける」が `rows()` 側しか見ないため、ここに無いと欄を埋められない
      budgetUsd: run.budgetUsd,
      // 未応答の要求。**速報（リング）ではなく行に載せる。**
      // リングは画面側で400件を超えたぶんが捨てられるので、1ターンで数百行来た日に
      // 要求そのものが消えて二度と答えられなくなる。行は毎回まるごと入れ替わるので、
      // 答えて消えたことも取りこぼしも次のフレームで自己修復する。
      // 中身は要求が来た時と消えた時にしか変わらない＝毎秒 push にはならない
      asks: [...run.pending.values()].map(askRow),
      // 撃ったが返事待ちの切り替え。**行に載せるのは `asks` と同じ理由。**
      // 別のタブで替えた最中にもう一方が二重に撃つのを止められるし、
      // 押した窓を閉じても「切り替え中」が残る。`at` を載せないのは毎秒の差分判定のため
      switching: [...run.livePending.values()]
        .filter((p) => p.kind === 'live')
        .map((p) => ({ field: p.field, value: p.value })),
      // 撃ったが返事待ちの割り込み。二重に撃たせないために行へ載せる。
      // 真偽1つで足りるのは、控えるのは同時に1本だけと `interrupt()` が決めているため
      interrupting: [...run.livePending.values()].some((p) => p.kind === 'interrupt'),
      // CLI が名乗った機能。**null は「名乗らなかった」で、空配列（何も無い）とは別。**
      // 画面はこれを見て割り込みの札を出すかどうかを決める。init で入るだけなので毎秒動かない
      capabilities: run.capabilities,
      // 送れるスラッシュコマンド。**`get()` ではなく行に載せる。**
      // 使うのは入力欄の隣の札で、あれが見ているのは `rows()` の行だけ
      // （`runFor(sessionId)` が引くのがそちら）。`get()` に置くと画面から届かない。
      // 60 語で 700 バイトほどあるが、init のときしか変わらないので差分判定で止まる
      slashCommands: run.slashCommands,

      // CLI が stderr へ吐いた直近の1行。**速報の並びには混ぜない**（本文が読めなくなる）が、
      // 見出しには出す。`get()` にしか出さないと、画面が `/api/runs/:id` を
      // 引いていない以上どこにも現れない。普段は null なので欄ごと出ない
      lastStderr: run.lastStderr,
    };
  }

  return {
    /**
     * いま新しく起こしてよいか。
     *
     * **`add()` の前に必ず呼ぶこと。** ここで断らないと上限が意味を失う。
     * `run/index.mjs` は canStart → add → spawn を全部同期で進めるので、
     * そのあいだに別の要求が割り込んで二重に起きることはない。
     *
     * @param {number} now 時刻
     * @returns {{ok:true}|{ok:false, reason:string}}
     */
    canStart(now) {
      let active = 0;
      for (const r of runs.values()) if (!isRunOver(r.state)) active += 1;
      if (active >= max) {
        return { ok: false, reason: `同時に動かせるのは ${max} 本までです（いま ${active} 本）` };
      }
      if (lastStartAt !== null) {
        const since = now - lastStartAt;
        // 時計が巻き戻ったとき（since が負）は通す。
        // 負を「間隔が足りない」と読むと、巻き戻った幅のあいだ起動できなくなる
        if (since >= 0 && since < minIntervalMs) {
          return { ok: false, reason: '起動が続けざまです。少し待ってからもう一度' };
        }
      }
      return { ok: true };
    },

    /**
     * run を1つ足す。
     *
     * `spec.prompt` は**持たない。** stdin へ書いたら役目は終わりで、
     * 本文は `--replay-user-messages` の戻り（`echo`）として速報に出る。
     *
     * @param {object} spec `buildRunSpec` が返した spec
     * @param {number} now 時刻
     * @returns {string} 付けた runId
     */
    add(spec, now) {
      const runId = `r${++runSeq}`;
      runs.set(runId, {
        runId,
        sessionId: spec.sessionId,
        cwd: spec.cwd,
        model: spec.model ?? null,
        effort: spec.effort ?? null,
        permissionMode: spec.permissionMode,
        budgetUsd: spec.budgetUsd ?? null,
        resume: spec.resume === true,
        state: 'starting',
        reason: null,
        pid: null,
        exitCode: null,
        perTurn: false,
        startedAt: now,
        lastLineAt: null,
        turns: 0,
        costUSD: null,
        stopRequested: false,
        switchRequested: false,
        /** @type {Map<string, object>} requestId → 未応答の要求 */
        pending: new Map(),
        /** @type {Map<string, object>} requestId → 撃った要求の控え。`{kind, ..., at}` */
        // **受理されるまで持つ**（受理を待たずに書き換えないため）。
        //
        // `kind` は `'live'`（値の入れ替え。`field` と `value` を持つ）か
        // `'interrupt'`（割り込み。替える項目が無いので持たない）。
        // **割り込みを `LIVE_FIELDS` に足さない。** あれは「項目→subtype→パラメタ名」の表で、
        // 足すと `LIVE_FIELDS[p.field]` が undefined になり、答えを読む側がその場で落ちる。
        // 器を分けずに印を1つ持たせたのは、後始末が `livePending.clear()` の1箇所で済むため
        livePending: new Map(),
        /** @type {string[]|null} CLI が名乗った機能。**無ければ null**（空配列に丸めない） */
        capabilities: null,
        /** @type {string[]|null} 送れるスラッシュコマンド。**無ければ null**（空配列に丸めない） */
        slashCommands: null,
        /** @type {number|null} そのターンで考えた量（累計）。畳んだ結果だけを持つ */
        thinking: null,
        /** @type {string|null} 子が stderr へ吐いた直近の1行。失敗していなくても持つ */
        lastStderr: null,
        // `droppedLines` は**長すぎて捨てた行の数**。殻（`run/index.mjs`）から入れてもらう。
        // 台帳は行を読むだけで、捨てる判断は `createLineSplitter` がしているため
        counts: { lines: 0, broken: 0, events: 0, droppedLines: 0 },
      });
      lastStartAt = now;
      prune();
      return runId;
    },

    /**
     * 子が起きたことを記録する。
     *
     * `waiting` からも `running` へ戻すのは、`perTurn` の run を起こし直したときのため。
     * `switching` も同じ理由で戻す（前の子を畳んで新しい子を起こした直後がここに来る）。
     * `budget`（予算切れ）も同じ。上限に当たった子を畳んだあと、続きを起こした直後がここ。
     *
     * @param {string} runId 対象
     * @param {number|null} pid 子の PID
     * @returns {boolean} 記録できたか
     */
    setPid(runId, pid) {
      const run = runs.get(runId);
      if (!run || isRunOver(run.state)) return false;
      run.pid = typeof pid === 'number' && Number.isFinite(pid) ? pid : null;
      if (run.state === 'starting' || run.state === 'waiting'
        || run.state === 'switching' || run.state === 'budget') {
        // **状態を替える前に落とす。** `clearStateReason` はいまの状態を見て決めるので、
        // 後ろに置くと `running` になった run を見て何もしない。
        // そのまま送って起こし直したとき（`restart()`）に効くのはここだけで、
        // 残すと「予算の上限に達しました」が動いている run の理由として出続ける
        clearStateReason(run);
        run.state = 'running';
      }
      return true;
    },

    /**
     * 長すぎて捨てた行の数を記録する。
     *
     * ## なぜこれだけ殻から入れてもらうか
     *
     * 捨てる判断をしているのは `createLineSplitter`（`os/claude.mjs`）で、台帳は
     * **捨てられた行を見ることすらできない。** だから数だけ受け取る。
     *
     * ## なぜ要るか
     *
     * 段1で逃げ道を10通り塞いだあと、**唯一残っているデッドロックの経路**がこれ。
     * 4MB を超える `control_request`（巨大な `Write` の許可要求など）が届くと、
     * 行がまるごと捨てられる。こちらは要求が来たことを知らないので誰も答えず、
     * 向こうは答えを待ち続ける。既存の `stalled`（2分）が状態としては拾うが、
     * **画面には「反応がありません」としか出ない**ので原因にたどり着けない。
     *
     * 段4より前は `splitter.dropped` を誰も読んでいなかった。
     *
     * ## 数えるだけでは足りない
     *
     * `counts` は `get()`（`/api/runs/:id`）にしか出ず、画面はそこを引いていない。
     * **数えたものが誰の目にも触れなければ診断にならない**ので、増えたときは速報に1行積む。
     * めったに起きないこと（実測では一度も起きていない）なので、
     * 「標準エラーは速報に混ぜない」の理由（本文が読めなくなる）はここには当たらない。
     *
     * @param {string} runId 対象
     * @param {number} n これまでに捨てた行の**累計**（差分ではない）
     * @param {number} now 時刻
     * @returns {Array<object>} 積んだ速報。増えていなければ空
     */
    noteDropped(runId, n, now) {
      const run = runs.get(runId);
      if (!run || typeof n !== 'number' || !Number.isFinite(n) || n < 0) return [];

      const total = Math.floor(n);
      const before = run.counts.droppedLines;
      // 累計をそのまま入れる。**足し込まない。**
      // 殻は `splitter.dropped` を毎回そのまま渡してくるので、足すと二重に数える
      run.counts.droppedLines = total;
      if (total <= before) return [];

      return [pushNote(
        run,
        `長すぎる行を ${total - before} 件捨てました（累計 ${total} 件）。`
        + '答えるべき要求が混ざっていた場合、返事が来ないまま止まります',
        now,
      )];
    },

    /**
     * 子が stderr へ吐いた直近の1行を記録する。
     *
     * **失敗していなくても持つ。** これまでは `fail()` のときにしか使っていなかったが、
     * `Malformed updatedPermissions` のような**こちらの配線の間違い**は
     * 終了コード 0 のまま stderr にだけ出る。捨てていると自分のミスに気づけない。
     *
     * 詳細（`get()`）にだけ出す。行に載せると差分判定をすり抜ける値が増える。
     *
     * @param {string} runId 対象
     * @param {string|null} text 1行に畳んだもの（畳むのは殻の仕事）
     * @returns {boolean} 記録できたか
     */
    noteStderr(runId, text) {
      const run = runs.get(runId);
      if (!run) return false;
      // 空で上書きしない。前に出た警告を消してしまう
      if (typeof text !== 'string' || !text) return false;
      run.lastStderr = text;
      return true;
    },

    /**
     * stream-json の1行を反映する。
     *
     * @param {string} runId 対象
     * @param {object} classified `classifyStreamLine` の戻り
     * @param {number} now 時刻
     * @returns {Array<object>} 積んだ速報（呼ぶ側はこれをそのまま SSE へ流す）
     */
    apply(runId, classified, now) {
      const run = runs.get(runId);
      // 子がいないあいだに届いた行は捨てる。
      // 止めた直後には数行が遅れて届くので、これが無いと「停止しました」の後に本文が並ぶ。
      // 予算切れも同じ（子は殻の側が畳んでいる最中）。続きを打てば `setPid` が
      // `running` へ戻すので、そこから先の行はまた通る
      if (!run || isChildDone(run.state)) return [];

      run.lastLineAt = now;
      run.counts.lines += 1;
      if (classified?.kind === 'broken') run.counts.broken += 1;

      // 行が届いた＝動いている。沈黙から戻す。
      // **落とすのは戻すときだけ。** 外に出すと、状態を1つ足した日に
      // 「札はそのままで理由だけ消える」という読めない見え方になる
      if (run.state === 'starting' || run.state === 'stalled') {
        clearStateReason(run);
        run.state = 'running';
      }

      const pushed = toRunEvents(classified).map((ev) => pushEvent(run, ev, now));

      // 別のセッションへ書き込んでいないか。
      // `session_id` はどの行にも載るので init に限らず毎行見る（init はターンごとに何度も来る）
      if (classified?.sessionId && !sameSessionId(classified.sessionId, run.sessionId)) {
        run.state = 'failed';
        run.reason = `セッションIDが一致しません（求めた ${run.sessionId} / 返った ${classified.sessionId}）`;
        pushed.push(pushNote(run, run.reason, now));
        return pushed;
      }

      // 届いた要求をまず捌く。**`result` の処理より前。**
      // 1行に両方は載らないので順序に実害は無いが、読み順をこちらへ寄せておく
      if (classified?.kind === 'permission') {
        // 1行の要約は `toRunEvents` が `describeTool` で組んだものを使い回す。
        // ここで組み直すと**同じ判断が2箇所**になり、片方だけ直る日が来る
        const ev = pushed.find((e) => e.kind === 'permission');
        pushed.push(...takeAsk(run, classified.info ?? {}, ev?.detail ?? null, now));
      } else if (classified?.kind === 'control') {
        pushed.push(...refuseControl(run, classified.info ?? {}, now));
      } else if (classified?.kind === 'control-result') {
        pushed.push(...takeControlResult(run, classified.info ?? {}, now));
      } else if (classified?.kind === 'init') {
        // 速報は `toRunEvents` が既に組んでいる。ここで拾うのは行に載せる名乗りだけ
        takeInit(run, classified.info ?? {});
      } else if (classified?.kind === 'thinking') {
        // 速報は積まない。行に載せるだけ（`toRunEvents` も空を返している）
        takeThinking(run, classified.info ?? {});
      } else if (classified?.kind === 'rate-limit') {
        takeRateLimit(classified.info ?? {}, now);
      }

      for (const ev of pushed) {
        if (ev.kind !== 'result') continue;

        // `num_turns` は累積ではない（実測。2往復目も 1 に戻る）ので、こちらで数える
        run.turns += 1;
        if (typeof ev.costUSD === 'number') run.costUSD = ev.costUSD;

        // そのターンで考えた量を、終わりの1件にだけ載せて畳む。
        //
        // **行（`toRow`）には載せない。** 行は状態が変わったときにしか描き直されないので、
        // 8件刻みで動く値を置くと古い数が残り続ける（0 と不明を分けるのと同じ理由で、
        // 古い値を今の値の顔で出さない）。ここなら並んだ位置がそのターンの終わりに固定される。
        //
        // 積んだ記録そのものを書き換えている。`pushEvent` はリングに入れた実体を返すので、
        // ここでの代入はリングにも SSE にも同じものが乗る。**畳む材料（累計）を知っているのは
        // 台帳だけ**で、`toRunEvents` は1行しか見ないので組めない
        ev.thinkingTokens = run.thinking;
        run.thinking = null;

        if (ev.terminalReason === 'budget_exhausted') {
          // 実測で**プロセスは死なない**ので、子は殻の側（`reapIfDone`）が畳む。
          //
          // **`failed` にしない。** 何も失敗していない。自分で置いた上限に当たっただけで、
          // 上げれば同じ会話の続きが打てる。終端にすると `detach()` が `entry.spec` を捨てるので、
          // 上限を上げて続ける道（`switch`）がその瞬間に消える。「失敗しました」の札も嘘になる
          run.state = 'budget';
          run.reason = oneLine(ev.errors, REASON_MAX) ?? '予算の上限に達しました';
          pushed.push(pushNote(run, run.reason, now));
          // **上限は子ごとに数え直す**（実測。`/switch` のあとで費用が起点へ戻る）。
          // だから「そのまま送る」でも同じ額ぶん進む。黙っていると
          // 「上限を上げないと動かない」と読まれる
          pushed.push(pushNote(run, 'そのまま送れば同じ上限で続きます。上限そのものを替えるなら「替えて続ける」から', now));
          break;
        }

        // 予算超過以外の `is_error` では止めない。
        // 知らない `terminal_reason` で子を殺すと、動いているセッションを壊すことになる。
        // 分からないときは過小に反応する側へ倒し、理由だけ残す
        run.reason = ev.isError
          ? (oneLine(ev.errors ?? ev.text, REASON_MAX) ?? 'エラーで終わりました')
          : null;
        if (run.state === 'running') run.state = 'waiting';
      }

      return pushed;
    },

    /**
     * 指示を送ったことを記録する。
     *
     * **本文は持たない。** 積むのは「送りました」の1行だけで、
     * 中身は `--replay-user-messages` の戻りとして向こうから返ってくる。
     * こうしておくと「書けたのに読まれていない」と「読まれたが応答が無い」が切り分けられる。
     *
     * @param {string} runId 対象
     * @param {number} now 時刻
     * @returns {Array<object>} 積んだ速報
     */
    markInput(runId, now) {
      const run = runs.get(runId);
      if (!run || isRunOver(run.state)) return [];
      // 沈黙の時計を戻す。戻さないと、長く待たせた後の1通目で即 stalled になる
      run.lastLineAt = now;
      const ev = pushNote(run, '指示を送りました', now);
      clearStateReason(run);
      if (run.state === 'waiting' || run.state === 'stalled' || run.state === 'budget') {
        run.state = 'running';
      }
      return [ev];
    },

    /**
     * 許可要求に答える。
     *
     * 断る理由の切り分けはここでやり、**HTTP のどの番号にするかは殻（`run/index.mjs`）が決める。**
     * 台帳が番号を知ると、窓口を1つ足すたびにこちらも直すことになる。
     *
     * `decision.then` は「答えたあと権限モードも替える」ぶん。
     * **語彙の検証はここではしない**（`spec.mjs` が持っている）。受け取るのは検証済みの1語と、
     * 殻が採番した `thenRequestId`。採番をここでやると `randomUUID` が要って、
     * 「時刻すら外から受ける純関数の器」という作りが崩れる。
     *
     * `decision.choices` は選択肢で答えるぶん（`{番号: 札 | [札…]}`）。
     * **原文を持っているのは台帳だけ**なので、`updatedInput` を組むのもここでやる。
     *
     * @param {string} runId 対象
     * @param {string} requestId どの要求への答えか
     * @param {object} decision `{behavior, message?, choices?, updatedPermissions?, then?, thenRequestId?}`
     * @param {number} now 時刻
     * @returns {{ok:boolean, code?:string, reason?:string, events:Array<object>}}
     *          `code` は `no-run` / `over` / `no-request` / `answered` / `bad` / `bad-choices`。
     *          `bad-choices` のときだけ `reason` に何が足りないかが入る
     */
    answer(runId, requestId, decision, now) {
      const run = runs.get(runId);
      if (!run) return { ok: false, code: 'no-run', events: [] };
      // 子がいなければ書く先が無い。予算切れもここに入る（`isRunOver` ではなく `isChildDone`）
      if (isChildDone(run.state)) return { ok: false, code: 'over', events: [] };

      const id = typeof requestId === 'string' ? requestId : '';
      if (!id) return { ok: false, code: 'no-request', events: [] };
      const p = run.pending.get(id);
      // **run が無いのではなく、その要求がもう無い。** 2つのタブから同時に押したときに
      // 片方が「別の窓で答えられました」と言えるように、run 不明とは分けて返す
      if (!p) return { ok: false, code: 'answered', events: [] };

      const behavior = decision?.behavior;
      if (behavior !== 'allow' && behavior !== 'deny') return { ok: false, code: 'bad', events: [] };

      // **台帳を触る前に組む。** 選び方が足りなくて断るときに pending を消していると、
      // 押し直す先が消えたまま「答えていない質問があります」だけが残る
      let updatedInput = null;
      if (behavior === 'allow' && decision.choices !== undefined && decision.choices !== null) {
        // 選択肢で答えられるのは質問だけ。ツールの引数を画面から差し替える道は作らない
        if (p.kind !== 'question') return { ok: false, code: 'bad', events: [] };
        const built = buildQuestionInput(p, decision.choices);
        if (!built.ok) return { ok: false, code: 'bad-choices', reason: built.reason, events: [] };
        updatedInput = built.updatedInput;
      }

      run.pending.delete(id);
      // 沈黙の時計を戻す。戻さないと、待たせたぶんがそのまま無音として数えられて、
      // 答えた直後に `stalled` へ落ちる
      run.lastLineAt = now;

      // 知っているキーだけ通す。画面から来た余計なキーをそのまま CLI へ渡さない。
      // `deny` のときに `updatedInput` を落とすといった**形の規則は `stream.mjs` の
      // エンコーダが持っている**ので、こちらでは絞るだけにして二重に書かない
      const out = { behavior };
      const msg = oneLine(decision.message, REASON_MAX);
      if (msg) out.message = msg;
      // **画面から来た `updatedInput` を素通しさせない。** 組むのは質問の答えのときだけで、
      // その中身も上の `buildQuestionInput` が原文から作ったもの。
      // 素通しにすると、カードに出した Bash のコマンドと実際に走るコマンドを
      // 別にできてしまう＝**人が承認したものと違うものが動く。**
      if (updatedInput) out.updatedInput = updatedInput;
      if (Array.isArray(decision.updatedPermissions) && decision.updatedPermissions.length > 0) {
        out.updatedPermissions = decision.updatedPermissions;
      }
      outbox.push({ runId, kind: 'permission-response', requestId: id, decision: out });

      const what = askWhat(p.kind, p.tool);
      // **選んだ札を残す。** 「そのセッションで自分が何を判断したか」を出すのが
      // このアプリの目的の半分で、速報の側にもそれが1行あると追いやすい
      const chose = updatedInput
        ? oneLine(Object.values(updatedInput.answers).join(' / '), REASON_MAX)
        : null;
      const events = [pushNote(run, behavior === 'allow'
        ? (chose ? `質問に答えました（${chose}）` : `${what}を許可しました`)
        : `${what}を断りました${msg ? `（${msg}）` : ''}`, now)];

      // **許可を積んだ後に撃つ。** モード変更を先にすると、CLI が plan の検査を
      // 通している最中に足元が変わる。順序に意味を持たせない場面が多いこのやり取りで、
      // ここだけは順序に意味がある。
      // 断ったときに撃たないのは、プランを差し戻したのにモードだけ抜けるのを防ぐため
      if (behavior === 'allow' && typeof decision.then === 'string' && decision.then
        && typeof decision.thenRequestId === 'string' && decision.thenRequestId) {
        run.livePending.set(decision.thenRequestId, {
          kind: 'live', field: 'permissionMode', value: decision.then, at: now,
        });
        queueControl(runId, decision.thenRequestId, LIVE_FIELDS.permissionMode.subtype,
          { [LIVE_FIELDS.permissionMode.key]: decision.then });
        events.push(pushNote(run, `権限モードを ${decision.then} に替えています`, now));
      }

      // 全部答えたら動き出す。**1件でも残っていれば許可待ちのまま。**
      // 並列のツール呼び出しでは複数まとめて来るので、1件答えただけでは進まない
      if (run.pending.size === 0 && run.state === 'needs-permission') run.state = 'running';
      return { ok: true, events };
    },

    /**
     * 子を殺さずに設定を替える。**撃つだけ。** 効いたかどうかは `takeControlResult` が決める。
     *
     * 断る理由の切り分けはここでやり、**HTTP のどの番号にするかは殻（`run/index.mjs`）が決める。**
     * `answer()` と同じ作法。
     *
     * **値の語彙は検証しない**（`spec.mjs` の `checkPermissionMode` / `checkModel` が持っている）。
     * 受け取るのは検証済みの値と、殻が採番した `requestId`。採番をここでやると `randomUUID` が
     * 要って、「時刻すら外から受ける純関数の器」という作りが崩れる。
     *
     * **台帳を触る前に全部確かめる。** 途中で断ると、1つ目だけ撃たれて2つ目が撃たれない
     * 半端な状態になる（呼んだ側からは「400 だった」としか見えないのに、片方は替わっている）。
     *
     * @param {string} runId 対象
     * @param {Array<{field:string, value:string, requestId:string}>} wants 替えたいもの
     * @param {number} now 時刻
     * @returns {{ok:boolean, code?:string, reason?:string, events:Array<object>}}
     *          `code` は `no-run` / `over` / `no-child` / `bad` / `same` / `switching`
     */
    setLive(runId, wants, now) {
      const run = runs.get(runId);
      if (!run) return { ok: false, code: 'no-run', events: [] };
      if (isRunOver(run.state)) return { ok: false, code: 'over', events: [] };
      // 予算切れなど、終端ではないが子がいないもの。こちらは建て直す（`/switch`）しかない
      if (isChildDone(run.state)) return { ok: false, code: 'no-child', events: [] };

      const list = Array.isArray(wants) ? wants : [];
      if (list.length === 0) return { ok: false, code: 'bad', events: [] };

      const seen = new Set();
      for (const w of list) {
        const f = LIVE_FIELDS[w?.field];
        if (!f || typeof w.value !== 'string' || !w.value
          || typeof w.requestId !== 'string' || !w.requestId) {
          return { ok: false, code: 'bad', events: [] };
        }
        // 同じ項目を2つ並べられると、後から来た答えがどちらのものか分からなくなる
        if (seen.has(w.field)) return { ok: false, code: 'bad', events: [] };
        seen.add(w.field);
        if (run[w.field] === w.value) {
          return { ok: false, code: 'same', reason: `${f.label}はいまと同じです`, events: [] };
        }
        for (const p of run.livePending.values()) {
          if (p.field !== w.field) continue;
          // 二重に撃つと、返ってきた答えのどちらが後なのか決められない。
          // 10秒（`liveAckTimeoutMs`）で控えが落ちるので、詰まったままにはならない
          return { ok: false, code: 'switching', reason: `${f.label}はいま切り替え中です`, events: [] };
        }
      }

      const events = [];
      for (const w of list) {
        const f = LIVE_FIELDS[w.field];
        run.livePending.set(w.requestId, { kind: 'live', field: w.field, value: w.value, at: now });
        queueControl(runId, w.requestId, f.subtype, { [f.key]: w.value });
        events.push(pushNote(run, `${f.label}を ${w.value} に替えています`, now));
      }
      return { ok: true, events };
    },

    /**
     * いま走っているターンへ割り込む（CLI の Esc に当たる）。
     *
     * **止めるのとは別のこと。** `/stop` は子ごと落として run を終わらせる。
     * こちらは子を生かしたまま「いまやっていることをやめて」と言うだけで、
     * そのあと続きを打てる。今までは前者しか無かったので、
     * 長い作業を1つ取り消したいだけでも会話ごと捨てるしかなかった。
     *
     * **名乗り（`capabilities`）が無いときは撃たせる。**
     * 「不明」を「使えない」と読むと、名乗る前の版で永久に断ることになる。
     * 通じなければ `sweepLive` が 10 秒で控えを落とし「返事がありませんでした」と言う。
     *
     * 逆に `cancelQueued` は**名乗っていなければ断る。** 頼まれたことを黙って落とすと、
     * 「控えも消えたはず」と思い込んだまま続きが流れることになる。
     *
     * @param {string} runId 対象
     * @param {string} requestId 殻が採番した id
     * @param {{cancelQueued?:boolean}} opts 控えている指示ごと取り消すか
     * @param {number} now 時刻
     * @returns {{ok:boolean, code?:string, reason?:string, events:Array<object>}}
     *          `code` は `no-run` / `over` / `no-child` / `bad` / `unsupported` /
     *          `no-cancel` / `interrupting`
     */
    interrupt(runId, requestId, opts, now) {
      const run = runs.get(runId);
      if (!run) return { ok: false, code: 'no-run', events: [] };
      if (isRunOver(run.state)) return { ok: false, code: 'over', events: [] };
      if (isChildDone(run.state)) return { ok: false, code: 'no-child', events: [] };
      if (typeof requestId !== 'string' || !requestId) {
        return { ok: false, code: 'bad', events: [] };
      }

      const caps = run.capabilities;
      if (Array.isArray(caps) && !caps.includes(INTERRUPT_CAP)) {
        return { ok: false, code: 'unsupported', events: [] };
      }
      const cancelQueued = opts?.cancelQueued === true;
      if (cancelQueued && Array.isArray(caps) && !caps.includes(CANCEL_QUEUED_CAP)) {
        return { ok: false, code: 'no-cancel', events: [] };
      }

      for (const p of run.livePending.values()) {
        // 二重に撃つと、返ってきた `still_queued` がどちらのものか決められない
        if (p.kind === 'interrupt') return { ok: false, code: 'interrupting', events: [] };
      }

      run.livePending.set(requestId, { kind: 'interrupt', at: now });
      // **頼まれていないキーを付けない。** 未知のキーを向こうがどう扱うかは読めない
      queueControl(runId, requestId, 'interrupt', cancelQueued ? { cancel_queued: true } : {});
      return {
        ok: true,
        events: [pushNote(run, cancelQueued
          ? '割り込んでいます（控えている指示も取り消します）'
          : '割り込んでいます', now)],
      };
    },

    /**
     * 送るべき意図を取り出す。**取り出したら空にする。**
     *
     * 二重に渡すと同じ許可要求へ2回答えることになり、向こうがどう転ぶか分からない。
     * 行に組んで stdin へ書くのは `run/index.mjs` の `commit()` の仕事。
     *
     * @returns {Array<object>} 積んであったぶん。無ければ空
     */
    takeOutbox() {
      return outbox.length === 0 ? [] : outbox.splice(0, outbox.length);
    },

    /**
     * 停止を頼まれたことを記録する。
     *
     * `stopClaude` は stdin を閉じてから最大5秒かけて木ごと落とす。
     * そのあいだを `running` と言うのも `stopped` と言うのも嘘になるので、状態を1つ挟む。
     *
     * @param {string} runId 対象
     * @param {number} now 時刻
     * @returns {Array<object>} 積んだ速報。既に終わっていれば空
     */
    markStopping(runId, now) {
      const run = runs.get(runId);
      if (!run || isRunOver(run.state)) return [];
      // 畳むと決めたので、抱えている要求に答える意味は無い
      clearPending(run);
      // 落とさないと、実行パネルの「理由」の行が「止まった理由」として読まれる
      clearStateReason(run);
      run.stopRequested = true;
      run.state = 'stopping';
      return [pushNote(run, '停止しています', now)];
    },

    /**
     * 切り替えを頼まれたことを記録する。
     *
     * `stopping` と分けてあるのは、この先が正反対だから。
     * あちらは畳んで終わり、こちらは畳んでから同じ `sessionId` で起こし直す。
     * 同じ状態にすると `onExit` がどちらか一方しか選べず、
     * 切り替えの途中で `stopped`（終端）に落ちて起こし直せなくなる。
     *
     * **`spec` を丸ごと受ける。** `add()` が既に spec を受けているので形の依存は増えない。
     * 何が変わったかは前の値と比べてここで文にする。
     * `index.mjs` から文言を渡す形にすると、台帳の中と外に同じ判断が2つできる。
     *
     * @param {string} runId 対象
     * @param {object} spec 切り替え後の spec（`buildRunSpec` の戻り）
     * @param {number} now 時刻
     * @returns {Array<object>} 積んだ速報。既に終わっていれば空
     */
    markSwitching(runId, spec, now) {
      const run = runs.get(runId);
      if (!run || isRunOver(run.state)) return [];
      // 建て直すので、いまの子への要求は消える。答えても行き先が無い
      clearPending(run);

      // 外したときは「指定なし」と書く。空欄にすると、外したのか元からなのか読めない
      const parts = [];
      if (spec.model !== run.model) parts.push(`モデルを ${spec.model ?? '指定なし'} に`);
      if (spec.effort !== run.effort) parts.push(`思考量を ${spec.effort ?? '指定なし'} に`);
      if (spec.permissionMode !== run.permissionMode) {
        parts.push(`権限モードを ${spec.permissionMode} に`);
      }
      // 予算は「外した」も意味を持つ（上限なし）ので、null をそのまま言葉にする
      if (spec.budgetUsd !== run.budgetUsd) {
        parts.push(spec.budgetUsd === null ? '予算を上限なしに' : `予算を ${spec.budgetUsd} に`);
      }

      // 止めるときと同じ。替えた先の run に前の理由（無音・予算切れ）を持ち越さない
      clearStateReason(run);
      // pid が無ければ畳む工程そのものが無い（`perTurn` と予算切れがそれ）。
      // 旗を立てても消費する `close` が来ないので立てっぱなしになり、
      // 起こし直した子が自分で異常終了したときに `onExit` がそれを切り替えと読む。
      // すると終端へ落ちず、`RUN_MAX` の枠を掴んだまま永久に残る
      run.switchRequested = run.pid !== null;
      run.state = 'switching';
      run.model = spec.model ?? null;
      run.effort = spec.effort ?? null;
      run.permissionMode = spec.permissionMode;
      run.budgetUsd = spec.budgetUsd ?? null;
      // 切り替えた先は必ず `--resume`。画面の「続き」の印もここで合わせる
      run.resume = true;

      const text = parts.length > 0 ? `${parts.join('、')}切り替えています` : '切り替えています';
      return [pushNote(run, text, now)];
    },

    /**
     * 起こせなかった・続けられなくなったことを記録する。
     *
     * 実行ファイルが無いときは `child.on('error')` にしか来ないので、その受け皿でもある。
     *
     * @param {string} runId 対象
     * @param {string} reason 理由
     * @param {number} now 時刻
     * @returns {Array<object>} 積んだ速報
     */
    fail(runId, reason, now) {
      const run = runs.get(runId);
      if (!run || isRunOver(run.state)) return [];
      clearPending(run);
      run.state = 'failed';
      run.reason = oneLine(reason, REASON_MAX) ?? '失敗しました';
      run.pid = null;
      return [pushNote(run, run.reason, now)];
    },

    /**
     * 子が閉じたことを反映する。
     *
     * `waiting` のまま 0 で閉じた場合だけ**終端にしない。**
     * 1往復ごとにプロセスが閉じる作りに変わっても、続きを打てる形を保つため。
     *
     * @param {string} runId 対象
     * @param {{code?:number|null, signal?:string|null}} [info] 終了の様子
     * @param {number} now 時刻
     * @returns {Array<object>} 積んだ速報
     */
    onExit(runId, info, now) {
      const run = runs.get(runId);
      if (!run) return [];
      // **`isRunOver` の判定より前。** 既に終端でも、抱えたままにする理由が無い。
      // `outbox` には積まない（子がいないので書く先が無い）
      clearPending(run);

      const code = typeof info?.code === 'number' ? info.code : null;
      const signal = typeof info?.signal === 'string' ? info.signal : null;

      run.pid = null;
      run.exitCode = code;
      // 既に終端なら状態は上書きしない。exitCode だけ記録して帰る
      if (isRunOver(run.state)) return [];

      if (run.stopRequested) {
        run.state = 'stopped';
        return [pushNote(run, '止めました', now)];
      }

      // **`stopRequested` より後に見ること。** 切り替えの最中に停止を頼まれると
      // 両方立つので、先に見ると「止めろと言われたのに切り替え中へ戻る」ことになる。
      if (run.switchRequested) {
        // 切り替えのために自分で畳んだぶん。ここで終端にすると起こし直せない。
        // `switching` のまま残し、新しい子の `setPid` で `running` へ戻す。
        // 旗を下ろすのは、次に来る close（新しい子のもの）をまた切り替えと読まないため
        run.switchRequested = false;
        return [pushNote(run, '切り替えのため、いったん止めました', now)];
      }

      // 予算切れで畳んだぶん。**ここで終端にしない。** 上限に当たった子を
      // 殻の側が畳んでいるだけなので、`budget` のまま残して続きを打てる形を保つ。
      // 実測で stdin を閉じると `code=1` で閉じるので、下まで落とすと「異常終了」に化ける
      if (run.state === 'budget') return [];

      if (run.state === 'waiting' && code === 0) {
        run.perTurn = true;
        return [pushNote(run, '1往復ぶんで終了しました。続けて入力できます', now)];
      }

      if (code === 0) {
        run.state = 'done';
        return [pushNote(run, '終了しました', now)];
      }

      run.state = 'failed';
      run.reason = signal
        ? `異常終了しました（signal ${signal}）`
        : `異常終了しました（code ${code === null ? '不明' : code}）`;
      return [pushNote(run, run.reason, now)];
    },

    /**
     * 沈黙している run を `stalled` にする。
     *
     * **`running` だけが対象。** `waiting` は沈黙が正常な状態なので見ない
     * （見ると、返事を待たせているだけのものが全部「無音」になる）。
     *
     * 1行も来ていない run は `startedAt` から測る。
     * これが無いと「起こしたが1行も出さずに固まった」がいつまでも `starting` のままになる。
     *
     * @param {number} now 時刻
     * @returns {{changed:Array<string>, events:Array<object>}} 変わった runId と、積んだ速報
     */
    tick(now) {
      const changed = [];
      const events = [];
      for (const run of runs.values()) {
        // **無音の判定より前で、状態の絞り込みの外。**
        // 許可待ちは `running` でも `starting` でもないので、中に入れると一度も測られない
        const swept = sweepAsks(run, now);
        if (swept.length > 0) {
          events.push(...swept);
          changed.push(run.runId);
        }

        // 「替えました」の返事の時間切れ。**状態（`state`）は変えないが、行は変わる。**
        // `switching` が空に戻るので `changed` に入れる。入れないと画面が「切り替え中」のまま残る
        const settled = sweepLive(run, now);
        if (settled.length > 0) {
          events.push(...settled);
          changed.push(run.runId);
        }

        // 許可待ちの無音は正常なので射程を広げない。あちらは上の時間切れが見ている
        if (run.state !== 'running' && run.state !== 'starting') continue;
        if (now - (run.lastLineAt ?? run.startedAt) < stallMs) continue;
        // 言うのは測ったことだけ。圧縮中は2分以上ふつうに無音になる（実測121秒）ので、
        // 「応答がありません」と書くと動いているセッションを故障として報告することになる
        run.reason = `出力が${quietFor(now - (run.lastLineAt ?? run.startedAt))}止まっています。圧縮や長いコマンドの最中かもしれません`;
        run.state = 'stalled';
        changed.push(run.runId);
        events.push(pushNote(run, run.reason, now));
      }
      prune();
      return { changed, events };
    },

    /**
     * 一覧へ出す行。粗い値だけ。
     *
     * @returns {Array<object>} 起こした順
     */
    rows() {
      return [...runs.values()].map(toRow);
    },

    /**
     * 1本ぶんの詳しい姿。詳細を開いたときだけ引く。
     *
     * @param {string} runId 対象
     * @returns {object|null} 無ければ null
     */
    get(runId) {
      const run = runs.get(runId);
      if (!run) return null;
      return {
        ...toRow(run),
        lastLineAt: run.lastLineAt,
        counts: { ...run.counts },
      };
    },

    /**
     * 溜めてある速報を返す。
     *
     * @param {number} [from] この `seq` より後。0 か未指定なら持っているぶん全部
     * @returns {{events:Array<object>, from:number, nextSeq:number, missed:number}}
     *          `missed` は落として渡せなかった件数。**黙って詰めない**
     */
    events(from) {
      const start = Number.isFinite(from) && from > 0 ? Math.floor(from) : 0;
      const oldest = ring.length ? ring[0].seq : seq + 1;
      return {
        events: ring.filter((e) => e.seq > start),
        from: start,
        nextSeq: seq,
        // 続きを求められたのに、その一部が既に押し出されている
        missed: start > 0 && oldest > start + 1 ? oldest - start - 1 : 0,
      };
    },

    /**
     * run を1つ消す。終わったものだけ。
     *
     * @param {string} runId 対象
     * @returns {boolean} 消したか
     */
    remove(runId) {
      const run = runs.get(runId);
      if (!run || !isRunOver(run.state)) return false;
      return runs.delete(runId);
    },

    /**
     * 直近の枠の使用率。**行ではなく、ここから1つだけ出す。**
     *
     * @returns {object|null} `{fiveHour, sevenDay, resetsAt, at}`
     */
    rateLimit() {
      return latestRate;
    },

    /**
     * 立ち上がりに、紙から読んだ枠の使用率を置く。
     *
     * **すでに測ったものがあれば触らない。** 紙は必ず過去のもので、
     * 走っている実行から届いた数のほうが新しい。順番の前後で古い数に
     * 戻ることが無いよう、上書きの向きをここで1回だけ決めておく。
     *
     * @param {object|null} rl `run/rate.mjs` の `loadRate()` の戻り
     * @returns {void}
     */
    seedRate(rl) {
      if (latestRate !== null) return;
      if (!rl || typeof rl.at !== 'number') return;
      latestRate = rl;
    },

    /**
     * 台帳ぜんたいの様子。`/api/health` に出す。
     *
     * @returns {{active:number, total:number, seq:number, dropped:number}}
     */
    stats() {
      let active = 0;
      for (const r of runs.values()) if (!isRunOver(r.state)) active += 1;
      return { active, total: runs.size, seq, dropped };
    },
  };
}

/* ------------------------------------------------------------------ 合流 */

/**
 * 実行の状態を、一覧の語彙へ写す。
 *
 * 語彙が2つあるのは、見ているものが違うから。
 * `RUN_STATE_LABELS` は「この子プロセスがどうなっているか」、
 * `parse/state.mjs` の `STATE_LABELS` は「誰がボールを持っているか」を言っている。
 *
 * **写さずに run の語をそのまま `state` へ入れてはいけない。**
 * `STATE_RANK` にその語が無いので `?? 9` で一覧の末尾に沈み、
 * いま動いているセッションが最下部に並ぶ。
 *
 * `stalled`（無音）を `unknown`（rank 4）ではなく `awaiting-reply`（rank 2）へ
 * 写しているのは、あれが**人が見に行くべきもの**だから。不明の位置に沈めると気づけない。
 */
const RUN_TO_LIST_STATE = Object.freeze({
  starting: 'running',
  running: 'running',
  stopping: 'running',
  switching: 'running',
  waiting: 'awaiting-reply',
  stalled: 'awaiting-reply',
  // 許可待ちは承認待ちの位置（rank 1）。押さないと1行も進まないので、
  // 返信待ち（rank 2・放っておいても壊れない）と同じ高さに並べてはいけない。
  //
  // **写し先を変えるなら byStatus も一緒に立てる。** 下の overlay() / synthRow() を見ること。
  // 立てないと `notify/watch.mjs` の `requireByStatus` に当たって、
  // いちばん急ぐ状態だけが永久に鳴らなくなる（写す前は awaiting-reply の
  // `{slow:true, requireConfident:true}` で2分後に鳴っていた）
  'needs-permission': 'needs-approval',
  // 予算切れも「あなたの番」の位置。上げて続けるか止めるかを決めるのは人なので、
  // 待たせているものとして同じ高さに並べる
  budget: 'awaiting-reply',
  stopped: 'ended',
  failed: 'ended',
  done: 'ended',
});

/**
 * 台帳の行を、一覧の行に重ねる。
 *
 * **終わった run は状態を上書きしない。** 終わっていれば会話ログのほうが正しく、
 * `deriveState` が普通に判定できる。載せるのは「この画面から起こした」という事実だけ。
 *
 * @param {object} row 一覧の行
 * @param {object} run 台帳の行（`rows()` が返す粗い形）
 * @returns {object} 新しい行
 */
function overlay(row, run) {
  const badge = { ...run };
  if (isRunOver(run.state)) return { ...row, origin: 'deck', run: badge };

  const state = RUN_TO_LIST_STATE[run.state] ?? row.state;
  return {
    ...row,
    // headless の登録簿には `status` のキーが無く、`deriveState` の2段目・3段目が効かない。
    // 実測（2026-08-16）で、走っている最中の1本が `awaiting-reply` に見えていた
    alive: true,
    pid: run.pid ?? row.pid,
    state,
    // 画面には run の実態を出す（「あなたの番」「無音」など）。
    // 上の写しは並び順と色のためだけのもの
    stateLabel: run.stateLabel,
    ball: ballOf(state),
    // `state` を上書きするので、blocking も一緒に写す。片方だけだと1行の中で
    // `state:'needs-approval'` と `blocking:false` が矛盾し、`needsYou` が数え落とす
    blocking: isBlocking(state),
    // 台帳が正なので、ログの末尾から読んだ「待っているツール」は伏せる。
    // 残すと、実際には次の手へ進んでいるのに古い dangling が出続ける
    waitingFor: null,
    stateReason: run.reason ?? 'この画面から起こしたセッション',
    stateConfident: true,
    statusRaw: null,
    // 「登録簿の status が待ち系」ではなく「**止まっている裏づけがある**
    // （＝しきい値だけの推測ではない）」の意味で立てる。台帳は未応答の
    // `control_request` を実際に握っているので、登録簿より強い証人。
    // `statusRaw` は null のまま（あちらは別の問いに答えるフィールド）
    byStatus: run.state === 'needs-permission',
    origin: 'deck',
    run: badge,
  };
}

/**
 * 会話ログがまだ無い run から、一覧の行を組む。
 *
 * `view/shape.mjs` の `identity()` / `stateFields()` と同じキーを手で並べてある。
 * **あちらを import しない。** `run/` は末端の層で `view/` を見ないと決めてあるため。
 * 向きを崩すくらいなら、キーが2箇所に並ぶほうがまだ直しやすい。
 *
 * @param {object} run 台帳の行
 * @param {number} now 時刻
 * @returns {object} 一覧の行
 */
function synthRow(run, now) {
  const state = RUN_TO_LIST_STATE[run.state] ?? 'running';
  const cwd = run.cwd ?? null;
  const startedAt = Number.isFinite(run.startedAt) ? run.startedAt : null;

  return {
    // identity() と同じ並び
    sessionId: run.sessionId,
    pid: run.pid ?? null,
    name: run.sessionId ? run.sessionId.slice(0, 8) : '不明',
    cwd,
    project: projectNameOf(cwd),
    // 指示文は台帳が持っていない（`rows()` に載せていない）。
    // 会話ログが出れば次の走査で本物の見出しに入れ替わる
    title: null,
    permissionMode: run.permissionMode ?? null,
    mode: null,
    model: run.model ?? null,
    effort: run.effort ?? null,
    version: null,
    gitBranch: null,
    contextTokens: null,
    startedAt,
    alive: true,

    // stateFields() と同じ並び
    state,
    stateLabel: run.stateLabel,
    ball: ballOf(state),
    blocking: isBlocking(state),
    // **ここだけは動いてよい。** `refresh()` の差分判定が除外している2つなので、
    // 毎秒変わっても押し出しは起きない（それ以外の値は動かさない）
    idleMs: Number.isFinite(now) && startedAt !== null ? Math.max(0, now - startedAt) : null,
    lastActivityAt: startedAt,
    waitingFor: null,
    stateReason: 'この画面から起こしたセッション（会話ログはまだありません）',
    stateConfident: true,
    statusRaw: null,
    // 通知の鍵に混ざる値。**null にしない。**
    // `notify/watch.mjs` は返信待ちの鍵を `sessionId` ＋ `anchorId` で作るので、
    // ここが空だと鍵が生涯1つになり、2回目以降が黙って落ちる。
    // 会話ログが出れば overlay 側（ログ末尾の uuid）に入れ替わる
    anchorId: run.runId ?? null,
    // overlay() と同じ理由（「止まっている裏づけがある」）で立てる
    byStatus: run.state === 'needs-permission',

    // 一覧だけが使う項目
    nameSource: null,
    lastPrompt: null,
    lastAssistantText: null,
    skills: [],
    agents: [],
    subagentCount: null,
    parseErrors: 0,
    logFile: null,
    logSize: null,
    hasLog: false,
    // 稼働中は中身が薄くても必ず出す、と listSessions が決めている。それに合わせる
    substantive: true,

    origin: 'deck',
    run: { ...run },
  };
}

/**
 * 一覧に、この画面から起こしたぶんを重ねる。
 *
 * ## なぜ合流が要るか
 *
 * headless で立てても `sessions/<PID>.json` は書かれるが、**`status` のキーが無い**（実測）。
 * だから `deriveState` は末尾の行だけで状態を決めることになり、
 * 走っている最中でも「返信待ち」に見える。`parse/state.mjs` の規則は**1行も変えず**、
 * 台帳が知っている本当の状態をここで重ねて直す。
 *
 * ## 呼ぶ場所
 *
 * `server.mjs` の `refresh()`。**`view/` の中でやらない。**
 * `view/` と `run/` はお互いを import しない決まりなので、合成の場所はサーバーだけ。
 * 並べ直しは `view/sessions.mjs` の `sortRows` を使う（比較器を2箇所に書かない）。
 *
 * ## 足すのは生きているぶんだけ
 *
 * 終わった run でログが無いものは、行を合成しない。
 * 足すと、書庫にも詳細にも出せない幽霊行が `HISTORY_MAX` 件ぶん一覧に残る。
 * 起こしてすぐ失敗したものは実行パネルとフォームの帯に出るので、そちらで足りる。
 *
 * @param {Array<object>} rows 一覧の行（`listSessions` が返したもの）
 * @param {Array<object>} runRows 台帳の行（`runner.rows()`）
 * @param {number} [now] 時刻。合成行の `idleMs` にだけ使う
 * @returns {Array<object>} 重ねた新しい配列（並べ替えはしない）
 */
export function mergeRuns(rows, runRows, now = 0) {
  const base = Array.isArray(rows) ? rows : [];
  if (!Array.isArray(runRows) || runRows.length === 0) return base;

  // 同じ sessionId で2本あるなら、後から起こしたほうを採る。
  // `--resume` で起こし直すと、前の run が終端のまま履歴に残っているため
  const bySession = new Map();
  for (const run of runRows) {
    if (run?.sessionId) bySession.set(run.sessionId, run);
  }

  const merged = base.map((row) => {
    const run = row?.sessionId ? bySession.get(row.sessionId) : null;
    if (!run) return row;
    bySession.delete(row.sessionId);
    return overlay(row, run);
  });

  for (const run of bySession.values()) {
    if (isRunOver(run.state)) continue;
    merged.push(synthRow(run, now));
  }
  return merged;
}
