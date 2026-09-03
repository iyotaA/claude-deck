/* 詳細ペインに積むパネル。
 *
 * 層3。1枚が1つの関数で、どれも同じ形を返す。
 *
 *   HTMLElement … 積む節点
 *   null        … 出すものが無い（呼ぶ側は何もしない）
 *
 * 以前は目次（上のジャンプ用リンク）に出す1件も一緒に返していたが、
 * 中央タブに割ったときに目次ごと外した。タブと役目が重なるうえ、
 * タブの数は選んでいないタブのぶんも要るので、パネルの戻り値からは取れない。
 */
import { el, since, stamp, shortModel, fact, num } from './util.js';
import { store, syncQuery } from './store.js';
import { idleOf } from './rows.js';
import { panel, SEC, toggle } from './panel.js';
import * as Timeline from './timeline/index.js';
// 層0 の語彙なので直に見てよい（store.js が同じことをしている）。
// index.js を経由させると index -> view -> store の循環になる
import { splitEdits } from './timeline/kinds.js';

/**
 * ファイル1件の行。
 *
 * 「書き換えたファイル」と「ここまで」で同じ顔にする。片方だけ切り方を変えると、
 * 同じパスが場所によって違って見える。
 *
 * 末尾2階層だけ薄く出すのは、フルパスを出すと器の幅を越えるため。
 * 時系列の edit 行（timeline/item.js）も同じ切り方にしてある
 *
 * @param {string} path ファイルのパス
 * @param {string|number} lead 1列目に出すもの（回数、またはツール名）
 */
function fileLi(path, lead) {
  const li = el('li');
  li.append(el('span', 'n', lead));
  const parts = String(path ?? '').split(/[\\/]/).filter(Boolean);
  const name = parts.pop();
  const box = el('span', 'p');
  if (parts.length) box.append(el('span', 'dir', `${parts.slice(-2).join('/')}/`));
  // パスが取れていないものもある。空欄にせず、取れていないことを書く
  box.append(document.createTextNode(name ?? '(パス不明)'));
  li.append(box);
  return li;
}

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

  return p.section;
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

  return p.section;
}

/** @param {object} d 詳細の応答 */
export function compactionPanel(d) {
  if (!d.digest.compactions.length) return null;

  const p = panel('文脈の圧縮', { id: SEC.compact, count: `${d.digest.compactions.length} 回` });
  p.body.append(el('p', 'note',
    'このセッションは途中で文脈が圧縮されています。圧縮より前のやり取りは要約に置き換わっているため、下の時系列で確認してください。'));

  return p.section;
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

  return p.section;
}

/** @param {object} d 詳細の応答 */
export function filesPanel(d) {
  if (!d.digest.files.length) return null;

  const p = panel('書き換えたファイル', { id: SEC.files, count: `${d.digest.files.length} 件` });
  const ul = el('ul', 'files');
  for (const f of d.digest.files.slice(0, 40)) ul.append(fileLi(f.path, f.count));
  p.body.append(ul);

  return p.section;
}

/**
 * 「ここまで」。時系列の終わりに置く、いまの到達点のまとめ。
 *
 * **芯の5つのうち「どうなったのか」に答える1枚。**
 * これまで触ったファイル・TODO・決めたことは右のインスペクタの中にあり、
 * レールを1押ししないと見えなかった。読み終わる場所へ出す。
 *
 * 並び順（新しい順・古い順）に関わらず時系列の後ろに置く。
 * ここに出すのは時刻を持たない**累積の集計**なので、時系列のどの位置とも対応しない。
 *
 * 詳しくは「成果」タブが持つ。ここは要約と、そこへの入り口だけ。
 *
 * @param {object} d 詳細の応答
 * @param {object} [opts]
 * @param {Function} [opts.onMore] 「成果」タブへ移る。**層4 から差す**
 *   （ここから setDetailTab を呼ぶと detail-panels(3) -> detail(4) の逆向きになる）
 */
export function outcomeBlock(d, { onMore } = {}) {
  const files = d.digest.files ?? [];
  const tasks = d.tasks?.items ?? [];
  const answers = d.digest.items
    .filter((i) => i.kind === 'answer')
    .flatMap((i) => i.answers ?? []).length;
  const plans = d.digest.stats?.plans ?? 0;

  if (!files.length && !tasks.length && !answers && !plans) return null;

  const p = panel('ここまで', { id: SEC.outcome });

  const writes = files.reduce((s, f) => s + (f.count ?? 0), 0);
  const dl = el('dl', 'facts');
  fact(dl, '触ったファイル', files.length ? `${num(files.length)} 件 / ${num(writes)} 回` : null);
  fact(dl, 'TODO', tasks.length ? `${num(d.tasks.counts.completed ?? 0)} / ${num(tasks.length)} 完了` : null);
  fact(dl, '決めたこと', (answers || plans) ? `回答 ${num(answers)} / プラン ${num(plans)}` : null);
  p.body.append(dl);

  // よく触ったファイルの上位だけ。全部は「成果」タブにある
  if (files.length) {
    const ul = el('ul', 'files');
    for (const f of files.slice(0, 3)) ul.append(fileLi(f.path, f.count));
    p.body.append(ul);
  }

  if (onMore) {
    const more = el('button', 'btn', '成果をぜんぶ見る');
    more.type = 'button';
    more.addEventListener('click', onMore);
    p.body.append(more);
  }

  // **数が食い違うことを隠さない。**
  // 時系列の edit 行は足跡（trace）から拾っているので、間引き（MAX_TRACES = 200）で
  // 落ちた区間の書き換えは calls ごと消えていて拾えない。いっぽう digest.files は
  // 全走査の集計なので落ちない。断らないと「時系列に出ている数を数えても合わない」になる
  const shown = splitEdits(d.digest.items)
    .filter((i) => i.kind === 'edit')
    .reduce((s, i) => s + (i.calls?.length ?? 0), 0);
  if (writes > shown) {
    p.body.append(el('p', 'note',
      `時系列に出している書き換えは、残っている足跡から拾ったぶんだけです（${num(shown)} 回 / ${num(writes)} 回）。古いぶんは間引きで落ちています`));
  }

  return p.section;
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
  // 見出しは短い名前。長い説明は紙の側（#insp-title）が持つ。
  // usagePanel が「何にトークンを使ったか」の紙に「数値」のパネルを置いているのと同じ作法。
  // 前はどちらも「セッションの状態」で、同じ文字が縦に2つ並んでいた
  const basics = panel('診断', { id: SEC.basics });

  // **性質で3つに割る。** 前は17行が同じ濃さで1つの dl に並んでいて、
  // 「いまどうなっているか」の3行が「PID」「セッションID」と同じ重さで埋もれていた。
  // 区切りは .facts-waits の破線を借りる（**新しいクラスを作らない**）。
  //
  // 畳まない・節にも割らない。ここを探しているのは、たいてい何かがおかしいとき。
  // そこで段階的に開示すると、開く順番を当てるゲームになる。**密でよい場所**
  const dl = el('dl', 'facts');
  const idleNode = el('dd', null, since(idleOf(row)));
  idleNode.dataset.liveIdle = row.sessionId;
  if (row.lastActivityAt) idleNode.title = stamp(row.lastActivityAt);
  fact(dl, '判定の根拠', row.stateReason);
  dl.append(el('dt', null, '最後の動きから'), idleNode);
  fact(dl, '登録簿の status', row.statusRaw);
  fact(dl, '文脈の量', row.contextTokens ? `${row.contextTokens.toLocaleString('ja-JP')} tokens` : null);
  if (d) fact(dl, 'やり取りの回数', `${d.digest.stats.turns} 往復 / ツール ${d.digest.stats.toolCalls} 回`);
  basics.body.append(dl);

  // この作業がどう設定されているか。替えたくなったら入力欄の上の札から替える
  const setup = el('dl', 'facts facts-waits');
  fact(setup, '権限モード', row.permissionMode);
  fact(setup, 'モデル', shortModel(row.model));
  fact(setup, '思考量', row.effort);
  fact(setup, 'ブランチ', row.gitBranch);
  if (setup.childElementCount > 0) basics.body.append(setup);

  // 素性。ふだん読む値ではないので最後に置く
  const id = el('dl', 'facts facts-waits');
  fact(id, 'PID', row.pid);
  fact(id, 'バージョン', row.version);
  fact(id, 'セッションID', row.sessionId);
  if (row.startedAt) fact(id, '開始', stamp(row.startedAt));
  if (d) {
    fact(id, 'ログの大きさ', `${Math.round(d.log.size / 1024).toLocaleString('ja-JP')} KB / ${d.log.entries} 行`);
    if (d.log.parseErrors) fact(id, '読めなかった行', `${d.log.parseErrors} 行`);
  }
  if (id.childElementCount > 0) basics.body.append(id);

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

  return basics.section;
}
