/* この画面から起こした実行のパネル。
 *
 * 層3。detail-panels.js・agents.js・usage-panel.js と同格で、返す形も同じ（{section, nav} か null）。
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
 * ## 速報であって正本ではない
 *
 * ここに出るのは「いま何が起きているか」。読み返す正本は ~/.claude/projects/ の会話ログで、
 * そちらは同じ詳細ペインの時系列パネルが描く。同じものを2通りに描かない。
 */
import { el, dur, stamp, shortModel, fact } from './util.js';
import { panel, SEC } from './panel.js';
import { runFor, eventsOf, droppedOf, runsMissed, EVENTS_PER_RUN } from './runs.js';
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
  if (state === 'stalled' || state === 'failed') return 'warn';
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
  // total_cost_usd のほうは累積（実測 0.803025 → 0.843727）。同じ行に並んでいるので混ぜやすい
  fact(dl, 'ここまでの費用', typeof ev.costUSD === 'number' ? `$${ev.costUSD.toFixed(4)}` : null);
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

/**
 * 実行パネル。この画面から起こしたセッションのときだけ出す。
 *
 * @param {string|null} sessionId 開いているセッション
 * @returns {{section: HTMLElement, nav: object}|null}
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

  attach({ log, drop, runId: row.runId });
  render();

  return { section: p.section, nav: { id: SEC.run, label: '実行', count: label, tone } };
}
