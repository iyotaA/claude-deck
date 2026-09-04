/* 3つ目のモード「数値」。セッションを跨いだ集計。
 *
 * 層7。出し分けを持っているのは `mode.js` の `setMode` で、**あちらから呼ばれる**
 * （`main.js` が `initMode({ onUsage: showUsage })` で差す）。
 * **ここから `mode.js` を import しない。** 向きが両方に付くと、その場では動くのに
 * 順番を変えた瞬間に立ち上がらなくなる。
 *
 * ログを全文読む一番重い窓口（実測で60本 1秒台）を叩くので、**開いたときに1回だけ引く。**
 * SSE の毎秒の押し出しには載せない。
 *
 * 詳細ペインの数値パネル（`usage-panel.js`）とは別物。
 * あちらは開いている1本、こちらは横断。絵の部品（層1の `usage-chart.js`）だけを共有する。
 */
import { el, shortModel } from './util.js';
import { icon } from './icons.js';
import { dom, store } from './store.js';
import { closeListAfterPick } from './drawer.js';
import { select } from './session.js';
import { cardShell, cardTitle, closeCardMeta, metaPath } from './card.js';
import {
  block, readNote, hitRateNote, statTile, barList, shareBar, trendList, tableDetails,
  foldBlock, deltaText,
  tokensStrict, pctStrict, numStrict,
  toolsBlock as toolsBlockOf,
} from './usage-chart.js';

/**
 * カードを押されたあとに作業台へ移す口。`initUsageTab` で外から差す。
 *
 * 数値モードは全幅で、中央の詳細ペインが消えている（`usage.css`）。押した1本を
 * 見せるには作業台へ戻すしかないが、その判断（`setMode`）を持っているのは
 * `mode.js` の側で、**こちらから import すると向きが両方に付く。**
 * `runs.js` の `subscribeRuns(fn)` と同じ切り方で、配線だけ外に出す。
 *
 * @type {(() => void)|null}
 */
let onPick = null;

/**
 * 横棒に出すツールの数。残りは下の表で読む。
 *
 * **6 で足りる。** 実測（27 種）で 7 位以下は 1 位の 5% を切っていて、
 * 棒の長さでは差が読めない。読めない棒を並べるより表へ回す。
 */
const BARS_MAX = 6;

/**
 * 横棒に出すスキルの数。残りは下の表で読む。
 *
 * **母数で足切りしなくなった。** 前は「呼んだ回数が3回未満は順位から外す」を
 * 持っていたが、帰属ラベルで数えると runs は「使ったセッション数」になり、
 * 1本でしか使っていないスキルが実際に重いことは普通にある
 * （実測で claude-in-chrome は1セッションで 3.0M）。
 *
 * 並べる軸も「1回あたり」から「全体に占める割合」へ変えたので、
 * たまたま重い1回が順位を歪める心配がそもそも無い
 * （割合が大きいということは、実際に全体を食っているということ）。
 */
const SKILL_RANK_MAX = 6;

/**
 * 常時出す推移の数。残りは畳んだ中で読む。
 *
 * 折れ線は1本ずつ形を追うものなので、20 本並べても上から順に見るだけになる。
 * **畳むのは絵だけで、注記も表も畳まない**（何が省かれたかは畳みの外に残る）。
 */
const TREND_MAX = 3;

/**
 * カードで出すセッションの数。残りは表で読む。
 *
 * 12 枚だと 3 列 × 4 段で、節ひとつが画面の高さを丸ごと使う。
 * ここは「重いのはどれか」を見る場所で、全部を眺める場所ではない。
 */
const ROWS_MAX = 6;

/**
 * 節の並びと名前。**ここを1行足すだけで節が増える。**
 *
 * 出し分けは CSS が `data-sec` で行うので、JS は名前を書くだけでよい
 * （`settings.js` と同じ作法。JS で出し入れすると節ごとに配線が増える）。
 */
const SECTIONS = [
  { id: 'over', label: '概要' },
  { id: 'tools', label: 'ツール', count: (d) => d.tools?.length },
  { id: 'skills', label: 'スキル', count: (d) => d.skills?.length },
  { id: 'rows', label: 'セッション', count: (d) => d.rows?.length },
];

/**
 * いま開いている節。
 *
 * **`localStorage` に残さない。** モードと同じ扱いで、開くたび「概要」へ戻す
 * （設定モーダルが「開くたびに畳んだ状態へ戻す」のと同じ理由 …
 * 前に開いたかどうかを覚えると、開くたびに違う画面が出る）。
 */
let usageSec = 'over';

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
  const out = new DocumentFragment();
  const box = el('div', 'stats');
  // 実消費の但し書きだけは札に残す。あれは「その数がどこから出たか」の内訳で、
  // 数を読むときに一緒に読む値だから（他の3本は読み方の断り書き）
  box.append(statTile('実消費', tokensStrict(d.totals.ite), `${numStrict(d.requests)} 回の要求`));
  // 本数で割ると「長く話したセッションが多い月」というだけで動く。
  // 要求あたりなら、セッションの長さの違いを気にせず並べられる
  box.append(statTile('1要求あたり', tokensStrict(d.requests > 0 ? d.totals.ite / d.requests : null)));
  box.append(statTile('セッション', `${numStrict(d.sessions)} 本`));
  box.append(statTile('キャッシュ命中率', pctStrict(d.cache.hitRate)));
  out.append(box);

  // **1本も減らしていない。** 札から外したぶんは、そのまま下の塊へ移すだけ。
  // 札に付けたままだと、長い但し書きを持つ札（命中率）だけ背が高くなり、
  // 面も枠も持たない4枚がどこで区切れているのか読めなかった
  const read = readNote([
    '1要求あたりは長さの違いを均した値です。作業の中身でも動きます。',
    scanNote(d),
    crossHitRateNote(d),
  ]);
  if (read) out.append(read);
  return out;
}

/**
 * 概要の節。**開いたときに最初に出るのはここ。**
 *
 * 4札と、この期間の内訳（帰属バー）と、3つのテーマの代表値だけを置く。
 * 数えられる値は約19個で、下の3節（ツール・スキル・セッション）はどれも
 * ここからは畳まれている。
 *
 * **並べ方が3つとも違うので、各行にその基準を書く。** ツールは文脈への積み上がり、
 * スキルは全体に占める割合、セッションは実消費。1画面に3つの順序が混ざるので、
 * 書かないと「同じものさしで並んでいる」と読まれる。
 *
 * @param {object} d `/api/usage` の応答
 * @param {(sec: string) => void} go 節を切り替える口
 * @returns {DocumentFragment}
 */
function overviewBlock(d, go) {
  const out = new DocumentFragment();
  out.append(tiles(d));

  const un = d.skillsUnattributed;
  if (un) {
    const box = block('この期間の内訳');
    box.append(shareBar('スキルに帰属', un.share === null ? null : 1 - un.share,
      `残り ${pctStrict(un.share)}`));
    const read = readNote([
      'Claude Code が要求ごとに付けた帰属ラベルで数えています。'
      + '帰属は原因ではありません — 重かったのは仕事の内容かもしれません。',
      '残りはどのスキルにも紐づいていません。スキルを使わずに進めたぶんが入ります。',
    ]);
    if (read) box.append(read);
    out.append(box);
  }

  const box = block('いちばん重いもの');
  const list = el('ul', 'usage-peek');

  /**
   * 1行ぶん。名前・代表値・行き先。
   *
   * @param {string} key テーマの名前
   * @param {string} sec 行き先の節
   * @param {string} head 代表値（既に整形済みの文字列）
   * @param {string} basis 何で並べているか
   */
  const row = (key, sec, head, basis) => {
    const li = el('li');
    li.append(el('span', 'peek-k', key));
    const v = el('span', 'peek-v');
    v.append(el('span', 'peek-head', head));
    v.append(el('span', 'peek-basis', basis));
    li.append(v);

    // **押せるものは行き先の印を持つ。** 隣の代表値（押せない）と
    // 止まった絵で見分けが付くようにする
    const btn = el('button', 'peek-go', `${key}を見る`);
    btn.type = 'button';
    btn.append(icon('chevron'));
    btn.addEventListener('click', () => go(sec));
    li.append(btn);
    list.append(li);
  };

  const tools = (d.tools ?? []).slice(0, 3);
  if (tools.length) {
    row('ツール', 'tools',
      tools.map((t) => `${t.tool} ${tokensStrict(t.tokens)}`).join(' ／ '),
      '文脈への積み上がりが多い順');
  }
  const skills = (d.skills ?? []).slice(0, 3);
  if (skills.length) {
    row('スキル', 'skills',
      skills.map((x) => `${x.skill} ${pctStrict(x.share)}`).join(' ／ '),
      '全体の実消費に占める割合が大きい順');
  }
  const rows = (d.rows ?? []).slice(0, 3);
  if (rows.length) {
    row('セッション', 'rows',
      rows.map((r) => tokensStrict(r.ite)).join(' ／ '),
      '実消費が多い順');
  }

  if (!list.children.length) return out;
  box.append(list);
  out.append(box);
  return out;
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
  return toolsBlockOf(d.tools, {
    note: 'そのツールの結果が、どれだけ文脈に積まれたかです。集めたセッションぶんを足しています。',
    bars: BARS_MAX,
    tableLabel: `ツール ${d.tools.length} 件を表で見る`,
  });
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
  const toRow = (s) => ({
    label: s.skill,
    values: s.series.map((p) => p.ite),
    value: tokensStrict(s.series[s.series.length - 1].ite),
    sub: (s.trend ? deltaText(s.trend.last, s.trend.prevMedian) : null) ?? '',
    alt: `${s.skill} を呼ぶたびの実消費の移り変わり`,
  });

  // 上位だけ常時出し、残りは畳む。**並べ替えない** —
  // 上の棒と同じ並び（サーバーが実消費の降順で返したもの）のまま頭から取る。
  // ここで別の比較器を持つと、棒と絵で順位が食い違って同じ節に2つの順序ができる
  const list = trendList(rows.slice(0, TREND_MAX).map(toRow));
  const restList = trendList(rows.slice(TREND_MAX).map(toRow));
  if (list) {
    // 上の棒とは別の話（量 と 向き）なので `note-part` で破線を引いて区切る
    box.append(el('p', 'note note-part', '呼ぶたびの実消費です。左が古く、右がいちばん新しい回。'));
    box.append(list);
    // 畳むのは絵だけ。下の注記も表も畳まないので、何が省かれたかは畳みの外に残る
    const rest = foldBlock(`残り ${rows.length - TREND_MAX} 件の推移を見る`, restList);
    if (rest) box.append(rest);
  }

  // 絵から落ちたぶんと、並べようがなかったぶん。**どちらも黙って捨てない。**
  // 読む位置は絵のすぐ下でよいが、3本が縦に散らばると絵より注記のほうが嵩む。
  // 読むだけの塊へまとめて、面で1つに見せる
  const omitted = rows.reduce((n, s) => n + (s.seriesOmitted ?? 0), 0);
  const read = readNote([
    // しきい値の数字は書かない。決めているのはサーバー側なので、
    // ここに写すと片方だけ古くなる（`percentile` を2箇所に書かないのと同じ理屈）
    list
      ? '右端の割合は、最新の1回と、それより前の中央値との差です。'
        + '比べる相手が足りないものは差を出しません。'
      : null,
    omitted > 0 ? `古い ${omitted} 回は絵から外しました（新しいほうだけ描いています）。` : null,
    undated > 0
      ? `時刻が読めなかった ${undated} 回は推移に並べていません（回数と合計には入っています）。`
      : null,
  ]);
  if (read) box.append(read);
}

/**
 * スキルはどれだけ占めているか。
 *
 * **注記は折りたたまずに常時出す。ここを消すなら、この節ごと消すこと。**
 * 数えているのは Claude Code が要求ごとに付けた帰属ラベルで、
 * 「そのスキルの文脈下で走った」であって「そのスキルのせいで増えた」ではない。
 *
 * **無帰属を先に出す。** 実測で全体の 5〜8 割がどのスキルにも紐づかないので、
 * それを言わずに個別の割合だけ並べると、足しても 100% に届かない理由が読めない。
 *
 * @param {object} d
 * @returns {HTMLElement|null}
 */
function skillsBlock(d) {
  const skills = d.skills ?? [];
  const un = d.skillsUnattributed;
  // ラベルが1つも無くても、無帰属の説明は出す価値がある（古い版のログだと全部そこへ落ちる）
  if (!skills.length && !un) return null;

  const box = block('スキルはどれだけ占めているか');

  // **無帰属を先に置く。** ここが全体の何割かを示してから個別の割合を出さないと、
  // 下の棒を全部足しても 100% に届かない理由が読めない。
  // 溝が「残り」そのものになるので、部品を新しく作らずに済む
  if (un) {
    box.append(shareBar('スキルに帰属', un.share === null ? null : 1 - un.share,
      `残り ${pctStrict(un.share)}`));
  }

  // **文言は帰属ラベルの話へ直した。** 前の「呼び出した直後の一続き」は
  // もう事実と違う（あなたの発言も圧縮も跨ぐ）。因果が取れないことは変わらない
  const lead = readNote([
    'Claude Code が要求ごとに付けた帰属ラベルで数えています。'
    + '帰属は原因ではありません — 重かったのは仕事の内容かもしれません。',
    '分母は集めた全体の実消費です。'
    + '下の割合を足しても 100% にならないのは、残りがどのスキルにも紐づいていないためです。',
    d.skillsOmitted?.count
      ? `${numStrict(d.skillsOmitted.count)} 件は上限で切りました（実消費 ${tokensStrict(d.skillsOmitted.ite)}）。`
      : null,
  ]);
  if (lead) box.append(lead);

  if (!skills.length) return box;

  // **並べ替えない。** サーバーが実消費の降順で返したものをそのまま使う。
  // 前は「1回あたり」で並べ直していたが、いまは runs が「使ったセッション数」なので
  // avg が「1セッションあたり」になり、順位の意味が変わってしまう
  const ranked = skills.slice(0, SKILL_RANK_MAX);

  box.append(barList(ranked.map((s) => ({
    label: s.skill,
    // 棒の長さは全体に占める割合。値の列も割合にするので、
    // 「棒は share、折れ線は向き」と1つの絵に1つの問いだけを語らせられる
    value: s.share ?? 0,
    text: pctStrict(s.share),
    sub: `${numStrict(s.sessions)} 本`,
  }))));

  const read = readNote([
    '全体の実消費に占める割合の大きい順です。右は使ったセッションの数。',
    skills.length > ranked.length
      ? `残り ${numStrict(skills.length - ranked.length)} 件は下の表で読めます。`
      : null,
  ]);
  if (read) box.append(read);

  appendTrends(box, skills, d.skillsUndated);

  box.append(tableDetails(
    `スキル ${skills.length} 件を表で見る`,
    ['スキル', '全体の％', '実消費', '使ったセッション', '1セッションあたり', '要求'],
    skills.map((s) => [
      s.skill,
      pctStrict(s.share), numStrict(s.ite), numStrict(s.sessions),
      numStrict(s.avg), numStrict(s.requests),
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
  // aria-current は付けない。押すとモードごと移るので、
  // 「いま見ているもの」の意味が一覧・書庫と違う
  const { li, card } = cardShell(row, { variant: 'is-usage', current: false });

  const top = el('div', 'card-top');
  top.append(el('span', 'usage-ite', tokensStrict(row.ite)));
  top.append(el('span', 'when', `${numStrict(row.requests)} 回`));
  card.append(top);

  const label = row.title ?? '（指示なしで終わっています）';
  card.append(cardTitle(row, label));

  const meta = el('div', 'card-meta');
  const path = metaPath(row);
  if (path) meta.append(path);
  const model = shortModel(row.model);
  if (model) meta.append(el('span', 'tag', model));
  // 混ざっている行は命中率が読めない。表の列をそのまま信じさせない
  if (row.mixed) meta.append(el('span', 'tag', 'モデル混在'));
  closeCardMeta(card, meta);

  // 行き先の印。**押すと右に詳細が出る**ことを、動かさなくても分かる形で出す
  // （すぐ上に並ぶ .stat は押せないので印を持たない）。
  // 絶対配置で右端の中央に置くので、DOM 上の位置は末尾でよい
  card.append(icon('chevron'));

  card.addEventListener('click', () => {
    // **作業台へ移すのを先にやる。** 詳細ペインは数値モードのあいだ display で消えていて、
    // このあとの setListOpen が焦点をそこへ移す。出す前に呼ぶと焦点が行き場を失う
    onPick?.();
    // 'live' にしない。60本には24時間より古いものが混ざるので、`apply()` の
    // 「一覧から消えたら選択を外す」（`selectedFrom === 'live'` のときだけ働く）に
    // 引っかかって、押した直後に先頭へ飛ぶ
    select(row.sessionId, 'usage');
    closeListAfterPick(dom.detail);
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
    `セッション ${d.rows.length} 件を表で見る`,
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

/**
 * 節を切り替える。**器の data-sec を書き替えるだけ。**
 *
 * 出し入れは CSS がやるので、ここで節点を作り直さない
 * （作り直すと開いた `<details>` が閉じる）。
 *
 * @param {string} sec 節の名前
 */
function setUsageSec(sec) {
  usageSec = SECTIONS.some((x) => x.id === sec) ? sec : 'over';
  dom.usage.dataset.sec = usageSec;
  for (const btn of dom.usageNav.children) {
    btn.setAttribute('aria-pressed', String(btn.dataset.sec === usageSec));
  }
  // 節を替えたら先頭から読ませる。前の節のスクロール位置が残ると、
  // 短い節へ移ったときに何も見えない位置で止まる
  dom.usage.scrollTop = 0;
}

/**
 * 節ナビの札を組み直す。件数が変わるので、引き直すたびに呼ぶ。
 *
 * 見た目は `settings.css` の `.settings-navb` を借りている
 * （**顔の語彙を増やさない**。選んでいないあいだは面も枠も持たず、
 * 選んだものだけが面と `--accent` の棒を持つ）。
 *
 * @param {object|null} d `/api/usage` の応答
 */
function renderUsageNav(d) {
  dom.usageNav.replaceChildren();
  for (const sec of SECTIONS) {
    const btn = el('button', 'settings-navb', sec.label);
    btn.type = 'button';
    btn.dataset.sec = sec.id;
    btn.setAttribute('aria-pressed', String(sec.id === usageSec));
    const n = d ? sec.count?.(d) : null;
    // 0 と「まだ分からない」を分ける。0 件なら 0 と書く（消さない）
    if (typeof n === 'number') btn.append(el('span', 'n', numStrict(n)));
    btn.addEventListener('click', () => setUsageSec(sec.id));
    dom.usageNav.append(btn);
  }
}

/** 数値モードの中身を描き直す */
function renderUsage() {
  const u = store.usageTab;
  dom.usage.replaceChildren();
  renderUsageCount();
  renderModelOptions();
  renderUsageNav(u.loaded ? u.data : null);
  dom.usage.dataset.sec = usageSec;
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

  // **節ごとに器で包む。** 出し分けは CSS が data-sec で行うので、
  // ここは「どの節に何を入れるか」だけを決める（settings.js と同じ作法）
  for (const [name, node] of [
    ['over', overviewBlock(d, setUsageSec)],
    ['tools', toolsBlock(d)],
    ['skills', skillsBlock(d)],
    ['rows', rowsBlock(d)],
  ]) {
    if (!node) continue;
    const sec = el('section', 'usage-sec');
    sec.dataset.sec = name;
    sec.append(node);
    dom.usage.append(sec);
  }
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
      const reason = await res.json().then((j) => j?.reason ?? j?.error).catch(() => null);
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
 * 数値モードを出す。`mode.js` の setMode から（initMode に差した口経由で）呼ばれる。
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
