/* 詳細ペインの時系列。
 *
 * app.js から切り出したもの。切った理由は行数だけではない。
 * 時系列は「絞り込む → 1行を組む → 器だけ差し替える」で完結していて、
 * 詳細ペインの他のパネル（回答・TODO・ファイル・状態）とは材料も描き直しの周期も違う。
 *
 * 依存は一方向にする。
 *   timeline.js → app.js の小道具（el / since / dur / num / ymd / hms / mark）と store / syncQuery
 *   app.js      → このファイルの Timeline.* だけ
 * app.js からこのファイルの中の名前を直に呼ばない。逆向きに呼びたくなったら、
 * それは Timeline の口に足すべきものか、そもそも時系列の仕事ではないかのどちらか。
 *
 * 読み込む順は index.html で timeline.js → app.js。
 * app.js の store の初期値が Timeline.initialHiddenKinds() を呼ぶので、
 * このファイルが先に評価されていないと立ち上がらない。
 *
 * 文字列は必ず textContent で入れる（innerHTML を使わない）。ここはログ本文を直に出す側。
 */
'use strict';

/* --------------------------------------------------------------- 隠す種類 */

/**
 * 時系列で既定から隠す種類。
 *
 * 足跡（trace）は件数が桁で多い。既定で出すと判断の記録が埋もれる。
 *
 * 拒否リストで持つのが要点。許可リストにすると、サーバが新しい種類を足したときに
 * 既定で見えなくなる。「未知の形で落ちない」は、黙って消えないことも含む。
 * 副産物として「足跡は既定オフ」が特別扱いではなく初期値1つで済む
 */
const HIDDEN_KINDS_DEFAULT = ['trace'];

/**
 * 隠している種類の初期値を決める。
 *
 * **localStorage には覚えさせない。** ここだけ他の設定（並び順・テーマ・稼働中だけ）と扱いを分ける。
 * 覚えさせると、足跡をいちど押して中を見ただけで既定が永久に壊れる。
 * 「判断の記録が埋もれない」はこのアプリの土台なので、開き直したら既定に戻すほうが安全。
 *
 * 出したままにしたい人は ?hide= を空で付けた URL を開く。
 * 「キーが無い」と「空で付いている」は分けて見るので、空は「何も隠さない」の指定になる。
 * これで「既定のまま」「何も隠さない」「これだけ隠す」の3つを人に渡せる
 *
 * @param {string|null} fromUrl ?hide= の値。付いていなければ null（空文字とは別もの）
 * @returns {Set<string>}
 */
function initialHiddenKinds(fromUrl = null) {
  if (fromUrl === null) return new Set(HIDDEN_KINDS_DEFAULT);
  return new Set(fromUrl.split(',').map((s) => s.trim()).filter(Boolean));
}

/**
 * ?hide= に書く値。
 *
 * 既定と同じなら null を返す（キーを付けない）。空文字は「何も隠さない」の指定なので、
 * null とは分けて返す。syncQuery() の側でこの2つを見分けてもらう
 * @returns {string|null}
 */
function hideQueryValue() {
  const hide = [...store.hiddenKinds].sort().join(',');
  return hide === [...HIDDEN_KINDS_DEFAULT].sort().join(',') ? null : hide;
}

/* ------------------------------------------------------------- 種類のラベル */

const KIND_LABELS = {
  prompt: 'あなたの指示',
  answer: 'あなたの回答',
  plan: 'プラン',
  denial: '却下・不許可',
  skill: 'スキル',
  agent: 'サブエージェント',
  say: 'Claude',
  compact: '文脈の圧縮',
  error: 'エラー',
  slash: 'コマンド',
  interrupt: 'あなたが中断',
  // Claude 自身が書いた中間報告。機械的に抜き出した記録ではないので、語を分けておく
  recap: 'Claude の中間報告',
  elided: '省略',
  // ふつうのツール呼び出し。既定では隠している（HIDDEN_KINDS_DEFAULT）。
  // 絞り込みのチップにも同じ語が出るので、ここを直せば両方が変わる
  trace: '足跡',
};

/**
 * 「判断だけ」で残す種類。
 *
 * Claude の説明（say）を落とすと、自分が動かした所だけが縦に並ぶ。
 * 何十往復もしたセッションを思い出すときは、こちらのほうが速い。
 *
 * recap（Claude の中間報告）は入れない。自己申告であって自分の判断ではないため。
 */
const DECISION_KINDS = new Set([
  'prompt', 'answer', 'plan', 'denial', 'interrupt', 'slash', 'skill', 'agent', 'error', 'compact',
]);

/* ----------------------------------------------------------------- 待ち時間 */

/**
 * 待ちの種類ごとの言い方。
 *
 * どれも「〜までの間」で止める。「迷った時間」「悩んだ時間」とは書かない。
 * ログから分かるのは前のやり取りからの経過だけで、席を外していた時間と区別できない
 */
const WAIT_LABELS = {
  answer: '回答までの間',
  plan: '承認までの間',
  denial: '却下までの間',
  reply: '返信までの間',
  tool: 'ツールの往復',
};

/** 待ちに必ず添える注記。言い切らないための断り書き */
const WAIT_NOTE = '「…までの間」は前のやり取りからの経過時間です。席を外していた時間と区別できないため、迷っていた時間とは限りません。';

/**
 * 待ち時間の印を1つ作る。
 *
 * wait が null のときは何も返さない。圧縮や中断を跨いだ区間・時刻が取れなかった区間が
 * そこに当たる。0 と書くと「即答した」に読めるので、取れなかったものは出さない。
 *
 * @param {object|null} wait digest の item.wait（{kind, ms, away}）
 * @returns {HTMLElement|null}
 */
function waitBadge(wait) {
  if (!wait || typeof wait.ms !== 'number') return null;
  const node = el('span', 'tl-wait', `${WAIT_LABELS[wait.kind] ?? '間'} ${since(wait.ms)}`);
  node.title = WAIT_NOTE;
  // 4時間を超える間は、判断に使った時間として読ませない
  if (wait.away) {
    node.dataset.away = 'true';
    node.append(el('span', 'away', '席を外していた可能性'));
  }
  return node;
}

/**
 * 待ちの集計を1行にする。
 *
 * 測れたものが1つも無ければ null。fact() が null を素通りするので、
 * 「取れなかった項目は出さない」が自動で守られる。
 *
 * @param {object|null} bucket stats.waits の1つ（{count, totalMs, maxMs, away}）
 */
function waitFact(bucket) {
  if (!bucket) return null;
  const parts = [];
  if (bucket.count > 0) {
    parts.push(`${bucket.count} 回`);
    parts.push(`合計 ${since(bucket.totalMs)}`);
    parts.push(`最長 ${since(bucket.maxMs)}`);
  }
  // 4時間超は合計に混ぜていない。件数だけは出して「無かった」と読ませない
  if (bucket.away > 0) parts.push(`4時間超 ${bucket.away} 回は別枠`);
  return parts.length ? parts.join(' / ') : null;
}

/* --------------------------------------------------------------- 絞り込み */

/**
 * 検索語に当たった所を <mark> で囲んだ節点の並びを返す。
 *
 * innerHTML は使わない。当たった所は要素として作り、それ以外は createTextNode で入れる。
 * ログ本文にタグが書かれていても、ただの文字として出る。
 *
 * 正規表現も使わない。検索語は人が打つ文字列なので、記号のたびにエスケープが要る。
 *
 * @param {string|null} text
 * @param {string|null} needle 検索語。null なら素の文字として1つ返す
 * @returns {Array<Node>}
 */
function markUp(text, needle) {
  const t = String(text ?? '');
  if (!needle) return [document.createTextNode(t)];

  // 大小を無視して探す。ただし toLowerCase で長さが変わる文字（İ など）が混ざると
  // 元の文字列と位置がずれて、関係ない所を切り出す。
  // そのときだけ大小を区別する検索に落とす。ずれた強調を出すより外れるほうがまし
  const lower = t.toLowerCase();
  const nLower = needle.toLowerCase();
  const exact = lower.length !== t.length || nLower.length !== needle.length;
  const hay = exact ? t : lower;
  const pin = exact ? needle : nLower;

  const out = [];
  let from = 0;
  for (;;) {
    const hit = hay.indexOf(pin, from);
    if (hit < 0) break;
    if (hit > from) out.push(document.createTextNode(t.slice(from, hit)));
    out.push(el('mark', null, t.slice(hit, hit + pin.length)));
    from = hit + pin.length;
  }
  if (!out.length) return [document.createTextNode(t)];
  if (from < t.length) out.push(document.createTextNode(t.slice(from)));
  return out;
}

/**
 * 検索語の強調つきで節点を1つ作る。
 *
 * el() と同じ形で呼べるようにしてある。needle が null なら el() と同じものができる
 */
function marked(tag, className, text, needle) {
  const node = el(tag, className);
  node.append(...markUp(text, needle));
  return node;
}

/** 検索語が何回出てくるか。markUp と同じ数え方（大小は無視、重なりは数えない） */
function countHits(text, needle) {
  if (!needle) return 0;
  const hay = String(text ?? '').toLowerCase();
  const pin = needle.toLowerCase();
  if (!pin) return 0;
  let n = 0;
  let from = 0;
  for (;;) {
    const hit = hay.indexOf(pin, from);
    if (hit < 0) return n;
    n += 1;
    from = hit + pin.length;
  }
}

/**
 * この item を検索語と突き合わせる文字列。
 *
 * 対象は画面に出している文字だけにする。出していないものに当てると
 * 「一致したのに、その行を見ても語が無い」行が出てしまう
 */
function searchableOf(item) {
  const parts = [KIND_LABELS[item.kind] ?? item.kind];
  const push = (v) => { if (typeof v === 'string' && v) parts.push(v); };
  push(item.text);
  push(item.tool);
  push(item.detail);
  push(item.note);
  push(item.message);
  push(item.skill);
  push(item.args);
  push(item.command);
  push(item.agentType);
  push(item.description);
  push(item.denialLabel);
  push(item.plan);
  push(item.feedback);
  push(item.planFile);
  // 足跡は畳んだ中に文字がある。畳んでいても画面には出しているので検索の対象に入れる
  for (const t of item.tools ?? []) push(t);
  for (const c of item.calls ?? []) {
    push(c.tool);
    push(c.detail);
    push(c.head);
  }
  for (const a of item.answers ?? []) {
    push(a.question);
    push(a.chosen);
    push(a.header);
    for (const o of [...(a.chosenOptions ?? []), ...(a.otherOptions ?? [])]) {
      push(o.label);
      push(o.description);
    }
  }
  return parts.join('\n');
}

/**
 * searchableOf の結果を item ごとに覚える。
 *
 * item は詳細を取り直すまで同じ参照なので、1文字打つたびに組み直さなくて済む。
 * WeakMap なので詳細が入れ替われば古い分は勝手に消える
 */
const searchCache = new WeakMap();

/** 覚えてあれば使う。 */
function searchTextOf(item) {
  let s = searchCache.get(item);
  if (s === undefined) {
    s = searchableOf(item);
    searchCache.set(item, s);
  }
  return s;
}

/**
 * 時系列を絞り込む。
 *
 * 順序は「種類 → 検索語」。逆にすると見出しの件数が何を数えたものか読めなくなる
 * （検索で 12 件に絞ったあと種類で隠すと、12 は消えた行を含んだ数になる）。
 *
 * 「判断だけ」は種類の絞り込みとは独立させて AND する。
 * 種類の集合の preset にすると、既存の ?only=1 と localStorage の意味が変わってしまう
 */
function filterTimeline(items) {
  let out = items;
  if (store.hiddenKinds.size) out = out.filter((i) => !store.hiddenKinds.has(i.kind));
  if (store.onlyDecisions) out = out.filter((i) => DECISION_KINDS.has(i.kind));
  if (store.tq) {
    const pin = store.tq.toLowerCase();
    out = out.filter((i) => searchTextOf(i).toLowerCase().includes(pin));
  }
  return out;
}

/**
 * 種類ごとの件数。チップの並びを作るのに使う。
 *
 * 並びは KIND_LABELS の順に固定する。多い順にすると、セッションを切り替えるたびに
 * チップの位置が入れ替わって押し間違える。知らない種類は後ろに足す（黙って消さない）
 */
function countKinds(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const ordered = new Map();
  for (const kind of Object.keys(KIND_LABELS)) {
    if (counts.has(kind)) ordered.set(kind, counts.get(kind));
  }
  for (const [kind, n] of counts) {
    if (!ordered.has(kind)) ordered.set(kind, n);
  }
  return ordered;
}

/* --------------------------------------------------------------- 1行を組む */

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
function bodyText(text, limit, maxLines, fullLength = null, needle = null) {
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
  more.append(marked('pre', null, t, needle));
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
function answerBlock(a, compact, needle = null) {
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
 * @param {object} item digest の plan 1件
 * @param {boolean} compact 全文を畳むだけにするか
 * @param {string|null} [needle] 検索語
 */
function planBlock(item, compact, needle = null) {
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
  if (item.plan && !compact) {
    const d = el('details', 'more');
    const hits = countHits(item.plan, needle);
    d.append(el('summary', null, hits ? `プラン全文　一致 ${num(hits)} 件` : 'プラン全文'));
    if (hits) d.open = true;
    d.append(marked('pre', null, item.plan, needle));
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
function rawBlock(makeUrl, uuid) {
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
function rawUrlFor(sessionId) {
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
function whenNode(at) {
  const node = el('div', 'tl-when');
  // 時刻が無い行でも列は残す。ノードごと省くと本文が左の列にずれ込む
  if (!at) return node;
  const d = new Date(at);
  node.append(el('span', 'tl-date', ymd(d)), el('span', 'tl-time', hms(d)));
  return node;
}

/**
 * 時系列の1行。
 *
 * @param {object} item digest の item
 * @param {object} [ctx] 描くときの文脈。{needle} 検索語 / {rawUrl} 原文の取得先を作る関数
 */
function timelineItem(item, ctx = {}) {
  const needle = ctx.needle ?? null;
  const row = el('div', 'tl');
  row.dataset.kind = item.kind;

  if (item.kind === 'compact') {
    const body = el('div', 'tl-body');
    const from = num(item.preTokens);
    const to = num(item.postTokens);
    const trigger = item.trigger === 'auto' ? '自動' : item.trigger ?? '';
    body.append(el('div', 'tl-text',
      `ここで文脈が圧縮されました（${from} → ${to} tokens${trigger ? ` / ${trigger}` : ''}）。これより前の細部は Claude 側にも残っていません`));
    const compactRaw = rawBlock(ctx.rawUrl, item.uuid);
    if (compactRaw) body.append(compactRaw);
    row.append(body);
    return row;
  }

  row.append(whenNode(item.at));
  const body = el('div', 'tl-body');
  const kindRow = el('div', 'tl-kind');
  kindRow.append(...markUp(KIND_LABELS[item.kind] ?? item.kind, needle));
  // 前のやり取りからの間。取れていない行には何も付かない
  const wait = waitBadge(item.wait);
  if (wait) kindRow.append(wait);
  body.append(kindRow);

  switch (item.kind) {
    // 自分の指示は判断の記録そのものなので、Claude の説明より長く出す
    case 'prompt':
      body.append(...bodyText(item.text, 900, 12, null, needle));
      break;
    case 'say':
      body.append(...bodyText(item.text, 260, 4, item.fullLength, needle));
      break;
    // Claude の自己申告。時系列でもその場で断ってから本文を出す
    case 'recap':
      body.append(el('p', 'note', 'Claude 自身が書いた中間報告です。機械的に抜き出した記録ではありません'));
      body.append(...bodyText(item.text, 600, 8, item.fullLength, needle));
      break;
    // 間引きで落ちた区間の目印。何が落ちたかまで出す（足跡だけの区間かどうかが読めるように）
    case 'elided': {
      const kinds = Object.entries(item.byKind ?? {})
        .map(([k, n]) => `${KIND_LABELS[k] ?? k} ${n}`)
        .join(' / ');
      const range = item.fromAt && item.toAt
        ? `（${hms(new Date(item.fromAt))} 〜 ${hms(new Date(item.toAt))}）`
        : '';
      body.append(el('div', 'tl-text',
        `${item.count} 件を省略しました${kinds ? `　${kinds}` : ''}${range}`));
      break;
    }
    // 選んだ理由（選択肢の説明文）は判断の記録そのものなので、時系列でも省かない
    case 'answer':
      for (const a of item.answers ?? []) body.append(answerBlock(a, false, needle));
      break;
    case 'plan':
      body.append(...planBlock(item, false, needle).childNodes);
      break;
    case 'denial':
      body.append(marked('div', 'tl-text', `${item.denialLabel} — ${item.tool}`, needle));
      if (item.detail) body.append(marked('pre', 'tl-detail', item.detail, needle));
      // note は定型文を除いた残り。自分が添えたコメントがあればここに出る
      if (item.note) body.append(marked('pre', 'tl-detail', item.note, needle));
      break;
    case 'interrupt':
      body.append(el('div', 'tl-text', 'ここで実行を止めた'));
      break;
    case 'skill':
      body.append(marked('div', 'tl-text', item.args ? `/${item.skill} ${item.args}` : `/${item.skill}`, needle));
      break;
    case 'agent':
      body.append(marked('div', 'tl-text',
        [item.agentType, item.description].filter(Boolean).join(' — ') || '(説明なし)', needle));
      break;
    case 'error':
      body.append(marked('div', 'tl-text', `${item.tool}${item.detail ? ` — ${item.detail}` : ''}`, needle));
      if (item.message) body.append(marked('pre', 'tl-detail', item.message, needle));
      break;
    case 'slash':
      body.append(marked('div', 'tl-text', item.args ? `${item.command} ${item.args}` : item.command, needle));
      break;
    // 足跡。assistant の1行につき1件で、並列に呼んだ分は calls にまとまっている。
    // 既定では畳んでおく。1件ずつ広げると、ここだけで画面が埋まって判断の記録が流れる
    case 'trace': {
      const tools = item.tools?.length ? item.tools.join(' / ') : 'ツール';
      const label = [
        `${tools}${item.count > 1 ? ` ×${item.count}` : ''}`,
        typeof item.durationMs === 'number' ? dur(item.durationMs) : null,
      ].filter(Boolean).join('　');
      const d = el('details', 'more trace');
      // 畳んだ中に検索語があるときは開いて出す。閉じたままだと語が見つからない
      const inner = (item.calls ?? [])
        .map((c) => [c.tool, c.detail, c.head].filter(Boolean).join(' '))
        .join('\n');
      const hits = countHits(inner, needle);
      d.append(marked('summary', null, hits ? `${label}　一致 ${num(hits)} 件` : label, needle));
      if (hits) d.open = true;

      const ul = el('ul', 'trace-calls');
      for (const c of item.calls ?? []) {
        const li = el('li');
        const line = el('div', 'trace-head');
        line.append(marked('span', 'mono', c.tool ?? '?', needle));
        if (c.detail) line.append(marked('span', 'trace-detail', c.detail, needle));
        if (c.pending) {
          // 結果が来ていない。いま止まっているのがここだと分かる
          line.append(el('span', 'trace-n', '結果を待っています'));
        } else {
          if (typeof c.durationMs === 'number') line.append(el('span', 'trace-n', dur(c.durationMs)));
          // 0 字と「測れなかった」を分ける。null のときは何も出さない
          if (typeof c.resultChars === 'number') line.append(el('span', 'trace-n', `${num(c.resultChars)} 字`));
        }
        li.append(line);
        // 結果の先頭だけ。中身が要るときは原文へ戻る
        if (c.head) li.append(marked('div', 'trace-result', c.head, needle));
        ul.append(li);
      }
      d.append(ul);
      body.append(d);
      break;
    }
    default:
      body.append(el('div', 'tl-text', JSON.stringify(item)));
  }

  // 原文へ戻る口。同じ assistant 行から複数の item が出るので、これは「この行を開く」意味になる
  const raw = rawBlock(ctx.rawUrl, item.uuid);
  if (raw) body.append(raw);

  row.append(body);
  return row;
}

/* ------------------------------------------------------------- 描き直し */

/**
 * 1回に出す時系列の件数。
 *
 * 400件を前もって全部組むと初回の描画が重い。窓を掛けて、末尾のボタンで継ぎ足す。
 * 120 はふつうの画面でスクロール数回ぶんに収まる量
 */
const TL_PAGE = 120;

/**
 * 窓の外にしか無い種類を数える。
 *
 * 「チップを押したのに何も変わらない」に見えるのを防ぐためのもの。
 * 足跡は間引きで新しい 200 件だけが残る（MAX_TRACES）ので、古い順で見ていると
 * 窓の中に1件も入らないことがある。実測した例では 383 件のうち最初の足跡が 151 件目で、
 * 先頭 120 件には0件だった。この状態で足跡を出すと、見出しの件数と「続きを出す」の
 * 残り数だけが動いて、出ている行は1行も変わらない。
 *
 * 窓の中に1件でもある種類は入れない。そちらは押せば目で見て変わるので、言う必要がない。
 *
 * @param {Array} ordered 絞り込みと並び替えを終えた全件
 * @param {number} from ここから先が窓の外
 * @returns {Map<string, number>} 種類 → 窓の外にある件数
 */
function kindsBeyond(ordered, from) {
  const inside = new Set();
  for (let i = 0; i < from; i += 1) inside.add(ordered[i].kind);

  const out = new Map();
  for (let i = from; i < ordered.length; i += 1) {
    const kind = ordered[i].kind;
    if (inside.has(kind)) continue;
    out.set(kind, (out.get(kind) ?? 0) + 1);
  }
  return out;
}

/**
 * 時系列だけを描き直すための取っ手。
 *
 * renderDetail() が時系列パネルを組むたびに attach() で入れ替える。
 * null のあいだは時系列が画面に無い（未選択・取得中・失敗）ので、render() は何もしない。
 *
 * items をここに写して持つのは、開いている時系列と描く材料を食い違わせないため。
 * render() から store.detail を見に行くと、押した瞬間に別の詳細が入っていることがある。
 *
 * app.js から直に触らせないのが分割の要点。触れるのは attach / detach / setNav の3つだけ
 */
let tlRef = null;

/**
 * 検索欄の待ち時間。
 *
 * 1文字ごとに組み直すと、400件の時系列では打っている手が引っかかる。
 * 種類のチップは意図した1回の操作なので、こちらは待たずに即座に反映する
 */
const TL_DEBOUNCE_MS = 120;

let tlSearchTimer = null;

/**
 * 時系列パネルの取っ手を差し替える。
 *
 * @param {object} ref
 * @param {HTMLElement} ref.host 時系列の器（この中だけを replaceChildren する）
 * @param {HTMLElement|null} ref.count 見出しの件数を入れる節点
 * @param {Array} ref.items 間引き後の全 item
 * @param {number} ref.dropped 間引きで落ちた件数
 */
function attach(ref) {
  tlRef = {
    host: ref.host,
    count: ref.count ?? null,
    nav: null,
    items: ref.items ?? [],
    dropped: ref.dropped ?? 0,
  };
}

/**
 * 取っ手を捨てる。
 *
 * 詳細ペインを作り直す前に呼ぶ。作り直したあとの画面に無い節点を掴んだままにしない
 */
function detach() {
  tlRef = null;
}

/**
 * 目次の件数の差し替え先を教える。
 *
 * パネルが3枚に届かないと目次自体が出ないので、null が来ることもある
 * @param {HTMLElement|null} node
 */
function setNav(node) {
  if (tlRef) tlRef.nav = node ?? null;
}

/**
 * 時系列の絞り込み帯を組む。
 *
 * 呼ぶのは renderDetail() だけ。返した節点は .tl-host の外（.timeline の兄弟）に置く。
 * 器の中に入れると render() の replaceChildren で入力欄まで作り直され、
 * 1文字打つたびに caret が消えて打ち続けられなくなる
 *
 * @param {Array} all 間引き後の全 item。チップの並びと件数はここから作る
 */
function filterBar(all) {
  const bar = el('div', 'tl-filter');

  const q = el('input', 'tl-q');
  q.type = 'search';
  q.placeholder = '時系列の中を探す';
  q.setAttribute('aria-label', '時系列を検索');
  // 値の復元は value に入れるだけ。?tq= で開いた人にも打った途中の人にも同じ形で効く
  if (store.tq) q.value = store.tq;
  q.addEventListener('input', () => {
    clearTimeout(tlSearchTimer);
    tlSearchTimer = setTimeout(() => {
      store.tq = q.value.trim() || null;
      // 探した状態を人に渡せるようにする（?tq=）
      syncQuery();
      // 当てはまる件数が変わるので窓は先頭から出し直す
      render({ reset: true });
    }, TL_DEBOUNCE_MS);
  });
  bar.append(q);

  const kinds = el('div', 'tl-kinds');
  for (const [kind, n] of countKinds(all)) {
    const chip = el('button', 'tl-chip', KIND_LABELS[kind] ?? kind);
    chip.type = 'button';
    chip.append(el('span', 'n', num(n)));
    // 押した状態は「出している」を true とする。隠す種類を持つのは store 側の拒否リスト
    const paint = () => {
      const shown = !store.hiddenKinds.has(kind);
      chip.setAttribute('aria-pressed', String(shown));
      chip.title = shown ? 'この種類を隠す' : 'この種類を出す';
    };
    paint();
    chip.addEventListener('click', () => {
      if (store.hiddenKinds.has(kind)) store.hiddenKinds.delete(kind);
      else store.hiddenKinds.add(kind);
      paint();
      // 残すのは URL（?hide=）だけ。localStorage に覚えさせない理由は initialHiddenKinds に書いた
      syncQuery();
      render({ reset: true });
    });
    kinds.append(chip);
  }
  bar.append(kinds);

  return bar;
}

/**
 * 時系列だけを描き直す。
 *
 * 絞り込みや並び替えで変わるのは時系列の中身と件数だけ。それなのに renderDetail() を
 * 呼ぶと、回答パネル・TODO・ファイル・状態の一覧まで作り直すことになる。
 * 開いた <details> とスクロール位置が消え、絞り込みの入力欄では caret が飛ぶ
 *
 * @param {object} [opts]
 * @param {boolean} [opts.reset] 窓を先頭に戻すか。
 *   当てはまる件数が変わる操作（検索・種類・判断だけ・並び順）では true にする。
 *   「続きを出す」からは false のまま呼ぶ（そこで戻すと押した意味が消える）
 */
function render({ reset = false } = {}) {
  if (!tlRef) return;
  const t0 = performance.now();

  // 窓を先頭に戻すのは、頼まれたときとセッションを選び直したときだけ。
  // 追記で詳細が入れ替わるたびに戻すと、動いているセッションでは2秒ごとに巻き戻る
  if (reset || store.tlShownFor !== store.selected) {
    store.tlShown = TL_PAGE;
    store.tlShownFor = store.selected;
  }

  const all = tlRef.items;
  const matched = filterTimeline(all);
  const ordered = store.newestFirst ? [...matched].reverse() : matched;
  const shown = ordered.slice(0, Math.max(TL_PAGE, store.tlShown));
  const rest = ordered.length - shown.length;

  const box = el('div', 'timeline');
  // 検索語は1回だけ渡す。timelineItem が store を見に行くと、
  // 描いている途中で語が変わったときに強調と絞り込みが食い違う。
  // 原文の取得先も同じ理由でここで固める（描いている最中に選択が変わっても混ざらない）
  const ctx = { needle: store.tq, rawUrl: rawUrlFor(store.selected) };
  for (const item of shown) box.append(timelineItem(item, ctx));

  const nodes = [box];
  if (!ordered.length) {
    // 「1件も無い」と「絞り込みで消えた」を分ける。後者は戻し方も添える
    nodes.push(el('div', 'empty-note', all.length
      ? '絞り込みに当てはまる行がありません。検索語を消すか、隠している種類を出してください'
      : '時系列に出せる行がありません'));
  }
  if (rest > 0) {
    // 窓の外にしか無い種類は名前で伝える。多いときは上位3つに絞る（並びが長いと読まれない）
    const beyond = [...kindsBeyond(ordered, shown.length)].sort((a, b) => b[1] - a[1]);
    if (beyond.length) {
      const head = beyond.slice(0, 3).map(([k, n]) => `${KIND_LABELS[k] ?? k} ${num(n)} 件`).join('　');
      const restKinds = beyond.length > 3 ? `　ほか ${num(beyond.length - 3)} 種類` : '';
      nodes.push(el('div', 'empty-note', `いま出している範囲より先に、${head}${restKinds}があります`));
    }

    const more = el('button', 'btn tl-more', `続きを出す（残り ${num(rest)} 件）`);
    more.type = 'button';
    more.addEventListener('click', () => {
      store.tlShown = shown.length + TL_PAGE;
      render();
    });
    nodes.push(more);
  }
  tlRef.host.replaceChildren(...nodes);

  // 見出しの件数。窓で切っているときは「出している数 / 当てはまった数」を出す。
  // 全体の数だけを出すと、下に「続きを出す」がある理由が読めない
  const label = shown.length < ordered.length
    ? `${num(shown.length)} / ${num(ordered.length)} 件`
    : store.onlyDecisions
      ? `${num(matched.length)} / ${num(all.length)} 件`
      : `${num(all.length)} 件${tlRef.dropped ? `（説明 ${num(tlRef.dropped)} 件は省略）` : ''}`;
  if (tlRef.count) tlRef.count.textContent = label;
  // 目次の件数も絞り込みで動く。放っておくと古い数が上に残る
  if (tlRef.nav) tlRef.nav.textContent = num(matched.length);

  mark('timeline', t0);
}

/**
 * app.js に見せる口。
 *
 * ここに無いものは app.js から呼ばない。逆に、ここに足すときは
 * 「時系列の仕事か」を一度考える。詳細ペイン全体の話なら app.js 側に置く。
 *
 * answerBlock / planBlock / bodyText / waitFact を外に出しているのは、
 * 時系列の外（「あなたの番」と「あなたが決めたこと」のパネル）でも同じ見せ方をするため。
 * 同じものを2通りに描くと、同じ判断が場所によって違って見える
 */
const Timeline = {
  initialHiddenKinds,
  hideQueryValue,
  attach,
  detach,
  setNav,
  filterBar,
  render,
  answerBlock,
  planBlock,
  bodyText,
  waitFact,
  WAIT_LABELS,
  WAIT_NOTE,
};
