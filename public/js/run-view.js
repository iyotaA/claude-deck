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
import { runFor, eventsOf, droppedOf, runsMissed, EVENTS_PER_RUN, EFFORT_LABELS } from './runs.js';
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
  other: 'その他',
  broken: '読めなかった行',
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
      const line = el('div', 'run-out');
      if (ev.isError) line.classList.add('is-error');
      // 中身が空でも「返ってきた」ことは伝える（黙って空行にしない）
      line.textContent = ev.text || (ev.isError ? '（エラー。中身なし）' : '（中身なし）');
      return [line];
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
  // ただし**累積するのは同じ子のあいだだけ。**「モデルなどを替えて続ける」は子を起こし直すので、
  // そこで起点に戻る（実測 0.401036 → 切り替え後の最初の result で 0.130617）。
  // だから「ここまで」とは書かない。切り替えを挟んだぶんは、並んだ result を足したものが合計になる
  fact(dl, 'この起動ぶんの費用', typeof ev.costUSD === 'number' ? `$${ev.costUSD.toFixed(4)}` : null);
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
  fact(dl, '理由', row.reason);
  return dl;
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
 * 取れなければ切り替えの節を出さないだけで、送る・止めるはそのまま動く。
 * 引き直さないのは「窓口ごと無いと分かったら一度で諦める」の作法
 * （更新の前後で、画面だけ新しくサーバーが古いことがある）。
 */
let runOptions = null;
let optionsAsked = false;

/**
 * 操作の器。**module-level に1つだけ持って使い回す。**
 *
 * 詳細ペインは detailKeyOf() が動くと丸ごと作り直されるが、
 * document から外れても <textarea> の value と <details> の開閉は消えない。
 * だから作り直しのたびに同じ節点を append し直すだけにしてある。
 *
 * @type {null | {
 *   wrap: HTMLElement, prompt: HTMLTextAreaElement, send: HTMLButtonElement,
 *   stop: HTMLButtonElement, msg: HTMLElement, det: HTMLElement,
 *   swModel: HTMLInputElement, swEffort: HTMLSelectElement, swMode: HTMLSelectElement,
 *   apply: HTMLButtonElement, runId: string|null, busy: boolean, over: boolean,
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
 * @param {HTMLElement} control 入力
 * @param {string} hint 右に置く説明
 */
function gridRow(grid, id, text, control, hint) {
  const lb = el('label', 'settings-label', text);
  lb.htmlFor = id;
  control.id = id;
  grid.append(lb, control, el('p', 'settings-hint', hint));
}

/** 下に一言出す。空文字で消える。 */
function say(text, tone = '') {
  ops.msg.textContent = text;
  ops.msg.dataset.tone = text ? tone : '';
}

/** ボタンの入切をまとめて当てる。 */
function applyEnabled() {
  const off = ops.busy || ops.over;
  ops.send.disabled = off;
  ops.stop.disabled = off;
  ops.apply.disabled = off;
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
  const model = ops.swModel.value.trim();
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
 * 送る／替える。どちらも指示文が要るので、窓口と本文だけ変える。
 *
 * @param {'input'|'switch'} kind
 */
async function post(kind) {
  if (ops.busy || ops.over) return;

  const runId = ops.runId;
  if (!runId) return;

  const text = ops.prompt.value.trim();
  if (!text) {
    say('指示を書いてください', 'bad');
    ops.prompt.focus();
    return;
  }

  const body = { prompt: text };
  if (kind === 'switch') {
    // <input type="number"> は数として読めない中身のとき value が空になる。
    // 空は「上限なし」の指定なので、そのまま通すと打ち間違いが黙って上限を外す
    if (ops.swBudget.validity?.badInput) {
      say('予算は数で書いてください', 'bad');
      return;
    }
    const patch = collectSwitch();
    if (!patch) {
      say('替えるところがありません', 'bad');
      return;
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
    if (ops.runId !== runId) return;

    if (!res.ok || !data?.ok) {
      say(data?.reason ?? `送れませんでした（HTTP ${res.status}）`, 'bad');
      return;
    }

    // 送っているあいだに書き足していたら消さない。消すのは送ったぶんが残っているときだけ
    if (ops.prompt.value.trim() === text) ops.prompt.value = '';
    say(kind === 'switch' ? switchedText(data) : '送りました', 'good');
  } catch (err) {
    if (ops.runId === runId) say(`送れませんでした（${err.message}）`, 'bad');
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
 * 器は2つに割ってある。毎回使うもの（入力欄・送る・止める）は中央下の composer へ、
 * ときどき使うもの（替えて続ける）はパネルへ。
 * composer 側は詳細ペインの外に置かれるので作り直されず、打っている途中でも消えない。
 */
function buildOps() {
  // ── 中央下の入力欄
  const bar = el('div', 'composer-in');

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

  const stop = el('button', 'btn', '止める');
  stop.type = 'button';
  stop.addEventListener('click', onStop);

  const msg = el('p', 'settings-msg');
  msg.setAttribute('role', 'status');

  const btns = el('div', 'composer-btns');
  btns.append(send, stop);

  const line = el('div', 'composer-row');
  line.append(prompt, btns);

  bar.append(line, msg);

  // ── 替えて続ける。パネル側に残して畳んでおく（普段は使わないので手元に置かない）
  const wrap = el('div', 'run-ops');
  // 選択肢を引けるまで器ごと出さない。中身が無いのに上の線だけ残ると意味のない区切りに見える
  wrap.hidden = true;

  const det = el('details', 'run-switch');
  det.append(el('summary', null, 'モデルなどを替えて続ける'));

  const grid = el('div', 'settings-grid');

  const swModel = el('input', 'settings-text');
  swModel.type = 'text';
  swModel.spellcheck = false;
  gridRow(grid, 'run-sw-model', 'モデル', swModel, '空にすると CLI の既定へ戻る');

  const swEffort = el('select', 'settings-select');
  gridRow(grid, 'run-sw-effort', '思考量', swEffort, '深いほど時間と費用が増える');

  const swMode = el('select', 'settings-select');
  gridRow(grid, 'run-sw-mode', '権限モード', swMode, 'ここで選んだ内容で走る。途中で許可は求めない');

  // 予算切れから抜ける道はここだけ（そのまま送ると同じ上限で回り直す）
  const swBudget = el('input', 'settings-num');
  swBudget.type = 'number';
  swBudget.step = '0.01';
  gridRow(grid, 'run-sw-budget', '上限', swBudget, '空にすると上限なし。上限は起こし直すたびに数え直す');

  const apply = el('button', 'btn', 'この内容で続ける');
  apply.type = 'button';
  apply.addEventListener('click', () => post('switch'));

  const swFoot = el('div', 'run-ops-foot');
  swFoot.append(apply, el('p', 'settings-hint', 'いまの子をいったん止めて、同じ会話を続きから起こし直す'));

  const swBody = el('div', 'run-switch-body');
  swBody.append(grid, swFoot);
  det.append(swBody);

  wrap.append(det);

  ops = {
    bar, wrap, prompt, send, stop, msg, det, swModel, swEffort, swMode, swBudget, apply,
    runId: null, busy: false, over: false, stopArmed: false, stopTimer: null, lastRow: null,
  };
  return ops;
}

/** いまの指定を切り替えの欄へ写す。 */
function prefillSwitch(row) {
  ops.swModel.value = row.model ?? '';
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

  fillSelect(ops.swEffort, [
    { value: '', label: '指定しない（CLI の既定）' },
    ...(runOptions.efforts ?? []).map((v) => ({ value: v, label: EFFORT_LABELS[v] ?? v })),
  ]);

  const b = runOptions.budget ?? {};
  if (Number.isFinite(b.min)) ops.swBudget.min = String(b.min);
  if (Number.isFinite(b.max)) ops.swBudget.max = String(b.max);

  ops.det.hidden = modes.length === 0;
  // 中身が無いなら器ごと隠す（上の線だけが残ると意味のない区切りに見える）
  ops.wrap.hidden = ops.det.hidden;
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
 * 器をいまの実行に合わせる。節点は2つ（composer と パネル）あるので ops をそのまま返す。
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
  }

  ops.lastRow = row;
  ops.over = RUN_OVER.has(row.state);
  applyEnabled();

  if (ops.over) {
    ops.prompt.placeholder = 'この実行はもう終わっています';
    disarmStop();
  } else {
    ops.prompt.placeholder = '続きを書いて送る（Ctrl+Enter でも送れる）';
  }

  // 人が開いて書き換えているあいだは上書きしない。
  // 状態が変わるたびに選び直されると、押す直前に値が入れ替わる
  if (!ops.det.open) prefillSwitch(row);

  // 中身は1回だけ引く。取れなければ切り替えの節は畳んだまま出さない
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
  // 器が2つに割れているので両方見る。composer 側は作り直されないが、
  // ここで控えても restoreFocus() が「人が先に触っていたら奪わない」で降りるので害は無い
  if (!ops || !node) return;
  if (!ops.bar.contains(node) && !ops.wrap.contains(node)) return;

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
  if (!row) return null;
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

  const label = row.stateLabel ?? row.state;
  const tone = toneOf(row.state);
  const p = panel('この画面から起こした実行', { id: SEC.run, count: label, tone });

  p.body.append(factsOf(row));

  const drop = el('p', 'run-drop');
  drop.hidden = true;
  p.body.append(drop);

  const log = el('div', 'run-log');
  p.body.append(log);

  // 替えて続ける。送る・止めるは中央下の composer 側にある（composerFor）
  p.body.append(syncOps(row).wrap);

  attach({ log, drop, runId: row.runId });
  render();
  restoreFocus();

  return p.section;
}
