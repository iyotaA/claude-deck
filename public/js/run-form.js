/* この画面から新しいセッションを起こすフォーム。
 *
 * 層7。settings.js と同じ層で、作法もあちらに揃えてある。
 * <dialog> ＋ showModal()、<form> で囲まない、中身は開いたときに1回だけ引く。
 *
 * ## 窓口は自分で叩く
 *
 * runs.js（層2）は「取り口を増やさない」方針で、GET も POST も持っていない。
 * だからここが自分で fetch する。settings.js が /api/settings/notify を
 * 自分で叩いているのと同じ形で、層の向きは 7 → 5 → … の一方向のまま。
 *
 * ## 起こしたあと、勝手に画面を動かさない
 *
 * 起こした直後は会話ログがまだ1行も無く、一覧にも並ばない（合流は別の工程）。
 * その状態で詳細ペインへ飛ばすと「このセッションは開けませんでした」を
 * 数秒のあいだ見せることになる。だから結果はモーダルの中に出して、
 * 詳細へ移るかどうかは押した人に決めてもらう。
 */
import { el } from './util.js';
import { EFFORT_LABELS } from './runs.js';
import { dom } from './store.js';
import { select } from './session.js';

/** 開いたときに引いた選択肢。閉じても捨てないが、開くたびに引き直す */
let options = null;

/** 起こしたセッション。「詳細を開く」が押せるかどうかの根拠 */
let started = null;

/** 実行中。二度押しを止める */
let busy = false;

/** 下の帯に一言出す。空文字で消える */
function say(text, tone = '') {
  dom.runformMsg.textContent = text;
  dom.runformMsg.dataset.tone = text ? tone : '';
}

/**
 * いま起こせない理由。無ければ null。
 *
 * 押してから断られるより、開いた時点で分かるほうがよい。
 * サーバー側（run/index.mjs）が同じことをもう一度見るので、
 * ここを抜けたとしても危ないほうへは倒れない。
 *
 * @returns {string|null}
 */
function blockReason() {
  if (!options) return null;

  // ok が null は「まだ確かめている」。**false と同じに扱わない**（0 と不明を分ける）
  const c = options.claude;
  if (c?.ok === false) return `claude を起動できません（${c.reason ?? c.label ?? '理由不明'}）`;

  const s = options.runs;
  if (Number.isFinite(s?.active) && Number.isFinite(s?.max) && s.active >= s.max) {
    return `いま ${s.active} 本動いています（同時に動かせるのは ${s.max} 本まで）`;
  }

  if (!options.cwds?.length) return '起こせるフォルダがありません';
  return null;
}

/** 実行ボタンの入切。塞がっている理由があるあいだは、押せる状態に戻さない */
function setBusy(on) {
  busy = on;
  dom.runformStart.disabled = on || Boolean(blockReason());
  dom.runPrompt.disabled = on;
}

/** 選んだモードが危ないものなら、赤い但し書きを見せる */
function noteMode() {
  dom.runNote.hidden = dom.runMode.selectedOptions[0]?.dataset.danger !== '1';
}

/**
 * <select> の中身を組み直す。
 *
 * @param {HTMLSelectElement} sel
 * @param {Array<{value: string, label: string, danger?: boolean}>} items
 */
function fillSelect(sel, items) {
  sel.replaceChildren();
  for (const it of items) {
    const opt = el('option', null, it.label);
    opt.value = it.value;
    // 但し書きを出すかどうかの根拠。値そのもの（bypassPermissions）で
    // 判定すると、語彙が増えたときにここも直すことになる
    if (it.danger) opt.dataset.danger = '1';
    sel.append(opt);
  }
}

/** 引いた選択肢を画面へ流し込む */
function fillOptions(o) {
  options = o;

  fillSelect(dom.runCwd, (o.cwds ?? []).map((v) => ({ value: v, label: v })));

  fillSelect(dom.runMode, (o.modes ?? []).map((m) => ({
    value: m.value, label: m.label, danger: m.danger,
  })));
  if (o.defaultMode) dom.runMode.value = o.defaultMode;

  fillSelect(dom.runEffort, [
    { value: '', label: '指定しない（CLI の既定）' },
    ...(o.efforts ?? []).map((v) => ({ value: v, label: EFFORT_LABELS[v] ?? v })),
  ]);

  const b = o.budget ?? {};
  if (Number.isFinite(b.min)) dom.runBudget.min = String(b.min);
  if (Number.isFinite(b.max)) dom.runBudget.max = String(b.max);
  if (Number.isFinite(b.default)) dom.runBudget.value = String(b.default);
  if (Number.isFinite(o.promptMax)) dom.runPrompt.maxLength = o.promptMax;

  noteMode();
  const blocked = blockReason();
  dom.runformStart.disabled = Boolean(blocked);
  say(blocked ?? '', 'bad');
}

async function loadOptions() {
  try {
    const res = await fetch('/api/runs/options', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fillOptions(await res.json());
  } catch (err) {
    options = null;
    dom.runformStart.disabled = true;
    say(`選択肢を読めませんでした（${err.message}）`, 'bad');
  }
}

/**
 * 送る中身を組む。
 *
 * **空欄はキーごと送らない。** サーバー側が「無ければ既定」で組み立てるので、
 * 空文字を送ると「指定したのに空」と読まれかねない（設定モーダルと同じ作法）。
 *
 * @param {string} prompt 前後を落とした指示文
 */
function collect(prompt) {
  const body = { cwd: dom.runCwd.value, prompt, permissionMode: dom.runMode.value };

  const model = dom.runModel.value.trim();
  if (model) body.model = model;

  const effort = dom.runEffort.value;
  if (effort) body.effort = effort;

  const budget = dom.runBudget.value.trim();
  if (budget) body.budgetUsd = Number(budget);

  return body;
}

async function start() {
  if (busy || dom.runformStart.disabled) return;

  const prompt = dom.runPrompt.value.trim();
  if (!prompt) {
    say('指示を書いてください', 'bad');
    dom.runPrompt.focus();
    return;
  }

  setBusy(true);
  say('起こしています…');
  try {
    const res = await fetch('/api/runs', {
      method: 'POST',
      // 付け忘れると書き込み口の門番に断られる。ここ1箇所に寄せてある
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(collect(prompt)),
    });
    const data = await res.json().catch(() => null);

    if (!res.ok || !data?.ok) {
      // サーバーは断る理由を日本語で返す。HTTP の番号より読めるので、あればそれを出す
      say(data?.reason ?? `起こせませんでした（HTTP ${res.status}）`, 'bad');
      return;
    }

    started = data.run?.sessionId ?? null;
    // 同じ指示をもう一度送ってしまわないように空にする
    dom.runPrompt.value = '';
    dom.runformShow.hidden = !started;
    say('起こしました。最初の応答が出るまで少しかかります', 'good');
  } catch (err) {
    say(`起こせませんでした（${err.message}）`, 'bad');
  } finally {
    setBusy(false);
  }
}

/**
 * 起こしたセッションの詳細を開く。
 *
 * 経路は 'query'。**'live' にしてはいけない。**
 * 起こした直後は一覧にまだ並ばないので、'live' で選ぶと次の push（2秒後）に
 * stream.js が「一覧から消えた」と読んで選択を外し、先頭のセッションへ飛ぶ。
 */
function show() {
  if (!started) return;
  select(started, 'query');
  dom.runform.close();
}

/**
 * 起こすフォームを開く。
 *
 * 上のバーのボタンとパレット（Ctrl+K）が同じ口を通る。
 * 開くたびに前回の結果を消して、中身は1回だけ引く
 */
export function openRunForm() {
  started = null;
  dom.runformShow.hidden = true;
  say('');
  dom.runform.showModal();
  // 中身は開いたときに1回だけ引く。ここを毎秒更新しない。
  // 中で受け止めているので await せずに投げてよい
  loadOptions();
  dom.runPrompt.focus();
}

export function initRunForm() {
  dom.runformOpen.addEventListener('click', openRunForm);
  dom.runformClose.addEventListener('click', () => dom.runform.close());

  // 背面を押したら閉じる。dialog 自身に余白を持たせていないので、
  // ここへ来るのは背面を押したときだけになる（run.css の padding: 0）
  dom.runform.addEventListener('click', (ev) => {
    if (ev.target === dom.runform) dom.runform.close();
  });

  dom.runformStart.addEventListener('click', start);
  dom.runformShow.addEventListener('click', show);
  dom.runMode.addEventListener('change', noteMode);

  // <form> で囲っていないので Enter は自分で拾う。
  // **本文欄だけは別扱い。** あそこの Enter は改行で、実行は Ctrl+Enter。
  // 長い指示を書いている途中に Enter で走り出すのがいちばん困る。
  //
  // 見るのはクラス名ではなく要素名にしてある。中の見た目は設定モーダルの
  // クラス（.settings-text など）を借りているので、クラスで判定すると
  // 借り先の名前がここに書かれることになる。<button> は素通りさせてよい
  // （ボタンの上の Enter はブラウザが click に変える）
  dom.runform.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    if (ev.target === dom.runPrompt) {
      if (!ev.ctrlKey && !ev.metaKey) return;
    } else if (!ev.target.matches('input, select')) {
      return;
    }
    ev.preventDefault();
    start();
  });
}
