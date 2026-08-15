/* 詳細ペインの「数値」パネル。
 *
 * 層3。`detail-panels.js` と同格で、返す形も同じ（`{section, nav}` か `null`）。
 *
 * **主役は「何が文脈を食っているか」の1つだけ。**
 * 実消費も命中率も、見て納得して終わりになりやすい。
 * 「Read 1回で 68k 積まれた」だけが、次の呼び方を変える動機になる。
 * だから主役を上に置き、残りは下へ落として折りたたむ。
 *
 * ここは描くだけで、取りに行かない。数値は `session.js` が引いて store に置く。
 * 中で fetch すると、404（この版のサーバーには窓口が無い）のときに
 * 「セクションを自分で消す」羽目になり、`{section, nav}` を返す約束と噛み合わなくなる。
 */
import { el, fact } from './util.js';
import { panel, SEC } from './panel.js';
import {
  block, hitRateNote, statTile, barList, sparkline, tableDetails,
  tokensStrict, pctStrict, numStrict,
} from './usage-chart.js';

/** 横棒に出すツールの数。残りは下の表で読む。 */
const BARS_MAX = 8;

/** 実消費の内訳の並び。応答のキーと画面の名前をここで対にする。 */
const ITE_ROWS = [
  { key: 'in', weightKey: 'in', label: '入力（キャッシュされなかった分）' },
  { key: 'cacheRead', weightKey: 'cacheRead', label: 'キャッシュ読み' },
  { key: 'cacheWrite5m', weightKey: 'cacheWrite5m', label: 'キャッシュ書き（5分）' },
  { key: 'cacheWrite1h', weightKey: 'cacheWrite1h', label: 'キャッシュ書き（1時間）' },
  { key: 'out', weightKey: 'out', label: '出力' },
];

/**
 * 上に並べる4枚の札。
 *
 * @param {object} usage
 * @param {object|null} d 詳細（圧縮の回数だけ借りる）
 * @returns {HTMLElement}
 */
function tiles(usage, d) {
  const box = el('div', 'stats');
  box.append(statTile('実消費', tokensStrict(usage.totals.ite), `${numStrict(usage.requests)} 回の要求`));
  box.append(statTile('文脈保有量', tokensStrict(usage.context.last), '最後の要求の時点。足し合わせない値です'));
  box.append(statTile('キャッシュ命中率', pctStrict(usage.cache.hitRate), hitRateNote(usage)));
  // 詳細がまだ読めていなければ回数も分からない。0 と書かずに伏せる
  const compactions = d?.digest?.compactions?.length;
  box.append(statTile(
    '文脈の圧縮',
    typeof compactions === 'number' ? `${compactions} 回` : '—',
    compactions ? '圧縮より前のやり取りは要約に置き換わっています' : null,
  ));
  return box;
}

/**
 * 主役。何が文脈を食っているか。
 *
 * 注記は**折りたたまずに常時出す。** ここに出ているのは
 * 「その要求とその次の要求のあいだに、文脈がどれだけ伸びたか」であって、
 * ツールが返した文字数そのものではない。
 *
 * @param {object} usage
 * @returns {HTMLElement|null}
 */
function toolsBlock(usage) {
  if (!usage.tools.length) return null;

  const box = block('何が文脈を食っているか');
  box.append(el('p', 'note',
    'そのツールの結果が、どれだけ文脈に積まれたかです。「Read 1回で 68k」が分かれば、次から範囲や limit を絞れます。'));

  box.append(barList(usage.tools.slice(0, BARS_MAX).map((t) => ({
    label: t.tool,
    value: t.tokens,
    sub: `${numStrict(t.calls)} 回`,
  }))));

  // 帰属できなかったぶん。黙って落とすと合計が合わない理由が分からなくなる
  const u = usage.toolsUnattributed;
  const notes = [];
  if (u.noToolTokens > 0) {
    notes.push(`ツール以外（あなたの発言など） ${tokensStrict(u.noToolTokens)}`);
  }
  if (u.negativeCount > 0) {
    notes.push(`測れなかった回 ${numStrict(u.negativeCount)} 回（文脈が縮んだ回。ほとんどは圧縮です）`);
  }
  if (notes.length) box.append(el('p', 'note note-sub', notes.join(' / ')));

  box.append(tableDetails(
    `全 ${usage.tools.length} 件を表で見る`,
    ['ツール', '回数', '合計', '平均', '最大1回'],
    usage.tools.map((t) => [
      t.tool, numStrict(t.calls), numStrict(t.tokens), numStrict(t.avg), numStrict(t.max),
    ]),
  ));
  return box;
}

/**
 * スキルを呼んだあとの一続き。
 *
 * **注記は折りたたまずに常時出す。ここを消すなら、この節ごと消すこと。**
 * 測っているのは「Skill を呼んだ次の要求から、次にあなたの番が来るまで」で、
 * その消費がスキルのせいなのか、たまたま重い作業だったのかは分けられない。
 * 数字だけを並べると、読む人は必ず「このスキルは重い」と読む。
 *
 * @param {object} usage
 * @returns {HTMLElement|null}
 */
function skillsBlock(usage) {
  // 古いサーバー（この窓口が無い版）から来た応答にはキーごと無い
  const skills = usage.skills ?? [];
  if (!skills.length) return null;

  const box = block('スキルを呼んだあと');
  box.append(el('p', 'note',
    '「スキルを呼び出した直後の一続き」を測っています。スキルが原因とは限りません。'));
  box.append(el('p', 'note note-sub',
    '次にあなたが発言する（または /clear・中断・圧縮が入る）までを1区間として数えています。'));

  box.append(barList(skills.slice(0, BARS_MAX).map((s) => ({
    label: s.skill,
    value: s.ite,
    sub: `${numStrict(s.runs)} 回`,
  }))));

  box.append(tableDetails(
    `全 ${skills.length} 件を表で見る`,
    ['スキル', '呼んだ回数', '要求', '実消費', '1回あたり'],
    skills.map((s) => [
      s.skill, numStrict(s.runs), numStrict(s.requests), numStrict(s.ite), numStrict(s.avg),
    ]),
  ));
  return box;
}

/**
 * 文脈の伸び方。形だけを見る。
 *
 * 折れ線が鋸の歯のように落ちていれば、そこが圧縮。
 * 一段ずつ階段状に伸びていれば、大きな結果を都度積んでいる。
 *
 * @param {object} usage
 * @returns {HTMLElement|null}
 */
function growthBlock(usage) {
  const series = usage.context.series;
  const chart = sparkline(series, '文脈保有量の移り変わり');
  if (!chart) return null;

  const box = block('文脈の伸び方');
  const frame = el('div', 'spark');
  frame.append(chart);
  box.append(frame);

  // 絵は形しか語らないので、両端と山の高さは必ず文字でも出す
  const lo = series.reduce((m, v) => (v < m ? v : m), Infinity);
  box.append(el('p', 'spark-caption',
    `最小 ${tokensStrict(lo)} 〜 最大 ${tokensStrict(usage.context.peak)}　最後は ${tokensStrict(usage.context.last)}`));

  const g = usage.context.growth;
  if (g) {
    const dl = el('dl', 'facts');
    fact(dl, '1要求あたりの伸び（中央値）', tokensStrict(g.median));
    fact(dl, '同 p90', tokensStrict(g.p90));
    fact(dl, '同 最大', tokensStrict(g.max));
    box.append(dl);
  }
  return box;
}

/**
 * 実消費の内訳。重みはサーバーが返したものを使う。
 *
 * 比率はモデルによらず同じ（出力は入力の5倍、キャッシュ読みは 0.1 倍）。
 * だから単価が変わっても、この表の数字は嘘にならない。
 *
 * @param {object} usage
 * @returns {HTMLElement}
 */
function iteBlock(usage) {
  const w = usage.iteWeights ?? {};
  const rows = ITE_ROWS.map((r) => {
    const raw = usage.totals[r.key];
    const weight = w[r.weightKey];
    // 掛けると小数が出る（×1.25 は 0.25 刻み）。トークンの列に .5 が並ぶと
    // 測り方が細かいように見えるので、ここで整数へ寄せる。
    // 丸めるぶん、内訳の和は合計と数トークンずれ得る。合計はサーバーが出した値をそのまま出す
    const share = typeof raw === 'number' && typeof weight === 'number' ? Math.round(raw * weight) : null;
    return [r.label, numStrict(raw), typeof weight === 'number' ? `×${weight}` : '—', numStrict(share)];
  });
  rows.push(['合計（実消費）', '—', '—', numStrict(usage.totals.ite)]);

  const box = block('実消費の内訳');
  box.append(el('p', 'note',
    '入力トークンに換算した量です。金額ではありません。単価はモデルによって違いますが、この比率はどのモデルでも同じです。'));
  box.append(tableDetails('内訳を表で見る', ['項目', 'トークン', '重み', '実消費への寄与'], rows, { total: true }));
  return box;
}

/**
 * 数値パネル1枚。
 *
 * @param {object|null} usage `/api/sessions/:id/usage` の応答
 * @param {object|null} d 詳細の応答（圧縮の回数だけ借りる。まだ読めていなければ null）
 * @param {string|null} error 取れなかった理由
 * @returns {{section: HTMLElement, nav: object}|null}
 */
export function usagePanel(usage, d, error) {
  if (!usage) {
    // まだ届いていない・この版のサーバーには窓口が無い、のどちらも静かに退く。
    // 「読んでいます」を出すと、404 のときに永久に出たままになる
    if (!error) return null;
    const p = panel('数値', { id: SEC.usage });
    p.body.append(el('p', 'note', `数値を取れません: ${error}`));
    return { section: p.section, nav: { id: SEC.usage, label: '数値' } };
  }

  // 要求が1件も無ければ節ごと出さない。0 が並ぶだけの枠は、読む人の時間を取るだけ
  if (!usage.requests) return null;

  const p = panel('数値', { id: SEC.usage, count: `${usage.requests} 回の要求` });
  p.body.append(tiles(usage, d));

  const tools = toolsBlock(usage);
  if (tools) p.body.append(tools);
  // 「何が食っているか」の系統なので、ツールの隣に置く
  const skills = skillsBlock(usage);
  if (skills) p.body.append(skills);
  const growth = growthBlock(usage);
  if (growth) p.body.append(growth);
  p.body.append(iteBlock(usage));

  return {
    section: p.section,
    nav: { id: SEC.usage, label: '数値', count: usage.requests },
  };
}
