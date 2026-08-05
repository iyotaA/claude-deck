/* 詳細ペインの組み立て。
 *
 * 層4。パネル1枚ずつの中身は detail-head / detail-wait / detail-panels / agents が持ち、
 * ここは「どの順で積むか」と「作り直すかどうか」だけを決める。
 *
 * 積む順は読む順。あなたの番 → 決めたこと → TODO → 圧縮 → 時系列 →
 * サブエージェント → ファイル → セッションの状態。
 */
import { el } from './util.js';
import { mark } from './perf.js';
import { dom, store, STATE_COLOR } from './store.js';
import { headOf, detailErrorNow } from './rows.js';
import { panel, navBlock, SEC } from './panel.js';
import { detailActions, summaryBlock } from './detail-head.js';
import { waitingBlock } from './detail-wait.js';
import {
  decisionsPanel, todoPanel, compactionPanel, timelinePanel, filesPanel, basicsPanel,
} from './detail-panels.js';
import { agentsPanel } from './agents.js';
import * as Timeline from './timeline/index.js';

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
    row?.state ?? '',
    row?.stateLabel ?? '',
    row?.stateReason ?? '',
    row?.statusRaw ?? '',
    row?.alive ? '1' : '0',
    row?.pid ?? '',
    row?.contextTokens ?? '',
    w ? `${w.tool ?? ''}${w.detail ?? ''}` : '',
  ].join('');
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

export function renderDetail() {
  const t0 = performance.now();
  // row と呼んでいるのは一覧の行と同じ形のもの。一覧に居なければ詳細から組む
  const row = headOf(store.selected);
  const error = detailErrorNow();
  lastDetailRender = { detail: store.detail, key: detailKeyOf() };
  // 前の取っ手はここで捨てる。作り直したあとの画面に無い節点を掴んだままにしない
  Timeline.detach();
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

  // なぜこの作業をしているか。読む順として、待ちの内容より先に来る必要がある
  if (d) {
    const summary = summaryBlock(d.summary);
    if (summary) wrap.append(summary);
  }

  const stack = el('div', 'stack');
  /** 上のジャンプ用リンクに出す並び。パネルを積むのと同じ順に足していく */
  const sections = [];
  /**
   * パネル1枚を積む。null（出すものが無い）はそのまま素通りする。
   *
   * 積む順と目次の並びを1箇所で揃えるための小道具。別々に書くと、
   * パネルを1枚足したときに目次だけ順番がずれる
   *
   * @param {{section: HTMLElement, nav?: object}|null} p
   */
  const add = (p) => {
    if (!p) return;
    stack.append(p.section);
    if (p.nav) sections.push(p.nav);
  };

  // 何を待っているか。自分の番のときはここが最初に読む場所になるので、目的の直下に置く
  add(waitingBlock(row, d));

  if (d) {
    add(decisionsPanel(d));
    add(todoPanel(d));
    add(compactionPanel(d));
    add(timelinePanel(d));
    // 時系列の下、書き換えたファイルの前。調査の記録は時系列の続きとして読まれる
    add(agentsPanel(d.subagents, row.sessionId));
    add(filesPanel(d));
  } else if (error) {
    const p = panel('詳細を読み込めませんでした');
    p.body.append(el('p', 'note', error));
    stack.append(p.section);
  } else {
    stack.append(el('div', 'loading', 'ログを読んでいます…'));
  }

  add(basicsPanel(row, d));

  // ジャンプ用リンクはパネルを積み終わってから作る（あるものだけを並べたいので）
  const nav = navBlock(sections);
  if (nav) {
    wrap.append(nav);
    // 目次の件数の差し替え先を教えておく。パネルが3枚に届かないと目次自体が出ないので、
    // 取れないこともある（Timeline 側が null を見て素通りする）
    Timeline.setNav(nav.querySelector(`[data-sec="${SEC.timeline}"] .n`));
  }

  wrap.append(stack);
  // 時系列の中身はここで入れる。まだ document に付いていないので、
  // 120件を組んでもレイアウトの計算は1回で済む
  Timeline.render();
  dom.detail.append(wrap);
  mark('detail', t0);
}
