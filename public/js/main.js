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
 *   層0  util.js / perf.js / timeline/kinds.js   誰にも依存しない
 *   層1  store.js（kinds.js を直に見る）/ rows.js
 *   層2  timeline.js
 *   層3  このファイル                            全部を見る
 *
 * 時系列は timeline.js に分けてある。呼ぶのは Timeline.* を通してだけで、
 * あちらの中の名前を直に触らない（理由は timeline.js の冒頭に書いてある）。
 *
 * 'use strict' は書かない。module は常に strict で動く。
 */
import { el, since, dur, shortModel, tokens, hms, stamp, shortStamp, num, kb, mb, fact } from './util.js';
import { mark } from './perf.js';
import {
  query, dom, store, syncQuery,
  STATE_COLOR, QUIET_MODES, SUMMARY_ORDER, ARCHIVE_SORTS,
} from './store.js';
import { idleOf, rowOf, headOf, visibleRows, detailErrorNow } from './rows.js';
// 名前空間ごと受ける。Timeline.render() のような呼び方をそのまま残すため。
// 中をさらに分けても、差し替えるのはこの1行だけで済む
import * as Timeline from './timeline.js';

/* ---------------------------------------------------------------- 一覧 */

function buildCard(row) {
  const li = el('li');
  const card = el('button', 'card');
  card.type = 'button';
  card.style.setProperty('--state-color', STATE_COLOR[row.state] ?? 'var(--off)');
  card.setAttribute('aria-current', String(row.sessionId === store.selected));
  card.dataset.sessionId = row.sessionId ?? '';

  const top = el('div', 'card-top');
  const state = el('span', 'state', row.stateLabel);
  // 判定に自信が無いものは印を付ける。断定して外すより、迷っていると伝えたほうが役に立つ
  if (row.stateConfident === false) state.dataset.guess = 'true';
  top.append(state);
  if (row.name && row.name !== row.title) top.append(el('span', 'tag', row.name));
  const idle = el('span', 'idle', since(idleOf(row)));
  // 「3時間20分」だけでは、それが今日の何時なのかが分からない。実時刻は乗せたときだけ出す
  if (row.lastActivityAt) idle.title = stamp(row.lastActivityAt);
  top.append(idle);
  card.append(top);

  const title = el('div', 'card-title', row.title ?? '（まだ指示なし）');
  if (!row.title) title.classList.add('is-empty');
  card.append(title);

  if (row.waitingFor) {
    const wait = el('div', 'waiting');
    wait.append(el('span', 'tool', row.waitingFor.tool));
    if (row.waitingFor.detail) wait.append(el('span', 'detail', row.waitingFor.detail));
    card.append(wait);
  }

  // 一覧のタグは「読み方が変わる情報」だけに絞る。
  // 全行に同じ値が並ぶタグ（既定の権限モード・同じモデル）はノイズになるので出さない。
  // モデルや思考量は詳細ビュー側で見せる
  const meta = el('div', 'card-meta');
  if (row.project) meta.append(el('span', 'path', row.project));
  if (row.gitBranch && row.gitBranch !== 'HEAD') meta.append(el('span', 'tag', row.gitBranch));
  if (row.permissionMode && !QUIET_MODES.has(row.permissionMode)) {
    const tag = el('span', 'tag', row.permissionMode);
    if (row.permissionMode === 'plan') tag.classList.add('is-plan');
    meta.append(tag);
  }
  for (const skill of row.skills ?? []) {
    meta.append(el('span', 'tag is-skill', `/${skill.skill}`));
  }
  const ctx = tokens(row.contextTokens);
  if (ctx) meta.append(el('span', 'tag', `ctx ${ctx}`));
  if (meta.childElementCount > 0) card.append(meta);

  card.addEventListener('click', () => {
    select(row.sessionId);
    // 引き出しは選ぶために開くもの。選び終わったら用済みなので閉じて詳細に場所を渡す。
    // 同じものを選び直したときも閉じたいので、select の中ではなくここに置く
    setListOpen(false, dom.detail);
  });
  li.append(card);
  return li;
}

function renderList() {
  const rows = visibleRows();
  dom.list.replaceChildren();

  if (rows.length === 0) {
    const li = el('li');
    li.append(el('div', 'empty', store.onlyLive
      ? '稼働中のセッションはありません'
      : 'セッションが見つかりません'));
    dom.list.append(li);
  } else {
    for (const row of rows) dom.list.append(buildCard(row));
  }

  const live = store.rows.filter((r) => r.alive).length;
  dom.listCount.textContent = `稼働中 ${live} / 表示 ${rows.length}`;
}

function renderSummary() {
  dom.summary.replaceChildren();
  const counts = store.meta?.counts ?? {};
  // ラベルはサーバ側の STATE_LABELS。まだ受け取っていない間はキーをそのまま出す
  const labels = store.meta?.stateLabels ?? {};
  for (const key of SUMMARY_ORDER) {
    const n = counts[key] ?? 0;
    if (n === 0) continue;
    const label = labels[key] ?? key;
    const chip = el('span', 'chip');
    chip.style.setProperty('--state-color', STATE_COLOR[key]);
    const dot = el('span', 'state');
    dot.style.color = STATE_COLOR[key];
    chip.append(dot, document.createTextNode(label), el('strong', null, n));
    if (key.startsWith('needs')) chip.classList.add('is-hot');
    dom.summary.append(chip);
  }
  if (dom.summary.childElementCount === 0) {
    dom.summary.append(el('span', 'chip', '動いているセッションなし'));
  }
}

/** 経過時間の表示だけを進める。作り直さないのでスクロール位置が動かない */
function refreshTimes() {
  const byId = new Map(store.rows.map((r) => [r.sessionId, r]));
  for (const node of dom.list.querySelectorAll('.card')) {
    const row = byId.get(node.dataset.sessionId);
    if (!row) continue;
    const idle = node.querySelector('.idle');
    if (idle) {
      idle.textContent = since(idleOf(row));
      // 追記が進めば実時刻も動く。textContent だけ直すと title が古いままになる
      if (row.lastActivityAt) idle.title = stamp(row.lastActivityAt);
    }
  }
  const detailIdle = dom.detail.querySelector('[data-live-idle]');
  if (detailIdle) {
    // 一覧に無いセッション（?session= で直に開いたもの）は詳細から引く。
    // byId だけを見ていると、そこで経過時間が凍る
    const id = detailIdle.dataset.liveIdle;
    const head = byId.get(id) ?? headOf(id);
    if (head) {
      detailIdle.textContent = since(idleOf(head));
      if (head.lastActivityAt) detailIdle.title = stamp(head.lastActivityAt);
    }
  }
}

/* ---------------------------------------------------------------- 書庫 */

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
 * @param {'live'|'archive'} tab
 * @param {object} [opts]
 * @param {boolean} [opts.sync] URL を書き戻すか。起動時だけ false にする
 *   （まだ ?session= を store に取り込んでいないので、書き戻すと指定が消える）
 */
function setTab(tab, { sync = true } = {}) {
  store.tab = tab === 'archive' ? 'archive' : 'live';
  const isArchive = store.tab === 'archive';

  dom.tabLive.setAttribute('aria-pressed', String(!isArchive));
  dom.tabArchive.setAttribute('aria-pressed', String(isArchive));
  dom.liveHead.hidden = isArchive;
  dom.list.hidden = isArchive;
  dom.archiveHead.hidden = !isArchive;
  dom.archive.hidden = !isArchive;
  if (sync) syncQuery();

  if (!isArchive) {
    // まだ一覧を受け取っていない起動直後は描かない。空表示が一瞬出るのを避ける
    if (store.meta) renderList();
    return;
  }
  if (!store.archive.loaded && !store.archive.loading) loadArchive();
  else renderArchive();
}

/* ---------------------------------------------------------------- 詳細 */

/**
 * パネル1枚。
 *
 * id は上のジャンプ用リンクから飛ぶために振る。
 * tone は枠と見出しの色。急ぐものだけ色を変え、他は素のままにする。
 */
function panel(title, opts = {}) {
  const section = el('section', 'panel');
  if (opts.id) section.id = opts.id;
  if (opts.tone) section.classList.add(`is-${opts.tone}`);
  const head = el('h3', null, title);
  if (opts.count !== undefined && opts.count !== null) head.append(el('span', 'count', opts.count));
  if (opts.action) head.append(opts.action);
  section.append(head);
  const body = el('div', 'panel-body');
  section.append(body);
  return { section, body };
}

/** パネルの id。ジャンプ用リンクと対で使う。 */
const SEC = {
  wait: 'sec-wait',
  decisions: 'sec-decisions',
  todo: 'sec-todo',
  compact: 'sec-compact',
  timeline: 'sec-timeline',
  agents: 'sec-agents',
  files: 'sec-files',
  basics: 'sec-basics',
};

function toggle(label, pressed, onClick) {
  const b = el('button', 'btn', label);
  b.type = 'button';
  b.setAttribute('aria-pressed', String(pressed));
  b.addEventListener('click', onClick);
  return b;
}

/**
 * 詳細の操作ボタン。
 *
 * 指示を送り込むことはしない（非公開の仕組みに乗ると壊れやすい）。
 * 窓を前面に出すところまでやって、あとは本人が打つ。それで用は足りる。
 */
function detailActions(row) {
  const box = el('div', 'detail-actions');
  const hint = el('span', 'hint');

  if (row.alive && row.pid) {
    const focus = el('button', 'btn', 'ターミナルを前面に');
    focus.type = 'button';
    focus.addEventListener('click', async () => {
      focus.disabled = true;
      hint.textContent = '呼んでいます…';
      try {
        const res = await fetch(`/api/focus?pid=${encodeURIComponent(row.pid)}`, { method: 'POST' });
        const data = await res.json();
        if (!data.ok) {
          hint.textContent = `出せません: ${data.reason}`;
        } else if (data.tabbed) {
          // 窓は前に出るがタブは選べない。出たつもりで待たせないよう、そこは正直に書く
          hint.textContent = `${data.app} を前面に出しました。タブの切り替えは手動でどうぞ`;
        } else {
          hint.textContent = `前面に出しました（${data.detail ?? ''}）`;
        }
      } catch (err) {
        hint.textContent = `出せません: ${err.message}`;
      } finally {
        focus.disabled = false;
      }
    });
    box.append(focus);
  }

  // 終了したセッションを開き直すときのコマンド。cwd を間違えると別のログになるので一緒に渡す
  if (row.sessionId) {
    const copy = el('button', 'btn', '再開コマンドをコピー');
    copy.type = 'button';
    const command = row.cwd
      ? `cd "${row.cwd}"; claude --resume ${row.sessionId}`
      : `claude --resume ${row.sessionId}`;
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(command);
        hint.textContent = 'コピーしました';
      } catch {
        hint.textContent = command;
      }
    });
    box.append(copy);
  }

  box.append(hint);
  return box;
}

/**
 * 「なぜこの作業をしているか」を先頭に畳んで置く。
 *
 * 下のパネルを読めば分かることでも、切り替えのたびに読み下すのは重い。
 * 目的と直近の判断だけを最初に見せて、続きは下で追えるようにする。
 */
function summaryBlock(summary) {
  if (!summary || summary.source === 'error') return null;

  // 上のバーの .summary とは別物。名前を分けておかないと両方に同じ CSS が当たる
  const box = el('div', 'purpose');
  if (summary.headline) {
    box.append(el('div', 'purpose-head', summary.headline));
    // 出どころが Claude の中間報告なら、そう断る。
    // 機械的に抜き出した指示やタイトルと同じ重さに見せてはいけない（自己申告なので）
    if (summary.headlineSource === 'recap') {
      const mark = el('div', 'purpose-src');
      mark.append(el('span', 'claim', 'Claude の申告'));
      mark.append(document.createTextNode(summary.headlineAt
        ? `${stamp(summary.headlineAt)} 時点で Claude 自身が書いた中間報告です`
        : 'Claude 自身が書いた中間報告です'));
      box.append(mark);
    }
  }

  if (summary.compacted) {
    // 圧縮されている場合、上の見出しは本当の始まりではないかもしれない
    box.append(el('div', 'purpose-warn', '途中で文脈が圧縮されているため、これより前の指示は残っていません'));
  }

  if (summary.points?.length) {
    const dl = el('dl', 'purpose-points');
    for (const p of summary.points) {
      // 待ちの中身はすぐ下の「あなたの番」で大きく出すので、ここでは繰り返さない。
      // 要約データ側からは消さない（画面を持たない使い道でも状態が読めるように）
      if (p.label === '待っているもの') continue;
      dl.append(el('dt', null, p.label));
      dl.append(el('dd', null, p.text));
    }
    if (dl.childElementCount > 0) box.append(dl);
  }

  return box.childNodes.length ? box : null;
}

/**
 * 待ちの種類ごとの、見出しと「何をすれば進むのか」。
 *
 * ここに無い状態（実行中・終了）は待っていないので、パネルそのものを出さない。
 */
const WAIT_GUIDE = {
  'needs-answer': {
    title: '質問に答える',
    tone: 'hot',
    lead: '選択肢を選ぶまで、この先へ進みません',
  },
  'needs-plan-approval': {
    title: 'プランを承認する',
    tone: 'hot',
    lead: 'この計画で進めてよいかを決めてください',
  },
  'needs-approval': {
    title: '実行を許可する',
    tone: 'hot',
    lead: 'このツールを実行してよいかを決めてください',
  },
  'awaiting-reply': {
    title: '次の指示を出す',
    tone: 'warn',
    lead: 'Claude は応答を返し終えて止まっています',
  },
};

/**
 * まだ答えていない質問。
 *
 * 選択肢は説明つきで全部出す。ここで選ぶわけではないが、
 * 何を訊かれているか分かればターミナルへ戻ってすぐ答えられる。
 * 決めた答え（decision-a）とは見せ方を変えて、選んだものと混同させない。
 */
function pendingQuestion(a) {
  const wrap = el('div', 'decision');
  wrap.append(el('div', 'decision-q', a.question || '(質問文なし)'));

  const options = a.otherOptions ?? [];
  if (options.length) {
    const ul = el('ul', 'choices');
    for (const o of options) {
      const li = el('li');
      li.append(el('span', 'label', o.label));
      if (o.description) li.append(document.createTextNode(` — ${o.description}`));
      ul.append(li);
    }
    wrap.append(ul);
  }
  return wrap;
}

/**
 * 「いま何を待たれているか」を目的のすぐ下に置く。
 *
 * 状態の名前だけでは動けない。返信待ちなら何に返すのか、承認待ちなら何を承認するのか、
 * そこまで出さないと結局ターミナルへ戻って読み直すことになる。
 * 待ちの種類ごとに、判断に必要なものをここへ持ってくる。
 *
 * @param {object} row 一覧の1行
 * @param {object|null} d 詳細（まだ読めていなければ null）
 */
function waitingBlock(row, d) {
  const guide = WAIT_GUIDE[row.state];
  if (!guide) return null;

  const p = panel(`あなたの番 — ${guide.title}`, { id: SEC.wait, tone: guide.tone });
  p.section.classList.add('is-wait');
  p.body.append(el('p', 'note', guide.lead));

  const items = d?.digest?.items ?? [];
  const lastOf = (pred) => {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (pred(items[i])) return items[i];
    }
    return null;
  };

  if (row.state === 'needs-answer') {
    const ask = lastOf((i) => i.kind === 'answer' && i.unanswered);
    for (const a of ask?.answers ?? []) p.body.append(pendingQuestion(a));
    // 詳細がまだ来ていない間は、一覧が持っている質問文だけ出しておく
    if (!ask && row.waitingFor?.detail) p.body.append(el('div', 'wait-q', row.waitingFor.detail));
  } else if (row.state === 'needs-plan-approval') {
    const plan = lastOf((i) => i.kind === 'plan' && i.pending);
    if (plan?.planFile) {
      const line = el('div', 'wait-lead', 'プランの保存先 ');
      line.append(el('span', 'mono', plan.planFile));
      p.body.append(line);
    }
    if (plan?.plan) p.body.append(...Timeline.bodyText(plan.plan, 1400, 18));
    else if (d) p.body.append(el('p', 'note', 'プランの本文はログから取れませんでした'));
  } else if (row.state === 'needs-approval') {
    if (row.waitingFor) {
      p.body.append(el('div', 'wait-tool', row.waitingFor.tool));
      if (row.waitingFor.detail) p.body.append(el('pre', null, row.waitingFor.detail));
    }
  } else if (row.state === 'awaiting-reply') {
    const say = lastOf((i) => i.kind === 'say' && i.text);
    if (say) {
      p.body.append(el('div', 'wait-lead', 'Claude の最後の応答'));
      p.body.append(...Timeline.bodyText(say.text, 700, 8));
    }
  }

  return { section: p.section, tone: guide.tone };
}

/**
 * 上に置くジャンプ用のリンク。
 *
 * 詳細は縦に長いので、下にある TODO や時系列は開いた時点では見えない。
 * 何が入っているかを先に並べておけば、あると分かってから探しに行ける。
 * スクロールしても上に残すので、戻る手間もない。
 *
 * @param {Array<{id:string,label:string,count?:string|number,tone?:string}>} sections
 */
function navBlock(sections) {
  // 2つ以下なら見れば分かる。目次のほうが目立ってしまう
  if (sections.length < 3) return null;

  const nav = el('nav', 'deck-nav');
  nav.setAttribute('aria-label', 'この詳細に入っているもの');

  for (const s of sections) {
    const b = el('button', 'nav-chip', s.label);
    b.type = 'button';
    // あとから件数だけ差し替えるための目印。時系列は絞り込みで数が動く
    b.dataset.sec = s.id;
    if (s.tone) b.classList.add(`is-${s.tone}`);
    if (s.count !== undefined && s.count !== null) b.append(el('span', 'n', s.count));
    b.addEventListener('click', () => {
      const target = document.getElementById(s.id);
      if (!target) return;
      // 動きを減らす設定は CSS では効かない指定なので、ここで見て切り替える
      const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
    });
    nav.append(b);
  }
  return nav;
}

/* ------------------------------------------------------ サブエージェントの記録 */

/**
 * サブエージェントの状態の日本語。
 *
 * 「実行中」を作らない。終わったセッションの記録を見ているのに走っていることになる。
 * 起動しか分かっていないものは「起動した」までしか言わない。
 *
 * 未知の値はそのまま出す（黙って消さない）
 */
const AGENT_STATUS = {
  completed: '完了',
  launched: '起動した',
  pending: '結果なし',
  killed: '打ち切り',
  failed: '失敗',
};

/** これを超えたらボタンに大きさを添える。止めはしない、驚かせないだけ */
const AGENT_BIG_BYTES = 2 * 1024 * 1024;

/**
 * サブエージェント1件の行。
 *
 * 押されたときだけ取りに行く。パネルを開いた時点では1件も本文を読まない。
 * 記録は最大20件あり、1件が最大 2.6MB になる
 *
 * @param {object} a detail.subagents.items の1件
 * @param {string} sessionId いま開いているセッション
 * @returns {HTMLElement}
 */
function agentRow(a, sessionId) {
  const li = el('li', 'agent');
  if (!a.log.exists) li.classList.add('is-gone');

  const head = el('div', 'agent-head');
  head.append(el('span', 'agent-type', a.agentType ?? '種類不明'));

  const mid = el('span', 'agent-desc');
  mid.append(el('span', 'agent-desc-text', a.description ?? '（指示の記録がありません）'));

  // 添える事実は取れたものだけ。取れなかったものを 0 と書かない
  const facts = [];
  if (a.at) facts.push(hms(new Date(a.at)));
  if (a.status) facts.push(AGENT_STATUS[a.status] ?? a.status);
  if (typeof a.durationMs === 'number') facts.push(dur(a.durationMs));
  if (typeof a.toolUseCount === 'number') facts.push(`ツール ${num(a.toolUseCount)} 回`);
  if (typeof a.reportChars === 'number') facts.push(`報告 ${num(a.reportChars)} 字`);
  if (typeof a.log.size === 'number') facts.push(kb(a.log.size));
  if (facts.length) mid.append(el('span', 'agent-meta', facts.join('　')));

  // 入れ子は親ログに toolUseId が無いので結びつかない。それが正常だと分かる書き方にする
  if (!a.linked) {
    mid.append(el('span', 'agent-note', a.spawnDepth && a.spawnDepth > 1
      ? `入れ子（深さ ${a.spawnDepth}）なので、親のログに呼び出しの記録がありません`
      : '親のログに対応する呼び出しが見つかりません'));
  }
  head.append(mid);

  if (!a.log.exists) {
    head.append(el('span', 'agent-note', '記録が見つかりません'));
    li.append(head);
    return li;
  }

  // <details> にしない。頭が3列のグリッドで、<summary> を器にすると
  // マーカーの扱いがブラウザ間で揃わない。原文（<details>）との不一致は意図したもの
  const big = typeof a.log.size === 'number' && a.log.size > AGENT_BIG_BYTES;
  const btn = el('button', 'btn', big ? `開く（${mb(a.log.size)}）` : '開く');
  btn.type = 'button';
  btn.setAttribute('aria-expanded', 'false');
  const body = el('div', 'agent-body');
  body.hidden = true;
  head.append(btn);
  li.append(head, body);

  let loaded = false;
  let loading = false;
  btn.addEventListener('click', async () => {
    const open = btn.getAttribute('aria-expanded') === 'true';
    if (open) {
      btn.setAttribute('aria-expanded', 'false');
      body.hidden = true;
      return;
    }
    btn.setAttribute('aria-expanded', 'true');
    body.hidden = false;
    // 2回目以降は hidden の付け外しだけ
    if (loaded || loading) return;

    loading = true;
    body.replaceChildren(el('div', 'loading', '記録を読んでいます…'));
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(a.agentId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const nodes = [];
      if (data.log?.truncated) {
        nodes.push(el('div', 'note', 'ログが大きいので先頭だけ読んでいます。最終報告は親のログ側に入っています'));
      }
      nodes.push(Timeline.renderPlain(data.digest?.items ?? []));
      body.replaceChildren(...nodes);
      loaded = true;
    } catch (err) {
      // 失敗しても閉じられるままにする。押し直せば取り直せる
      body.replaceChildren(el('div', 'empty-note', `記録が取れません: ${err.message}`));
    } finally {
      loading = false;
    }
  });

  return li;
}

/**
 * サブエージェントの記録のパネル。
 *
 * 一覧には絶対に載せない（readdir が毎秒 46 セッション分走ることになる）。
 * ここは詳細を開いたときだけ組む
 *
 * @param {object} subagents detail.subagents
 * @param {string} sessionId いま開いているセッション
 * @returns {{section: HTMLElement, count: number}|null} 出すものが無ければ null
 */
function agentsPanel(subagents, sessionId) {
  const items = subagents?.items ?? [];
  if (!items.length && !subagents?.readError) return null;

  const p = panel('サブエージェントの記録', { id: SEC.agents, count: `${num(items.length)} 件` });
  if (subagents.readError) {
    p.body.append(el('p', 'note', `記録の置き場所を読めませんでした: ${subagents.readError}`));
  }

  const missing = subagents.counts?.missingLog ?? 0;
  if (missing) {
    p.body.append(el('p', 'note', `${num(missing)} 件は呼び出しだけが残っていて、記録のファイルがありません`));
  }

  const ul = el('ul', 'agents');
  for (const a of items) ul.append(agentRow(a, sessionId));
  p.body.append(ul);

  return { section: p.section, count: items.length };
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
    row?.state ?? '',
    row?.stateLabel ?? '',
    row?.stateReason ?? '',
    row?.statusRaw ?? '',
    row?.alive ? '1' : '0',
    row?.pid ?? '',
    row?.contextTokens ?? '',
    w ? `${w.tool ?? ''}${w.detail ?? ''}` : '',
  ].join('');
}

/** 前回 renderDetail() を通したときの材料。detail は参照そのままで見比べる */
let lastDetailRender = { detail: undefined, key: null };

/**
 * 必要なら詳細ペインを作り直す。
 *
 * apply() と loadDetail() は毎秒ここを通る。作り直すかどうかの判断は detailKeyOf() に寄せた
 */
function renderDetailIfNeeded() {
  if (lastDetailRender.detail === store.detail && lastDetailRender.key === detailKeyOf()) return;
  renderDetail();
}

function renderDetail() {
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

  // 何を待っているか。自分の番のときはここが最初に読む場所になるので、目的の直下に置く
  const waiting = waitingBlock(row, d);
  if (waiting) {
    stack.append(waiting.section);
    sections.push({ id: SEC.wait, label: 'あなたの番', tone: waiting.tone });
  }

  if (d) {
    // 「自分が何を決めたか」が課題の中心なので、待ちの次に置く（待っていなければ先頭）
    const decisions = d.digest.items.filter((i) => i.kind === 'answer' || i.kind === 'plan');
    if (decisions.length) {
      const answers = decisions.flatMap((i) => i.answers ?? []).length;
      const p = panel('あなたが決めたこと', {
        id: SEC.decisions,
        count: `回答 ${answers} / プラン ${d.digest.stats.plans}`,
      });
      // 見出しと同じ数え方にする（回答＋プラン）。
      // ログの行数を出すと、見出しの「回答 3 / プラン 1」と食い違って読めなくなる
      sections.push({
        id: SEC.decisions,
        label: 'あなたが決めたこと',
        count: answers + d.digest.stats.plans,
      });
      for (const item of decisions) {
        if (item.kind === 'answer') {
          for (const a of item.answers ?? []) p.body.append(Timeline.answerBlock(a, false));
        } else {
          const box = el('div', 'decision');
          box.append(el('div', 'decision-q', 'プランを提出'));
          box.append(...Timeline.planBlock(item, false).childNodes);
          p.body.append(box);
        }
      }
      stack.append(p.section);
    }

    if (d.tasks.items.length) {
      const done = d.tasks.counts.completed ?? 0;
      const p = panel('TODO', { id: SEC.todo, count: `${done} / ${d.tasks.items.length} 完了` });
      sections.push({ id: SEC.todo, label: 'TODO', count: `${done}/${d.tasks.items.length}` });
      const ul = el('ul', 'todo');
      for (const t of d.tasks.items) {
        const li = el('li');
        li.dataset.status = t.status;
        li.append(el('span', 'st', t.statusLabel));
        const s = el('span', 'subject', t.subject);
        li.append(s);
        ul.append(li);
      }
      p.body.append(ul);
      stack.append(p.section);
    }

    if (d.digest.compactions.length) {
      const p = panel('文脈の圧縮', { id: SEC.compact, count: `${d.digest.compactions.length} 回` });
      sections.push({ id: SEC.compact, label: '文脈の圧縮', count: d.digest.compactions.length });
      p.body.append(el('p', 'note',
        'このセッションは途中で文脈が圧縮されています。圧縮より前のやり取りは要約に置き換わっているため、下の時系列で確認してください。'));
      stack.append(p.section);
    }

    // 押したときに renderDetail() を呼ばない。時系列の中身と件数しか変わらないので、
    // 全体を作り直すと開いた <details> とスクロール位置まで捨てることになる。
    // そのぶん、ボタン自身の見た目（押した状態・並び順の文字）はここで書き換える
    const onlyBtn = toggle('判断だけ', store.onlyDecisions, () => {
      store.onlyDecisions = !store.onlyDecisions;
      localStorage.setItem('claude-deck.onlyDecisions', store.onlyDecisions ? '1' : '0');
      // 開き方を人に渡せるようにする（?only=1）
      syncQuery();
      onlyBtn.setAttribute('aria-pressed', String(store.onlyDecisions));
      // 当てはまる件数が変わるので窓は先頭から出し直す（reset）
      Timeline.render({ reset: true });
    });
    const orderBtn = toggle(store.newestFirst ? '新しい順' : '古い順', false, () => {
      store.newestFirst = !store.newestFirst;
      localStorage.setItem('claude-deck.newestFirst', store.newestFirst ? '1' : '0');
      orderBtn.textContent = store.newestFirst ? '新しい順' : '古い順';
      // 逆から出すことになるので、窓の続きは意味を持たない
      Timeline.render({ reset: true });
    });
    const actions = el('span', 'panel-actions');
    actions.append(onlyBtn, orderBtn);

    // 件数は Timeline.render() が入れる。ここで空文字を渡すのは、入れる先の節点を作らせるため
    const p = panel('時系列', { id: SEC.timeline, count: '', action: actions });
    sections.push({ id: SEC.timeline, label: '時系列', count: '' });
    // 絞り込みの帯は器の外（.timeline の兄弟）に置く。
    // 中に入れると Timeline.render() が入力欄まで作り直し、1文字ごとに caret が飛ぶ
    const host = el('div', 'tl-host');
    p.body.append(Timeline.filterBar(d.digest.items), host);
    stack.append(p.section);
    Timeline.attach({
      host,
      count: p.section.querySelector('h3 .count'),
      items: d.digest.items,
      dropped: d.digest.stats.droppedItems ?? 0,
    });

    // 時系列の下、書き換えたファイルの前。調査の記録は時系列の続きとして読まれる
    const agents = agentsPanel(d.subagents, row.sessionId);
    if (agents) {
      stack.append(agents.section);
      sections.push({ id: SEC.agents, label: 'サブエージェントの記録', count: agents.count });
    }

    if (d.digest.files.length) {
      const q = panel('書き換えたファイル', { id: SEC.files, count: `${d.digest.files.length} 件` });
      sections.push({ id: SEC.files, label: '書き換えたファイル', count: d.digest.files.length });
      const ul = el('ul', 'files');
      for (const f of d.digest.files.slice(0, 40)) {
        const li = el('li');
        li.append(el('span', 'n', f.count));
        const parts = String(f.path).split(/[\\/]/);
        const name = parts.pop();
        const box = el('span', 'p');
        if (parts.length) box.append(el('span', 'dir', `${parts.slice(-2).join('/')}/`));
        box.append(document.createTextNode(name));
        li.append(box);
        ul.append(li);
      }
      q.body.append(ul);
      stack.append(q.section);
    }
  } else if (error) {
    const p = panel('詳細を読み込めませんでした');
    p.body.append(el('p', 'note', error));
    stack.append(p.section);
  } else {
    stack.append(el('div', 'loading', 'ログを読んでいます…'));
  }

  const basics = panel('セッションの状態', { id: SEC.basics });
  sections.push({ id: SEC.basics, label: 'セッションの状態' });
  const dl = el('dl', 'facts');
  const idleNode = el('dd', null, since(idleOf(row)));
  idleNode.dataset.liveIdle = row.sessionId;
  if (row.lastActivityAt) idleNode.title = stamp(row.lastActivityAt);
  fact(dl, '判定の根拠', row.stateReason);
  dl.append(el('dt', null, '最後の動きから'), idleNode);
  fact(dl, '登録簿の status', row.statusRaw);
  fact(dl, '権限モード', row.permissionMode);
  fact(dl, 'モデル', shortModel(row.model));
  fact(dl, '思考量', row.effort);
  fact(dl, '文脈の量', row.contextTokens ? `${row.contextTokens.toLocaleString('ja-JP')} tokens` : null);
  fact(dl, 'ブランチ', row.gitBranch);
  fact(dl, 'PID', row.pid);
  fact(dl, 'バージョン', row.version);
  fact(dl, 'セッションID', row.sessionId);
  if (row.startedAt) fact(dl, '開始', stamp(row.startedAt));
  if (d) {
    fact(dl, 'やり取りの回数', `${d.digest.stats.turns} 往復 / ツール ${d.digest.stats.toolCalls} 回`);
    fact(dl, 'ログの大きさ', `${Math.round(d.log.size / 1024).toLocaleString('ja-JP')} KB / ${d.log.entries} 行`);
    if (d.log.parseErrors) fact(dl, '読めなかった行', `${d.log.parseErrors} 行`);
  }
  basics.body.append(dl);

  // 待ちの集計。1つも測れていなければ行も注記も出さない
  const waits = d?.digest?.stats?.waits;
  if (waits) {
    const wdl = el('dl', 'facts facts-waits');
    const L = Timeline.WAIT_LABELS;
    fact(wdl, L.answer, Timeline.waitFact(waits.answer));
    fact(wdl, L.plan, Timeline.waitFact(waits.plan));
    fact(wdl, L.denial, Timeline.waitFact(waits.denial));
    fact(wdl, L.reply, Timeline.waitFact(waits.reply));
    fact(wdl, L.tool, Timeline.waitFact(waits.tool));
    if (wdl.childElementCount > 0) {
      basics.body.append(wdl);
      // 注記は必ず添える。数字だけを出すと「迷っていた時間」と読まれる
      basics.body.append(el('p', 'note', Timeline.WAIT_NOTE));
    }
  }

  stack.append(basics.section);

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

/* ------------------------------------------------------ 詳細の取得と保持 */

/** sessionId から {mark, data}。mark が変わっていなければ再取得しない */
const detailCache = new Map();
const DETAIL_CACHE_MAX = 8;
let detailToken = 0;

/**
 * 詳細キャッシュの目印。
 *
 * lastActivityAt は使えない。サーバの SSE 差分判定がこのキーを比較から外しているので、
 * 会話が進んでも push されず目印が動かない。それで詳細が開いたときのまま止まっていた。
 * logSize は追記しか起きないので単調に増える。
 *
 * 一覧に居ないセッションは追記が止まっているものなので、前に取った詳細の大きさで代える。
 * 0 は「大きさが取れなかった」＝不明の意味にして、必ず取り直す。
 * 0 を有効な目印にすると、大きさが取れない行で古い内容を出し続けることになる。
 *
 * @param {string} sessionId
 * @returns {number} 0 は不明
 */
function detailStampOf(sessionId) {
  const row = rowOf(sessionId);
  if (row) return row.logSize ?? 0;
  return detailCache.get(sessionId)?.data?.log?.size ?? 0;
}

async function loadDetail(sessionId, { silent = false } = {}) {
  if (!sessionId) {
    store.detail = null;
    renderDetailIfNeeded();
    return;
  }

  // 名前を cacheMark にしてあるのは、トップレベルの mark()（描画時間の記録）を隠さないため。
  // timeline.js からも mark() を呼ぶようになったので、隠すと気づきにくい事故になる
  const cacheMark = detailStampOf(sessionId);
  const cached = detailCache.get(sessionId);
  // 目印が不明（0）のときは一致と見なさない。0 同士を突き合わせると永久にキャッシュが効く
  if (cached && cacheMark !== 0 && cached.mark === cacheMark) {
    store.detail = cached.data;
    store.detailError = null;
    store.detailErrorFor = null;
    renderDetailIfNeeded();
    return;
  }

  const token = ++detailToken;
  if (!silent) {
    store.detail = null;
    store.detailError = null;
    store.detailErrorFor = null;
    renderDetailIfNeeded();
  }

  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
    if (!res.ok) {
      // サーバは理由を日本語で返してくる。HTTP 404 より読める文言になるので、あればそれを出す
      const reason = await res.json().then((j) => j?.error).catch(() => null);
      throw new Error(reason ?? `HTTP ${res.status}`);
    }
    const data = await res.json();
    // 選び直したあとに古い応答が届いても無視する
    if (token !== detailToken || store.selected !== sessionId) return;
    // 目印は一覧の logSize を優先し、無ければ取れた詳細の大きさで代える。
    // ここで不明（0）のまま入れると、次の push で必ず取り直しになる
    detailCache.set(sessionId, { mark: cacheMark || data.log?.size || 0, data });
    if (detailCache.size > DETAIL_CACHE_MAX) {
      detailCache.delete(detailCache.keys().next().value);
    }
    store.detail = data;
    store.detailError = null;
    store.detailErrorFor = null;
  } catch (err) {
    if (token !== detailToken) return;
    store.detail = null;
    store.detailError = err.message;
    store.detailErrorFor = sessionId;
  }
  renderDetailIfNeeded();
}

/**
 * @param {string|null} sessionId
 * @param {'live'|'query'|'archive'} [from] 選んだ経路。store.selectedFrom の説明を参照
 */
function select(sessionId, from = 'live') {
  if (store.selected === sessionId) return;
  store.selected = sessionId || null;
  store.selectedFrom = store.selected ? from : null;
  // 印は両方の一覧に付け直す。書庫で選んだあと稼働中に戻ったとき、
  // 同じセッションが両方に居ることがある
  for (const node of [...dom.list.querySelectorAll('.card'), ...dom.archive.querySelectorAll('.card')]) {
    node.setAttribute('aria-current', String(node.dataset.sessionId === store.selected));
  }
  syncQuery();
  loadDetail(store.selected);
}

/* ------------------------------------------------------------ データ取得 */

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

function setLive(state, label) {
  dom.live.dataset.live = state;
  dom.live.textContent = label;
}

async function fetchOnce() {
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

function connect() {
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

/* -------------------------------------------------------- 狭い画面の一覧 */

/** 引き出しに切り替わる幅。CSS のメディアクエリと同じ値にする */
const NARROW = matchMedia('(max-width: 860px)');

/**
 * 引き出しが閉じているあいだ、一覧に触れないようにする。
 *
 * 閉じた引き出しは画面の外にあるだけで、消えてはいない。
 * このままだと見えていないカードに Tab で入り込めるので、inert で丸ごと外す。
 * CSS の visibility でも隠せるが、切り替わりが1フレームで確定せず、
 * 開いた直後に focus を移せなくなるため使わない。
 */
function syncListInert() {
  dom.listPane.inert = NARROW.matches && !dom.app.classList.contains('is-list-open');
}

/**
 * 一覧の引き出しを開閉する。
 *
 * 狭い画面では一覧が画面の手前に出てくる。開けっぱなしにする理由が無いので、
 * 選んだら自分で引っ込む。広い画面では一覧が常に見えているため何もしない。
 *
 * @param {boolean} open 開くなら true
 * @param {HTMLElement|null} moveFocusTo 閉じたあとに focus を移す先
 */
function setListOpen(open, moveFocusTo = null) {
  const changed = dom.app.classList.contains('is-list-open') !== open;
  dom.app.classList.toggle('is-list-open', open);
  dom.listToggle.setAttribute('aria-expanded', String(open));
  dom.listToggle.setAttribute('aria-label', open ? 'セッション一覧を閉じる' : 'セッション一覧を開く');
  syncListInert();

  // 広い画面では引き出し自体が無い。focus を勝手に動かすと操作を横取りしてしまう
  if (!changed || !NARROW.matches) return;

  if (open) {
    // 選ぶために開いたので、選べる場所へ移る
    const card = dom.list.querySelector('.card[aria-current="true"]') ?? dom.list.querySelector('.card');
    card?.focus();
  } else if (moveFocusTo) {
    moveFocusTo.focus();
  }
}

function initListDrawer() {
  dom.listToggle.addEventListener('click', () => {
    const open = !dom.app.classList.contains('is-list-open');
    setListOpen(open, dom.listToggle);
  });

  dom.listClose.addEventListener('click', () => setListOpen(false, dom.listToggle));
  dom.scrim.addEventListener('click', () => setListOpen(false, dom.listToggle));

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !dom.app.classList.contains('is-list-open')) return;
    ev.preventDefault();
    setListOpen(false, dom.listToggle);
  });

  // 幅が変わったら、その幅に合う状態へ戻す。
  // 広い画面では一覧が常に見えているので、開いた状態も触れない状態も残さない
  NARROW.addEventListener('change', (ev) => {
    if (ev.matches) syncListInert();
    else setListOpen(false);
  });

  syncListInert();
}

/* ------------------------------------------------------------------ 起動 */

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

/** 書庫タブの配線。store.tab は保存しないので、初期値は URL だけから決まる */
function initTabs() {
  dom.tabLive.addEventListener('click', () => setTab('live'));
  dom.tabArchive.addEventListener('click', () => setTab('archive'));

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

initTheme();
initListDrawer();
initTabs();
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
