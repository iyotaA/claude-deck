/* 詳細ペインに積むパネル。
 *
 * 層3。1枚が1つの関数で、どれも同じ形を返す。
 *
 *   { section, nav } … section は積む節点、nav は上のジャンプ用リンクに出す1件
 *   null            … 出すものが無い（呼ぶ側は何もしない）
 *
 * 目次の1件を各パネル自身に持たせているのが要点。detail.js 側で並べると、
 * パネルを1枚足すたびに離れた2箇所を揃える必要が出て、件数の数え方がずれる。
 */
import { el, since, stamp, shortModel, fact } from './util.js';
import { store, syncQuery } from './store.js';
import { idleOf } from './rows.js';
import { panel, SEC, toggle } from './panel.js';
import * as Timeline from './timeline/index.js';

/**
 * 「あなたが決めたこと」。回答と提出したプランを、時系列と同じ見せ方で並べる。
 *
 * このアプリの課題の中心なので、待ちの次に置く（待っていなければ先頭）
 * @param {object} d 詳細の応答
 */
export function decisionsPanel(d) {
  const decisions = d.digest.items.filter((i) => i.kind === 'answer' || i.kind === 'plan');
  if (!decisions.length) return null;

  const answers = decisions.flatMap((i) => i.answers ?? []).length;
  const p = panel('あなたが決めたこと', {
    id: SEC.decisions,
    count: `回答 ${answers} / プラン ${d.digest.stats.plans}`,
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

  return {
    section: p.section,
    // 見出しと同じ数え方にする（回答＋プラン）。
    // ログの行数を出すと、見出しの「回答 3 / プラン 1」と食い違って読めなくなる
    nav: { id: SEC.decisions, label: 'あなたが決めたこと', count: answers + d.digest.stats.plans },
  };
}

/** @param {object} d 詳細の応答 */
export function todoPanel(d) {
  if (!d.tasks.items.length) return null;

  const done = d.tasks.counts.completed ?? 0;
  const p = panel('TODO', { id: SEC.todo, count: `${done} / ${d.tasks.items.length} 完了` });
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

  return {
    section: p.section,
    nav: { id: SEC.todo, label: 'TODO', count: `${done}/${d.tasks.items.length}` },
  };
}

/** @param {object} d 詳細の応答 */
export function compactionPanel(d) {
  if (!d.digest.compactions.length) return null;

  const p = panel('文脈の圧縮', { id: SEC.compact, count: `${d.digest.compactions.length} 回` });
  p.body.append(el('p', 'note',
    'このセッションは途中で文脈が圧縮されています。圧縮より前のやり取りは要約に置き換わっているため、下の時系列で確認してください。'));

  return {
    section: p.section,
    nav: { id: SEC.compact, label: '文脈の圧縮', count: d.digest.compactions.length },
  };
}

/**
 * 時系列。器と絞り込みの帯を組み、描く先を Timeline へ預けるところまでやる。
 *
 * 中身を入れるのは呼ぶ側の Timeline.render()。パネルを積み終わってから描くほうが、
 * まだ document に付いていないぶんレイアウトの計算が1回で済む
 *
 * @param {object} d 詳細の応答
 */
export function timelinePanel(d) {
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
  // 絞り込みの帯は器の外（.timeline の兄弟）に置く。
  // 中に入れると Timeline.render() が入力欄まで作り直し、1文字ごとに caret が飛ぶ
  const host = el('div', 'tl-host');
  p.body.append(Timeline.filterBar(d.digest.items), host);
  Timeline.attach({
    host,
    count: p.section.querySelector('h3 .count'),
    items: d.digest.items,
    dropped: d.digest.stats.droppedItems ?? 0,
  });

  return {
    section: p.section,
    nav: { id: SEC.timeline, label: '時系列', count: '' },
  };
}

/** @param {object} d 詳細の応答 */
export function filesPanel(d) {
  if (!d.digest.files.length) return null;

  const p = panel('書き換えたファイル', { id: SEC.files, count: `${d.digest.files.length} 件` });
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
  p.body.append(ul);

  return {
    section: p.section,
    nav: { id: SEC.files, label: '書き換えたファイル', count: d.digest.files.length },
  };
}

/**
 * セッションの状態。取れた事実だけを並べる（fact が空の項目を落とす）。
 *
 * 経過時間の dd には data-live-idle を振る。refreshTimes() がここだけを
 * 毎秒書き換えるので、詳細を作り直さずに時間が進む
 *
 * @param {object} row 一覧の行に相当するもの
 * @param {object|null} d 詳細（まだ読めていなければ null）
 */
export function basicsPanel(row, d) {
  const basics = panel('セッションの状態', { id: SEC.basics });
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

  return {
    section: basics.section,
    nav: { id: SEC.basics, label: 'セッションの状態' },
  };
}
