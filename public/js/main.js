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
 *   層1  store.js（kinds.js を直に見る）/ panel.js / detail-head.js
 *   層2  rows.js / drawer.js / timeline/（外からは index.js の1枚として見る）
 *   層3  detail-wait.js / detail-panels.js / agents.js
 *   層4  detail.js
 *   層5  session.js
 *   層6  list.js
 *   層7  archive.js / stream.js / settings.js / update.js
 *   層8  このファイル
 *
 * timeline/ の中も6枚で層をなしているが、外から見るときは index.js の1枚として扱う。
 * 中の向きは timeline/index.js の冒頭に書いてある。
 *
 * 循環を切っている所が4つある。動かすと立ち上がらないので、理由を書いておく。
 *   - hideQueryValue は引数で受け取る（store → kinds → store を切る）
 *   - store.js は timeline/kinds.js を直に見る（index → view → store を切る）
 *   - detailErrorNow は rows.js に置く（detail ⇄ session を切る）
 *   - setListOpen は drawer.js に置く（list → main → list を切る）
 *
 * 時系列は timeline/ に分けてある。呼ぶのは Timeline.* を通してだけで、
 * あちらの中のファイルを直に import しない（理由は timeline/index.js の冒頭に書いてある）。
 *
 * 'use strict' は書かない。module は常に strict で動く。
 */
import { query, dom, store } from './store.js';
import { visibleRows } from './rows.js';
import { initListDrawer } from './drawer.js';
import { renderList } from './list.js';
import { initTabs } from './archive.js';
import { select, detailCache } from './session.js';
import { setLive, fetchOnce, connect } from './stream.js';
import { initSettings } from './settings.js';
import { initUpdate } from './update.js';

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
initTabs();
initSettings();
initUpdate();
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

fetchOnce().then(() => {
  // つなぎっぱなしの接続があるとヘッドレスブラウザがロード完了を待ち続ける。
  // 見た目の確認を撮るときは ?nolive=1 で止める
  if (query.get('nolive') === '1') {
    setLive('off', '自動更新なし');
    return;
  }
  connect();
});
