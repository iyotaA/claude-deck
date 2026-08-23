/* 書庫（終了したものも含む全セッション）と、左のペインのタブ。
 *
 * 層7。タブを稼働中に戻すときに renderList（list.js）を呼ぶので、あちらより下に置く。
 *
 * 数値タブ（usage-tab.js）も同じ層だが、**呼ぶのはこちらから片方向だけ。**
 * タブの出し分けを持っているのが setTab なので、向きは自然にこうなる。
 * 逆（あちらから setTab を呼ぶ）を足すと循環になる。
 */
import { el, kb, shortStamp, stamp, agentTag } from './util.js';
import { dom, store, syncQuery, ARCHIVE_SORTS, TABS } from './store.js';
import { setListOpen } from './drawer.js';
import { select, loadDetail } from './session.js';
import { renderDetailIfNeeded } from './detail.js';
import { renderList } from './list.js';
import { showUsage, initUsageTab } from './usage-tab.js';

/** 1ページの件数。サーバ側の上限は 50 */
const ARCHIVE_PER = 30;
/** 検索欄のデバウンス。打つたびに引くと 1 文字ごとにファイルを読ませることになる */
const ARCHIVE_DEBOUNCE_MS = 200;

let archiveToken = 0;
let archiveTimer = null;

/**
 * 書庫のカード1枚。
 *
 * 状態色は出さない。書庫に出るものは全部終わっているので、色を付けると
 * 稼働中の一覧と同じ重さに見えて、どれから手をつけるかが読めなくなる。
 */
function buildArchiveCard(row) {
  const li = el('li');
  const card = el('button', 'card is-archive');
  card.type = 'button';
  card.setAttribute('aria-current', String(row.sessionId === store.selected));
  card.dataset.sessionId = row.sessionId ?? '';

  const top = el('div', 'card-top');
  const when = el('span', 'when', shortStamp(row.mtimeMs));
  // 「08/03 14:22」だけでは何年のものか分からない。年は乗せたときだけ出す
  if (row.mtimeMs) when.title = stamp(row.mtimeMs);
  top.append(when);
  top.append(el('span', 'idle', kb(row.logSize)));
  card.append(top);

  // 「読んでいないから空」と「本当に空」を混同させない。read でそこを分ける
  const label = row.title ?? (row.read ? '（指示なしで終わっています）' : '（まだ読んでいません）');
  const title = el('div', 'card-title', label);
  if (!row.title) title.classList.add('is-empty');
  card.append(title);

  const meta = el('div', 'card-meta');
  if (row.project) meta.append(el('span', 'path', row.project));
  if (row.gitBranch && row.gitBranch !== 'HEAD') meta.append(el('span', 'tag', row.gitBranch));
  // まだ読んでいない行では null なので何も出ない。中身を読んだ行にだけ付く
  const agents = agentTag(row.subagentCount);
  if (agents) meta.append(agents);
  if (meta.childElementCount > 0) card.append(meta);

  card.addEventListener('click', () => {
    select(row.sessionId, 'archive');
    setListOpen(false, dom.detail);
  });
  li.append(card);
  return li;
}

/** 書庫のヘッダに出す件数と、読んだ件数の内訳 */
function renderArchiveCount() {
  const a = store.archive;
  if (!a.loaded) {
    dom.archiveCount.textContent = '';
    return;
  }
  const parts = [`${a.total.toLocaleString('ja-JP')} 件`];
  if (a.rows.length < a.total) parts.push(`${a.rows.length} 件表示`);
  // どこまで中身を読んだかを正直に出す。打ち切っていれば「全部を探せていない」と分かる
  if (a.meta?.scanLimited) parts.push(`中身は新しい ${a.meta.scanMax} 件まで`);
  dom.archiveCount.textContent = parts.join(' / ');
}

function renderArchive() {
  const a = store.archive;
  dom.archive.replaceChildren();
  renderArchiveCount();

  // 空表示を4つに割る。ひとまとめにすると「まだ引いていない」と「0件だった」が同じ顔になる
  if (a.unavailable) {
    const li = el('li');
    li.append(el('div', 'empty', '書庫はまだ使えません（サーバ側が対応していません）'));
    dom.archive.append(li);
    return;
  }
  if (a.error) {
    const li = el('li');
    const box = el('div', 'empty', `書庫を読めませんでした: ${a.error}`);
    const retry = el('button', 'btn', 'もう一度試す');
    retry.type = 'button';
    retry.addEventListener('click', () => loadArchive());
    const action = el('div', 'empty-note');
    action.append(retry);
    box.append(action);
    li.append(box);
    dom.archive.append(li);
    return;
  }
  if (!a.loaded) {
    // 引いている途中だけ出す。押す前から空の枠を出すと「0件だった」に見える
    if (a.loading) {
      const li = el('li');
      li.append(el('div', 'empty', '書庫を読んでいます…'));
      dom.archive.append(li);
    }
    return;
  }
  if (a.rows.length === 0) {
    const li = el('li');
    const box = el('div', 'empty', a.q
      ? `「${a.q}」に当たるセッションがありません`
      : 'セッションのログが見つかりません');
    // 既定の検索はタイトルまで見ていない。深い検索という手が残っていることを伝える
    if (a.q && !a.deep) {
      box.append(el('div', 'empty-note', '「中身も探す」を入れると、ログを開いてタイトルまで探します'));
    }
    li.append(box);
    dom.archive.append(li);
    return;
  }

  for (const row of a.rows) dom.archive.append(buildArchiveCard(row));

  if (a.rows.length < a.total) {
    const li = el('li');
    const more = el('button', 'btn archive-more',
      `続きを出す（残り ${(a.total - a.rows.length).toLocaleString('ja-JP')} 件）`);
    more.type = 'button';
    more.disabled = a.loading;
    more.addEventListener('click', () => loadArchive({ append: true }));
    li.append(more);
    dom.archive.append(li);
  }
}

/**
 * 書庫を引く。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.append] 次のページを継ぎ足す（並びと検索語は変えない）
 */
async function loadArchive({ append = false } = {}) {
  const a = store.archive;
  if (a.unavailable) return;

  const token = ++archiveToken;
  a.loading = true;
  a.error = null;
  renderArchive();

  const params = new URLSearchParams();
  params.set('page', String(append ? a.page + 1 : 1));
  params.set('per', String(ARCHIVE_PER));
  params.set('sort', a.sort);
  if (a.q) params.set('q', a.q);
  if (a.deep) params.set('deep', '1');

  try {
    const res = await fetch(`/api/archive?${params.toString()}`, { cache: 'no-store' });
    // サーバ側と歩調を合わせずに画面側だけ先に入れられるようにする
    if (res.status === 404) {
      if (token === archiveToken) {
        a.unavailable = true;
        a.loading = false;
        renderArchive();
      }
      return;
    }
    if (!res.ok) {
      const reason = await res.json().then((j) => j?.error).catch(() => null);
      throw new Error(reason ?? `HTTP ${res.status}`);
    }
    const data = await res.json();
    // 打ち終わる前の応答が後から届くことがある。古い応答で上書きしない
    if (token !== archiveToken) return;
    a.rows = append ? [...a.rows, ...(data.rows ?? [])] : (data.rows ?? []);
    a.total = data.total ?? a.rows.length;
    a.page = data.page ?? 1;
    a.pages = data.pages ?? 1;
    a.meta = data.meta ?? null;
    a.loaded = true;
  } catch (err) {
    if (token !== archiveToken) return;
    a.error = err.message;
  } finally {
    if (token === archiveToken) {
      a.loading = false;
      renderArchive();
    }
  }
}

/**
 * 左のペインを切り替える。
 *
 * 書庫を出しているあいだも上のバーのまとめ（renderSummary）は動かし続ける。
 * あれが「誰かが待っている」の唯一の合図なので、ここで止めると質問を取りこぼす。
 *
 * 出し分けは hidden の付け外しだけでやる。作り直さないので、
 * 書庫の途中まで読んだ位置や、数値の開いた <details> がタブを行き来しても残る。
 *
 * @param {'live'|'archive'|'usage'} tab TABS のどれか。知らない値は 'live' に落とす
 * @param {object} [opts]
 * @param {boolean} [opts.sync] URL を書き戻すか。起動時だけ false にする
 *   （まだ ?session= を store に取り込んでいないので、書き戻すと指定が消える）
 */
export function setTab(tab, { sync = true } = {}) {
  const prev = store.tab;
  store.tab = TABS.has(tab) ? tab : 'live';
  const now = store.tab;

  // 3つに増えたので「書庫かどうか」の二値では書けない。
  // 出す側を1つ選んで、残りは全部隠す形にする
  dom.tabLive.setAttribute('aria-pressed', String(now === 'live'));
  dom.tabArchive.setAttribute('aria-pressed', String(now === 'archive'));
  dom.tabUsage.setAttribute('aria-pressed', String(now === 'usage'));
  dom.liveHead.hidden = now !== 'live';
  dom.list.hidden = now !== 'live';
  dom.archiveHead.hidden = now !== 'archive';
  dom.archive.hidden = now !== 'archive';
  dom.usageHead.hidden = now !== 'usage';
  dom.usage.hidden = now !== 'usage';
  // 数値のときだけ左のペインを全幅にする（幅と、中央・右を消すのは usage.css）。
  // 目印をここに付けているのは、幅の話が CSS 側だけで閉じるため
  dom.listPane.classList.toggle('is-usage', now === 'usage');
  if (sync) syncQuery();

  // 数値のあいだ apply() は中央を飛ばしている（stream.js）。出るときに追いつかせる。
  // **数値から出たときだけ。** live ⇄ 書庫では詳細ペインが消えていないので、
  // 止めていたものが無く、払う理由が無い。setMode('work') と同じ形
  if (prev === 'usage' && now !== 'usage') {
    renderDetailIfNeeded();
    loadDetail(store.selected, { silent: true });
  }

  if (now === 'live') {
    // まだ一覧を受け取っていない起動直後は描かない。空表示が一瞬出るのを避ける
    if (store.meta) renderList();
    return;
  }
  if (now === 'usage') {
    showUsage();
    return;
  }
  if (!store.archive.loaded && !store.archive.loading) loadArchive();
  else renderArchive();
}

/** タブの配線。store.tab は保存しないので、初期値は URL だけから決まる */
export function initTabs() {
  dom.tabLive.addEventListener('click', () => setTab('live'));
  dom.tabArchive.addEventListener('click', () => setTab('archive'));
  dom.tabUsage.addEventListener('click', () => setTab('usage'));
  // 数値タブは全幅で、詳細ペインが消えている（usage.css）。押した1本を見せるには
  // 作業台へ戻すしかないので、その口だけを渡す。**向きはこちらから片方向のまま。**
  // あちらから setTab を呼ぶと循環になる（監視盤のカードが buildCard(row, onPick) で
  // 後始末だけ差し替えられているのと同じ形）
  initUsageTab({ onPick: () => setTab('live') });

  dom.archiveQ.value = store.archive.q ?? '';
  dom.archiveSort.value = store.archive.sort;
  dom.archiveDeep.checked = store.archive.deep;

  dom.archiveQ.addEventListener('input', () => {
    const next = dom.archiveQ.value.trim() || null;
    if (next === store.archive.q) return;
    store.archive.q = next;
    syncQuery();
    // 打っている途中で毎回引かない。1文字ごとにサーバにログを開かせることになる
    if (archiveTimer) clearTimeout(archiveTimer);
    archiveTimer = setTimeout(() => {
      archiveTimer = null;
      loadArchive();
    }, ARCHIVE_DEBOUNCE_MS);
  });

  // 意図した1クリックなので、こちらは即時に引き直す
  dom.archiveDeep.addEventListener('change', () => {
    store.archive.deep = dom.archiveDeep.checked;
    loadArchive();
  });

  dom.archiveSort.addEventListener('change', () => {
    const v = dom.archiveSort.value;
    store.archive.sort = ARCHIVE_SORTS.has(v) ? v : 'recent';
    syncQuery();
    loadArchive();
  });

  setTab(store.tab, { sync: false });
}
