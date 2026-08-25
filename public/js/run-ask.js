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
 * `runs.js` は速報（run の出来事）を1件も持たない。seq の水位だけ進めて中身は捨てる。
 * 溜めていた頃も溢れたぶんは捨てていた（1ターンで数百行来る）ので、
 * どちらにせよ**要求を速報に載せると消えて二度と答えられない。**
 * 行（`rows`）は毎フレーム総入れ替えなので、取りこぼしが次のフレームで自己修復する。
 *
 * ## 送るのは「選んだ札」だけ
 *
 * 選択式の質問には `choices`（`{質問の番号: 札 | [札…]}`）を送る。
 * **`updatedInput` は組まない。** ツールの引数を画面から差し替えられるようにすると、
 * カードに出したコマンドと実際に走るコマンドを別にできてしまう。
 * 鍵が質問文でなく番号なのは、台帳が質問文を 200 字で切って渡してくるから
 * （切れた文字列を鍵にすると、長い質問が永久に答えられない）。
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

/**
 * 権限モードの言い方。ボタンの括弧に出す。
 *
 * `spec.mjs` の `PERMISSION_MODE_LABELS` とわざと重複させている（`RUN_OVER` と同じ切り方。
 * ここへ配るために `run-view.js` の選択肢を借りると向きができる）。
 * **括弧の中まで同じ言い方に揃える。** 片方だけ直すと、同じ語に別の説明が付く。
 */
const THEN_LABELS = {
  auto: 'auto mode — Claude が判断・危ないものだけ確認',
  acceptEdits: 'accept edits — ファイル変更は自動・コマンドは確認',
};

/** 本文の頭出し。長い Bash コマンドや差分をここで畳む。 */
const BODY_LIMIT = 1400;
/** 同上、行数のほう。 */
const BODY_LINES = 18;

/**
 * 送信中の askId。
 *
 * **成功しても `send()` は null に戻さない。** `runs` フレームで `row.asks` から
 * 消えるのを待つ。消す権利をサーバーだけが持てば「消えたのに答えられていない」が
 * 構造的に起きない。持たなければ、ずれない。
 *
 * **戻す場所は `askBlock()` の1箇所だけ。**（失敗したときの `failed()` を除く）
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
 * 質問の見出しを短く言う。足りないものを1行で伝えるときに使う。
 *
 * 質問文は台帳が 200 字まで載せてくるので、そのまま出すと
 * 「〜を選んでください」の1行がカードより長くなる。
 *
 * @param {object} q 質問1件
 * @returns {string}
 */
function qName(q) {
  if (q.header) return q.header;
  const t = q.question;
  return t.length > 24 ? `${t.slice(0, 24)}…` : t;
}

/**
 * 選択式の質問に答えるフォームを組んで、カードへ足す。
 *
 * **submit は全問まとめて1つ。** 質問ごとにボタンを置くと
 * 「1問目だけ送った」という**サーバー側に存在しない状態**を画面が作れてしまう。
 *
 * **`<form>` で囲まない。** 囲むと `textarea` の Enter が送信になる。
 * 「進める」を Enter で誤爆させるのが、この画面でいちばん危ない操作。
 * 送信は Ctrl+Enter（`run-form.js` の判定と同じ作法）。
 *
 * @param {HTMLElement} card 差し込み先のカード
 * @param {object} ctx `send()` に渡す文脈
 * @param {Array<object>} questions 台帳が載せた質問（`{key, question, header, multiSelect, options}`）
 * @param {Array<HTMLButtonElement>} btns ボタンの並び（呼び出し側が row へ入れる）
 */
function questionForm(card, ctx, questions, btns) {
  const groups = [];

  for (const q of questions) {
    const wrap = el('div', 'decision');
    // 見出しは質問より小さく出す。無いことがあるので、あるときだけ
    if (q.header) wrap.append(el('div', 'ask-head', q.header));
    wrap.append(el('div', 'decision-q', q.question));

    const ul = el('ul', 'choices');
    // 要求が入れ替わったとき、前のグループと name が衝突しないよう askId を混ぜる
    const name = `ask-${ctx.askId}-${q.key}`;
    const type = q.multiSelect ? 'checkbox' : 'radio';
    const boxes = [];

    const pick = (label, description) => {
      const li = el('li');
      const lab = el('label', 'ask-pick');
      const box = el('input');
      box.type = type;
      box.name = name;
      box.value = label;
      const text = el('span', 'ask-pick-text');
      text.append(el('span', 'label', label));
      if (description) text.append(document.createTextNode(` — ${description}`));
      lab.append(box, text);
      li.append(lab);
      ul.append(li);
      boxes.push(box);
      return { li, box };
    };

    for (const o of q.options ?? []) pick(o.label, o.description);

    // **「その他（自分で書く）」を必ず足す。** 選択肢に無いことを言いたい場面は必ずあり、
    // 無いと「断ってから言葉で伝える」しか道が残らない
    const other = pick('その他（自分で書く）', null);
    const free = el('textarea', 'settings-text ask-free');
    free.rows = 2;
    free.placeholder = 'ここに書く（Ctrl+Enter で答える）';
    free.spellcheck = false;
    free.hidden = true;
    other.li.append(free);

    wrap.append(ul);
    card.append(wrap);
    groups.push({ q, boxes, other: other.box, free });
  }

  const hint = el('p', 'settings-hint');
  const submit = button('この内容で答える', 'is-armed', () => {
    if (submit.disabled) return;
    send(ctx, { behavior: 'allow', choices: read() });
  });

  /** 選んだ札を `{番号: 札 | [札…]}` に組む。鍵は**番号**（質問文は切ってあるので鍵にできない） */
  const read = () => {
    const out = {};
    for (const g of groups) {
      const vals = [];
      for (const b of g.boxes) {
        if (!b.checked) continue;
        // 「その他」は箱の value ではなく、書いたものを送る
        if (b === g.other) {
          const t = g.free.value.trim();
          if (t) vals.push(t);
        } else {
          vals.push(b.value);
        }
      }
      out[g.q.key] = g.q.multiSelect ? vals : (vals[0] ?? '');
    }
    return out;
  };

  /**
   * 送れない理由を1行で返す。無ければ null。
   *
   * **押してから断られるより、開いた時点で分かるほうがよい**（`run-form.js` の `blockReason()` と同じ作法）。
   */
  const blocked = () => {
    for (const g of groups) {
      if (!g.boxes.some((b) => b.checked)) return `「${qName(g.q)}」を選んでください`;
      if (g.other.checked && !g.free.value.trim()) return `「${qName(g.q)}」の「その他」に書いてください`;
    }
    return null;
  };

  const refresh = () => {
    for (const g of groups) {
      // 「その他」を選んだときだけ書く欄を出す。畳んだままにすると、選んだのに書けない
      g.free.hidden = !g.other.checked;
      for (const b of g.boxes) b.closest('li')?.classList.toggle('is-picked', b.checked);
    }
    const why = blocked();
    hint.textContent = why ?? '';
    hint.hidden = why === null;
    submit.disabled = why !== null;
  };

  // `input` は radio / checkbox でも textarea でも飛ぶ。`change` と両方は要らない
  card.addEventListener('input', refresh);
  card.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || (!ev.ctrlKey && !ev.metaKey)) return;
    // 断る理由を書いている最中の Ctrl+Enter で「答える」を撃たない。
    // 断ろうとしている人が、押した覚えのない許可を出すことになる
    if (ev.target.classList?.contains('ask-why')) return;
    ev.preventDefault();
    submit.click();
  });

  refresh();
  btns.push(submit);
  return hint;
}

/**
 * 要求1件のカード。
 *
 * @param {string} runId 実行の識別子
 * @param {object} ask 台帳の行が持つ要求（`{id, kind, tool, detail, body, questions, suggestMode, at}`）
 * @returns {HTMLElement}
 */
function askCard(runId, ask) {
  const card = el('div', 'ask');
  const msg = el('p', 'settings-msg');
  msg.setAttribute('role', 'status');
  const btns = [];
  const ctx = { runId, askId: ask.id, card, msg, btns };
  // 台帳が選択肢の形に組めたときだけ入る。組めなかった版では `body` に落ちてくるので、
  // その場合は下の「言葉で伝える」カードになる（**未知の形で落ちない**）
  const questions = ask.kind === 'question' && Array.isArray(ask.questions) && ask.questions.length > 0
    ? ask.questions
    : null;

  // ── 何を訊かれているか
  if (ask.kind === 'plan') {
    // プランは Markdown のまま来る。切らずに全部描く（承認するかを決める場所なので）。
    // 画面が埋まらないよう、高さの上限は markdown.css の `.is-wait .md` が持つ
    if (ask.body) card.append(mdView(ask.body));
  } else if (questions) {
    // 質問文も選択肢もフォームが出す。ここで `detail` を出すと1問目が二重に並ぶ
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
  // 送れない理由の1行（選択式のときだけ questionForm が返す）
  let hint = null;
  // ボタンの下に置く案内。いまはツール許可のときだけ
  let foot = null;
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
  } else if (questions) {
    hint = questionForm(card, ctx, questions, btns);
    btns.push(button('断る', null,
      () => send(ctx, { behavior: 'deny', message: reason() })));
  } else if (ask.kind === 'question') {
    // 選択肢の形に組めなかったとき（原文の形が違う版など）。**それでもカードは出す。**
    // 出さないと、10分の時間切れまで無言で止まったように見える
    card.append(el('p', 'settings-hint',
      'この質問は選択肢の形が読めませんでした。'
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
    // **毎回訊かれるのを止める道を、訊かれている場所で言う。**
    // 押せる導線にしていないのは、実行パネル（`run-view.js`）の節点を掴む必要があり、
    // 「`run-view.js` とは向きを作らない」を崩すことになるため（`run-resume.js` と同じ線）
    foot = el('p', 'settings-hint',
      '毎回この確認を出したくないときは、入力欄の上にある「いま …」の札から替えられます。'
      + 'いまの子はそのまま続きます。');
  }

  row.append(...btns);
  card.append(why);
  if (hint) card.append(hint);
  card.append(row);
  if (foot) card.append(foot);
  card.append(msg);

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
  // 子が死んでいれば答え先が無い。要求が残っていても無いものとして扱う
  const asks = RUN_OVER.has(run.state) || !Array.isArray(run.asks) ? [] : run.asks;

  // **送信中の印を解くのはここだけ。** サーバーが要求を消したことを、行そのもので確かめる。
  // これが無いと、答えたあとに次の要求が来ても印が前の id のまま残り、
  // 続く `send()` が冒頭の即 return に食われて**押しても何も起きない**
  // （実測。質問が続けて来ると「この内容で答える」が無反応になり、リロードで直った）。
  if (sending && !asks.some((a) => a.id === sending)) sending = null;

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
  // 許可要求は定義上いつも「答えないと1行も進まない」ので、`row.blocking` を見ない。
  // このカードは台帳から直に組むので、一覧の行がまだ来ていない時期でも出る
  p.section.classList.add('is-block');
  p.body.append(el('p', 'note', guide.lead));
  if (asks.length > 1) {
    p.body.append(el('p', 'settings-hint', 'すべて答えるまで、この先へ進みません。'));
  }

  for (const ask of asks) p.body.append(askCard(run.runId, ask));
  return p.section;
}
