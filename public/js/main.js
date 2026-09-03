/* ClaudeDeck の画面側の入口。index.html が読むのはこの1本だけ。
 *
 * 会話ログの中身をそのまま画面に出すので、文字列は必ず textContent で入れる。
 * innerHTML を使うと、ログに入っていたタグがそのまま解釈されてしまう。
 *
 * ESM なので読み込み順を人が守る必要はない。import が解決の順を決める。
 * 素の <script> を並べていたときは、順番を1つ入れ替えると立ち上がらず、
 * 同じ名前をトップレベルに2つ置くと SyntaxError で丸ごと落ちていた。
 *
 * 依存は上から下へ一方向にだけ流す。逆向きに import したくなったら置き場所が間違っている。
 *   層0  util.js / perf.js / timeline/kinds.js       誰にも依存しない
 *   層1  store.js（kinds.js を直に見る）/ panel.js / detail-head.js / usage-chart.js
 *   層2  rows.js / drawer.js / zoom.js / resize.js / runs.js /
 *        timeline/（外からは index.js の1枚として見る）
 *   層3  detail-wait.js / detail-panels.js / agents.js / usage-panel.js /
 *        run-view.js / run-resume.js
 *   層4  detail.js
 *   層5  session.js
 *   層6  list.js
 *   層7  archive.js / usage-tab.js / board.js / stream.js / settings.js /
 *        update.js / run-form.js / palette.js
 *   層8  このファイル
 *
 * 数値は2つに分かれている。1本ぶんが usage-panel.js（層3・詳細ペイン）、
 * 横断が usage-tab.js（層7・モードの1つ）。絵の部品（usage-chart.js）だけを共有する。
 * 層7 の中の向きは3本。palette.js → run-form.js / stream.js → board.js /
 * palette.js → board.js。どれも片方向で、逆を足すと循環になる。
 * usage-tab.js は誰からも import されない（呼ぶのはこのファイルだけ）。
 * board.js の setMode が数値モードを出す口は initBoard({ onUsage }) で差してある。
 * palette.js は層7 のいちばん下流で、誰からも import されない（呼ぶのはこのファイルだけ）。
 *
 * board.js（監視盤）が層7 なのは list.js（層6）から buildCard を借りているため。
 * 見た目を新しく作らないための借用で、向きはこちらが正しい。
 *
 * timeline/ の中も6枚で層をなしているが、外から見るときは index.js の1枚として扱う。
 * 中の向きは timeline/index.js の冒頭に書いてある。
 *
 * 循環を切っている所が4つある。動かすと立ち上がらないので、理由を書いておく。
 *   - hideQueryValue は引数で受け取る（store → kinds → store を切る）
 *   - store.js は timeline/kinds.js を直に見る（index → view → store を切る）
 *   - detailErrorNow は rows.js に置く（detail ⇄ session を切る）
 *   - setListOpen は drawer.js に置く（list → main → list を切る）
 *   - 拡大は zoom.js（層2）に置き、組み直しは initZoom({ onChange }) で差す
 *     （detail → zoom → detail を切る）
 *
 * 実行の速報も同じ形で切ってある。runs.js（層2）は描画側を知らず、
 * subscribeRuns(fn) で外から登録する。配線するのはこのファイル（層8）で、
 * runs.js が run-view.js を import すると runs(2) ⇄ run-view(3) の循環になる。
 *
 * 時系列は timeline/ に分けてある。呼ぶのは Timeline.* を通してだけで、
 * あちらの中のファイルを直に import しない（理由は timeline/index.js の冒頭に書いてある）。
 *
 * 'use strict' は書かない。module は常に strict で動く。
 */
import { query, dom, store } from './store.js';
import { icon } from './icons.js';
import { visibleRows } from './rows.js';
import { initListDrawer, setListOpen, initialListOpen } from './drawer.js';
import { initZoom } from './zoom.js';
import { initResize } from './resize.js';
import { initRuns, subscribeRuns } from './runs.js';
import { renderDetail, renderDetailIfNeeded, initInspector } from './detail.js';
import { renderList, renderRate } from './list.js';
import { initArchive, showArchive } from './archive.js';
import { showUsage, initUsageTab } from './usage-tab.js';
import { initBoard, setMode } from './board.js';
import { select, detailCache } from './session.js';
import { setLive, fetchOnce, connect } from './stream.js';
import { initSettings } from './settings.js';
import { initUpdate } from './update.js';
import { initRunForm } from './run-form.js';
import { initPalette } from './palette.js';

function initTheme() {
  const forced = query.get('theme');
  if (forced === 'dark' || forced === 'light') {
    document.documentElement.setAttribute('data-theme', forced);
  }

  const saved = forced ? null : localStorage.getItem('claude-deck.theme');
  if (saved === 'dark' || saved === 'light') {
    document.documentElement.setAttribute('data-theme', saved);
  } else if (!forced) {
    document.documentElement.removeAttribute('data-theme');
  }

  dom.themeToggle.addEventListener('click', () => {
    const root = document.documentElement;
    const now = root.getAttribute('data-theme')
      || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = now === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    localStorage.setItem('claude-deck.theme', next);
  });
}

/**
 * 一覧の中で上下キーで移動できるようにする。
 *
 * 稼働中と書庫で同じ操作にする。選んだ経路（from）だけが違う。
 *
 * @param {HTMLElement} listEl 対象の一覧
 * @param {'live'|'archive'} from 選んだ経路
 */
function initListKeys(listEl, from) {
  listEl.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    const cards = [...listEl.querySelectorAll('.card')];
    const at = cards.indexOf(document.activeElement);
    if (at === -1) return;
    const next = cards[at + (ev.key === 'ArrowDown' ? 1 : -1)];
    if (next) {
      ev.preventDefault();
      next.focus();
      select(next.dataset.sessionId, from);
    }
  });
}

initTheme();
initListDrawer();
// 前に開いていた形で始める（既定は開く）。
// **覚えさせない（remember: false）。** ここは復元であって人の操作ではないので、
// 書き戻すと「読んだ値をそのまま書く」だけの無駄な往復になる
setListOpen(initialListOpen(), null, false);
// 拡大は帯のボタン・Esc・背面・× の4つで開閉する。どれで閉じても札が
// 「縮小」のまま残らないよう、組み直しをこちらから差す（向きは 8 -> 2）。
// 差すのは renderDetail のほう。renderDetailIfNeeded は中身が同じなら何もしないので、
// 札だけを付け替えたいこの用には効かない
initZoom({ onChange: renderDetail });
initInspector();
initResize();
// 書庫の探す帯を配線してから initBoard に渡す。あちらの setMode は
// ?mode=archive で開いたときに onArchive（= showArchive）をその場で呼ぶので、
// 先に配線しておかないと検索欄の初期値が当たる前に引き始める。
// 押されたあと作業台へ移す口も、ここで差す（archive.js は board.js を import しない）
initArchive({ onPick: () => setMode('work') });
// 数値モードの絞り込みを配線してから initBoard に渡す。あちらの setMode は
// ?mode=usage で開いたときに onUsage（= showUsage）をその場で呼ぶので、
// 先に配線しておかないと <select> の初期値が当たる前に引き始める
initUsageTab({ onPick: () => setMode('work') });
// パレットより前に置く。あちらは board.js の setMode を呼ぶので、
// 押される前にモードが当たっていないと最初の1回が空振りする。
// 数値モードの中身は usage-tab.js にあるので、出す口だけを差す
// （board.js があちらを import すると、同じ層7 に向きが1本増える）
initBoard({ onUsage: showUsage, onArchive: showArchive });
initSettings();
initUpdate();
initRunForm();
initPalette();
initListKeys(dom.list, 'live');
initListKeys(dom.archive, 'archive');

dom.onlyLive.checked = store.onlyLive;
dom.onlyLive.addEventListener('change', () => {
  store.onlyLive = dom.onlyLive.checked;
  localStorage.setItem('claude-deck.onlyLive', store.onlyLive ? '1' : '0');
  renderList();
  // 絞り込みで選んでいた行が消えたら、見えている先頭に移す
  const visible = visibleRows();
  if (!visible.some((r) => r.sessionId === store.selected)) {
    select(visible[0]?.sessionId ?? null);
  }
});

// 手で押したときは詳細も取り直す。中身が同じでも読み直したい場面のためのボタンなので
dom.reload.addEventListener('click', () => {
  detailCache.clear();
  fetchOnce();
});

// 実行の台帳が動いた（現れた・状態が変わった・終わった）ので詳細ペインを作り直す。
//
// **速報1件ごとには来ない。** 画面は速報を1件も持たないので、runs.js は
// 中身を捨てて seq だけ進めている。1ターン数百行のたびに作り直すと、
// 開いた <details> と入力中の caret が毎回消える
subscribeRuns(() => {
  // 枠の使用率は行に載って届く。**一覧の tick 任せにしない。**
  // あちらが切れているあいだ（?nolive=1 や再接続待ち）に数だけ凍る
  renderRate();
  renderDetailIfNeeded();
});

// 上のバーのアイコン。**起動時に1回だけ差す。**
//
// HTML 側は空のボタンにしてある。innerHTML を使わない決まりなので、
// SVG は icons.js が createElementNS で組んだ節点をここで append する。
// 名前は title と aria-label が持つので、絵だけにしても意味は消えない。
//
// 「起こす」だけ 14px にする。文字と並ぶので、16px だと絵のほうが大きく見える
dom.listToggle.append(icon('sidebar'));
dom.brand.prepend(icon('deck'));
dom.runformOpen.prepend(icon('plus', 14));
dom.reload.append(icon('refresh'));
dom.settingsOpen.append(icon('gear'));
dom.themeToggle.append(icon('contrast'));

fetchOnce().then(() => {
  // つなぎっぱなしの接続があるとヘッドレスブラウザがロード完了を待ち続ける。
  // 見た目の確認を撮るときは ?nolive=1 で止める
  if (query.get('nolive') === '1') {
    setLive('off', '自動更新なし');
    return;
  }
  connect();
  // 実行の速報は一覧とは別の SSE。あちらは全タブが常時つないでいる経路なので
  // 相乗りさせない（1ターン数百行の速報に一覧の更新が引きずられる）
  initRuns();
});
