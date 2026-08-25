/* この画面から起こした実行のパネル。
 *
 * 層3。detail-panels.js・agents.js・usage-panel.js と同格で、返す形も同じ（節点か null）。
 *
 * ## 中だけ差し替える
 *
 * 詳細ペインは detailKeyOf() が動いたときだけ作り直す。速報は1ターンで数百行来るので、
 * それを鍵に混ぜると開いた <details>・スクロール位置・入力中の caret が毎回消える。
 * だから timeline/ と同じ形にして、器（.run-log）を attach() で預け、
 * render() が**新しく届いたぶんだけ追記**する。
 *
 * 全部作り直さないのは、出来事が増えるだけで前の行は動かないから。
 * 全消し＋再構築にすると、行数が増えるほど描き直しが重くなる。
 *
 * ## 操作の器も使い回す
 *
 * 送る・止める・替えるの節点も module-level に1つだけ持ち、作り直すたびに append し直す。
 * document から外れても <textarea> の value と <details> の開閉は消えないので、
 * 詳細ペインが丸ごと作り直されても書きかけの文が残る。
 * 焦点だけは外れるので、detach() で控えて runPanel() の最後に戻す。
 *
 * ## 速報であって正本ではない
 *
 * ここに出るのは「いま何が起きているか」。読み返す正本は ~/.claude/projects/ の会話ログで、
 * そちらは同じ詳細ペインの時系列パネルが描く。同じものを2通りに描かない。
 */
import { el, dur, stamp, shortModel, fact } from './util.js';
import { panel, SEC } from './panel.js';
import {
  runFor, eventsOf, droppedOf, runsMissed, EVENTS_PER_RUN, EFFORT_LABELS,
  MODEL_FREE, modelOptions, modelPick, modelValue,
} from './runs.js';
import { bodyText } from './timeline/index.js';

/** 地の文の頭出し。これを超えたら <details> に畳む（時系列と同じ作法）。 */
const TEXT_LIMIT = 600;
const TEXT_LINES = 10;

/** 出来事の種類の名前。ここに無いものは kind をそのまま出す。 */
const EVENT_LABELS = {
  init: '開始',
  text: 'Claude',
  tool: '道具',
  'tool-result': '結果',
  echo: 'あなた',
  result: '1往復の終わり',
  note: '記録',
  hook: 'フック',
  other: 'その他',
  broken: '読めなかった行',
};

/**
 * 「実行されなかった理由」の名前。
 *
 * 実測で出たのは `permission-rule` の1種類だけ（自分が `control_response` で断ったとき）。
 * **ここに無い語はそのまま出す。** 版が上がって新しい語が来た日に、
 * 知らない語を黙って捨てると「エラーになった」としか見えなくなる。
 */
const NON_EXEC_LABELS = {
  'permission-rule': 'あなたが断ったので実行されていません',
};

/**
 * 状態に応じたパネルの色。
 *
 * 色を付けるのは待たせているときと、うまくいっていないときだけ。
 * 実行中に色を付けると、動いている＝急ぎに見えて一覧の状態色と意味がぶつかる。
 */
function toneOf(state) {
  if (state === 'waiting') return 'hot';
  // 予算切れを `hot`（あなたの番）にしない。あちらは送れば進むが、
  // こちらは上限を上げるか、同じ上限でもう一度回すと決めないと1行も動かない
  if (state === 'stalled' || state === 'failed' || state === 'budget') return 'warn';
  return null;
}

/** 出来事1件の中身。kind ごとに形が違う。 */
function bodyOf(ev) {
  switch (ev.kind) {
    case 'text':
    case 'echo':
      return bodyText(ev.text, TEXT_LIMIT, TEXT_LINES);

    case 'tool': {
      const line = el('div', 'run-tool');
      line.append(el('span', 'run-tool-name', ev.tool ?? '(名前なし)'));
      // detail は材料が無ければ null で来る。空文字に丸めない
      if (ev.detail) line.append(el('span', 'run-tool-detail', ev.detail));
      return [line];
    }

    case 'tool-result': {
      const out = [];
      // **断ったものはエラーの赤で出さない。** こちらが断った結果は `is_error:true` で返るので
      // （実測。`stream.mjs` の `nonExecutionOf` を見ること）、印を見ずに色を付けると
      // 「自分で止めた」と「向こうが壊れた」が画面で同じ顔になる
      if (ev.nonExecution) out.push(el('div', 'run-skip', NON_EXEC_LABELS[ev.nonExecution] ?? `実行されませんでした（${ev.nonExecution}）`));

      const line = el('div', 'run-out');
      if (ev.isError && !ev.nonExecution) line.classList.add('is-error');
      // 中身が空でも「返ってきた」ことは伝える（黙って空行にしない）
      line.textContent = ev.text || (ev.isError ? '（エラー。中身なし）' : '（中身なし）');
      out.push(line);
      return out;
    }

    case 'init': {
      const dl = el('dl', 'facts');
      fact(dl, 'モデル', shortModel(ev.model));
      fact(dl, '権限', ev.permissionMode);
      fact(dl, 'フォルダ', ev.cwd);
      fact(dl, '道具', Array.isArray(ev.tools) ? `${ev.tools.length} 種` : null);
      return dl.childElementCount > 0 ? [dl] : [];
    }

    case 'result':
      return resultBody(ev);

    case 'note':
      return [el('div', 'run-note', ev.text ?? '')];

    case 'broken':
      return [el('div', 'run-out is-error', ev.sample ? `読めなかった行: ${ev.sample}` : '読めなかった行')];

    case 'hook': {
      const line = el('div', 'run-tool');
      line.append(el('span', 'run-tool-name', ev.name ?? ev.event ?? '(名前なし)'));
      // ok が null なのは「成功か分からなかった」。そのときは何も言わない（成功と書かない）
      if (ev.ok === false) {
        const code = typeof ev.exitCode === 'number' ? `失敗（code ${ev.exitCode}）` : '失敗';
        line.append(el('span', 'run-tool-detail is-error', code));
      }
      const out = [line];
      // フックの出力は拾っていない（数KBあるため）。stderr だけは出す。壊れたときの唯一の手がかり
      if (ev.stderr) out.push(el('div', 'run-out is-error', ev.stderr));
      return out;
    }

    case 'other':
      return [el('div', 'run-other', [ev.type, ev.subtype].filter(Boolean).join(' / ') || '(型なし)')];

    default:
      // 知らない kind が来ても行ごと消さない。見出しだけは出ている
      return [];
  }
}

/** 1往復の終わり。数字の意味が種類で違うので、ラベルで書き分ける。 */
function resultBody(ev) {
  const out = [];
  if (ev.text) out.push(...bodyText(ev.text, TEXT_LIMIT, TEXT_LINES));

  const dl = el('dl', 'facts');
  fact(dl, 'かかった時間', typeof ev.durationMs === 'number' ? dur(ev.durationMs) : null);
  // num_turns は**そのターンぶん**の数（実測で2往復目も 1）。累積ではない
  fact(dl, 'このターンの往復', ev.numTurns);
  // total_cost_usd のほうは累積（実測 0.803025 → 0.843727）。同じ行に並んでいるので混ぜやすい。
  //
  // ただし**累積するのは同じ子のあいだだけ。**「権限モード・モデルを替える」の建て直し側は子を起こし直すので、
  // そこで起点に戻る（実測 0.401036 → 切り替え後の最初の result で 0.130617）。
  // だから「ここまで」とは書かない。切り替えを挟んだぶんは、並んだ result を足したものが合計になる
  fact(dl, 'この起動ぶんの費用', typeof ev.costUSD === 'number' ? `$${ev.costUSD.toFixed(4)}` : null);
  // そのターンで考えた量。台帳が刻みを畳んだもの（速報には1件も並ばない）。
  // 0 は「考えなかった」で不明ではないので、そのまま出す
  fact(dl, '考えた量', typeof ev.thinkingTokens === 'number' ? `${ev.thinkingTokens.toLocaleString()} トークン` : null);
  fact(dl, '止まった理由', ev.terminalReason);
  // 断ったものが無いときは行ごと出さない。0 を隠すのは「取れなかった」ではなく
  // 「起きなかった」ので、0 と不明を分ける原則には触れない
  fact(dl, '断ったツール', ev.denials || null);
  if (dl.childElementCount > 0) out.push(dl);

  // errors の中身の形は実測できていない。文字にして出すだけにして、黙って落とさない
  if (Array.isArray(ev.errors) && ev.errors.length > 0) {
    const text = ev.errors.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n');
    out.push(el('div', 'run-out is-error', text));
  }
  return out;
}

/** 出来事1件の節点。 */
function eventNode(ev) {
  const wrap = el('div', 'run-ev');
  wrap.dataset.kind = ev.kind;
  // サブエージェントの行は親の発言と混ざって並ぶ。どちらが本流か分かるように下げる
  if (ev.sub) wrap.classList.add('is-sub');

  const head = el('div', 'run-ev-head');
  if (ev.at) head.append(el('span', 'run-ev-at', stamp(ev.at).slice(11)));
  head.append(el('span', 'run-ev-kind', EVENT_LABELS[ev.kind] ?? ev.kind));
  if (ev.sub) head.append(el('span', 'run-ev-sub', 'サブ'));
  wrap.append(head);

  for (const node of bodyOf(ev)) wrap.append(node);
  return wrap;
}

/** 実行の見出しに出す情報。状態が変わるまで動かない値だけを並べる。 */
function factsOf(row) {
  const dl = el('dl', 'facts');
  fact(dl, 'モデル', shortModel(row.model));
  fact(dl, '思考の深さ', row.effort);
  fact(dl, '権限', row.permissionMode);
  fact(dl, 'フォルダ', row.cwd);
  fact(dl, '始めた時刻', row.startedAt ? stamp(row.startedAt) : null);
  fact(dl, 'PID', row.pid);
  fact(dl, '往復', row.turns);
  // 0 が正常終了。fact が落とすのは null / undefined / 空文字だけなので、0 はそのまま出る
  // （util.js の tokens() と違って `if (!n)` ではない。ここは 0 と不明が別物として出る）
  fact(dl, '終了コード', row.exitCode);
  // 枠の使用率（CLI の `/usage` と同じもの）。API を叩くたびに届くが、
  // 値そのものはめったに動かないので、ここが描き直されるまで古いままでも実害が無い
  fact(dl, '枠の使用率', rateText(row.rateLimit));
  // CLI が stderr へ吐いた直近の1行。普段は無いので欄ごと出ない。
  // 出ているときは、たいていこちら側の配線が間違っている合図
  fact(dl, 'CLI の警告', row.lastStderr);
  fact(dl, '理由', row.reason);
  return dl;
}

/**
 * 枠の使用率を1行にする。
 *
 * `utilization` は 0〜1 の割合で届く（実測 0.06 / 0.69）。百分率にするのはここ。
 * **どちらも取れていなければ行ごと出さない**（`fact` が null を落とす）。
 *
 * @param {object|null|undefined} rl `{fiveHour, sevenDay, resetsAt}`
 * @returns {string|null}
 */
function rateText(rl) {
  if (!rl) return null;
  const pct = (v) => (typeof v === 'number' ? `${Math.round(v * 100)}%` : null);
  const parts = [];
  const h5 = pct(rl.fiveHour);
  const d7 = pct(rl.sevenDay);
  if (h5) parts.push(`5時間枠 ${h5}`);
  if (d7) parts.push(`7日枠 ${d7}`);
  if (parts.length === 0) return null;
  // resetsAt は**秒**の unix 時刻（実測）。ミリ秒として渡すと 1970 年になる
  if (typeof rl.resetsAt === 'number') parts.push(`次に空くのは ${stamp(rl.resetsAt * 1000).slice(5)}`);
  return parts.join(' / ');
}

/* ── 描く先を預かる。外から中の状態を触らせない ───────────────── */

/** @type {{log: HTMLElement, drop: HTMLElement, runId: string, seq: number}|null} */
let cur = null;

/**
 * 描く先を預ける。
 *
 * @param {{log: HTMLElement, drop: HTMLElement, runId: string}} opts
 */
export function attach(opts) {
  cur = { log: opts.log, drop: opts.drop, runId: opts.runId, seq: 0 };
}

/**
 * 預かった先を手放す。
 *
 * detail.js が詳細ペインを作り直す直前に呼ぶ。
 * 呼ばないと、画面から外れた節点を掴んだまま追記し続けることになる。
 */
export function detach() {
  // 焦点はここで控える。detail.js はこの直後に replaceChildren() するので、
  // 掴んでいた節点が document から外れ、焦点が body へ飛ぶ
  saveFocus();
  cur = null;
}

/** 下端に張り付いているか。人が上へスクロールして読んでいるあいだは動かさない。 */
function atBottom(host) {
  return host.scrollHeight - host.scrollTop - host.clientHeight < 40;
}

/**
 * 落とした件数の行。増えるので毎回書き換える。
 *
 * 黙って捨てない。ここが空欄のままだと「全部見えている」と読めてしまう。
 */
function syncDrop(node, runId) {
  const parts = [];
  const drop = droppedOf(runId);
  const lost = runsMissed();
  if (drop > 0) parts.push(`古い ${drop} 件は画面から落としました`);
  // つなぎ直しの取りこぼしは実行ごとに数えていない。全体の数だとそのまま書く
  if (lost > 0) parts.push(`つなぎ直しのあいだに ${lost} 件を取りこぼしました（全実行ぶん）`);
  node.textContent = parts.join('　');
  node.hidden = parts.length === 0;
}

/**
 * 新しく届いたぶんを追記する。
 *
 * 何度呼ばれても、前に出したところから先だけを足す。
 */
export function render() {
  if (!cur) return;

  syncDrop(cur.drop, cur.runId);

  const all = eventsOf(cur.runId);
  const fresh = all.filter((ev) => ev.seq > cur.seq);
  if (fresh.length === 0) {
    if (all.length === 0 && cur.log.childElementCount === 0) {
      cur.log.append(el('div', 'run-empty', 'まだ何も届いていません。'));
    }
    return;
  }

  const empty = cur.log.querySelector('.run-empty');
  if (empty) empty.remove();

  const first = cur.seq === 0;
  const stick = first || atBottom(cur.log);

  for (const ev of fresh) {
    cur.log.append(eventNode(ev));
    cur.seq = ev.seq;
  }
  // 画面に残す数は runs.js が持つぶんと同じにする。DOM だけ無限に伸びない
  while (cur.log.childElementCount > EVENTS_PER_RUN) cur.log.removeChild(cur.log.firstElementChild);

  if (!stick) return;
  if (first) {
    // 初回は detail.js がまだ document へ付ける前に呼ぶので、この場では高さが取れない。
    // 次の描画まで待ってから下端へ寄せる
    const log = cur.log;
    requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
    return;
  }
  cur.log.scrollTop = cur.log.scrollHeight;
}

/* ── 操作（送る・止める・替える）───────────────────────────── */

/**
 * もう手を出せない状態。
 *
 * サーバー側（run/index.mjs の isRunOver）と同じ3つにしてある。
 * **stopping と switching を入れない。** どちらも途中の姿で、そこから running へ戻る。
 * **budget（予算切れ）も入れない。** 上限を上げれば続けられるので、
 * ここに入れると3つのボタンが全部落ちて出口が無くなる。
 */
const RUN_OVER = new Set(['stopped', 'failed', 'done']);

/**
 * 子プロセスがもういない状態。**終わったもの ＋ 予算切れ。**
 *
 * 予算切れは終端ではない（続きから起こし直せる）が、子は死んでいる。
 * だから撃つ（`/mode`）ことはできず、建て直す（`/switch`）しかない。
 * サーバー側の `isChildDone` と同じ線で、あちらと同じく `RUN_OVER` とは分けてある。
 */
const RUN_NO_CHILD = new Set([...RUN_OVER, 'budget']);

/**
 * 割り込める状態。**「子が生きている」より狭い。**
 *
 * `waiting`（あなたの番）には割り込む先の作業が無いし、`needs-permission` は
 * 答えれば進むので、割り込むより答えるほうが正しい。`stalled` を入れてあるのは、
 * あれが「2分出力が無い」だけで走ってはいるから（圧縮の最中がここに入る）。
 */
const RUN_WORKING = new Set(['running', 'stalled']);

/**
 * 割り込みが撃てることを CLI が名乗る印。`src/run/ledger.mjs` の `INTERRUPT_CAP` と同じ語。
 *
 * **画面は名乗ったときだけ札を出す。** サーバーは名乗りが無い（null）ときも撃たせるが、
 * あれは「不明を不可と読まない」ための逃げ道で、こちらは押せる顔をした押せないボタンを
 * 出さないほうを採る。名乗る版なら init が来た時点で出るので、待つのは一瞬。
 */
const INTERRUPT_CAP = 'interrupt_receipt_v1';

/**
 * 子を殺さずに替えられる項目。サーバーの `LIVE_FIELDS` と同じ並び。
 *
 * **思考量と上限はここに無い。** 思考量は `--effort` の語とあちらが欲しいトークン数の
 * 対応が測れておらず、上限は argv でしか渡せない。どちらも建て直しが要る。
 */
const LIVE_KEYS = new Set(['permissionMode', 'model']);

/**
 * 見出しに出す状態の札。
 *
 * 一覧のカードと同じ `.state`（点 ＋ 太字 ＋ 状態色）を借りる。**見た目を新しく作らない。**
 * 素の `.count` に乗せていたときは `--fg-faint` の細字だったので、
 * このパネルでいちばん知りたいもの（いまどうなっているか）がいちばん薄く出ていた。
 *
 * 予算切れだけは点ではなく「$」の印にする（`run.css` の `[data-mark]`）。
 * 一覧では `awaiting-reply`（あなたの番）の位置に置いていて色も同じ `--warn` なので、
 * 点のままだと札の文字を読むまで見分けが付かない。
 *
 * @param {object} row 台帳の行
 * @returns {HTMLElement}
 */
function stateBadge(row) {
  const badge = el('span', 'state', row.stateLabel ?? row.state);
  // 色は必ず変数経由で取る（一覧の STATE_COLOR と同じ渡し方）。
  // 色が付かない状態は、動いているか・もう動かないかの2つに分ける
  const tone = toneOf(row.state);
  const color = tone ? `var(--${tone})` : (RUN_OVER.has(row.state) ? 'var(--off)' : 'var(--calm)');
  badge.style.setProperty('--state-color', color);
  if (row.state === 'budget') badge.dataset.mark = 'budget';
  return badge;
}

/** 替えたものの言い方。サーバーは changed を**キー名の配列**で返す。 */
const SWITCH_LABELS = {
  model: 'モデル', effort: '思考量', permissionMode: '権限モード', budgetUsd: '予算',
};

/** 「止める」の2段押し。1回目からこの時間で元へ戻る。 */
const STOP_CONFIRM_MS = 5000;

/**
 * 控えた焦点を戻してよい猶予。
 *
 * detach() と作り直しは同じタスクの中で続けて起きるので、これで足りる。
 * 短く切ってあるのは、detach() だけ呼ばれて runPanel() が呼ばれなかったとき
 * （実行パネルごと消えたとき）に、後から関係のない場所へ焦点を飛ばさないため。
 */
const FOCUS_MEMO_MS = 400;

/**
 * 切り替えの選択肢。**1回だけ引く。**
 *
 * 取れなければ替える札を出さないだけで、送る・止めるはそのまま動く。
 * 引き直さないのは「窓口ごと無いと分かったら一度で諦める」の作法
 * （更新の前後で、画面だけ新しくサーバーが古いことがある）。
 */
let runOptions = null;
let optionsAsked = false;

/**
 * 操作の器。**module-level に1つだけ持って使い回す。**
 *
 * 詳細ペインは detailKeyOf() が動くと丸ごと作り直されるが、
 * document から外れても <textarea> の value は消えない。
 * だから作り直しのたびに同じ節点を append し直すだけにしてある。
 *
 * **節点は2つとも詳細ペインの外にいる。** `bar` は index.html の中央下の器へ、
 * `dlg` は document.body へ直接付ける。作り直しに巻き込まれる道がそもそも無い。
 *
 * @type {null | {
 *   bar: HTMLElement, prompt: HTMLTextAreaElement, send: HTMLButtonElement,
 *   brk: HTMLButtonElement, stop: HTMLButtonElement, msg: HTMLElement,
 *   now: HTMLButtonElement, nowMode: HTMLElement, nowModel: HTMLElement, nowNote: HTMLElement,
 *   dlg: HTMLDialogElement, swModelPick: HTMLSelectElement, swModel: HTMLInputElement,
 *   swEffort: HTMLSelectElement, swMode: HTMLSelectElement, swBudget: HTMLInputElement,
 *   apply: HTMLButtonElement, swHow: HTMLElement, swPending: HTMLElement, swMsg: HTMLElement,
 *   runId: string|null, busy: boolean, over: boolean,
 *   stopArmed: boolean, stopTimer: number|null, lastRow: object|null
 * }}
 */
let ops = null;

/** 控えた焦点。detach() で控え、runPanel() の最後に戻す。 */
let focusMemo = null;

/**
 * <select> の中身を組み直す。
 *
 * 起こすフォーム（層7）にも同じ形の小道具があるが、あちらを import すると
 * 層3 → 層7 の逆向きになる。10行に満たないのでこちらに持つ
 * （共有するなら層0の util.js へ出すことになり、そちらのほうが影響が広い）。
 *
 * @param {HTMLSelectElement} sel
 * @param {Array<{value: string, label: string}>} items
 */
function fillSelect(sel, items) {
  sel.replaceChildren();
  for (const it of items) {
    const opt = el('option', null, it.label);
    opt.value = it.value;
    sel.append(opt);
  }
}

/**
 * 3列のグリッドに1行足す。設定モーダルの .settings-grid をそのまま借りている。
 *
 * @param {HTMLElement} grid 入れ先
 * @param {string} id 入力の id。ラベルと結ぶ
 * @param {string} text ラベル
 * @param {HTMLElement} control 入力。器（複数の入力をまとめた span）でもよい
 * @param {string} hint 右に置く説明
 * @param {string} [forId] 器を渡すとき、ラベルと結ぶ中の入力の id
 */
function gridRow(grid, id, text, control, hint, forId = '') {
  const lb = el('label', 'settings-label', text);
  if (forId) {
    lb.htmlFor = forId;
  } else {
    control.id = id;
    lb.htmlFor = id;
  }
  grid.append(lb, control, el('p', 'settings-hint', hint));
}

/**
 * 一言出す。空文字で消える。
 *
 * **入力欄の下とモーダルの中の両方へ書く。** 替えるのはモーダルの中で押すが、
 * うまくいったらモーダルは閉じるので、結果は入力欄の下に残っていないと読めない。
 * 分けて書き分けると、どちらへ出すかの判断が呼ぶ側それぞれに増える。
 */
function say(text, tone = '') {
  for (const node of [ops.msg, ops.swMsg]) {
    node.textContent = text;
    node.dataset.tone = text ? tone : '';
  }
}

/** ボタンの入切をまとめて当てる。 */
function applyEnabled() {
  const off = ops.busy || ops.over;
  ops.send.disabled = off;
  ops.stop.disabled = off;
  ops.apply.disabled = off;
  // 終わっている実行は替えようが無い。押せる顔のまま断るより、押せなくしておく
  ops.now.disabled = off;

  // 割り込みは「名乗っている」かつ「いま走っている」ときだけ。
  // 出す・出さないを行ごとに決めるので、状態は `lastRow` から読む
  const row = ops.lastRow;
  const named = Array.isArray(row?.capabilities) && row.capabilities.includes(INTERRUPT_CAP);
  ops.brk.hidden = !named;
  ops.brk.disabled = off || !RUN_WORKING.has(row?.state) || row?.interrupting === true;
  ops.brk.textContent = row?.interrupting === true ? '割り込んでいます…' : '割り込む';
}

/**
 * 送信中の入切。
 *
 * **入力欄は disabled にしない。** 押している最中に caret が飛び、
 * 待っているあいだに続きを書き足せなくなる。落とすのはボタンだけでよい。
 */
function setBusy(on) {
  ops.busy = on;
  applyEnabled();
}

/**
 * 替える中身を組む。**いまと同じ値はキーごと送らない。**
 *
 * サーバー側（mergeSwitch）は「キーが無い＝変えない」「空文字＝外す」で読む。
 * 何も変わらないときは断られるので、押す前にこちらで気づけるようにしておく。
 *
 * @returns {object|null} 替えるものが無ければ null
 */
function collectSwitch() {
  const row = ops.lastRow ?? {};
  const out = {};

  // 空欄は「外す（CLI の既定へ戻す）」の指定。だから空でもキーを送る
  const model = modelValue(ops.swModelPick.value, ops.swModel.value);
  if (model !== (row.model ?? '')) out.model = model;

  const effort = ops.swEffort.value;
  if (effort !== (row.effort ?? '')) out.effort = effort;

  // **権限モードだけは外せない。** 空を送るとサーバーが断る
  // （外した先が「既定」で、plan のつもりが acceptEdits で走る事故になるため）
  const mode = ops.swMode.value;
  if (mode && mode !== row.permissionMode) out.permissionMode = mode;

  // 予算だけは数。空欄は「上限なし」の指定なので、null にしてキーごと送る。
  // **比べる前に数へ直す。** 欄の値は文字列なので、生のままだと '5' といまの 5 が
  // 違って見えて、何も変えていないのに子を畳んで起こし直すことになる
  const raw = ops.swBudget.value.trim();
  const budget = raw === '' ? null : Number(raw);
  if (budget !== (row.budgetUsd ?? null)) out.budgetUsd = budget;

  return Object.keys(out).length > 0 ? out : null;
}

/** 替えたあとの言い方。changed はキー名で返るので、ここで日本語に直す。 */
function switchedText(data) {
  const names = (data.changed ?? []).map((k) => SWITCH_LABELS[k] ?? k);
  return names.length > 0 ? `${names.join('・')}を替えて続けます` : '替えて続けます';
}

/**
 * 押されたときにどちらの窓口へ行くかを決める。**判断は画面がやる。**
 *
 * - 子が生きていて、替えるのが権限モードとモデルだけ → `/mode`（指示文なしで即時）
 * - それ以外 → `/switch`（指示文つきで建て直し）
 *
 * サーバーの `/switch` に「権限モードだけなら撃つだけで済ませる」近道を作らないのは、
 * 呼ぶ側から見て**「指示文が要るときと要らないときがある窓口」**になり、
 * 判断が窓口の中に隠れるから。隠すならこちら側に置く。
 *
 * @returns {Promise<void>}
 */
async function applySwitch() {
  if (ops.busy || ops.over) return;

  // <input type="number"> は数として読めない中身のとき value が空になる。
  // 空は「上限なし」の指定なので、そのまま通すと打ち間違いが黙って上限を外す。
  // **どちらへ行くかを決める前に見る。** 壊れた数のまま `collectSwitch()` を読むと、
  // 「上限を外す」が混ざった中身で道を選ぶことになる
  if (ops.swBudget.validity?.badInput) {
    say('予算は数で書いてください', 'bad');
    return;
  }

  const patch = collectSwitch();
  if (!patch) {
    say('替えるところがありません', 'bad');
    return;
  }

  // 空の `model` は「外して CLI の既定へ戻す」の指定。撃つ道では表せない
  // （`set_model` に空は渡せない）ので、こちらも建て直しへ回す
  const live = !RUN_NO_CHILD.has(ops.lastRow?.state)
    && Object.entries(patch).every(([k, v]) => LIVE_KEYS.has(k) && typeof v === 'string' && v !== '');

  // 建て直すほうは指示文が要る。足りなければ post() が言う
  const ok = live ? await postMode(patch) : await post('switch');

  // **うまくいったときだけ閉じる。** 断られたときに閉じると、理由が
  // 入力欄の下に1行残るだけになり、直す場所（開いていた欄）から目が離れる
  if (ok && ops.dlg.open) ops.dlg.close();
}

/**
 * 子を殺さずに替える。
 *
 * **202 しか返らない。** 撃っただけで効いたかは分からないので、ここでは
 * 「送った」までしか言わない。替わったかどうかは行（`row.switching` が消え、
 * `row.permissionMode` が変わる）と速報の1行で分かる。
 *
 * @param {object} patch 替えるもの（`{permissionMode?, model?}`）
 * @returns {Promise<boolean>} 送れたか（モーダルを閉じてよいか）
 */
async function postMode(patch) {
  const runId = ops.runId;
  if (!runId) return false;

  setBusy(true);
  say('替えています…');
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/mode`, {
      method: 'POST',
      // 付け忘れると書き込み口の門番に断られる
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => null);

    // 返ってくるまでに別の実行へ移っていることがある。
    // そのまま書くと、**他人の実行の**メッセージ欄を書き換えることになる
    if (ops.runId !== runId) return false;

    if (!res.ok || !data?.ok) {
      say(data?.reason ?? `替えられませんでした（HTTP ${res.status}）`, 'bad');
      return false;
    }
    say('替えを送りました', 'good');
    return true;
  } catch (err) {
    if (ops.runId === runId) say(`替えられませんでした（${err.message}）`, 'bad');
    return false;
  } finally {
    if (ops.runId === runId) setBusy(false);
  }
}

/**
 * 送る／替える。どちらも指示文が要るので、窓口と本文だけ変える。
 *
 * @param {'input'|'switch'} kind
 * @returns {Promise<boolean>} 送れたか（モーダルを閉じてよいか）
 */
async function post(kind) {
  if (ops.busy || ops.over) return false;

  const runId = ops.runId;
  if (!runId) return false;

  const text = ops.prompt.value.trim();
  if (!text) {
    // 建て直しは入力欄の文を使う。**モーダルの中からは見えない**ので、
    // 何が足りないかを言うだけでなく、閉じてそこへ焦点を移す
    say('指示を書いてください（入力欄に、続きの指示を1行）', 'bad');
    if (ops.dlg.open) ops.dlg.close();
    ops.prompt.focus();
    return false;
  }

  const body = { prompt: text };
  if (kind === 'switch') {
    // <input type="number"> は数として読めない中身のとき value が空になる。
    // 空は「上限なし」の指定なので、そのまま通すと打ち間違いが黙って上限を外す
    if (ops.swBudget.validity?.badInput) {
      say('予算は数で書いてください', 'bad');
      return false;
    }
    const patch = collectSwitch();
    if (!patch) {
      say('替えるところがありません', 'bad');
      return false;
    }
    Object.assign(body, patch);
  }

  setBusy(true);
  say(kind === 'switch' ? '替えています…' : '送っています…');
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/${kind}`, {
      method: 'POST',
      // 付け忘れると書き込み口の門番に断られる
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);

    // 返ってくるまでに別の実行へ移っていることがある。
    // そのまま書くと、**他人の実行の**メッセージ欄と入力欄を書き換えることになる
    if (ops.runId !== runId) return false;

    if (!res.ok || !data?.ok) {
      say(data?.reason ?? `送れませんでした（HTTP ${res.status}）`, 'bad');
      return false;
    }

    // 送っているあいだに書き足していたら消さない。消すのは送ったぶんが残っているときだけ
    if (ops.prompt.value.trim() === text) ops.prompt.value = '';
    say(kind === 'switch' ? switchedText(data) : '送りました', 'good');
    return true;
  } catch (err) {
    if (ops.runId === runId) say(`送れませんでした（${err.message}）`, 'bad');
    return false;
  } finally {
    if (ops.runId === runId) setBusy(false);
  }
}

/**
 * 割り込む（CLI の Esc に当たる）。
 *
 * **2段押しにしない。** 止めるのと違って取り返しが付く（子は生きていて、
 * そのまま続きを打てる）。確認を挟むと、いちばん急いでいる場面で1回ぶん遅れる。
 *
 * **控えている指示を消すか（`cancelQueued`）は送らない。** 窓口は受けるが、
 * 画面には控えの本数を出す道がまだ無いので、選ばせても何を消すのか分からないまま押すことになる。
 */
async function doInterrupt() {
  const runId = ops.runId;
  if (!runId || ops.busy || ops.over) return;

  setBusy(true);
  say('割り込んでいます…');
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/interrupt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const data = await res.json().catch(() => null);
    // 返ってくるまでに別の実行へ移っていることがある（`post()` と同じ作法）
    if (ops.runId !== runId) return;

    if (!res.ok || !data?.ok) {
      say(data?.reason ?? `割り込めませんでした（HTTP ${res.status}）`, 'bad');
      return;
    }
    // 202。**「割り込みました」と言い切らない。** 届いたかは返事が来るまで分からない
    say('割り込みを送りました。返事を待っています…');
  } catch (err) {
    if (ops.runId === runId) say(`割り込めませんでした（${err.message}）`, 'bad');
  } finally {
    if (ops.runId === runId) setBusy(false);
  }
}

/** 2段押しを元へ戻す。 */
function disarmStop() {
  if (ops.stopTimer !== null) {
    clearTimeout(ops.stopTimer);
    ops.stopTimer = null;
  }
  ops.stopArmed = false;
  ops.stop.textContent = '止める';
  ops.stop.classList.remove('is-armed');
}

/** 実際に止めにいく。 */
async function doStop() {
  const runId = ops.runId;
  if (!runId) return;

  setBusy(true);
  say('止めています…');
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const data = await res.json().catch(() => null);
    if (ops.runId !== runId) return;

    if (!res.ok || !data?.ok) {
      say(data?.reason ?? `止められませんでした（HTTP ${res.status}）`, 'bad');
      return;
    }
    // closed が false は「木ごと落としにいったが、消えたことを確かめられていない」。
    // 「止めました」と言い切ると、残った孫に気づけなくなる
    const done = data.closed === false ? '止めにいきました（残っているかもしれません）' : '止めました';
    say(done, 'good');
  } catch (err) {
    if (ops.runId === runId) say(`止められませんでした（${err.message}）`, 'bad');
  } finally {
    if (ops.runId === runId) setBusy(false);
  }
}

/**
 * 止めるを押した。**2段押しにしてある。**
 *
 * kill は取り消せない。confirm() だと窓の外へ出てしまうので、
 * 1回目はボタンの字を変えるだけにして、5秒で元へ戻す。
 */
function onStop() {
  if (ops.busy || ops.over) return;

  if (!ops.stopArmed) {
    ops.stopArmed = true;
    ops.stop.textContent = 'もう一度押すと止めます';
    ops.stop.classList.add('is-armed');
    say('止めると、走っている途中でも終わります');
    ops.stopTimer = setTimeout(disarmStop, STOP_CONFIRM_MS);
    return;
  }
  disarmStop();
  doStop();
}

/**
 * 器を1回だけ組む。以降はこの節点を append し直して使う。
 *
 * 器は2つ。**どちらも詳細ペインの外にある。**
 *
 * - 中央下の入力欄（`bar`）… 送る・止めると、いまの権限モードの札
 * - 替えるモーダル（`dlg`）… `document.body` に1枚だけ置く
 *
 * 替えるほうを実行パネルの中の `<details>` から出したのは、**見つからなかったから。**
 * 走っているあいだ速報が伸び続けるので、替える口は画面の下へ流れていき、
 * いちばん替えたい場面（いま動いている最中）に限って、下までスクロールしないと出てこなかった。
 * いまは打つ場所のすぐ上に「いま plan mode」と出ていて、そこを押すと開く。
 *
 * モーダルの器を `index.html` に置かないのは、中身がこの実行の行で決まるからで、
 * 空の器だけ HTML に置いても、結局ここが全部組み直すことになる
 * （層7 のモーダル2枚は中身も固定なので、あちらは HTML に器がある）。
 */
function buildOps() {
  // ── 中央下の入力欄
  const bar = el('div', 'composer-in');

  // いまの権限モードとモデル。**押すと替えるモーダルが開く。**
  // CLI が入力欄のそばにモードを出しているのと同じ考えで、
  // 「いまどれで走っているか」と「替えられる」を1つの札で兼ねる
  const now = el('button', 'composer-now');
  now.type = 'button';
  // 語彙（権限モードの一覧）を引くまでは出さない。出すと、押しても空の窓が開く
  now.hidden = true;
  now.addEventListener('click', openSwitch);
  const nowMode = el('span', 'composer-now-mode');
  const nowModel = el('span', 'composer-now-model');
  const nowNote = el('span', 'composer-now-note');
  now.append(
    el('span', 'composer-now-lead', 'いま'),
    nowMode,
    el('span', 'composer-now-sep', '/'),
    nowModel,
    nowNote,
  );

  const prompt = el('textarea', 'run-prompt');
  prompt.id = 'run-ops-prompt';
  prompt.rows = 2;
  // 見えるラベルは置かない。placeholder が用を足すので、常時の文字を1行でも減らす
  prompt.setAttribute('aria-label', '続きの指示');

  // 本文欄の Enter は改行。送るのは Ctrl+Enter。
  // 長い指示を書いている途中に Enter で走り出すのがいちばん困る（起こすフォームと同じ）
  prompt.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || !(ev.ctrlKey || ev.metaKey)) return;
    ev.preventDefault();
    post('input');
  });

  const send = el('button', 'btn is-primary', '送る');
  send.type = 'button';
  send.addEventListener('click', () => post('input'));

  // 止めるの手前に置く。**並びで軽重を示す。**
  // 会話ごと消える「止める」がいちばん端で、その1つ内側が取り消せる「割り込む」
  const brk = el('button', 'btn', '割り込む');
  brk.type = 'button';
  brk.hidden = true;
  brk.addEventListener('click', doInterrupt);

  const stop = el('button', 'btn', '止める');
  stop.type = 'button';
  stop.addEventListener('click', onStop);

  const msg = el('p', 'settings-msg');
  msg.setAttribute('role', 'status');

  const btns = el('div', 'composer-btns');
  btns.append(send, brk, stop);

  const line = el('div', 'composer-row');
  line.append(prompt, btns);

  bar.append(now, line, msg);

  // ── 替えるモーダル。中の見た目は設定モーダルのクラスをそのまま借りる
  const dlg = el('dialog', 'runsw');
  dlg.setAttribute('aria-label', '権限モード・モデルを替える');

  const x = el('button', 'settings-x', '×');
  x.type = 'button';
  x.setAttribute('aria-label', '閉じる');
  x.addEventListener('click', () => dlg.close());

  const head = el('div', 'settings-head');
  head.append(el('h2', null, '権限モード・モデルを替える'), x);

  const grid = el('div', 'settings-sec settings-grid');

  // 権限モードをいちばん上に置く。この窓でいちばん替えたいものがこれで、
  // 押し間違いの被害も大きい（plan のつもりで書き換えが走る）
  const swMode = el('select', 'settings-select');
  gridRow(grid, 'run-sw-mode', '権限モード', swMode, 'いまの子のまま、次のターンから替わる');

  // 候補は「このマシンで実際に使われたモデル」。無いものは「自分で入力」から渡す
  const swModelPick = el('select', 'settings-select');
  swModelPick.id = 'run-sw-model-pick';
  swModelPick.addEventListener('change', noteModel);

  const swModel = el('input', 'settings-text');
  swModel.type = 'text';
  swModel.hidden = true;
  swModel.spellcheck = false;
  swModel.autocomplete = 'off';
  swModel.placeholder = 'モデル名をそのまま書く';
  swModel.setAttribute('aria-label', 'モデル名を自分で入力');

  const swModelRow = el('span', 'settings-row');
  swModelRow.append(swModelPick, swModel);
  gridRow(
    grid, 'run-sw-model', 'モデル', swModelRow,
    '使ったことのあるものを並べています。指定しないと CLI の既定へ戻る',
    swModelPick.id,
  );

  const swEffort = el('select', 'settings-select');
  gridRow(grid, 'run-sw-effort', '思考量', swEffort, '替えると起こし直しになる（指示文が要る）');

  // 予算切れから抜ける道はここだけ（そのまま送ると同じ上限で回り直す）
  const swBudget = el('input', 'settings-num');
  swBudget.id = 'run-sw-budget';
  swBudget.type = 'number';
  swBudget.step = '0.01';

  // 単位を添える。無いと、この欄だけ何の数を書くのか分からない（起こすフォームと同じ扱い）
  const swBudgetRow = el('span', 'settings-row');
  swBudgetRow.append(swBudget, el('span', 'settings-unit', 'USD'));
  gridRow(
    grid, 'run-sw-budget', '上限', swBudgetRow,
    '空にすると上限なし。起こし直すたびに数え直す',
    swBudget.id,
  );

  // 押したときに何が起きるかは、子が生きているかで変わる。**ボタンの文字は動かさない。**
  // 手を伸ばしている最中に押すものの名前が変わるほうが危ない
  const swHow = el('p', 'settings-hint');

  // 撃ったが返事待ちのぶん。**消すのは `say()` ではなく行**（`row.switching`）。
  // 画面が自分で消すと、失敗していたのに消えた＝替わったように見える
  const swPending = el('p', 'settings-msg');
  swPending.setAttribute('role', 'status');

  // グリッドとは段を分ける。地続きにすると、いちばん下の欄（上限）の
  // 説明がそのまま続いているように読める
  const note = el('div', 'settings-sec');
  note.append(swHow, swPending);

  const body = el('div', 'settings-body');
  body.append(grid, note);

  const apply = el('button', 'btn is-primary', 'この内容にする');
  apply.type = 'button';
  apply.addEventListener('click', applySwitch);

  const swMsg = el('p', 'settings-msg');
  swMsg.setAttribute('role', 'status');

  const foot = el('div', 'settings-foot');
  foot.append(swMsg, apply);

  dlg.append(head, body, foot);

  // 背面を押したら閉じる。dialog 自身に余白を持たせていないので、
  // ここへ来るのは背面を押したときだけになる（run.css の padding: 0）
  dlg.addEventListener('click', (ev) => {
    if (ev.target === dlg) dlg.close();
  });

  // <form> で囲っていないので Enter は自分で拾う（起こすフォームと同じ作法）。
  // ここに複数行の欄は無いので、素直に「押した＝この内容にする」でよい
  dlg.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || !ev.target.matches('input, select')) return;
    ev.preventDefault();
    applySwitch();
  });

  // **詳細ペインの外へ出す。** 中に置くと作り直しのたびに開いたまま消える
  document.body.append(dlg);

  ops = {
    bar, prompt, send, brk, stop, msg,
    now, nowMode, nowModel, nowNote,
    dlg, swModelPick, swModel, swEffort, swMode, swBudget, apply, swHow, swPending, swMsg,
    runId: null, busy: false, over: false, stopArmed: false, stopTimer: null, lastRow: null,
  };
  return ops;
}

/**
 * 「自分で入力」のときだけ入力欄を出す。
 *
 * 起こすフォーム（層7）にも同じものがあるが、あちらを import すると層の向きが逆になる。
 * 判断のほう（値をどう割るか・どう組むか）は `runs.js` の純関数に寄せてあるので、
 * ここに残るのは出し入れだけ。
 */
function noteModel() {
  const free = ops.swModelPick.value === MODEL_FREE;
  const was = ops.swModel.hidden;
  ops.swModel.hidden = !free;
  if (free && was) ops.swModel.focus();
  // 候補へ戻したら書きかけを捨てる。残すと、見えない欄の中身が送られる
  if (!free) ops.swModel.value = '';
}

/**
 * 替えるモーダルを開く。
 *
 * **開くたびにいまの値を写す。** 開いているあいだ syncOps() は欄を触らないので、
 * 前に開いたときの選びかけがそのまま残っていることがある。
 */
function openSwitch() {
  if (!ops || ops.over || ops.dlg.open) return;
  if (ops.lastRow) prefillSwitch(ops.lastRow);
  // 前回の結果は消す。押す前から「替えました」が出ていると、押したかどうかが分からない
  say('');
  ops.dlg.showModal();
}

/**
 * 札に出す権限モードの短い名。
 *
 * ラベルは `plan mode（読むだけ・書き換えない）` のように括弧つきで来る。
 * **札では括弧を落とす。** 入力欄の上に置く1行なので、丸ごと出すと折り返して
 * 打つ場所が下へずれる。詳しい説明は開いた窓の <select> のほうに出ている。
 *
 * 語彙が引けていないときは値をそのまま出す。**「不明」とは書かない**
 * （値そのものは行に載っているので、分からないのは日本語の名前だけ）。
 *
 * @param {object} row 台帳の行
 * @returns {string}
 */
function modeText(row) {
  const value = row.permissionMode ?? '';
  if (!value) return '既定の権限';
  const hit = (runOptions?.modes ?? []).find((m) => m.value === value);
  const label = hit?.label ?? value;
  return label.split('（')[0].trim() || value;
}

/** いまの指定を切り替えの欄へ写す。 */
function prefillSwitch(row) {
  // 候補に無い名前のときは「自分で入力」側へ倒れる（runs.js の modelPick）。
  // 倒さないと <select> が空になり、**指定してあるのに指定なしに見える**
  const pick = modelPick(row.model ?? '', runOptions?.models);
  ops.swModelPick.value = pick.sel;
  ops.swModel.value = pick.free;
  ops.swModel.hidden = pick.sel !== MODEL_FREE;
  ops.swEffort.value = row.effort ?? '';
  // 知らない値だと <select> が空になる。そのときは選び直してもらう
  if (row.permissionMode) ops.swMode.value = row.permissionMode;
  // `null`（上限なし）と、サーバーが古くて項目ごと無いときは同じ空欄でよい。
  // どちらも「上限を渡していない」で、押しても何も変わらない
  ops.swBudget.value = row.budgetUsd === null || row.budgetUsd === undefined
    ? ''
    : String(row.budgetUsd);
}

/**
 * 引いた選択肢を切り替えの欄へ流し込む。
 *
 * **埋め直したら、開いていても prefill し直す。** <option> を入れ替えると
 * value が先頭へ飛ぶので、そのままだと acceptEdits で走っている実行に
 * plan が選ばれた状態で残る。押すと権限が変わるので、事故として重い。
 * 人が選び直したぶんはどのみち消えるが、空欄で残すよりは厳密に安全。
 */
function fillSwitch() {
  if (!ops || !runOptions) return;

  // 危ないモード（bypassPermissions）はサーバー側のラベルに「（危険）」が入っている。
  // 語彙そのものも環境変数が立っているときしか返らないので、ここでは素通しでよい
  const modes = (runOptions.modes ?? []).map((m) => ({ value: m.value, label: m.label }));
  fillSelect(ops.swMode, modes);

  fillSelect(ops.swModelPick, modelOptions(runOptions.models));

  fillSelect(ops.swEffort, [
    { value: '', label: '指定しない（CLI の既定）' },
    ...(runOptions.efforts ?? []).map((v) => ({ value: v, label: EFFORT_LABELS[v] ?? v })),
  ]);

  const b = runOptions.budget ?? {};
  if (Number.isFinite(b.min)) ops.swBudget.min = String(b.min);
  if (Number.isFinite(b.max)) ops.swBudget.max = String(b.max);

  // 語彙ごと取れなかったなら替えようが無い。札を出さない（押しても空の窓が開くだけ）
  ops.now.hidden = modes.length === 0;
  if (ops.lastRow) prefillSwitch(ops.lastRow);
}

/**
 * 切り替えの選択肢を引く。1回だけ。
 *
 * 中で受け止めているので、呼ぶ側は await も .catch() も要らない。
 */
async function loadOptions() {
  if (optionsAsked) return;
  optionsAsked = true;
  try {
    const res = await fetch('/api/runs/options', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    runOptions = await res.json();
    fillSwitch();
  } catch {
    // 取れなくても送る・止めるは動く。切り替えの節を出さないだけにして、引き直さない
    runOptions = null;
  }
}

/**
 * 器をいまの実行に合わせる。呼ぶ側が bar を欲しがるので ops をそのまま返す。
 *
 * 同じ描き直しの中で2回呼ばれても害は無い（2回目は runId が一致するので何も起きない）。
 *
 * @param {object} row 台帳の行
 * @returns {object}
 */
function syncOps(row) {
  if (!ops) buildOps();

  if (ops.runId !== row.runId) {
    // 別の実行へ移った。**前の実行あてに書いていた文を、次の実行へ送らせない**
    ops.runId = row.runId;
    ops.prompt.value = '';
    ops.busy = false;
    focusMemo = null;
    disarmStop();
    say('');
    // モーダルは詳細ペインの外なので、黙っていると開いたまま残る。
    // 前の実行の値が入った窓で押すと、**いまの実行にその値が当たる**
    if (ops.dlg.open) ops.dlg.close();
  }

  // **`applyEnabled()` より先に入れる。** 割り込みの札は行の `capabilities` と
  // `interrupting` を見て出し入れするので、古い行のまま当てると1フレーム遅れる
  ops.lastRow = row;
  ops.over = RUN_OVER.has(row.state);
  applyEnabled();

  if (ops.over) {
    ops.prompt.placeholder = 'この実行はもう終わっています';
    disarmStop();
  } else {
    ops.prompt.placeholder = '続きを書いて送る（Ctrl+Enter でも送れる）';
  }

  // 入力欄の上の札。**いまどれで走っているかを、打つ場所のすぐ上に出す。**
  // 替えられること自体が分かりにくかったので、状態の表示と入り口を1つにしてある
  ops.nowMode.textContent = modeText(row);
  ops.nowModel.textContent = shortModel(row.model) ?? '既定のモデル';

  // 押したときに何が起きるかは、子が生きているかで変わる。**行を見て毎回書き直す。**
  // 走っている最中に予算が切れると建て直しへ変わるので、固定文にできない
  ops.swHow.textContent = RUN_NO_CHILD.has(row.state)
    ? 'いまの子をいったん止めて、同じ会話を続きから起こし直す（指示文が要る）'
    : '権限モードとモデルは、いまの子のまま替わる。思考量と上限は起こし直しになる（指示文が要る）';

  // 撃ったが返事待ちのぶん。**消すのは行のほう。**
  // 受理・拒否・時間切れのどれでもサーバー側で消えるので、ここで消し忘れる道が無い
  const waiting = (row.switching ?? []).map((c) => SWITCH_LABELS[c.field] ?? c.field);
  ops.swPending.textContent = waiting.length > 0
    ? `${waiting.join('・')}を替えています。返事を待っています…`
    : '';

  // 返事待ちは札のほうにも出す。モーダルを閉じたあとに見えるのはこちらだけ。
  // 終わっている実行は押せない（applyEnabled）ので、そのときは状態の表示だけにする
  // （押せない札に「替える」と書くと嘘になる）
  ops.nowNote.textContent = waiting.length > 0 ? '替えています…' : (ops.over ? '' : '替える');
  ops.now.classList.toggle('is-switching', waiting.length > 0);

  // 人が開いて書き換えているあいだは上書きしない。
  // 状態が変わるたびに選び直されると、押す直前に値が入れ替わる
  if (!ops.dlg.open) prefillSwitch(row);

  // 中身は1回だけ引く。取れなければ替える札を出さない（押しても空の窓が開くだけ）
  loadOptions();

  return ops;
}

/**
 * いま掴んでいる焦点を控える。
 *
 * 詳細ペインは丸ごと作り直されるので、何もしないと打っている途中で焦点が飛ぶ。
 * 節点そのものは使い回すから、参照と caret の位置さえ覚えておけば戻せる。
 */
function saveFocus() {
  focusMemo = null;
  const node = document.activeElement;
  // 見るのは入力欄の側だけでよい。モーダルは document.body に置いてあって
  // 作り直されないので、開いたまま焦点が飛ぶことがない
  if (!ops || !node) return;
  if (!ops.bar.contains(node)) return;

  focusMemo = {
    runId: ops.runId,
    node,
    start: typeof node.selectionStart === 'number' ? node.selectionStart : null,
    end: typeof node.selectionEnd === 'number' ? node.selectionEnd : null,
    at: performance.now(),
  };
}

/**
 * 控えた焦点を戻す。
 *
 * **実際に focus するのは requestAnimationFrame の中。**
 * runPanel() が返る時点では detail.js がまだ節点を document へ付けていないので、
 * この場で focus しても効かない（render() の初回スクロールが待つのと同じ理由）。
 */
function restoreFocus() {
  const memo = focusMemo;
  focusMemo = null;
  if (!memo || memo.runId !== ops.runId) return;
  if (performance.now() - memo.at > FOCUS_MEMO_MS) return;

  requestAnimationFrame(() => {
    // 人が先にどこかを触っていたら奪わない
    if (document.activeElement && document.activeElement !== document.body) return;
    const node = memo.node;
    if (!node.isConnected || node.disabled) return;
    node.focus();
    if (memo.start !== null && typeof node.setSelectionRange === 'function') {
      node.setSelectionRange(memo.start, memo.end ?? memo.start);
    }
  });
}

/**
 * 中央下の入力欄に入れる節点。この画面から起こした実行のときだけ返す。
 *
 * **どのタブを見ていても呼ばれる。** パネル（runPanel）は「いま」のタブにしか出ないが、
 * 入力欄はタブに関係なく手が届く場所に置くので、同期はこちらにも要る。
 *
 * @param {string|null} sessionId 開いているセッション
 * @returns {HTMLElement|null}
 */
export function composerFor(sessionId) {
  const row = runFor(sessionId);
  if (!row) {
    // 実行でないセッションへ移った。入力欄ごと消えるので、開いていた窓も畳む
    if (ops?.dlg.open) ops.dlg.close();
    return null;
  }
  return syncOps(row).bar;
}

/**
 * 実行パネル。この画面から起こしたセッションのときだけ出す。
 *
 * @param {string|null} sessionId 開いているセッション
 * @returns {HTMLElement|null}
 */
export function runPanel(sessionId) {
  const row = runFor(sessionId);
  if (!row) return null;

  const p = panel('この画面から起こした実行', {
    id: SEC.run,
    count: stateBadge(row),
    tone: toneOf(row.state),
  });

  p.body.append(factsOf(row));

  const drop = el('p', 'run-drop');
  drop.hidden = true;
  p.body.append(drop);

  const log = el('div', 'run-log');
  p.body.append(log);

  // 操作は全部 composer 側にある（composerFor）。ここでは行に合わせるだけ呼ぶ
  syncOps(row);

  attach({ log, drop, runId: row.runId });
  render();
  restoreFocus();

  return p.section;
}
