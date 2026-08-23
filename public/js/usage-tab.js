/* 3つ目のモード「数値」。セッションを跨いだ集計。
 *
 * 層7。出し分けを持っているのは `board.js` の `setMode` で、**あちらから呼ばれる**
 * （`main.js` が `initBoard({ onUsage: showUsage })` で差す）。
 * **ここから `board.js` を import しない。** 向きが両方に付くと、その場では動くのに
 * 順番を変えた瞬間に立ち上がらなくなる。
 *
 * ログを全文読む一番重い窓口（実測で60本 1秒台）を叩くので、**開いたときに1回だけ引く。**
 * SSE の毎秒の押し出しには載せない。
 *
 * 詳細ペインの数値パネル（`usage-panel.js`）とは別物。
 * あちらは開いている1本、こちらは横断。絵の部品（層1の `usage-chart.js`）だけを共有する。
 */
import { el, shortModel } from './util.js';
import { dom, store } from './store.js';
import { setListOpen } from './drawer.js';
import { select } from './session.js';
import {
  block, hitRateNote, statTile, barList, trendList, tableDetails, deltaText,
  tokensStrict, pctStrict, numStrict,
} from './usage-chart.js';

/**
 * カードを押されたあとに作業台へ移す口。`initUsageTab` で外から差す。
 *
 * 数値モードは全幅で、中央の詳細ペインが消えている（`usage.css`）。押した1本を
 * 見せるには作業台へ戻すしかないが、その判断（`setMode`）を持っているのは
 * `board.js` の側で、**こちらから import すると向きが両方に付く。**
 * `runs.js` の `subscribeRuns(fn)` と同じ切り方で、配線だけ外に出す。
 *
 * @type {(() => void)|null}
 */
let onPick = null;

/** 横棒に出すツールの数。残りは下の表で読む。 */
const BARS_MAX = 8;

/**
 * スキルを順位付けする最低の呼び出し回数。
 *
 * **実測で全ログのスキルは12種82件、うち6種が n=1。**
 * 1回しか呼んでいないものを並べると、たまたま重い作業だった1回が
 * そのまま「このスキルは重い」と読まれる。母数の小さいものは順位から外し、
 * 下の表に「参考」として回す。
 */
const RANK_MIN_RUNS = 3;

/** 順位付けするスキルの数。 */
const SKILL_RANK_MAX = 5;

/** カードで出すセッションの数。残りは表で読む。 */
const ROWS_MAX = 12;

/** 打ち終わる前の応答を捨てるための札。`archive.js` と同じ作法 */
let usageToken = 0;

/**
 * 表の1列目に入れるセッションの名前。
 *
 * 表は `white-space: nowrap` なので、長い見出しをそのまま入れると
 * 横スクロールがどこまでも伸びる。頭だけ見せて、続きは card 側で読ませる。
 *
 * @param {object} row
 * @returns {string}
 */
function rowName(row) {
  const title = row.title ? row.title.replace(/\s+/g, ' ').trim() : null;
  const head = title ? (title.length > 28 ? `${title.slice(0, 28)}…` : title) : '（指示なし）';
  return row.project ? `${row.project} / ${head}` : head;
}

/**
 * キャッシュ命中率に添える但し書き。
 *
 * 層1の `hitRateNote()` に、この画面にしかない一言を足す。
 * 横断では**絞り込みという逃げ道がある**ので、「出ません」で終わらせない。
 *
 * @param {object} d `/api/usage` の応答
 * @returns {string}
 */
function crossHitRateNote(d) {
  const base = hitRateNote(d);
  if (d.cache.hitRate === null && (d.models?.length ?? 0) > 1) {
    return `${base}。上でモデルを1つ選ぶと出ます`;
  }
  return base;
}

/**
 * どこまで読んだか。合計が思ったより小さいときの説明になる。
 *
 * @param {object} d
 * @returns {string|null}
 */
function scanNote(d) {
  const m = d.meta ?? {};
  const parts = [];
  // **scanMax を出さない。** あれは上で選べる本数の上限（60）であって、
  // 実際に開いた数ではない。既定の 30 本で引いているのに「60 本まで読みました」と
  // 出ることになる（実測でそうなっていた）。読んだ数は必ず scanned から取る
  if (m.scanLimited) parts.push(`新しい ${numStrict(m.scanned)} 本まで読みました`);
  else if (typeof m.scanned === 'number') parts.push(`${numStrict(m.scanned)} 本を読みました`);
  // 開いたが要求が1件も無かったもの（/clear の残骸など）。黙って落とすと数が合わない
  if (m.empty > 0) parts.push(`うち ${numStrict(m.empty)} 本は要求なし`);
  return parts.length ? parts.join(' / ') : null;
}

/**
 * 上に並べる4枚の札。
 *
 * @param {object} d
 * @returns {HTMLElement}
 */
function tiles(d) {
  const box = el('div', 'stats');
  box.append(statTile('実消費', tokensStrict(d.totals.ite), `${numStrict(d.requests)} 回の要求`));
  // 本数で割ると「長く話したセッションが多い月」というだけで動く。
  // 要求あたりなら、セッションの長さの違いを気にせず並べられる
  box.append(statTile(
    '1要求あたり',
    tokensStrict(d.requests > 0 ? d.totals.ite / d.requests : null),
    '長さの違いを均した値。作業の中身でも動きます',
  ));
  box.append(statTile('セッション', `${numStrict(d.sessions)} 本`, scanNote(d)));
  box.append(statTile('キャッシュ命中率', pctStrict(d.cache.hitRate), crossHitRateNote(d)));
  return box;
}

/**
 * 主役。何が文脈を食っているか。
 *
 * 注記は**折りたたまずに常時出す。** ここに出ているのは
 * 「その要求とその次の要求のあいだに、文脈がどれだけ伸びたか」であって、
 * ツールが返した文字数そのものではない。
 *
 * @param {object} d
 * @returns {HTMLElement|null}
 */
function toolsBlock(d) {
  if (!d.tools.length) return null;

  const box = block('何が文脈を食っているか');
  box.append(el('p', 'note',
    'そのツールの結果が、どれだけ文脈に積まれたかです。集めたセッションぶんを足しています。'));

  box.append(barList(d.tools.slice(0, BARS_MAX).map((t) => ({
    label: t.tool,
    value: t.tokens,
    sub: `${numStrict(t.calls)} 回`,
  }))));

  box.append(tableDetails(
    `全 ${d.tools.length} 件を表で見る`,
    ['ツール', '回数', '合計', '平均', '最大1回'],
    d.tools.map((t) => [
      t.tool, numStrict(t.calls), numStrict(t.tokens), numStrict(t.avg), numStrict(t.max),
    ]),
  ));
  return box;
}

/**
 * スキルを呼ぶたびの推移を積む。
 *
 * 平均だけでは向きが読めない。実データでは平均 213k のスキルが
 * 214k → 101k → 619k → 118k → 13k と桁で動いていた。
 * 「前回より軽くなったか」はこの並びを見ないと分からない。
 *
 * **但し書きは上の節のものがそのまま効く。** 測っているのは呼んだ直後の一続きなので、
 * 下がったのは楽な仕事だっただけかもしれない。だから**増減で色を変えない**
 * （中央値との差を色分けしないのは詳細ペイン側と同じ扱い）。
 *
 * @param {HTMLElement} box 積む先
 * @param {object[]} skills
 * @param {number} [undated] 時刻が読めず、並べられなかった区間の数
 */
function appendTrends(box, skills, undated) {
  // 絵は2点から描ける。差の文字が付くのは `trend`（比べる相手が3件）のあるものだけ。
  // **絵と差で条件を分ける。** 揃えると、3回呼んだスキルの並びが丸ごと見えなくなる
  const rows = skills.filter((s) => (s.series?.length ?? 0) >= 2);

  const list = trendList(rows.map((s) => ({
    label: s.skill,
    values: s.series.map((p) => p.ite),
    value: tokensStrict(s.series[s.series.length - 1].ite),
    sub: (s.trend ? deltaText(s.trend.last, s.trend.prevMedian) : null) ?? '',
    alt: `${s.skill} を呼ぶたびの実消費の移り変わり`,
  })));
  if (list) {
    // 上の棒とは別の話（量 と 向き）なので `note-part` で破線を引いて区切る
    box.append(el('p', 'note note-part', '呼ぶたびの実消費です。左が古く、右がいちばん新しい回。'));
    box.append(list);
    // しきい値の数字は書かない。決めているのはサーバー側なので、
    // ここに写すと片方だけ古くなる（`percentile` を2箇所に書かないのと同じ理屈）
    box.append(el('p', 'spark-caption',
      '右端の割合は、最新の1回と、それより前の中央値との差です。'
      + '比べる相手が足りないものは差を出しません。'));
  }

  // 絵から落ちたぶんと、並べようがなかったぶん。**どちらも黙って捨てない**
  const omitted = rows.reduce((n, s) => n + (s.seriesOmitted ?? 0), 0);
  if (omitted > 0) {
    box.append(el('p', 'note note-sub',
      `古い ${omitted} 回は絵から外しました（新しいほうだけ描いています）。`));
  }
  if (undated > 0) {
    box.append(el('p', 'note note-sub',
      `時刻が読めなかった ${undated} 回は推移に並べていません（回数と合計には入っています）。`));
  }
}

/**
 * スキルを呼んだあと。
 *
 * **注記は折りたたまずに常時出す。ここを消すなら、この節ごと消すこと。**
 * 測っているのは「Skill を呼んだ次の要求から、次にあなたの番が来るまで」で、
 * その消費がスキルのせいなのか、たまたま重い作業だったのかは分けられない。
 *
 * 横断だと標本が増えるぶん、順位が「事実」に見えやすくなる。
 * だから1本ぶんより強く、母数の小さいものを順位から外す。
 *
 * @param {object} d
 * @returns {HTMLElement|null}
 */
function skillsBlock(d) {
  const skills = d.skills ?? [];
  if (!skills.length) return null;

  const box = block('スキルを呼んだあと');
  box.append(el('p', 'note',
    '「スキルを呼び出した直後の一続き」を測っています。スキルが原因とは限りません。'));

  // 順位は1回あたりで付ける。合計だと「よく呼ぶスキル」が上に来るだけになる
  const ranked = skills
    .filter((s) => s.runs >= RANK_MIN_RUNS)
    .sort((a, b) => b.avg - a.avg)
    .slice(0, SKILL_RANK_MAX);
  const few = skills.length - skills.filter((s) => s.runs >= RANK_MIN_RUNS).length;

  if (ranked.length) {
    box.append(barList(ranked.map((s) => ({
      label: s.skill,
      value: s.avg,
      sub: `${numStrict(s.runs)} 回`,
    }))));
    box.append(el('p', 'note note-sub', '1回あたりの実消費で並べています。'));
  } else {
    box.append(el('p', 'note note-sub',
      `どれも ${RANK_MIN_RUNS} 回に届いていないので、順位は付けません。`));
  }
  if (few > 0) {
    box.append(el('p', 'note note-sub',
      `呼んだ回数が ${RANK_MIN_RUNS} 回に満たない ${few} 件は順位から外しました（表に「参考」として出ます）。`));
  }

  appendTrends(box, skills, d.skillsUndated);

  box.append(tableDetails(
    `全 ${skills.length} 件を表で見る`,
    ['スキル', '呼んだ回数', '使ったセッション', '実消費', '1回あたり'],
    skills.map((s) => [
      s.runs >= RANK_MIN_RUNS ? s.skill : `${s.skill}（参考）`,
      numStrict(s.runs), numStrict(s.sessions), numStrict(s.ite), numStrict(s.avg),
    ]),
  ));
  return box;
}

/**
 * セッション1本のカード。押すと右に詳細が出る。
 *
 * **`aria-current` は付けない。** `select()` は `dom.list` と `dom.archive` の
 * `.card` にしか印を付け直さないので、ここに付けると古い印が残り続ける。
 *
 * @param {object} row
 * @returns {HTMLElement}
 */
function usageCard(row) {
  const li = el('li');
  const card = el('button', 'card is-usage');
  card.type = 'button';
  card.dataset.sessionId = row.sessionId ?? '';

  const top = el('div', 'card-top');
  top.append(el('span', 'usage-ite', tokensStrict(row.ite)));
  top.append(el('span', 'when', `${numStrict(row.requests)} 回`));
  card.append(top);

  const label = row.title ?? '（指示なしで終わっています）';
  const title = el('div', 'card-title', label);
  if (!row.title) title.classList.add('is-empty');
  card.append(title);

  const meta = el('div', 'card-meta');
  if (row.project) meta.append(el('span', 'path', row.project));
  const model = shortModel(row.model);
  if (model) meta.append(el('span', 'tag', model));
  // 混ざっている行は命中率が読めない。表の列をそのまま信じさせない
  if (row.mixed) meta.append(el('span', 'tag', 'モデル混在'));
  if (meta.childElementCount > 0) card.append(meta);

  card.addEventListener('click', () => {
    // **作業台へ移すのを先にやる。** 詳細ペインは数値モードのあいだ display で消えていて、
    // このあとの setListOpen が焦点をそこへ移す。出す前に呼ぶと焦点が行き場を失う
    onPick?.();
    // 'live' にしない。60本には24時間より古いものが混ざるので、`apply()` の
    // 「一覧から消えたら選択を外す」（`selectedFrom === 'live'` のときだけ働く）に
    // 引っかかって、押した直後に先頭へ飛ぶ
    select(row.sessionId, 'usage');
    setListOpen(false, dom.detail);
  });
  li.append(card);
  return li;
}

/**
 * セッション別。
 *
 * @param {object} d
 * @returns {HTMLElement|null}
 */
function rowsBlock(d) {
  if (!d.rows.length) return null;

  const box = block('セッション別');
  box.append(el('p', 'note', '実消費の多い順です。押すと右に中身が出ます。'));

  const list = el('ul', 'usage-rows');
  for (const row of d.rows.slice(0, ROWS_MAX)) list.append(usageCard(row));
  box.append(list);

  box.append(tableDetails(
    `全 ${d.rows.length} 件を表で見る`,
    ['セッション', '要求', '実消費', '文脈（最後）', '命中率'],
    d.rows.map((r) => [
      rowName(r), numStrict(r.requests), numStrict(r.ite),
      numStrict(r.contextLast), pctStrict(r.hitRate),
    ]),
  ));
  return box;
}

/** ヘッダに出す件数。どこまで読んだかも一緒に出す */
function renderUsageCount() {
  const u = store.usageTab;
  if (!u.loaded || !u.data) {
    dom.usageCount.textContent = '';
    return;
  }
  const m = u.data.meta ?? {};
  const parts = [`${u.data.sessions.toLocaleString('ja-JP')} 本`];
  if (typeof m.indexed === 'number') parts.push(`ログ ${m.indexed.toLocaleString('ja-JP')} 本`);
  // 書庫（archive.js）は scanMax をそのまま出しているが、あちらは上限＝実際に読む数。
  // こちらは上で本数を選べるので、上限と読んだ数が食い違う
  if (m.scanLimited) parts.push(`中身は新しい ${numStrict(m.scanned)} 本まで`);
  dom.usageCount.textContent = parts.join(' / ');
}

/**
 * モデルの絞り込みの選択肢を組み直す。
 *
 * **選択肢は絞り込んでいない応答からだけ拾う**（`store.usageTab.modelOptions`）。
 * `model=` を付けて引くと応答の models が1種しか返らないので、
 * そこから作り直すと「すべて」に戻す以外の道が消える。
 */
function renderModelOptions() {
  const u = store.usageTab;
  const names = u.modelOptions.map((m) => m.model);
  // 期間を変えた結果、選んでいたモデルが選択肢から消えることがある。
  // そのときも選択そのものは生きているので、自分で足して表示を合わせる
  if (u.model && !names.includes(u.model)) names.push(u.model);

  const sel = dom.usageModel;
  const keep = sel.firstElementChild; // 「すべてのモデル」。ここだけは常に残す
  sel.replaceChildren(keep);
  for (const name of names) {
    const opt = el('option', null, shortModel(name) ?? name);
    opt.value = name;
    sel.append(opt);
  }
  sel.value = u.model ?? '';
}

/** 数値モードの中身を描き直す */
function renderUsage() {
  const u = store.usageTab;
  dom.usage.replaceChildren();
  renderUsageCount();
  renderModelOptions();
  // 引き直しているあいだも前の内容を出したままにする（薄くするのは CSS 側）。
  // 下の早い return より前で外す。失敗して差し替わったのに薄いまま、を防ぐ
  dom.usage.classList.toggle('is-stale', u.loading && u.loaded);

  // 空表示を4つに割る。ひとまとめにすると「まだ引いていない」と「0件だった」が同じ顔になる
  if (u.unavailable) {
    dom.usage.append(el('div', 'empty', '数値はまだ使えません（サーバ側が対応していません）'));
    return;
  }
  if (u.error) {
    const box = el('div', 'empty', `数値を読めませんでした: ${u.error}`);
    const retry = el('button', 'btn', 'もう一度試す');
    retry.type = 'button';
    retry.addEventListener('click', () => loadUsage());
    const action = el('div', 'empty-note');
    action.append(retry);
    box.append(action);
    dom.usage.append(box);
    return;
  }
  if (!u.loaded) {
    // 引いている途中だけ出す。60本ぶんログを開くので、無言の間が1秒以上ある
    if (u.loading) dom.usage.append(el('div', 'empty', 'ログを読んで集計しています…'));
    return;
  }

  const d = u.data;
  if (!d || d.sessions === 0) {
    const box = el('div', 'empty', d?.filterModel
      ? `${shortModel(d.filterModel)} を主に使ったセッションがありません`
      : '集計できるセッションがありません');
    const note = scanNote(d ?? {});
    if (note) box.append(el('div', 'empty-note', note));
    dom.usage.append(box);
    return;
  }

  dom.usage.append(tiles(d));
  const tools = toolsBlock(d);
  if (tools) dom.usage.append(tools);
  // 「何が食っているか」の系統なので、ツールの隣に置く
  const skills = skillsBlock(d);
  if (skills) dom.usage.append(skills);
  const rows = rowsBlock(d);
  if (rows) dom.usage.append(rows);
}

/**
 * 数値を引く。
 *
 * 引き直しのあいだも前の内容を消さない（`loaded` を落とさない）。
 * 60本ぶんログを開くので、消してしまうと絞り込みを変えるたびに画面が空白になる。
 */
async function loadUsage() {
  const u = store.usageTab;
  if (u.unavailable) return;

  const token = ++usageToken;
  u.loading = true;
  u.error = null;
  renderUsage();

  const params = new URLSearchParams();
  params.set('limit', String(u.limit));
  if (u.days) params.set('days', String(u.days));
  if (u.model) params.set('model', u.model);

  try {
    const res = await fetch(`/api/usage?${params.toString()}`, { cache: 'no-store' });
    // サーバ側と歩調を合わせずに画面側だけ先に入れられるようにする
    if (res.status === 404) {
      if (token === usageToken) {
        u.unavailable = true;
        u.loading = false;
        renderUsage();
      }
      return;
    }
    if (!res.ok) {
      const reason = await res.json().then((j) => j?.error).catch(() => null);
      throw new Error(reason ?? `HTTP ${res.status}`);
    }
    const data = await res.json();
    // 打ち終わる前の応答が後から届くことがある。古い応答で上書きしない
    if (token !== usageToken) return;
    u.data = data;
    u.loaded = true;
    // **絞り込んでいないときだけ選択肢を取り直す。** 絞ると models が1種しか返らない
    if (!u.model) u.modelOptions = data.models ?? [];
  } catch (err) {
    if (token !== usageToken) return;
    u.error = err.message;
  } finally {
    if (token === usageToken) {
      u.loading = false;
      renderUsage();
    }
  }
}

/**
 * 数値モードを出す。`board.js` の setMode から（initBoard に差した口経由で）呼ばれる。
 *
 * 引くのは1回だけ。開くたびに引き直すと、モードを行き来しただけで
 * 60本ぶんのログを読み直すことになる。
 */
export function showUsage() {
  if (!store.usageTab.loaded && !store.usageTab.loading) loadUsage();
  else renderUsage();
}

/**
 * 数値モードの絞り込みの配線。`main.js` から1回だけ呼ぶ。
 *
 * @param {object} [opts]
 * @param {() => void} [opts.onPick] セッションのカードが押されたときに先に呼ぶもの。
 *   作業台へ戻すために使う（判断を持っているのは呼ぶ側）
 */
export function initUsageTab({ onPick: pick = null } = {}) {
  onPick = pick;
  const u = store.usageTab;
  dom.usageLimit.value = String(u.limit);
  dom.usageDays.value = u.days ? String(u.days) : '';

  // 3つとも意図した1クリックなので、その場で引き直す（検索欄のような間引きは要らない）
  dom.usageDays.addEventListener('change', () => {
    const v = Number.parseInt(dom.usageDays.value, 10);
    u.days = Number.isFinite(v) && v > 0 ? v : null;
    loadUsage();
  });

  dom.usageLimit.addEventListener('change', () => {
    const v = Number.parseInt(dom.usageLimit.value, 10);
    if (!Number.isFinite(v) || v <= 0) return;
    u.limit = v;
    loadUsage();
  });

  dom.usageModel.addEventListener('change', () => {
    u.model = dom.usageModel.value || null;
    loadUsage();
  });
}
