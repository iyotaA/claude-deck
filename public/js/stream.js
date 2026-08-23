/* データ取得。SSE でつなぎ、届いた一覧を画面へ流す。
 *
 * 層7。apply() が「1回の更新で何を描き直すか」を決めている場所なので、
 * 描き直す先（list / detail / session）をすべて見る。
 */
import { query, dom, store, syncQuery } from './store.js';
import { visibleRows } from './rows.js';
import { renderList, renderSummary, refreshTimes } from './list.js';
import { loadDetail } from './session.js';
import { renderDetailIfNeeded } from './detail.js';
import { renderBoard } from './board.js';

const initialSession = query.get('session');
let firstApply = true;

function apply(payload) {
  store.rows = payload.rows ?? [];
  store.meta = payload.meta ?? null;
  if (payload.meta?.now) store.now = payload.meta.now;
  // 一覧から選んでいたセッションが一覧から消えたら選択を外す。
  // ?session= で直に開いたものは一覧に居ないのが正常なので、push 1回で外してはいけない
  if (store.selected && store.selectedFrom === 'live'
    && !store.rows.some((r) => r.sessionId === store.selected)) {
    store.selected = null;
    store.selectedFrom = null;
  }
  if (firstApply) {
    firstApply = false;
    // 一覧にあるかどうかで判定しない。24時間より古いセッションも開けるようにするため。
    // 実在するかはサーバの応答で決まり、無ければ詳細側にエラーが出る
    if (initialSession) {
      store.selected = initialSession;
      store.selectedFrom = store.rows.some((r) => r.sessionId === initialSession) ? 'live' : 'query';
    }
  }
  // 何も選んでいなければ先頭を開く。並び順の先頭が最も急ぐものなので、
  // 開いた瞬間に見るべきものが出ている状態にする
  if (!store.selected) {
    store.selected = visibleRows()[0]?.sessionId ?? null;
    store.selectedFrom = store.selected ? 'live' : null;
  }
  // 開いているものを URL に残す。押して選んだときは select が書くが、
  // ここで自動的に決まった分（先頭を開く・?session= の取り込み）は通らない
  syncQuery();
  // まとめは書庫を出しているあいだも動かす。「誰かが待っている」の唯一の合図なので
  renderSummary();
  // 監視盤のあいだは中央も左も消えている。描いても誰も見ないうえ、詳細を引くのは
  // サーバー側の全文読みなので、見えないもののために毎2秒撃たない。
  // 作業台へ戻るときに setMode('work') が3つとも追いつかせる
  if (store.mode === 'board') {
    renderBoard();
    return;
  }
  // 数値モードのあいだも同じ。監視盤と違って**ここでは何も描かない。**
  // あちらは毎秒の一覧がそのまま材料だが、こちらの材料は /api/usage（ログを全文読む）で、
  // 開いたときに1回だけ引く形にしてある。作業台へ戻るときに setMode('work') が追いつかせる
  if (store.mode === 'usage') return;
  // 書庫を出しているあいだ #list には触らない。replaceChildren すると
  // 見えていない一覧のスクロール位置が毎秒先頭へ飛ぶ
  if (store.tab !== 'archive') renderList();
  // 詳細は「見えているものが動いたとき」だけ作り直す。毎回作り直すと、
  // 開いた <details> とスクロール位置が2秒ごとに消える
  renderDetailIfNeeded();
  // 詳細は中身が変わっていなければ取り直さない。
  // silent にして、取り直しのあいだも前の内容を出したままにする
  loadDetail(store.selected, { silent: true });
}

export function setLive(state, label) {
  dom.live.dataset.live = state;
  dom.live.textContent = label;
}

export async function fetchOnce() {
  try {
    const res = await fetch('/api/sessions', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    apply(await res.json());
    return true;
  } catch (err) {
    setLive('off', `取得できません（${err.message}）`);
    return false;
  }
}

export function connect() {
  let source;
  try {
    source = new EventSource('/api/stream');
  } catch {
    // SSE が使えない環境向けの保険
    setInterval(fetchOnce, 3000);
    fetchOnce();
    return;
  }

  source.addEventListener('open', () => setLive('on', 'つながっています'));
  source.addEventListener('sessions', (ev) => {
    setLive('on', 'つながっています');
    try {
      apply(JSON.parse(ev.data));
    } catch {
      /* 壊れたフレームは捨てる */
    }
  });
  source.addEventListener('tick', (ev) => {
    try {
      const { now } = JSON.parse(ev.data);
      if (now) {
        store.now = now;
        refreshTimes();
      }
    } catch {
      /* 無視 */
    }
  });
  source.addEventListener('error', () => setLive('off', '切れました。再接続中'));
}
