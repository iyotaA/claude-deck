/* 本文・回答・プラン・原文の部品。時系列の行の中身と、詳細のパネルの中身を兼ねる。
 *
 * 「あなたが決めたこと」のパネルは、時系列と同じ answerBlock / planBlock を使う。
 * 同じ判断を2通りに描くと、場所によって違って見えるため（index.js が外へ出している）。
 *
 * bodyText は長い本文を切る。切った跡に元の長さを添えるのはここの仕事。
 *
 * 畳んだ中の全文は Markdown として描く（mdView）。頭出しのほうは素の文字のまま。
 * あちらは文字数で切っているので、記法の途中で切れた断片を描くことになる
 * （**が片方だけ残った、表の途中で終わった、など）。切る単位をブロックへ移すまでは
 * 素の文字のほうが読める。
 */
import { el, num, ymd, hms, markUp, marked, countHits } from '../util.js';
import { mdView } from '../md-view.js';
import { store } from '../store.js';

/**
 * 長い本文は頭だけ出して、続きは折りたたむ。
 *
 * 時系列は「ざっと目で追える」ことが値なので、1件が画面を埋めてはいけない。
 * 全文は残すが、開いたときだけ見せる。
 *
 * @param {string|null} text 出す本文（サーバ側で既に切られていることがある）
 * @param {number} limit 頭出しの文字数
 * @param {number} maxLines 頭出しの行数
 * @param {number|null} [fullLength] 切る前の文字数。サーバが切っていれば受け取った長さより大きい
 * @param {string|null} [needle] 検索語。当たった所を強調する
 */
export function bodyText(text, limit, maxLines, fullLength = null, needle = null) {
  const t = String(text ?? '').trim();
  if (!t) return [];
  const lines = t.split('\n');
  if (t.length <= limit && lines.length <= maxLines) return [marked('div', 'tl-text', t, needle)];

  let head = lines.slice(0, maxLines).join('\n');
  if (head.length > limit) head = head.slice(0, limit);
  const more = el('details', 'more');
  // ここで持っているのが本当の全文かどうかで文言を変える。サーバ側が既に切っているのに
  // 「全文」と書くと嘘になる（say は 1,200 字、recap は 2,000 字で切られている）
  const clipped = typeof fullLength === 'number' && fullLength > t.length;
  const label = clipped
    ? `全 ${fullLength.toLocaleString('ja-JP')} 字（このうち ${t.length.toLocaleString('ja-JP')} 字まで表示）`
    : `全文（${t.length.toLocaleString('ja-JP')}字）`;
  // 検索語が頭出しに無く、続きの中にあるときは開いた状態で出す。
  // 閉じたまま出すと「一致した行なのに、見ても語が見つからない」ことになる
  const hits = countHits(t, needle);
  if (hits > countHits(head, needle)) more.open = true;
  more.append(el('summary', null, hits ? `${label}　一致 ${num(hits)} 件` : label));
  more.append(mdView(t, needle));
  return [marked('div', 'tl-text', `${head.trimEnd()}…`, needle), more];
}

/**
 * 回答1件を描く。
 *
 * compact のときは質問と選んだ答えだけ。時系列の中では短くしたいので。
 * それ以外は選択肢の説明と、選ばなかった案も出す。
 * 説明文が「その選択が何を意味していたか」なので、判断の理由がここに残る。
 *
 * @param {object} a digest の answer 1件
 * @param {boolean} compact 時系列の中で短く出すか
 * @param {string|null} [needle] 検索語
 */
export function answerBlock(a, compact, needle = null) {
  const wrap = el('div', 'decision');
  wrap.append(marked('div', 'decision-q', a.question || '(質問文なし)', needle));

  const box = el('div', 'decision-a');
  if (a.freeText) box.classList.add('is-free');
  if (a.chosen) {
    box.append(marked('div', 'label', a.chosen, needle));
    const why = a.chosenOptions?.[0]?.description;
    if (!compact && why) box.append(marked('p', 'why', why, needle));
    else if (!compact && a.freeText) box.append(el('p', 'why', '選択肢から選ばず、自分で書いた回答'));
  } else {
    box.append(el('div', 'label', '（まだ回答していません）'));
  }
  wrap.append(box);

  if (!compact && a.otherOptions?.length) {
    const d = el('details', 'rejected');
    d.append(el('summary', null, `選ばなかった案 ${a.otherOptions.length} 件`));
    const ul = el('ul');
    let hits = 0;
    for (const o of a.otherOptions) {
      const li = el('li');
      li.append(marked('span', 'label', o.label, needle));
      if (o.description) li.append(...markUp(` — ${o.description}`, needle));
      hits += countHits(o.label, needle) + countHits(o.description, needle);
      ul.append(li);
    }
    // 当たった所が畳んだ中にしか無いときは開いて出す。閉じたままだと語が見つからない
    if (hits) d.open = true;
    d.append(ul);
    wrap.append(d);
  }
  return wrap;
}

/**
 * この提出に対応するプランの系譜を取り出す。
 *
 * サーバは最後の提出1件だけを調べて uuid を添えてくる。ここで uuid を突き合わせるのは、
 * サブエージェントの時系列を同じ planBlock で描くときに、親のプランの系譜を
 * 子のプランへ貼ってしまう事故を防ぐため（子ログの uuid は親に存在しない）
 *
 * @param {object} item digest の plan 1件
 * @returns {object|null} 対応する系譜。無ければ null
 */
function lineageOf(item) {
  const lineage = store.detail?.planLineage ?? null;
  if (!lineage || !lineage.uuid || lineage.uuid !== item.uuid) return null;
  return lineage;
}

/**
 * プランの系譜を出す。
 *
 * 出すのは「あのとき approve したプランと、いまファイルに書かれているものが同じか」だけ。
 * 差分は作らない。両方の本文を畳んで並べ、読み手が見比べられる形にする。
 *
 * 文言はサーバ側（view/plans.mjs）が作る。判定と文言が離れると、
 * mtime だけを根拠に言い切らないという約束を2箇所で守ることになる
 *
 * @param {object} lineage detail.planLineage
 * @returns {Node[]} 足すノード
 */
function lineageNodes(lineage) {
  const out = [];
  for (const note of lineage.notes ?? []) {
    // 一致していた、は安心の知らせなので沈める。それ以外は目を留めてほしいので警告色にする
    const calm = note === '提出後にファイルは変わっていません';
    out.push(el('div', calm ? 'plan-note' : 'plan-note warn', note));
  }

  const disk = lineage.disk;
  if (disk?.text) {
    const d = el('details', 'more');
    // ymd / hms は Date を受ける。ミリ秒をそのまま渡すと詳細ペインごと落ちる
    const at = typeof disk.mtimeMs === 'number' ? new Date(disk.mtimeMs) : null;
    const when = at ? `　${ymd(at)} ${hms(at)} 更新` : '';
    d.append(el('summary', null, `いまのファイルの中身　${num(disk.chars)} 字${when}`));
    // 提出したときの本文（planBlock 側）と見比べるものなので、描き方を揃える。
    // 片方だけ Markdown にすると、同じ文でも別物に見える
    d.append(mdView(disk.text));
    out.push(d);
  }
  return out;
}

/**
 * @param {object} item digest の plan 1件
 * @param {boolean} compact 全文を畳むだけにするか
 * @param {string|null} [needle] 検索語
 */
export function planBlock(item, compact, needle = null) {
  const box = el('div', 'tl-body');
  const status = item.pending ? '承認を待っています' : item.approved ? '承認済み' : '差し戻し';
  const line = el('div', 'tl-text', status);
  // パスは等幅で出す。和文フォントに落ちると \ が ¥ の字形になって別物に見えるため
  if (item.planFile) {
    line.append(' — ');
    line.append(marked('span', 'mono', item.planFile, needle));
  }
  box.append(line);
  if (item.feedback) box.append(marked('pre', 'tl-detail', item.feedback, needle));

  const lineage = lineageOf(item);
  if (lineage) box.append(...lineageNodes(lineage));

  if (item.plan && !compact) {
    const d = el('details', 'more');
    const hits = countHits(item.plan, needle);
    // 系譜を出すときは、どちらの本文かが分かるように言い方を変える
    const label = lineage?.disk?.text ? '提出したときの本文' : 'プラン全文';
    d.append(el('summary', null, hits ? `${label}　一致 ${num(hits)} 件` : label));
    if (hits) d.open = true;
    d.append(mdView(item.plan, needle));
    box.append(d);
  }
  return box;
}

/**
 * 原文（会話ログの1行）を開ける折りたたみを作る。
 *
 * 押されたときだけ取りに行く。時系列には最大 400 行あるので、前もって全部取ると
 * 詳細を開くだけで数百回の往復になる。
 *
 * モーダルにしない理由が3つ。既存の「全文」と同じ操作感になる。focus trap が要らない。
 * そして Escape のハンドラは一覧の引き出しが開いているあいだ常に preventDefault() するので、
 * モーダルにすると閉じ方をそこと調停する仕組みが要る。
 *
 * 取得に失敗したときは done を立てない。閉じて開き直せば取り直せる。
 *
 * @param {((uuid: string) => (string|null))|null} makeUrl 取得先を作る関数。
 *   関数を渡す形にするのは、サブエージェントの記録を同じ timelineItem で描くときに
 *   子ログの uuid を親の URL へ投げる事故を防ぐため。
 *   これで timelineItem から store.selected への隠れた依存も消える
 * @param {string|null} uuid 開きたい行の uuid。elided は null なので出さない
 * @returns {HTMLElement|null}
 */
export function rawBlock(makeUrl, uuid) {
  if (typeof makeUrl !== 'function' || !uuid) return null;
  const url = makeUrl(uuid);
  if (!url) return null;

  const d = el('details', 'more raw');
  d.append(el('summary', null, '原文'));
  const out = el('pre', 'raw-body');
  d.append(out);

  let done = false;
  let loading = false;
  d.addEventListener('toggle', async () => {
    if (!d.open || done || loading) return;
    loading = true;
    out.textContent = '読み込んでいます…';
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // 伏せた・切ったを断ってから出す。黙って加工すると原文だと思って読まれる
      const notes = [];
      if (data.masked) notes.push('鍵らしい値は伏せてあります');
      if (data.truncated) notes.push('長すぎる所は切ってあります');
      const head = notes.length ? `※ ${notes.join(' / ')}\n\n` : '';
      out.textContent = `${head}${JSON.stringify(data.entry, null, 2)}`;
      done = true;
    } catch (err) {
      out.textContent = `原文が取れません: ${err.message}`;
    } finally {
      loading = false;
    }
  });
  return d;
}

/**
 * 原文の取得先を作る関数を返す。
 *
 * @param {string|null} sessionId いま開いているセッション
 * @returns {(uuid: string) => (string|null)}
 */
export function rawUrlFor(sessionId) {
  return (uuid) => (sessionId && uuid
    ? `/api/sessions/${encodeURIComponent(sessionId)}/entry/${encodeURIComponent(uuid)}`
    : null);
}

/**
 * 時系列の左端。日付と時刻を2段で出す。
 *
 * 時刻だけだと、23:58 の次に 00:03 が並んだときに同じ日なのか翌日なのかが読めない。
 * 日付が変わった行にだけ出す手もあるが、スクロールでその行が画面外へ出ると分からなくなるので、
 * 行だけを見て日付が読めるほうを取る。
 * @param {number|null} at そのやり取りの時刻（ミリ秒）。取れていなければ null
 */
export function whenNode(at) {
  const node = el('div', 'tl-when');
  // 時刻が無い行でも列は残す。ノードごと省くと本文が左の列にずれ込む
  if (!at) return node;
  const d = new Date(at);
  node.append(el('span', 'tl-date', ymd(d)), el('span', 'tl-time', hms(d)));
  return node;
}
