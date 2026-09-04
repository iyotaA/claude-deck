/**
 * 終わっているセッションの続きを、詳細ペインから起こす口。（層3）
 *
 * ターミナルで走らせていたセッションが終わったあと、同じ `sessionId` のまま
 * `--resume` で続きを起こす。ID が変わらないので、一覧・詳細・`?session=` も
 * ブックマークもそのまま生きる。
 *
 * **出すのは「もう動いていない」ときだけ。**
 * 生きているターミナルのセッションへ横から指示を入れる口はここに作らない
 * （`os/focus.mjs` の「ターミナルを前面に」で足りる）。
 * 同じログへ2つのプロセスが書く形は、サーバー側でも 409 で断っている。
 *
 * **`run-view.js` と同じ層に置き、あちらを import しない。**
 * 層3どうしで呼び合うと横向きの依存になる。`fillSelect` / `gridRow` は
 * 10行に満たないのでこちらにも持つ（共有するなら層0の `util.js` へ出すことになり、
 * そちらのほうが影響が広い）。あちらの `RUN_OVER` も同じ理由でここに持っている。
 *
 * 見た目は新しく作らない。設定モーダルの `.settings-*` と、実行パネルの
 * `.run-ops` / `.run-prompt` / `.run-ops-foot` をそのまま借りる。
 */
import { el, fact } from './util.js';
import { panel, SEC } from './panel.js';
import { runFor, EFFORT_LABELS, MODEL_FREE, modelOptions, modelValue } from './runs.js';
import { getJson } from './api.js';

/** これに入っていれば、その run はもう終わっている（`run-view.js` と同じ語彙）。 */
const RUN_OVER = new Set(['stopped', 'failed', 'done']);

/** 控えた焦点を戻してよい時間。これを過ぎたら別の操作とみなして戻さない。 */
const FOCUS_MEMO_MS = 400;

/** 器は module-level に1つだけ持ち回す。作り直すと打ちかけの指示が消える。 */
let ui = null;
/** `detach()` で控えた焦点。`resumePanel()` の最後に戻す。 */
let focusMemo = null;
/** `/api/runs/options` の中身。引けなかったときは null のまま。 */
let options = null;
/** 一度でも引いたか。**失敗しても引き直さない**（`run-view.js` と同じ作法）。 */
let optionsAsked = false;

/**
 * この行に「続きを起こす」の口を出してよいか。
 *
 * `cwd` が無いものは出さない。サーバーが許可リストと突き合わせられず、
 * 押しても必ず断られるため。
 *
 * @param {object|null} row 詳細ペインが持っている行
 * @returns {boolean}
 */
function canOffer(row) {
  if (!row?.sessionId || !row.cwd) return false;
  // ターミナル側がまだ生きている。横から入れない
  if (row.alive === true) return false;
  const run = runFor(row.sessionId);
  // この画面から起こしたものが動いている最中。操作は実行パネル側の役目
  if (run && !RUN_OVER.has(run.state)) return false;
  return true;
}

/**
 * 選択肢を1回だけ引く。失敗しても引き直さない。
 *
 * 失敗はすべて中で受け止めているので、呼ぶ側は await も `.catch()` も要らない。
 */
async function loadOptions() {
  if (optionsAsked) return;
  optionsAsked = true;
  try {
    options = await getJson('/api/runs/options');
    if (ui) applyOptions();
  } catch {
    // 引けなくても続きは起こせる。欄を出さないだけにする。
    // モデルも権限モードもキーごと送らなければ、サーバー側の既定（plan）で走る
    options = null;
  }
}

/**
 * 選択肢を器へ流し込む。引けていなければ欄ごと隠す。
 *
 * **一度埋めたら埋め直さない。** 詳細ペインは他の理由でもよく組み直されるので、
 * そのたびに既定へ戻すと、選んだモデルや権限モードが黙って消える。
 * 埋め直すのは別のセッションへ移ったときだけ（`syncUi()` が `filled` を落とす）。
 */
function applyOptions() {
  const o = options;
  ui.grid.hidden = !o;
  if (!o) return;
  if (ui.filled) { noteMode(); return; }
  ui.filled = true;
  fillSelect(ui.modelPick, modelOptions(o.models));
  noteModel();
  fillSelect(ui.effort, [
    { value: '', label: '指定しない（CLI の既定）' },
    ...(o.efforts ?? []).map((v) => ({ value: v, label: EFFORT_LABELS[v] ?? v })),
  ]);
  fillSelect(ui.mode, (o.modes ?? []).map((m) => ({ value: m.value, label: m.label })));
  if (o.defaultMode) ui.mode.value = o.defaultMode;
  const b = o.budget ?? {};
  if (Number.isFinite(b.min)) ui.budget.min = String(b.min);
  if (Number.isFinite(b.max)) ui.budget.max = String(b.max);
  if (Number.isFinite(b.default)) ui.budget.value = String(b.default);
  if (Number.isFinite(o.promptMax)) ui.prompt.maxLength = o.promptMax;
  noteMode();
}

/**
 * 「自分で入力」のときだけ入力欄を出す。
 *
 * 判断（値をどう組むか）は `runs.js` の純関数にあるので、ここは出し入れだけ。
 */
function noteModel() {
  const free = ui.modelPick.value === MODEL_FREE;
  const was = ui.model.hidden;
  ui.model.hidden = !free;
  if (free && was) ui.model.focus();
  // 候補へ戻したら書きかけを捨てる。残すと、見えない欄の中身が送られる
  if (!free) ui.model.value = '';
}

/** 危ないモードを選んだときだけ但し書きを出す。 */
function noteMode() {
  const hit = (options?.modes ?? []).find((m) => m.value === ui.mode.value);
  ui.danger.hidden = !hit?.danger;
}

/** `<select>` の中身を入れ替える。 */
function fillSelect(sel, items) {
  sel.replaceChildren();
  for (const it of items) {
    const opt = el('option', null, it.label);
    opt.value = it.value;
    sel.append(opt);
  }
}

/**
 * 3列のグリッドに1行足す。設定モーダルの `.settings-grid` をそのまま借りている。
 *
 * @param {HTMLElement} grid 入れ先
 * @param {string} id 入力の id。ラベルと結ぶ
 * @param {string} text ラベル
 * @param {HTMLElement} control 入力。器（複数の入力をまとめた span）でもよい
 * @param {string} hint 下に出す一言
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

/** 下に一言出す。空文字で消える。 */
function say(text, tone = '') {
  ui.msg.textContent = text;
  ui.msg.dataset.tone = text ? tone : '';
}

/** 送っているあいだはボタンを止める。 */
function setBusy(on) {
  ui.busy = on;
  ui.go.disabled = on;
}

/**
 * 器を1つだけ作る。以降は中身を差し替えて使い回す。
 *
 * 器は2つに割ってある。毎回使うもの（入力欄・起こす）は中央下の composer へ、
 * ときどき使うもの（モデルなどの指定と、状況の説明）はパネルへ。
 * composer 側は詳細ペインの外に置かれるので作り直されず、打っている途中でも消えない。
 */
function buildUi() {
  // ── 中央下の入力欄
  const bar = el('div', 'composer-in');

  const prompt = el('textarea', 'run-prompt');
  prompt.id = 'run-resume-prompt';
  prompt.rows = 2;
  prompt.spellcheck = false;
  prompt.placeholder = 'このセッションの続きを起こす（Ctrl+Enter でも起こせる）';
  // 見えるラベルは置かない。placeholder が用を足すので、常時の文字を1行でも減らす
  prompt.setAttribute('aria-label', '続きの指示');
  // 本文欄の Enter は改行。起こすのは Ctrl+Enter。
  // 長い指示を書いている途中に Enter で走り出すのがいちばん困る（起こすフォームと同じ）
  prompt.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || !(ev.ctrlKey || ev.metaKey)) return;
    ev.preventDefault();
    start();
  });

  const go = el('button', 'btn is-primary', '続きを起こす');
  go.type = 'button';
  go.addEventListener('click', start);

  const btns = el('div', 'composer-btns');
  btns.append(go);

  const line = el('div', 'composer-row');
  line.append(prompt, btns);

  const msg = el('p', 'settings-msg');
  msg.setAttribute('role', 'status');

  // 確認がどこへ出るかだけは手元にも書く。**パネルの説明を読んでいなくても押せる**ので、
  // いちばん外せない1行をここへ置く（残りの説明はパネル側）
  bar.append(line, el('p', 'settings-hint', '確認はこの画面に出ます'), msg);

  // ── 状況の説明と、モデルなどの指定。パネル側に残す
  const wrap = el('div', 'run-ops');

  wrap.append(el('p', 'run-note',
    'ターミナル側はもう動いていません。同じセッションのまま、この画面から続きを起こせます。'));

  const grid = el('div', 'settings-grid');

  // 候補は「このマシンで実際に使われたモデル」。名前を覚えていなくても選べる。
  // そこに無いものは「自分で入力」から渡す（新しいモデルが出た初日のため）
  const modelPickEl = el('select', 'settings-select');
  modelPickEl.id = 'run-resume-model-pick';
  modelPickEl.addEventListener('change', noteModel);

  const model = el('input', 'settings-text');
  model.type = 'text';
  model.hidden = true;
  model.spellcheck = false;
  model.autocomplete = 'off';
  model.placeholder = 'モデル名をそのまま書く';
  model.setAttribute('aria-label', 'モデル名を自分で入力');

  const modelRow = el('span', 'settings-row');
  modelRow.append(modelPickEl, model);
  gridRow(grid, 'run-resume-model', 'モデル', modelRow,
    '指定しないと CLI の既定で起こします。元のモデルは引き継ぎません',
    modelPickEl.id);
  const effort = el('select', 'settings-select');
  gridRow(grid, 'run-resume-effort', '思考量', effort, '深いほど時間とトークンを使います');
  const mode = el('select', 'settings-select');
  mode.addEventListener('change', noteMode);
  gridRow(grid, 'run-resume-mode', '権限モード', mode, 'ここで選んだ内容で走ります');
  const budget = el('input', 'settings-num');
  budget.type = 'number';
  budget.step = '0.01';
  gridRow(grid, 'run-resume-budget', '上限（USD）', budget, '空欄なら上限なし。入れた額に達すると止まります');
  grid.hidden = true;

  const danger = el('p', 'settings-hint run-danger',
    'このモードは許可を一切求めず、何でも実行します。');
  danger.hidden = true;

  wrap.append(grid, danger);

  return {
    bar, wrap, prompt, grid, modelPick: modelPickEl, model, effort, mode, budget, danger, go, msg,
    sessionId: null, cwd: null, busy: false, filled: false,
  };
}

/**
 * 器を今の行に合わせる。
 *
 * 別のセッションへ移ったときだけ中身を捨てる。同じセッションのまま描き直されただけなら、
 * 打ちかけの指示も選んだモデルもそのまま残す（詳細ペインは他の理由でもよく作り直される）。
 *
 * @param {object} row 詳細ペインが持っている行
 * @returns {object} 器（composer 側とパネル側の2つを持つ）
 */
function syncUi(row) {
  if (!ui) ui = buildUi();
  if (ui.sessionId !== row.sessionId) {
    ui.sessionId = row.sessionId;
    ui.prompt.value = '';
    ui.filled = false;
    say('');
    setBusy(false);
    focusMemo = null;
  }
  ui.cwd = row.cwd;
  return ui;
}

/** 起こす。空欄はキーごと送らない（サーバー側が「無ければ既定」で組む）。 */
function collect(prompt) {
  const body = { resume: true, sessionId: ui.sessionId, cwd: ui.cwd, prompt };
  // 選択肢を引けていないときは欄ごと隠しているので、何も足さずサーバーの既定に任せる
  if (!ui.grid.hidden) {
    const model = modelValue(ui.modelPick.value, ui.model.value);
    if (model) body.model = model;
    if (ui.effort.value) body.effort = ui.effort.value;
    if (ui.mode.value) body.permissionMode = ui.mode.value;
    const budget = ui.budget.value.trim();
    if (budget) body.budgetUsd = Number(budget);
  }
  return body;
}

/**
 * `POST /api/runs` を叩く。
 *
 * 起こしたあとに画面を勝手に動かさない。台帳へ現れれば `runStampFor()` が動いて
 * 詳細ペインが組み直され、実行パネルがこの口を引き継ぐ。
 */
async function start() {
  if (!ui || ui.busy) return;
  const runId = ui.sessionId;
  const text = ui.prompt.value.trim();
  if (!text) { say('続きの指示を書いてください', 'bad'); ui.prompt.focus(); return; }
  setBusy(true);
  say('起こしています…');
  try {
    const res = await fetch('/api/runs', {
      // 付け忘れると書き込み口の門番に断られる
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(collect(text)),
    });
    const data = await res.json().catch(() => null);
    // 返ってくるまでに別のセッションへ移っていることがある。
    // そのまま書くと**他人の詳細ペイン**のメッセージ欄と入力欄を書き換えることになる
    if (!ui || ui.sessionId !== runId) return;
    if (!res.ok || !data?.ok) {
      // サーバーは断る理由を日本語で返す。HTTP の番号より読めるので、あればそれを出す
      say(data?.reason ?? `起こせませんでした（HTTP ${res.status}）`, 'bad');
      return;
    }
    // 送っているあいだに書き足していたら消さない。消すのは送ったぶんが残っているときだけ
    if (ui.prompt.value.trim() === text) ui.prompt.value = '';
    say('起こしました。すぐ上に実行の欄が出ます', 'good');
  } catch (err) {
    if (ui && ui.sessionId === runId) say(`起こせませんでした（${err.message}）`, 'bad');
  } finally {
    if (ui && ui.sessionId === runId) setBusy(false);
  }
}

/** 焦点を控える。詳細ペインを組み直す直前に呼ばれる。 */
function saveFocus() {
  focusMemo = null;
  const node = document.activeElement;
  // 器が2つに割れているので両方見る。composer 側は作り直されないが、
  // ここで控えても restoreFocus() が「人が先に触っていたら奪わない」で降りるので害は無い
  if (!ui || !node) return;
  if (!ui.bar.contains(node) && !ui.wrap.contains(node)) return;
  focusMemo = {
    sessionId: ui.sessionId, node,
    start: typeof node.selectionStart === 'number' ? node.selectionStart : null,
    end: typeof node.selectionEnd === 'number' ? node.selectionEnd : null,
    at: performance.now(),
  };
}

/** 控えた焦点を戻す。人が先にどこかを触っていたら奪わない。 */
function restoreFocus() {
  const memo = focusMemo;
  focusMemo = null;
  if (!memo || memo.sessionId !== ui.sessionId) return;
  if (performance.now() - memo.at > FOCUS_MEMO_MS) return;
  requestAnimationFrame(() => {
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
 * 中央下の入力欄に入れる節点。終わっているセッションのときだけ返す。
 *
 * **どのタブを見ていても呼ばれる。** パネル（resumePanel）は「いま」のタブにしか出ないが、
 * 入力欄はタブに関係なく手が届く場所に置くので、選択肢の当て込みもこちらに要る。
 *
 * @param {object|null} row 詳細ペインが持っている行
 * @returns {HTMLElement|null}
 */
export function composerFor(row) {
  if (!canOffer(row)) return null;
  const bar = syncUi(row).bar;
  applyOptions();
  loadOptions();
  return bar;
}

/**
 * 詳細ペインを組み直す前に呼ぶ。焦点を控えるだけで、器は捨てない。
 *
 * `Timeline.detach()` / `RunView.detach()` と同じ役目。
 */
export function detach() {
  saveFocus();
}

/**
 * 「続きを起こす」のパネル。出す条件を満たさなければ null。
 *
 * @param {object|null} row 詳細ペインが持っている行（`headOf()` の結果）
 * @returns {HTMLElement|null}
 */
export function resumePanel(row) {
  if (!canOffer(row)) return null;
  const p = panel('このセッションの続きを起こす', { id: SEC.resume });
  const dl = el('dl', 'facts');
  fact(dl, 'フォルダ', row.cwd);
  p.body.append(dl, syncUi(row).wrap);
  // 引けていれば即座に反映され、まだなら着いた時点で `applyOptions()` が当たる
  applyOptions();
  loadOptions();
  restoreFocus();
  return p.section;
}
