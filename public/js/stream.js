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
  // 作業台でないあいだは**何も描かない。** 中央も左も消えているうえ、
  // 書庫（/api/archive）も数値（/api/usage）もファイルを開く窓口なので、
  // 見えないもののために毎2秒撃たない。左の一覧に触ると、見えていない
  // スクロール位置が毎秒先頭へ飛ぶ。
  // 作業台へ戻るときに setMode('work') が3つとも追いつかせる
  if (store.mode !== 'work') return;
  renderList();
  // 詳細は「見えているものが動いたとき」だけ作り直す。毎回作り直すと、
  // 開いた <details> とスクロール位置が2秒ごとに消える
  renderDetailIfNeeded();
  // 詳細は中身が変わっていなければ取り直さない。
  // silent にして、取り直しのあいだも前の内容を出したままにする
  loadDetail(store.selected, { silent: true });
}

/**
 * 上のバーに出す短い語。詳しい文は title へ回す。
 *
 * 知らない状態が来たら、渡された文をそのまま出す（黙って空にしない）。
 */
const LIVE_SHORT = { on: '接続', off: '切断', wait: '接続中' };

export function setLive(state, label) {
  dom.live.dataset.live = state;
  // **出すのは短い語だけ。** ここは道具（起こす・設定・配色）の並ぶ場所なので、
  // 押せない文が伸びると、押せるものを画面の端へ押しのける
  dom.live.textContent = LIVE_SHORT[state] ?? label;
  dom.live.title = label;
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
