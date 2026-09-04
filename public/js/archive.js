/* 書庫（終了したものも含む全セッション）。
 *
 * 層7。押されたときに select（session.js）を呼ぶので、あちらより下に置く。
 *
 * **左のペインのタブだったが、モードへ出した。** 数値を移したのと同じ引っ越しで、
 * 理由はあちらと違う。こちらは中身がセッション1本のものだが、
 * 出す項目が5つ（日付・大きさ・タイトル・置き場所・ブランチ）あるのに
 * 27rem の列に押し込んでいて、置き場所も期間も絞る場所が無かった。
 *
 * モードの出し入れそのものは mode.js の setMode が持つ。
 * こちらは「出せと言われたら描く」だけで、`showArchive()` がその口
 * （initMode({ onUsage }) と同じ差し方。層7 どうしで向きを持たせずに済む）。
 */
import { el, kb, shortStamp, stamp, agentTag } from './util.js';
import { icon } from './icons.js';
import { tokensStrict, pctStrict } from './usage-chart.js';
import { store, syncQuery, ARCHIVE_SORTS, ARCHIVE_DAYS } from './store.js';
import { dom } from './dom.js';
import { select } from './session.js';
import { cardShell, cardTitle, closeCardMeta, metaBranch, metaPath } from './card.js';

/** カードを押されたあとの後始末。main.js が差す */
let pick = null;

/**
 * 1ページの件数。サーバ側の上限は 50。
 *
 * **カードに数値を出したぶん背が伸びたので減らしてある。**
 * 30 のままだと、4列の窓で 8 行ぶん送らないと最後まで見えない。
 * ここを増やすときは、下の loadUsage が並列に叩く本数もそのまま増えることに注意
 * （実測: 30 件を並列で約 1 秒。逐次だと 5.4 秒かかる）
 */
const ARCHIVE_PER = 20;
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
  const { li, card } = cardShell(row, { variant: 'is-archive' });

  const top = el('div', 'card-top');
  const when = el('span', 'when', shortStamp(row.mtimeMs));
  // 「08/03 14:22」だけでは何年のものか分からない。年は乗せたときだけ出す
  if (row.mtimeMs) when.title = stamp(row.mtimeMs);
  top.append(when);
  top.append(el('span', 'idle', kb(row.logSize)));
  card.append(top);

  // 「読んでいないから空」と「本当に空」を混同させない。read でそこを分ける
  const label = row.title ?? (row.read ? '（指示なしで終わっています）' : '（まだ読んでいません）');
  card.append(cardTitle(row, label));

  const meta = el('div', 'card-meta');
  meta.append(...[metaPath(row), metaBranch(row)].filter(Boolean));
  // 索引にあれば出す。**絞った結果「なぜこれが出たか」が読める。**
  // 一覧のカード（list.js）と同じ形の札を借りる
  for (const skill of row.skills ?? []) {
    meta.append(el('span', 'tag is-skill', `/${skill}`));
  }
  // まだ読んでいない行では null なので何も出ない。中身を読んだ行にだけ付く
  const agents = agentTag(row.subagentCount);
  if (agents) meta.append(agents);
  closeCardMeta(card, meta);

  // 数値の器。**空のまま置いておく。** 中身は別の窓口（/api/sessions/:id/usage）から
  // 遅れて届く。ここで待つと、探した結果が出るまでが遅くなる
  const stats = el('div', 'card-stats');
  stats.dataset.usageFor = row.sessionId ?? '';
  fillStats(stats, store.archive.usage.get(row.sessionId));
  card.append(stats);

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
  dom.archiveClear.hidden = !hasFilter();
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
  if (a.project) params.set('project', a.project);
  if (a.skill) params.set('skill', a.skill);
  if (a.days) params.set('days', a.days);

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
      const reason = await res.json().then((j) => j?.reason ?? j?.error).catch(() => null);
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
    // 候補は絞り込む前の全行から作られるので、絞っても減らない。
    // **空で上書きしない。** 古いサーバは projects を返さないので、
    // 受け取れた日の候補をそのまま残す（0 と不明を分けるのと同じ）
    if (Array.isArray(data.meta?.projects)) {
      a.projects = data.meta.projects;
      renderProjects();
    }
    if (Array.isArray(data.meta?.skills)) {
      a.skills = data.meta.skills;
      a.skillIndex = data.meta.skillIndex ?? null;
      renderSkills();
    }
    a.loaded = true;
    // 数値は別の窓口から遅れて埋める。**ここで待たない**
    loadUsage(a.rows);
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

/** 数値の4つ。作業台の右の枠（usage-panel.js）と同じ順・同じ出どころにする */
const STAT_DEFS = [
  { key: 'ite', label: '実消費', of: (u) => tokensStrict(u?.totals?.ite) },
  { key: 'ctx', label: '文脈', of: (u) => tokensStrict(u?.context?.last) },
  { key: 'hit', label: '命中', of: (u) => pctStrict(u?.cache?.hitRate) },
  { key: 'cmp', label: '圧縮', of: (u) => (typeof u?.compact?.count === 'number' ? `${u.compact.count}回` : '—') },
];

/**
 * カードの数値を埋める。
 *
 * **まだ届いていないときは点線の器だけを置く。** 「0」と書かない ―― 使っていないのと
 * まだ読めていないのが同じ顔になる（`tokensStrict` を使うのも同じ理由で、
 * `util.js` の `tokens()` は 0 と不明を同じに見せる）。
 *
 * @param {HTMLElement} box `.card-stats`
 * @param {object|null|undefined} u 1本ぶんの数値。undefined はまだ届いていない
 */
function fillStats(box, u) {
  box.classList.toggle('is-waiting', u === undefined);
  if (u === undefined) {
    box.replaceChildren();
    return;
  }
  const items = STAT_DEFS.map((d) => {
    const cell = el('span', 'card-stat');
    cell.append(el('span', 'k', d.label), el('span', 'v', d.of(u)));
    return cell;
  });
  box.replaceChildren(...items);
}

/**
 * いま出ているカードの数値を引く。
 *
 * **並列に投げる。** 逐次だと 30 件で 5.4 秒、並列なら約 1 秒（実測）。
 * 1件ずつ届いたそばから、そのカードだけ書き換える ―― 一覧を組み直すと
 * 読んでいる位置が飛ぶ（`refreshTimes` と同じ流儀）。
 *
 * @param {object[]} rows 引く対象。すでに持っているものは飛ばす
 */
async function loadUsage(rows) {
  const a = store.archive;
  const need = rows.filter((r) => r.sessionId && !a.usage.has(r.sessionId));
  if (!need.length) return;
  const token = archiveToken;

  await Promise.all(need.map(async (row) => {
    let value = null;
    try {
      const res = await fetch(`/api/sessions/${row.sessionId}/usage`, { cache: 'no-store' });
      value = res.ok ? await res.json() : null;
    } catch {
      // 取れなくてもカードは出したまま。「—」が並ぶだけ
      value = null;
    }
    // 検索し直されていたら書かない（古い応答で新しい画面を汚さない）
    if (token !== archiveToken) return;
    a.usage.set(row.sessionId, value);
    // その1枚だけ差し替える。組み直さないのでスクロール位置が動かない
    const box = dom.archive.querySelector(`.card-stats[data-usage-for="${CSS.escape(row.sessionId)}"]`);
    if (box) fillStats(box, value);
  }));
}

/**
 * 置き場所の候補を組み直す。
 *
 * **選んでいた値は残す。** 引き直すたびに作り直すので、
 * 素朴に replaceChildren すると選択が「すべての置き場所」へ戻る。
 */
function renderProjects() {
  const a = store.archive;
  const keep = a.project;
  const all = el('option', null, 'すべての置き場所');
  all.value = '';
  const opts = [all];
  for (const p of a.projects) {
    // 件数も出す。「そこに何本あるか」が分かると、選ぶ前に見当が付く
    const o = el('option', null, `${p.label}（${p.n}）`);
    o.value = p.dir;
    opts.push(o);
  }
  // 選んでいた置き場所が候補に無いとき（URL を手で書いたぶん）も選べるようにする。
  // 黙って「すべて」へ戻すと、絞れているのに欄が「すべて」を指す食い違いになる
  if (keep && !a.projects.some((p) => p.dir === keep)) {
    const o = el('option', null, keep);
    o.value = keep;
    opts.push(o);
  }
  dom.archiveProject.replaceChildren(...opts);
  dom.archiveProject.value = keep ?? '';
}

/**
 * スキルの候補を組み直す。
 *
 * 置き場所（renderProjects）と同じ形だが、**索引がまだできていないことがある。**
 * そのときは選べなくして「作成中」と出す。黙って空の候補を出すと、
 * スキルを使っていないのか、まだ読めていないのかが区別できない。
 */
function renderSkills() {
  const a = store.archive;
  const st = a.skillIndex;
  // built が false のあいだは選ばせない。**候補が0件でも「作成中」とは限らない**ので、
  // 出どころ（索引の様子）で決める。0 と不明を分けるのと同じ
  const ready = st ? st.built === true : a.skills.length > 0;

  const keep = a.skill;
  const head = el('option', null, ready ? 'すべてのスキル' : 'スキルの索引を作っています…');
  head.value = '';
  const opts = [head];
  for (const s of a.skills) {
    const o = el('option', null, `${s.skill}（${s.n}）`);
    o.value = s.skill;
    opts.push(o);
  }
  // 索引に無いスキルを URL で指定されたぶんも選べるようにする（renderProjects と同じ）
  if (keep && !a.skills.some((s) => s.skill === keep)) {
    const o = el('option', null, keep);
    o.value = keep;
    opts.push(o);
  }
  dom.archiveSkill.replaceChildren(...opts);
  dom.archiveSkill.value = keep ?? '';
  dom.archiveSkill.disabled = !ready;
  dom.archiveSkillField.classList.toggle('is-waiting', !ready);
}

/** 絞り込みを1つでも掛けているか。外す札の出し入れに使う */
function hasFilter() {
  const a = store.archive;
  return Boolean(a.q || a.project || a.skill || a.days || a.deep || a.sort !== 'recent');
}

/**
 * 書庫を出す。mode.js の setMode から呼ばれる。
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
 *   main.js が `() => setMode('work')` を差す。**mode.js を import しない**
 *   （同じ層7 なので、向きを持たせずに済む形を選ぶ）
 */
export function initArchive({ onPick = null } = {}) {
  pick = onPick;

  dom.archiveQ.value = store.archive.q ?? '';
  dom.archiveSort.value = store.archive.sort;
  dom.archiveDeep.checked = store.archive.deep;
  dom.archiveDays.value = store.archive.days ?? '';
  // 候補はまだ届いていない。選んでいた値だけ先に入れておく（届いたら組み直す）
  renderProjects();
  renderSkills();

  // 絵は絞り込みの札にだけ差す。**カードの中には置かない。**
  // 横に3つ並ぶものは形で見分けられると速いが、項目が5つあるカードに足すと
  // 読む量が増えるだけで、探す速さは上がらない
  dom.archiveQ.closest('.archive-field').prepend(icon('search', 14));
  dom.archiveProject.closest('.archive-field').prepend(icon('folder', 14));
  // スキルは作業の道具なので、起こすフォームの「最初の指示」と同じ絵を借りる
  dom.archiveSkillField.prepend(icon('pencil', 14));
  dom.archiveDays.closest('.archive-field').prepend(icon('clock', 14));
  dom.archiveSort.closest('.archive-field').prepend(icon('sort', 14));
  // 絵だけのボタン。名前は title と aria-label が持つ
  dom.archiveClear.append(icon('x', 15));

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

  // スキル。索引ができるまでは disabled なので、押せた時点で候補は届いている
  dom.archiveSkill.addEventListener('change', () => {
    store.archive.skill = dom.archiveSkill.value || null;
    syncQuery();
    loadArchive();
  });

  // 置き場所。空文字は「すべて」なので null に倒す（サーバへ project= を送らない）
  dom.archiveProject.addEventListener('change', () => {
    store.archive.project = dom.archiveProject.value || null;
    syncQuery();
    loadArchive();
  });

  // 期間。知らない値は「絞らない」へ落とす（サーバ側が黙って丸めるのと同じ扱い）
  dom.archiveDays.addEventListener('change', () => {
    const v = dom.archiveDays.value;
    store.archive.days = ARCHIVE_DAYS.has(v) ? v : null;
    syncQuery();
    loadArchive();
  });

  // 全部外す。**並び順も戻す。** 「絞り込みを外す」を押したのに
  // 大きい順のままだと、外れていないように見える
  dom.archiveClear.addEventListener('click', () => {
    const a = store.archive;
    a.q = null;
    a.project = null;
    a.skill = null;
    a.days = null;
    a.deep = false;
    a.sort = 'recent';
    dom.archiveQ.value = '';
    dom.archiveProject.value = '';
    dom.archiveSkill.value = '';
    dom.archiveDays.value = '';
    dom.archiveSort.value = 'recent';
    dom.archiveDeep.checked = false;
    syncQuery();
    loadArchive();
  });
}
