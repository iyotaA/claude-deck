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
 *   層0  util.js / perf.js / timeline/kinds.js / nav.js / groups.js   誰にも依存しない
 *   層1  store.js（kinds.js を直に見る）/ panel.js / detail-head.js / usage-chart.js
 *   層2  rows.js / drawer.js / zoom.js / resize.js / runs.js /
 *        timeline/（外からは index.js の1枚として見る）
 *   層3  detail-wait.js / detail-panels.js / agents.js / usage-panel.js /
 *        run-view.js / run-resume.js
 *   層4  detail.js
 *   層5  session.js
 *   層6  list.js
 *   層7  archive.js / usage-tab.js / mode.js / stream.js / settings.js /
 *        update.js / run-form.js / palette.js
 *   層8  このファイル
 *
 * 数値は2つに分かれている。1本ぶんが usage-panel.js（層3・詳細ペイン）、
 * 横断が usage-tab.js（層7・モードの1つ）。絵の部品（usage-chart.js）だけを共有する。
 * 層7 の中の向きは3本。palette.js → run-form.js / stream.js → mode.js /
 * palette.js → mode.js。どれも片方向で、逆を足すと循環になる。
 * usage-tab.js は誰からも import されない（呼ぶのはこのファイルだけ）。
 * mode.js の setMode が書庫と数値を出す口は initMode({ onArchive, onUsage }) で差してある。
 * palette.js は層7 のいちばん下流で、誰からも import されない（呼ぶのはこのファイルだけ）。
 *
 * mode.js が層7 なのは list.js（層6）の renderList を呼ぶため。
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
import { query, store, LS } from './store.js';
import { dom } from './dom.js';
import { icon } from './icons.js';
import { visibleRows } from './rows.js';
import { initListDrawer, setListOpen, initialListOpen } from './drawer.js';
import { initZoom, openZoom, closeZoom } from './zoom.js';
import { initMarks } from './marks.js';
import { initResize } from './resize.js';
import { initRuns, subscribeRuns } from './runs.js';
import { renderDetail, renderDetailIfNeeded, initInspector } from './detail.js';
import { renderList, renderRate } from './list.js';
import { initArchive, showArchive } from './archive.js';
import { initToday } from './today.js';
import { showUsage, initUsageTab } from './usage-tab.js';
import { initMode, setMode } from './mode.js';
import { select, detailCache } from './session.js';
import { setLive, fetchOnce, connect, onReveal } from './stream.js';
import { initSettings } from './settings.js';
import { initAbout } from './about.js';
import { initUpdate } from './update.js';
import { initRunForm } from './run-form.js';
import { initPalette, openPalette } from './palette.js';

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
    // **`.row` も拾う。** 稼働中の一覧はカードから圧縮した行に替わったので、
    // `.card` だけ見ていると上下キーがそちらで効かない（書庫はカードのまま）
    const cards = [...listEl.querySelectorAll('.card, .row')];
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

initListDrawer();
// 前に開いていた形で始める（既定は開く）。
// **覚えさせない（remember: false）。** ここは復元であって人の操作ではないので、
// 書き戻すと「読んだ値をそのまま書く」だけの無駄な往復になる
setListOpen(initialListOpen(), null, false);
// 拡大は帯のボタン・Esc・背面・× の4つで開閉する。どれで閉じても札が
// 「縮小」のまま残らないよう、組み直しをこちらから差す（向きは 8 -> 2）。
// 差すのは renderDetail のほう。renderDetailIfNeeded は中身が同じなら何もしないので、
// 札だけを付け替えたいこの用には効かない
// 「作業台で開く」の行き先もここで差す（zoom.js は層2 なので mode.js を import しない）
// 「次の待ち →」の選び直しもここで差す（zoom.js は層2 なので session.js を import しない）
initZoom({ onChange: renderDetail, onOpenInWork: () => setMode('work'), onPick: (id) => select(id, 'live') });
// ピン留めとメモ（段8）。メモの窓の配線
initMarks();
initInspector();
initResize();
// 書庫の探す帯を配線してから initMode に渡す。あちらの setMode は
// ?mode=archive で開いたときに onArchive（= showArchive）をその場で呼ぶので、
// 先に配線しておかないと検索欄の初期値が当たる前に引き始める。
// 押されたあとの後始末も、ここで差す（archive.js は mode.js も zoom.js も import しない）。
// **書庫にいたまま詳細を出す。** 作業台へ飛ばすと、探していた結果がその場で消える。
// 中身は組み直さず、詳細ペインの節点をモーダルへ運ぶだけ（理由は zoom.js の冒頭）
initArchive({ onPick: () => openZoom() });
initToday();
// 数値モードの絞り込みを配線してから initMode に渡す。あちらの setMode は
// ?mode=usage で開いたときに onUsage（= showUsage）をその場で呼ぶので、
// 先に配線しておかないと <select> の初期値が当たる前に引き始める。
// **数値にいたまま詳細を出す**（書庫と同じ形。画面刷新⑤の D27）。前は作業台へ移していたが、
// 読み比べていたセッションの並びがその場で消える。移るかどうかは窓の頭の「作業台で開く」で押した人が決める
initUsageTab({ onPick: () => openZoom() });
// パレットより前に置く。あちらは mode.js の setMode を呼ぶので、
// 押される前にモードが当たっていないと最初の1回が空振りする。
// 数値モードの中身は usage-tab.js にあるので、出す口だけを差す
// （mode.js があちらを import すると、同じ層7 に向きが1本増える）
initMode({ onUsage: showUsage, onArchive: showArchive });
initSettings();
initAbout();
initUpdate();
initRunForm();
initPalette();
initListKeys(dom.list, 'live');
initListKeys(dom.archive, 'archive');

/**
 * 一覧の頭の「すべて｜稼働中」の押している側を、いまの `store.onlyLive` に合わせる。
 * **状態は store の1つだけ。** ボタンの aria-pressed は写しで、旗を2つ持たない
 */
function syncShowButtons() {
  dom.showAll.setAttribute('aria-pressed', String(!store.onlyLive));
  dom.showLive.setAttribute('aria-pressed', String(store.onlyLive));
}

/**
 * 一覧に何を出すかを替える（すべて／稼働中）。
 * いま押している側をもう一度押したときは何もしない（一覧を引き直す理由が無い）。
 *
 * @param {boolean} on 稼働中のセッションだけを出すなら true
 */
function setOnlyLive(on) {
  if (store.onlyLive === on) return;
  store.onlyLive = on;
  localStorage.setItem(LS.onlyLive, on ? '1' : '0');
  syncShowButtons();
  renderList();
  // 絞り込みで選んでいた行が消えたら、見えている先頭に移す
  const visible = visibleRows();
  if (!visible.some((r) => r.sessionId === store.selected)) {
    select(visible[0]?.sessionId ?? null);
  }
}

syncShowButtons();
dom.showAll.addEventListener('click', () => setOnlyLive(false));
dom.showLive.addEventListener('click', () => setOnlyLive(true));

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

// 上のバー・作業台の左上・左のレールのアイコン。**起動時に1回だけ差す。**
//
// HTML 側は空のボタンにしてある。innerHTML を使わない決まりなので、
// SVG は icons.js が createElementNS で組んだ節点をここで append する。
// 名前は aria-label（絵だけのボタンは title も）が持つので、絵だけにしても意味は消えない。
//
// 一覧の開閉は 18px。面も枠も持たないボタン（2rem）の中の絵だけが目印なので、16px だと器に対して小さく沈む。
// 「起こす」と探す欄は 14px にする。文字と並ぶので、16px だと絵のほうが大きく見える
dom.listToggle.append(icon('sidebar', 18));
dom.runformOpen.prepend(icon('plus', 14));
dom.paletteOpen.prepend(icon('search', 14));
dom.reload.append(icon('refresh'));
// 探す欄は入口のボタン。開くのは Ctrl+K と同じパレット（判断は持たず、口を呼ぶだけ）
dom.paletteOpen.addEventListener('click', openPalette);

// 左のレール。**札は 20px で描く**（44px の札の中で 16px だと絵が小さく沈む）。
// 頭の印だけ 24px にする。押せる札ではなく看板なので、札と同じ大きさだと
// 並びの先頭が札の1枚に見える（モックも印を札より1段大きく描いている）。
// 線の太さはどちらも base.css が 1.5px に揃え直す（20px は 1.2、24px は 1 で補正）。
// 設定は歯車（gear）のまま。横スライダーは 16px で「多」の字に見えた実測があるので使わない。
// 作業台の札はバッジ（#rail-badge）を中に持つので、絵は先頭へ差す
dom.navrailLogo.append(icon('deck', 24));
dom.modeWork.prepend(icon('work', 20));
dom.modeArchive.append(icon('archive', 20));
dom.modeUsage.append(icon('chart', 20));
dom.todayOpen.append(icon('today', 20));
dom.settingsOpen.append(icon('gear', 20));
dom.aboutOpen.append(icon('info', 20));
// 選ぶ口の絵。**12箇所をまとめて1回で舐める。**
// ネイティブの矢印は base.css が消しているので、代わりに置く形が要る。
// chevron を 90 度回して下向きにするのは CSS 側（`.selectbox > .sel-mark`）。
//
// **`sel-mark` の名前を必ず付ける。** 器の中には先頭の絵（書庫の `sort` など）も
// 居るので、`.icon` で当てると**そちらまで右端へ飛んで 90 度回る**
// （横棒3本が縦棒3本になって、シェブロンと重なって出ていた）。
//
// 器は index.html に静的に置いてあるものだけなので、ここで1回差せば足りる
// （候補が入れ替わっても器は作り直さない）
for (const box of document.querySelectorAll('.selectbox')) {
  const mark = icon('chevron', 13);
  mark.classList.add('sel-mark');
  box.append(mark);
}

fetchOnce().then(() => {
  // つなぎっぱなしの接続があるとヘッドレスブラウザがロード完了を待ち続ける。
  // 見た目の確認を撮るときは ?nolive=1 で止める
  if (query.get('nolive') === '1') {
    setLive('off', '自動更新なし');
    return;
  }
  // Windows の通知を押したとき（POST /api/reveal → 速報 reveal）。
  // **作業台へ移ってから選ぶ。** 書庫や数値のままだと、選んでも詳細が見えない。
  // 書庫から拡大で開いていたら先に畳む（「作業台で開く」と同じ順。逆にすると中央が空で出る）。
  // 選ぶのは 'query'（一覧に居ない終わったセッションでも、次の push で外されない）
  onReveal((sessionId) => {
    if (store.mode !== 'work') {
      closeZoom();
      setMode('work');
    }
    select(sessionId, 'query');
    // 窓を前に出すのはランチャの仕事（ブラウザは裏の窓からの focus を無視する）。
    // 前に出ている窓では、読み始められるよう詳細へ焦点を移す
    dom.detail.focus({ preventScroll: true });
  });
  connect();
  // 実行の速報は一覧とは別の SSE。あちらは全タブが常時つないでいる経路なので
  // 相乗りさせない（1ターン数百行の速報に一覧の更新が引きずられる）
  initRuns();
});
