/* 許可要求のカード。画面から「許可する・断る」を押す場所。
 *
 * 層3。`runs.js`（層2）・`timeline/index.js`（層2）・`md-view.js`（層1）・
 * `panel.js`（層1）・`util.js`（層0）だけを見る。
 *
 * ## `run-view.js` に足さない
 *
 * 行数ではなく**ライフサイクルが違う**から。あちらの `ops` は
 * 「入力中のテキスト」「開いた `<details>`」「速報の水位」を溜めて、
 * 詳細ペインが作り直されても壊れないようにしている＝**追記され続けるものを守る**作り。
 *
 * 要求カードは正反対。追記されない。答えたら消える。守るべき状態は
 * 「送信中の askId」1つだけ。混ぜると `applyEnabled()` の `ops.busy || ops.over` に
 * 性質の違う4つ目が入り、`setBusy(true)` が要求カードのボタンまで殺すかどうかの
 * 判断が毎回要ることになる。`run-resume.js` が `run-view.js` を import せず
 * `RUN_OVER` をあえて重複させているのと同じ線。
 *
 * ## 要求は「行」から読む。速報からは読まない
 *
 * `runs.js` の器は2つで、`events` は `EVENTS_PER_RUN = 400` で溢れたぶんを捨てる。
 * 1ターンで数百行来るので、そこに要求を載せると**要求そのものが消えて二度と答えられない。**
 * 行（`rows`）は毎フレーム総入れ替えなので、取りこぼしが次のフレームで自己修復する。
 *
 * ## 消す権利はサーバーだけが持つ
 *
 * 押しても画面はカードを消さない。`row.asks` から消えるのを待つ。
 * 先に消すと、サーバー側で失敗していたときに
 * **「消えたのに答えられていない」**という最悪の状態になる。
 */
import { el } from './util.js';
import { mdView } from './md-view.js';
import { bodyText } from './timeline/index.js';
import { panel, SEC } from './panel.js';
import { runFor } from './runs.js';

/**
 * 子がもういない状態。
 *
 * **`run-view.js` から import しない。** あちらとこちらは層が同じで、
 * 向きを作ると層3の中に依存が1本増える。`run-resume.js` が同じ判断をしている。
 */
const RUN_OVER = new Set(['stopped', 'failed', 'done']);

/** 聞かれ方ごとの、見出しと「何を決めるのか」。 */
const ASK_GUIDE = {
  plan: { title: 'プランを承認する', lead: 'この計画で進めてよいかを決めてください' },
  question: { title: '質問に答える', lead: '選択肢を選ぶまで、この先へ進みません' },
  tool: { title: '実行を許可する', lead: 'このツールを実行してよいかを決めてください' },
};

/** 権限モードの言い方。ボタンの括弧に出す。 */
const THEN_LABELS = {
  auto: 'auto — Claude が判断・危ないものだけ確認',
  acceptEdits: 'auto-accept edits — ファイルの変更まで自動で通す',
};

/** 本文の頭出し。長い Bash コマンドや差分をここで畳む。 */
const BODY_LIMIT = 1400;
/** 同上、行数のほう。 */
const BODY_LINES = 18;

/**
 * 送信中の askId。
 *
 * **成功しても null に戻さない。** `runs` フレームで `row.asks` から消えて
 * カードごと消えるのを待つ。持たなければ、ずれない。
 */
let sending = null;
/** @type {{askId: string, text: string}|null} 直近の失敗。1回だけ出す */
let lastFail = null;

/**
 * 押せる姿へ戻して、理由を出す。
 *
 * @param {object} ctx 送信中の文脈
 * @param {string} text 出す理由
 * @returns {void}
 */
function failed(ctx, text) {
  lastFail = { askId: ctx.askId, text };
  sending = null;
  ctx.card.classList.remove('is-sending');
  for (const b of ctx.btns) b.disabled = false;
  ctx.msg.textContent = text;
  ctx.msg.dataset.tone = 'bad';
}

/**
 * 答えを送る。
 *
 * `run-view.js` の `post()` と同じ作法で、`await` の後に**自分の番かを確かめてから書く。**
 * 確かめずに書くと、返ってくるまでに別のセッションへ移っていたとき
 * 他人の画面へ結果を書き込むことになる。
 *
 * @param {object} ctx `{runId, askId, card, msg, btns}`
 * @param {object} body 窓口へ渡す中身
 * @returns {Promise<void>}
 */
async function send(ctx, body) {
  if (sending) return;
  sending = ctx.askId;
  lastFail = null;

  ctx.card.classList.add('is-sending');
  for (const b of ctx.btns) b.disabled = true;
  ctx.msg.textContent = '送っています…';
  ctx.msg.dataset.tone = '';

  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(ctx.runId)}/answer`, {
      method: 'POST',
      // 付け忘れると書き込み口の門番に断られる
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: ctx.askId, ...body }),
    });
    const data = await res.json().catch(() => null);
    // 返ってくるまでに別の要求へ移っていることがある
    if (sending !== ctx.askId) return;

    if (!res.ok || !data?.ok) {
      failed(ctx, data?.reason ?? `送れませんでした（HTTP ${res.status}）`);
      return;
    }
    // ここでカードを消さない。消すのはサーバー（次の runs フレーム）
    ctx.msg.textContent = '送りました。反映を待っています…';
    ctx.msg.dataset.tone = 'good';
  } catch (err) {
    if (sending !== ctx.askId) return;
    failed(ctx, `送れませんでした（${err.message}）`);
  }
}

/**
 * ボタンを1つ作る。
 *
 * @param {string} label 出す文字
 * @param {string|null} className 追加のクラス
 * @param {Function} onClick 押したとき
 * @returns {HTMLButtonElement}
 */
function button(label, className, onClick) {
  const b = el('button', className ? `btn ${className}` : 'btn', label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/**
 * 要求1件のカード。
 *
 * @param {string} runId 実行の識別子
 * @param {object} ask 台帳の行が持つ要求（`{id, kind, tool, detail, body, suggestMode, at}`）
 * @returns {HTMLElement}
 */
function askCard(runId, ask) {
  const card = el('div', 'ask');
  const msg = el('p', 'settings-msg');
  msg.setAttribute('role', 'status');
  const btns = [];
  const ctx = { runId, askId: ask.id, card, msg, btns };

  // ── 何を訊かれているか
  if (ask.kind === 'plan') {
    // プランは Markdown のまま来る。切らずに全部描く（承認するかを決める場所なので）。
    // 画面が埋まらないよう、高さの上限は markdown.css の `.is-wait .md` が持つ
    if (ask.body) card.append(mdView(ask.body));
  } else {
    if (ask.tool) card.append(el('div', 'wait-tool', ask.tool));
    if (ask.detail) card.append(el('pre', null, ask.detail));
    // 本文は長いことがある（差分・巨大な引数）。頭出しにして残りは畳む
    if (ask.body && ask.body !== ask.detail) {
      for (const node of bodyText(ask.body, BODY_LIMIT, BODY_LINES)) card.append(node);
    }
  }

  // ── どう答えるか
  const row = el('div', 'ask-btns');
  const why = el('input', 'settings-text ask-why');
  why.type = 'text';
  // 空でも送れる。止めたいときに文章を考えさせない
  why.placeholder = '断る理由（任意）';
  why.spellcheck = false;
  const reason = () => why.value.trim();

  if (ask.kind === 'plan') {
    // **承認したまま plan に留まる道を出さない。** ここが今回のバグへの画面側の対処で、
    // 承認と権限モードの移動を1つのボタンに束ねれば、
    // 「承認したのに書けない」を人が選べなくなる。
    // <select> にしないのは、選ばないと既定（plan）のまま事故がそのまま残るから
    for (const mode of ['auto', 'acceptEdits']) {
      btns.push(button(`Yes（${THEN_LABELS[mode]}）`, 'is-armed',
        () => send(ctx, { behavior: 'allow', then: mode })));
    }
    btns.push(button('No（プランを直す）', null,
      () => send(ctx, { behavior: 'deny', message: reason() })));
  } else if (ask.kind === 'question') {
    // 段1では選択肢を組み立てない（段2でやる）。**それでもカードは出す。**
    // 出さないと、10分の時間切れまで無言で止まったように見える
    card.append(el('p', 'settings-hint',
      '選択肢を選んで答えるのは、まだこの画面からはできません。'
      + '断ったうえで、下の入力欄から言葉で伝えてください。'));
    btns.push(button('断る', null,
      () => send(ctx, { behavior: 'deny', message: reason() })));
  } else {
    btns.push(button('今回だけ許可', 'is-armed',
      () => send(ctx, { behavior: 'allow' })));
    // **助言が来たときだけ出す。** `~/.claude` へ書く行き先（userSettings）は
    // 台帳が落としてあるので、ここへ来るのはそのセッション限りのものだけ
    if (ask.suggestMode && THEN_LABELS[ask.suggestMode]) {
      btns.push(button(`今後も許可（${THEN_LABELS[ask.suggestMode]}）`, null,
        () => send(ctx, { behavior: 'allow', then: ask.suggestMode })));
    }
    btns.push(button('断る', null,
      () => send(ctx, { behavior: 'deny', message: reason() })));
  }

  row.append(...btns);
  card.append(why, row, msg);

  // 直前に失敗したものだけ、作り直したあとも理由を出す
  if (lastFail?.askId === ask.id) {
    msg.textContent = lastFail.text;
    msg.dataset.tone = 'bad';
  }
  return card;
}

/**
 * 許可待ちのパネル。**この画面から起こした実行のときだけ返す。**
 *
 * ターミナル側で動いているセッションでは `runFor()` が null を返すので、
 * 1行も新しいコードを通らない。見た目が今までと変わらないことが構造で保証される。
 *
 * @param {object} row 一覧の1行
 * @returns {HTMLElement|null} 答えるものが無ければ null
 */
export function askBlock(row) {
  const run = runFor(row?.sessionId);
  if (!run) return null;
  // 子が死んでいる。答え先が無い
  if (RUN_OVER.has(run.state)) return null;
  const asks = Array.isArray(run.asks) ? run.asks : [];
  if (asks.length === 0) return null;

  // 見出しは1件目に合わせる。並列のツール呼び出しでは複数まとめて来るが、
  // 状態を3つに割ると遷移の組み合わせが3倍になるので、割らずに札だけ変える
  const guide = ASK_GUIDE[asks[0].kind] ?? ASK_GUIDE.tool;
  const p = panel(`あなたの番 — ${guide.title}`, {
    id: SEC.wait,
    tone: 'hot',
    count: asks.length > 1 ? `${asks.length} 件` : null,
  });
  p.section.classList.add('is-wait');
  p.body.append(el('p', 'note', guide.lead));
  if (asks.length > 1) {
    p.body.append(el('p', 'settings-hint', 'すべて答えるまで、この先へ進みません。'));
  }

  for (const ask of asks) p.body.append(askCard(run.runId, ask));
  return p.section;
}
