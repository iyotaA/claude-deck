/* 詳細ペインの組み立て。
 *
 * 層4。パネル1枚ずつの中身は detail-head / detail-wait / detail-panels / agents が持ち、
 * ここは「どのタブに入れるか」と「作り直すかどうか」だけを決める。
 *
 * 以前は11枚のパネルを1本の縦棒に積んでいた。同時に置きうる情報の塊が多すぎて、
 * いま何を見ればいいのかが分からなくなっていたので、役目で6つのタブに割ってある。
 *
 *   いま … あなたの番 / この画面から起こした実行 / 続きを起こす
 *   経過 … 文脈の圧縮 / 時系列
 *   調査 … サブエージェントの記録
 *   数値 … 何にトークンを使ったか
 *   成果 … 決めたこと / TODO / 書き換えたファイル
 *   状態 … セッションの状態
 *
 * **選んだタブのぶんだけ組む。** 全部組んで CSS で隠す形にはしない。
 * timelinePanel() は必ず Timeline.attach() を呼ぶので、隠した節点を掴んだままになり、
 * 画面に出ていない時系列へ描き続けることになる。
 */
import { el, num } from './util.js';
import { mark } from './perf.js';
import { dom, store, syncQuery, STATE_COLOR } from './store.js';
import { headOf, detailErrorNow } from './rows.js';
import { panel } from './panel.js';
import { detailActions, summaryBlock } from './detail-head.js';
import { waitingBlock } from './detail-wait.js';
import {
  decisionsPanel, todoPanel, compactionPanel, timelinePanel, filesPanel, basicsPanel,
} from './detail-panels.js';
import { agentsPanel } from './agents.js';
import { usagePanel } from './usage-panel.js';
import { runStampFor } from './runs.js';
import * as RunView from './run-view.js';
import * as RunResume from './run-resume.js';
import * as Timeline from './timeline/index.js';

/**
 * 「いま」のタブに色を付ける状態。あなたの手が要るものだけ。
 *
 * running（Claude が動いている）には付けない。選んでいるタブの下線が --accent で、
 * 実行中の色（--calm）と同じ青なので、押されているのか色が付いているのか分からなくなる
 */
const NOW_TONE = {
  'needs-answer': 'is-hot',
  'needs-plan-approval': 'is-hot',
  'needs-approval': 'is-hot',
  'awaiting-reply': 'is-warn',
};

/**
 * 中央タブの定義。並びがそのまま画面の並び。id は store.detailTab の値。
 *
 * count はタブの右肩に出す数。**データを直に読む。**
 * パネルの戻り値からは取れない（選んでいないタブのパネルは組まないため）。
 *
 * 0 のときは数を出さない。ほとんどのセッションはサブエージェントを持たないので、
 * すべてのタブに 0 が並ぶだけになる。空かどうかは押したときの1行で言う。
 * そこでなら「まだ読めていない」と「無い」を書き分けられる
 *
 * needsDetail は「会話ログの全文（store.detail）が無いと何も組めない」印。
 * 立っているタブは、読めていなければ既存の取得中・失敗の表示へ倒す
 */
const TAB_DEFS = [
  { id: 'now', label: 'いま' },
  { id: 'log', label: '経過', needsDetail: true, count: (c) => c.d?.digest.items.length ?? null },
  { id: 'agents', label: '調査', needsDetail: true, count: (c) => c.d?.subagents?.items?.length ?? null },
  { id: 'usage', label: '数値' },
  { id: 'out', label: '成果', needsDetail: true },
  { id: 'basics', label: '状態' },
];

/**
 * いま出してよい数値。
 *
 * 選び直した直後は、前のセッションの数値がまだ store に残っている。
 * id を突き合わせないと、別のセッションの数字を数秒のあいだ出し続けることになる
 * （数値は詳細とは別の窓口から、別のタイミングで届く）
 *
 * @returns {object|null}
 */
function usageNow() {
  return store.usage?.id === store.selected ? store.usage : null;
}

/** 数値を取れなかった理由。detailErrorNow と同じく、選んでいるセッションのものだけ返す */
function usageErrorNow() {
  return store.usageErrorFor === store.selected ? store.usageError : null;
}

/**
 * いま出してよい「直近の中央値」。
 *
 * 数値そのものとは別の窓口から、さらに遅れて着く（直近24本を全文読むので実測 400〜700ms）。
 * 着くまでは null で、そのあいだは札に差を書かないだけ。**推測で 0 を書かない。**
 *
 * @returns {object|null}
 */
function baselineNow() {
  return store.usageBaseline?.id === store.selected ? store.usageBaseline.baseline : null;
}

/**
 * 詳細ペインを作り直すかどうかの材料。
 *
 * 一覧の push は2秒ごとに来る。そのたびに作り直すと、開いた <details> と
 * スクロール位置が消える。実際に画面へ出している値が動いたときだけ作り直す。
 *
 * idleMs と lastActivityAt は入れない。refreshTimes() が文字だけ差し替えるので
 * 作り直す必要がなく、しかも毎秒動くので入れると条件そのものが意味を失う
 */
function detailKeyOf() {
  const row = headOf(store.selected);
  const w = row?.waitingFor ?? null;
  return [
    store.selected ?? '',
    detailErrorNow() ?? '',
    // 開いているタブ。混ぜないと、押しても renderDetailIfNeeded() が素通りする
    store.detailTab,
    row?.state ?? '',
    row?.stateLabel ?? '',
    row?.stateReason ?? '',
    row?.statusRaw ?? '',
    row?.alive ? '1' : '0',
    row?.pid ?? '',
    row?.contextTokens ?? '',
    w ? `${w.tool ?? ''}${w.detail ?? ''}` : '',
    // 数値は詳細より遅れて届く。入れておかないと、届いてもパネルが出ない。
    // contextTokens が既に入っているので、稼働中は元から毎ターン作り直している。
    // ここを足したことで作り直しが増えるわけではない
    usageNow()?.logSize ?? '',
    usageErrorNow() ?? '',
    // 中央値はさらに遅れて着く（別の窓口。直近24本を読むので数値より遅い）。
    // ここへ入れておかないと、着いても鍵が動かず、札に差が書き足されない
    baselineStamp(),
    // 実行の状態。**出来事が増えただけでは動かない値**を runs.js が組んでいる。
    // 速報は1ターンで数百行来るので、それを鍵に混ぜると入力中の caret まで毎回消える。
    // 中への追記は RunView.render() が別に受け持つ
    runStampFor(store.selected),
  ].join('');
}

/**
 * 中央値のうち、実際に画面へ出している値だけを1本にまとめる。detailKeyOf の材料。
 *
 * 有無だけでは足りない。5分ごとに引き直したときに中身が動いていても鍵が同じままになる。
 * オブジェクトそのものを見比べない（毎回別の参照で届くので、必ず不一致になる）
 *
 * @returns {string}
 */
function baselineStamp() {
  const b = baselineNow();
  if (!b) return '';
  return [b.model, b.sessions, b.ite, b.contextLast, b.hitRate, b.compactCount].join(',');
}

/** 前回 renderDetail() を通したときの材料。detail は参照そのままで見比べる */
let lastDetailRender = { detail: undefined, key: null };

/**
 * 必要なら詳細ペインを作り直す。
 *
 * apply() と loadDetail() は毎秒ここを通る。作り直すかどうかの判断は detailKeyOf() に寄せた
 */
export function renderDetailIfNeeded() {
  if (lastDetailRender.detail === store.detail && lastDetailRender.key === detailKeyOf()) return;
  renderDetail();
}

/**
 * 中央タブの帯。
 *
 * 上に残す（sticky）。詳細は縦に長いので、下まで読んでから別のタブへ移るときに
 * 一番上まで戻らせない
 *
 * @param {{row: object, d: object|null}} ctx タブの数を出すための材料
 */
function tabBar(ctx) {
  const bar = el('nav', 'detail-tabs');
  bar.setAttribute('aria-label', 'このセッションの何を見るか');

  for (const t of TAB_DEFS) {
    const b = el('button', 'detail-tab', t.label);
    b.type = 'button';
    const on = store.detailTab === t.id;
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    // 「いま」だけは、別のタブを見ているあいだも手が要ることが分かるように色を付ける
    if (t.id === 'now' && NOW_TONE[ctx.row.state]) b.classList.add(NOW_TONE[ctx.row.state]);
    const n = t.count ? t.count(ctx) : null;
    if (n) b.append(el('span', 'n', num(n)));
    b.addEventListener('click', () => {
      if (store.detailTab === t.id) return;
      store.detailTab = t.id;
      syncQuery();
      renderDetail();
      // 前のタブで下まで読んでいた位置が残ると、移った先の途中から始まってしまう
      dom.detail.scrollTop = 0;
    });
    bar.append(b);
  }
  return bar;
}

/**
 * 選んでいるタブの中身を組んで stack へ積む。
 *
 * 空のときに黙って空白にしない。1行だけでも書いておかないと、
 * 押したのに何も起きていないように見える
 *
 * @param {HTMLElement} stack 積む先
 * @param {{row: object, d: object|null}} ctx
 */
function fillTab(stack, ctx) {
  const { row, d } = ctx;
  const add = (node) => { if (node) stack.append(node); };
  const none = (text) => stack.append(el('p', 'tab-none', text));

  switch (store.detailTab) {
    case 'log':
      // 圧縮を時系列の上に置く。どこで文脈が切れたかは、時系列の読み方そのものを変える
      add(compactionPanel(d));
      // timelinePanel は必ず節点を返す（Timeline.attach() を呼ぶのはここだけ）
      add(timelinePanel(d));
      break;

    case 'agents': {
      const p = agentsPanel(d.subagents, row.sessionId);
      if (p) add(p);
      else none('このセッションはサブエージェントを呼んでいません');
      break;
    }

    case 'usage': {
      // 詳細（d）が読めていなくても出せる。別の窓口から来るので、詳細の失敗に巻き込む理由が無い
      const p = usagePanel(usageNow(), d, usageErrorNow(), baselineNow());
      if (p) add(p);
      else if (usageNow()) none('このセッションには数えられる要求がありません');
      else none('数値を読んでいます…');
      break;
    }

    case 'out': {
      const before = stack.childElementCount;
      add(decisionsPanel(d));
      add(todoPanel(d));
      add(filesPanel(d));
      if (stack.childElementCount === before) none('まだ決めたこと・TODO・書き換えたファイルはありません');
      break;
    }

    case 'basics':
      add(basicsPanel(row, d));
      break;

    default: {
      // 'now'。何を待っているか → この画面から起こした実行 → 続きを起こす。
      // if (d) の外なのは、起こした直後はまだ会話ログが1行も無いため
      // （ログが出るまで何も出ないと、押したのに何も起きていないように見える）
      const before = stack.childElementCount;
      add(waitingBlock(row, d));
      add(RunView.runPanel(row.sessionId));
      add(RunResume.resumePanel(row));
      if (stack.childElementCount === before) none('いまあなたの手が要るものはありません');
      break;
    }
  }
}

export function renderDetail() {
  const t0 = performance.now();
  // row と呼んでいるのは一覧の行と同じ形のもの。一覧に居なければ詳細から組む
  const row = headOf(store.selected);
  const error = detailErrorNow();
  lastDetailRender = { detail: store.detail, key: detailKeyOf() };
  // 前の取っ手はここで捨てる。作り直したあとの画面に無い節点を掴んだままにしない。
  // 実行パネルも同じ形で器を預かっているので、そちらも一緒に手放す
  Timeline.detach();
  RunView.detach();
  RunResume.detach();
  dom.detail.replaceChildren();

  // 入口を3つに割る。ひとまとめにすると「選んでいない」「取得中」「取得に失敗した」が
  // すべて同じ空表示になり、存在しない id を開いても何も起きていないように見える
  if (!row) {
    if (!store.selected) {
      dom.detail.append(el('div', 'detail-empty', '左の一覧からセッションを選ぶと、ここに中身が出ます'));
    } else if (error) {
      const p = panel('このセッションは開けませんでした');
      p.body.append(el('p', 'note', error));
      const id = el('p', 'note', 'セッションID ');
      id.append(el('span', 'mono', store.selected));
      p.body.append(id);
      dom.detail.append(p.section);
    } else {
      dom.detail.append(el('div', 'loading', 'ログを読んでいます…'));
    }
    mark('detail', t0);
    return;
  }

  const wrap = el('div', 'detail');
  wrap.append(el('h2', null, row.title ?? row.name ?? row.sessionId));

  const sub = el('div', 'detail-sub');
  // stateLabel が無いときに空の .state を出すと、色の点だけが残って意味を持たない
  if (row.stateLabel) {
    const state = el('span', 'state', row.stateLabel);
    state.style.color = STATE_COLOR[row.state] ?? 'var(--off)';
    sub.append(state);
  }
  if (row.cwd) sub.append(el('span', 'path', row.cwd));
  wrap.append(sub);
  wrap.append(detailActions(row));

  const d = store.detail?.sessionId === store.selected ? store.detail : null;

  // なぜこの作業をしているか。どのタブを見ていても要るので、帯より上に置く
  if (d) {
    const summary = summaryBlock(d.summary);
    if (summary) wrap.append(summary);
  }

  const ctx = { row, d, error };
  wrap.append(tabBar(ctx));

  const stack = el('div', 'stack');
  const def = TAB_DEFS.find((t) => t.id === store.detailTab) ?? TAB_DEFS[0];
  if (def.needsDetail && !d) {
    // 全文が無いと何も組めないタブ。既存の取得中・失敗の表示へ倒す
    if (error) {
      const p = panel('詳細を読み込めませんでした');
      p.body.append(el('p', 'note', error));
      stack.append(p.section);
    } else {
      stack.append(el('div', 'loading', 'ログを読んでいます…'));
    }
  } else {
    fillTab(stack, ctx);
  }

  wrap.append(stack);
  // 時系列の中身はここで入れる。まだ document に付いていないので、
  // 120件を組んでもレイアウトの計算は1回で済む。
  // 「経過」以外のタブでは Timeline.attach() を通っていないので、何もしないで帰る
  Timeline.render();
  dom.detail.append(wrap);
  mark('detail', t0);
}
