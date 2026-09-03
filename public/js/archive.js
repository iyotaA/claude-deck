/* 書庫（終了したものも含む全セッション）。
 *
 * 層7。押されたときに select（session.js）を呼ぶので、あちらより下に置く。
 *
 * **左のペインのタブだったが、モードへ出した。** 数値を移したのと同じ引っ越しで、
 * 理由はあちらと違う。こちらは中身がセッション1本のものだが、
 * 出す項目が5つ（日付・大きさ・タイトル・置き場所・ブランチ）あるのに
 * 27rem の列に押し込んでいて、置き場所も期間も絞る場所が無かった。
 *
 * モードの出し入れそのものは board.js の setMode が持つ。
 * こちらは「出せと言われたら描く」だけで、`showArchive()` がその口
 * （initBoard({ onUsage }) と同じ差し方。層7 どうしで向きを持たせずに済む）。
 */
import { el, kb, shortStamp, stamp, agentTag } from './util.js';
import { dom, store, syncQuery, ARCHIVE_SORTS } from './store.js';
import { select } from './session.js';

/** カードを押されたあとの後始末。main.js が差す */
let pick = null;

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
    // 押されたあと何をするかは外から差す。いまは作業台へ移る
    pick?.();
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
    const li = el('li', 'is-wide');
    li.append(el('div', 'empty', '書庫はまだ使えません（サーバ側が対応していません）'));
    dom.archive.append(li);
    return;
  }
  if (a.error) {
    const li = el('li', 'is-wide');
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
      const li = el('li', 'is-wide');
      li.append(el('div', 'empty', '書庫を読んでいます…'));
      dom.archive.append(li);
    }
    return;
  }
  if (a.rows.length === 0) {
    const li = el('li', 'is-wide');
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
    const li = el('li', 'is-wide');
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
 * 書庫を出す。board.js の setMode から呼ばれる。
 *
 * 出し入れ（hidden の付け外し）は setMode 側が受け持つ。ここでやるのは中身だけ。
 * **開くたびに引き直さない。** 一度読めていればそのまま描くので、
 * 作業台と行き来しても、読んだ位置と検索語がそのまま残る。
 */
export function showArchive() {
  if (!store.archive.loaded && !store.archive.loading) loadArchive();
  else renderArchive();
}

/**
 * 探す帯の配線。main.js から1回だけ呼ぶ。
 *
 * 初期値は URL だけから決まる（localStorage には残さない）。
 *
 * @param {object} [opts]
 * @param {?function} [opts.onPick] カードを押されたあとの後始末。
 *   main.js が `() => setMode('work')` を差す。**board.js を import しない**
 *   （同じ層7 なので、向きを持たせずに済む形を選ぶ）
 */
export function initArchive({ onPick = null } = {}) {
  pick = onPick;

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
}
