/**
 * 層1。数値を絵にするための小道具。
 *
 * ここは `util.js` しか見ない。**store も panel も見ない。**
 * 見た瞬間に「どのセッションの話か」を知ることになり、
 * 使い回せない部品になる。
 *
 * SVG を扱うので `util.js` の `el()` は使えない（あれは `createElement`。
 * 名前空間が付かないので、SVG として解釈されず何も描かれない）。
 * 代わりに同じ `util.js` の `svgEl()` を使う（もとはここに置いていたが、
 * アイコン（`icons.js`）からも呼ぶので層0 へ移した）。
 */

import { el, num, shortModel, svgEl } from './util.js';
import { icon } from './icons.js';

/**
 * 節を1つ作る。数値の枠の中の小見出し。
 *
 * 詳細のパネル（層3）と横断のタブ（層7）が同じ形を使う。
 * どちらかに置くともう片方から見えないので、層1に置いてある。
 *
 * **tip は「読み方の説明」だけの置き場所**（右の紙で使う。画面刷新④）。見出しの右に ⓘ の印を置き、
 * 触れるか焦点を当てたときに吹き出しで出す。**誤読を防ぐ注記はここへ入れない** ―― 吹き出しは
 * 触れるまで出ないので、「常に出す」決まりの注記（因果・足し合わせない・入っていない など）は
 * 本文の段（`.note` / `readNote` / `.stat-note`）に残す。
 *
 * 印は押せる要素（button）にする。焦点を受けられるので、キーボードで来た人にも吹き出しが出る
 * （CSS の `:focus` / `:focus-visible`）。名前は aria-label が説明ごと持つ（読み上げにも乗る）。
 * **title は付けない** … 吹き出しと OS の札が二重に出る（左のレールの吹き出しと同じ理由）。
 * 右の紙は作り直されるので、焦点を拾い直す名前（data-refocus）も付ける。
 *
 * @param {string} title
 * @param {{tip?: string|null}} [opts]
 * @returns {HTMLElement}
 */
export function block(title, { tip = null } = {}) {
  const box = el('section', 'usage-block');
  const head = el('h4', null, title);
  if (tip) {
    const mark = el('button', 'tip-mark');
    mark.type = 'button';
    mark.dataset.tip = tip;
    mark.dataset.refocus = `tip:${title}`;
    mark.setAttribute('aria-label', `「${title}」の読み方: ${tip}`);
    mark.append(icon('info', 13));
    head.append(mark);
  }
  box.append(head);
  return box;
}

/**
 * 読むだけの塊。散らばっていた但し書きを1つの面へまとめる。
 *
 * **1本も減らさない。** 誤読を防ぐ注記は折りたたまずに常時出す決まりなので、
 * 消すのではなく「読めるが目立たない」段を面で作る。
 * 吹き出し（`block` の `tip`）へ移してよいのは読み方の説明だけで、ここに来るものは移さない。
 * 形は `settings.css` の `.settings-read`（押せるものが1つも無いことを
 * 文ではなく面で示す）から借りている。
 *
 * 節ではなく塊にしてあるので、札の下にも節の中にも置ける。
 *
 * @param {(string|null|undefined)[]} lines 出す文。null と空文字は飛ばす
 * @returns {HTMLElement|null} 1本も残らなければ null（空の面を置かない）
 */
export function readNote(lines) {
  const kept = (lines ?? []).filter((s) => typeof s === 'string' && s);
  if (!kept.length) return null;
  const box = el('div', 'usage-read');
  for (const line of kept) box.append(el('p', null, line));
  return box;
}

/**
 * キャッシュ命中率に添える但し書き。
 *
 * **モデルまたぎで比べられない。** キャッシュの最小長がモデル別で、
 * しかも単調でない（Opus 5 は 512、Opus 4.7 は 2,048、Opus 4.6 と Haiku 4.5 は 4,096）。
 * 最小長に満たないとエラーも出さずに黙ってキャッシュされないので、
 * 古いモデルの命中率が低く出るのは、使い方の差だけが理由ではない。
 *
 * 1本ぶんと横断で同じ形（`model` と `models`）を返すので、そのまま両方で使える。
 * 横断のほうは混ざっていると値そのものが null になるが、
 * **なぜ出ないかを書くのはこちらの仕事。** 数字の代わりに「—」だけを出さない。
 *
 * @param {{model: string|null, models: {model: string}[]}} usage
 * @returns {string}
 */
export function hitRateNote(usage) {
  const models = usage.models ?? [];
  if (models.length > 1) {
    return `モデルが ${models.length} 種類混ざっています。モデルまたぎでは比べられません`;
  }
  const name = usage.model ? shortModel(usage.model) : null;
  return name ? `${name} の中でだけ比べられます` : 'モデルが分かりません';
}

/**
 * トークン数を短く書く。**0 と「不明」を分ける。**
 *
 * **`if (!n)` で弾かない。** そう書くと 0 も null も同じ見た目になる（前の `util.js` の
 * `tokens()` がそうだった）。数値の画面では「実際に 0 だった」と「測れなかった」が別物なので、
 * 数かどうかを確かめてから整形する。
 *
 * @param {number|null|undefined} n
 * @returns {string} 測れないときは全角ダッシュ
 */
export function tokensStrict(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n < 1000) return String(Math.round(n));
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}

/**
 * 割合を百分率で書く。こちらも 0 と「不明」を分ける。
 *
 * @param {number|null|undefined} v 0〜1
 * @returns {string}
 */
export function pctStrict(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

/**
 * いつもと比べてどうか、を短く書く。
 *
 * **比べる相手がいなければ何も返さない。** 推測で `±0` と書かない。
 * 0 と「不明」を分けるのと同じ理由で、「差が無い」と「比べられない」は別物。
 *
 * 増減で色を変えない。実消費が多いのは、単に長く働いた日かもしれない。
 * 良し悪しを決めるのは読む人で、この画面ではない。
 *
 * @param {number|null|undefined} value いまの値
 * @param {number|null|undefined} base 比べる相手（中央値）
 * @param {{kind?: 'ratio'|'point'|'count', unit?: string}} [opts]
 *   `ratio` は百分率の増減（既定）。`point` は割合どうしの差をポイントで。
 *   `count` は素の差。`unit` は `count` のときだけ末尾に付く
 * @returns {string|null} 比べられなければ null
 */
export function deltaText(value, base, { kind = 'ratio', unit = '' } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (typeof base !== 'number' || !Number.isFinite(base)) return null;

  const diff = value - base;
  // 符号は全角のマイナス。半角ハイフンは小さすぎて、数字に紛れて見落とす
  const sign = diff > 0 ? '+' : diff < 0 ? '−' : '±';
  const abs = Math.abs(diff);

  if (kind === 'count') return `${sign}${num(abs)}${unit}`;
  if (kind === 'point') return `${sign}${(abs * 100).toFixed(1)}pt`;
  // 相手が 0 なら、何倍かを言えない。差だけ書いても単位が伝わらないので伏せる
  if (base === 0) return null;

  const pct = (abs / base) * 100;
  // **桁が増えたら倍率へ切り替える。** 「+9687%」は事実だが、桁を数えないと読めない
  // （実測：セッションを跨いだスキルの推移で、1本目 70k → 直近 6.9M のときに出た）。
  // 値を隠すのではなく、読める単位に替えるだけ。
  //
  // **符号は付けない。** 減った側は `abs / base` が 1 を超えないので、
  // 倍率が出た時点で必ず増加。`+×99` のように印を2つ重ねない
  if (pct >= 1000) {
    const times = value / base;
    return `×${times >= 10 ? Math.round(times) : times.toFixed(1)}`;
  }
  return `${sign}${Math.round(pct)}%`;
}

/**
 * 数値を1つ大きく出す札。
 *
 * 単一の現在値なので棒グラフにしない（棒は比べるためのもので、
 * 比べる相手がいない値を棒にすると、長さに意味があるように見えてしまう）。
 *
 * @param {string} label 何の数か
 * @param {string} value 既に文字列にしたもの（`tokensStrict` などを通す）
 * @param {string} [note] 小さく添える但し書き
 * @param {string|null} [delta] いつもとの差（`deltaText` の戻り値をそのまま渡す）
 * @returns {HTMLElement}
 */
export function statTile(label, value, note, delta) {
  const box = el('div', 'stat');
  box.append(el('div', 'stat-label', label));
  box.append(el('div', 'stat-value', value));
  // 差は値のすぐ下。但し書きより先に置く（値と一続きに読ませたい）
  if (delta) box.append(el('div', 'stat-delta', delta));
  if (note) box.append(el('div', 'stat-note', note));
  return box;
}

/**
 * 横棒・折れ線の行の名前。**全文を title に入れる。**
 *
 * 右の紙（詳細ペイン）は狭いので、名前を1行で「…」で切る（`usage.css` の `.insp .bar-label`）。
 * 切ったぶんは触れれば読める。数値モード（横断）は折り返しのままで、title は添えるだけ。
 * 3つの組み方（`shareBar` / `barList` / `trendList`）がここを通る（片方だけ title を忘れない）。
 *
 * @param {string} text 名前
 * @returns {HTMLElement}
 */
function barLabel(text) {
  const label = el('span', 'bar-label', text);
  // 空の名前に空の吹き出しを付けない
  if (text) label.title = String(text);
  return label;
}

/**
 * 部分と全体を1本で示す横棒。
 *
 * **溝がそのまま「残り」になる。** `.bar-track`（--bg-sunk）が全体、
 * `.bar-fill` が部分で、塗られていないところが説明を要する余りにあたる。
 * 新しい部品を作らず、`.bar` の行を1本置くだけで成立する。
 *
 * **これは「単一の現在値を棒にしない」に当たらない。** 比べる相手のいない値を
 * 棒にすると長さに意味があるように見えるが、こちらは部分と全体の関係そのものを
 * 長さで語っている。
 *
 * **床を --bg へ上げてからでないと成立しない。** 前は地も溝も --bg-sunk だったので、
 * 塗られていない部分が見えなかった。
 *
 * @param {string} label 左に置く名前
 * @param {number|null} ratio 0〜1。null は「出せない」（分母が0）
 * @param {string} [restLabel] 右に添える残りの説明
 * @returns {HTMLElement}
 */
export function shareBar(label, ratio, restLabel) {
  const list = el('ul', 'bars');
  const li = el('li', 'bar is-share is-top');
  li.append(barLabel(label));

  const track = el('span', 'bar-track');
  const fill = el('span', 'bar-fill');
  // null（分母が0で出せない）は 0 幅。**0 と不明を見た目で分けるのは値の側の仕事**で、
  // 右に出す文字が「—」になる
  const pct = typeof ratio === 'number' && Number.isFinite(ratio) ? ratio : 0;
  fill.style.width = `${Math.max(0, Math.min(1, pct)) * 100}%`;
  track.append(fill);
  li.append(track);

  li.append(el('span', 'bar-value', pctStrict(ratio)));
  li.append(el('span', 'bar-sub', restLabel ?? ''));
  list.append(li);
  return list;
}

/**
 * 横棒の一覧。量を長さで語る。
 *
 * **名義のカテゴリなので、値の大小で色を変えない。** 強調は1位だけ。
 *
 * @param {{label: string, value: number, sub?: string}[]} rows
 * @returns {HTMLElement}
 */
export function barList(rows) {
  const list = el('ul', 'bars');
  // 最大値は先頭ではなく全件から取る。並びが崩れていても絵が壊れないように
  const max = rows.reduce((m, r) => (r.value > m ? r.value : m), 0);
  rows.forEach((row, i) => {
    const li = el('li', 'bar');
    if (i === 0) li.classList.add('is-top');
    li.append(barLabel(row.label));

    const track = el('span', 'bar-track');
    const fill = el('span', 'bar-fill');
    // 0 でも 1% は描く。「呼んだが測れなかった」と「呼んでいない」を見た目で分けるため
    fill.style.width = `${max > 0 ? Math.max(1, (row.value / max) * 100) : 1}%`;
    track.append(fill);
    li.append(track);

    // 既定はトークン数として書く。割合のように単位が違うものは text で渡す
    // （**value は長さのため、text は読ませるため**。1つの値に2つの役目を持たせない）
    li.append(el('span', 'bar-value', row.text ?? tokensStrict(row.value)));
    li.append(el('span', 'bar-sub', row.sub ?? ''));
    list.append(li);
  });
  return list;
}

/**
 * 折れ線を1本だけ描く（スパークライン）。
 *
 * 目盛りも軸も付けない。ここで見たいのは形（伸び方と、圧縮でどこまで落ちたか）で、
 * 正確な値は横のキャプションと表のほうで読む。
 *
 * `preserveAspectRatio="none"` で横に引き伸ばすので、
 * 線は `vector-effect="non-scaling-stroke"` で太さを保つ
 * （付けないと横方向にだけ潰れて、細い線が消える）。
 *
 * @param {number[]} values 2点以上
 * @param {string} label 読み上げ用の説明
 * @returns {SVGElement|null} 点が足りなければ null
 */
export function sparkline(values, label) {
  if (!Array.isArray(values) || values.length < 2) return null;

  // Math.max(...arr) を使わない。120点なら通るが、上限を上げたときに引数の数で落ちる
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  const W = 100;
  const H = 30;
  const PAD = 1; // 線の太さのぶん。上下を切らないための余白
  const span = max - min;
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * W;
    // 全部同じ値なら真ん中に水平線を引く（0 除算を避けるためだけでなく、
    // 下端に貼り付くと「ずっと 0 だった」に見えるため）
    const t = span > 0 ? (v - min) / span : 0.5;
    const y = H - PAD - t * (H - PAD * 2);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  const svg = svgEl('svg', {
    class: 'spark-svg',
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-label': label,
  });
  // 面 → 線の順に足す。あとから足したほうが上に描かれる
  svg.append(svgEl('polygon', {
    class: 'spark-area',
    points: `0,${H} ${points.join(' ')} ${W},${H}`,
  }));
  svg.append(svgEl('polyline', {
    class: 'spark-line',
    points: points.join(' '),
    'vector-effect': 'non-scaling-stroke',
  }));
  return svg;
}

/**
 * 枠の使用率の二重の輪の形。**外が5時間の枠、内が7日の枠。**
 *
 * どれも **viewBox の座標**（`view` 四方）。器の大きさは CSS（base.css の `.rate-ring` が
 * `--navrail-cell` = 2.75rem = 44px）が持ち、SVG は器いっぱいに広がる。`view` を 44 に揃えてあるので、
 * いまは 1 単位がちょうど 1px になる（器の大きさを変えるなら、ここの数は比として読み替わる）。
 * 線の太さ 3、輪と輪の隙間 1.5。内側の輪の内径は 27（半径 15 − 線の半分 1.5 の倍）で、
 * 真ん中の数（12px。こちらは器と一緒に伸び縮みしない）の「100」が収まる幅にしてある。
 * 「100%」は収まらないので % は付けない（runs.js の ringView）。
 */
const RING = { view: 44, stroke: 3, outer: 19.5, inner: 15 };

/**
 * 枠の使用率の二重の輪を組む。**左のレール（list.js の renderRate）と、説明モーダルの凡例
 * （about.js の fillMeters）が同じものを使う。** 凡例を別の部品で描くと、輪を直した日に凡例だけ古くなる。
 *
 * 何を描くかは渡されたものに従うだけで、ここでは判断しない（判断は runs.js の ringView）。
 * - 読めていない枠（`five` / `seven` が null）は**溝だけ残して弧を描かない。**
 *   外＝5時間・内＝7日の位置の意味を動かさないため（片方しか無いときに繰り上げない）
 * - 弧の長さは `stroke-dasharray` を**属性で**入れる（CSS 変数にすると、JS が書く変数の一覧
 *   ―― `test/screen.test.mjs` の `FROM_JS` ―― に足す口が増える）
 * - 0% は長さ 0 の弧を置く。線の端が丸い（`stroke-linecap: round`）ので点が1つ出て、
 *   「読めていない（弧が無い）」と見分けが付く
 * - 色の段は `data-tone` に1語で書き、色そのものは CSS（base.css の `.rate-ring-*`）が当てる
 * - 古い観測（`stale`）は器に `data-stale` を立てる（CSS が沈める）
 *
 * SVG は `svgEl()`（createElementNS）で組む。`innerHTML` は使わない。
 * 絵は飾り（aria-hidden）で、名前は置く側（`#rate` の aria-label）が持つ。
 *
 * @param {{five: ?{ratio: number, tone: string}, seven: ?{ratio: number, tone: string},
 *          peak: string, stale?: boolean}} ring `ringView()` の戻り（凡例の見本も同じ道で組む）
 * @returns {HTMLElement}
 */
export function rateRing(ring) {
  const box = el('span', 'rate-ring');
  if (ring.stale) box.dataset.stale = '';

  const { view, stroke } = RING;
  const c = view / 2;
  // 幅と高さは書かない（器の CSS に任せる。数を2箇所に持たない）
  const svg = svgEl('svg', {
    viewBox: `0 0 ${view} ${view}`,
    'aria-hidden': 'true',
    focusable: 'false',
  });
  for (const [part, r] of [[ring.five, RING.outer], [ring.seven, RING.inner]]) {
    // 溝。読めていてもいなくても置く（輪の位置そのものが「どちらの枠か」を語る）
    svg.append(svgEl('circle', {
      class: 'rate-ring-track', cx: c, cy: c, r, fill: 'none', 'stroke-width': stroke,
    }));
    if (!part) continue;
    const len = 2 * Math.PI * r;
    svg.append(svgEl('circle', {
      class: 'rate-ring-arc',
      cx: c,
      cy: c,
      r,
      fill: 'none',
      'stroke-width': stroke,
      'stroke-linecap': 'round',
      'stroke-dasharray': `${(part.ratio * len).toFixed(2)} ${len.toFixed(2)}`,
      // 12時の位置から時計回りに伸ばす（円の既定の始点は3時）
      transform: `rotate(-90 ${c} ${c})`,
      'data-tone': part.tone || null,
    }));
  }
  box.append(svg, el('b', 'rate-ring-num', ring.peak));
  return box;
}

/**
 * スパークラインを1行ずつ並べる。
 *
 * 器は `barList` と同じ4列（名前・絵・値・添え）を借りる。
 * **並べて比べるものだと見た目で伝えるため**で、違うのは2列目が棒ではなく折れ線なところだけ。
 *
 * 棒は「量」を長さで語るが、こちらは「向き」を形で語る。
 * だから1位の強調をしない（`is-top` は付けない）。順位はもう棒の側で付いている。
 *
 * 2点に足りない行は**黙って飛ばす**のではなく、呼ぶ側が事前に外す。
 * ここで飛ばしてしまうと「絵が出ない行がある」ことに呼ぶ側が気づけない
 * （返り値が null になるのは1行も描けなかったときだけ）。
 *
 * @param {{label: string, values: number[], value: string, sub?: string, alt: string}[]} rows
 * @returns {HTMLElement|null} 1行も描けなければ null
 */
export function trendList(rows) {
  const list = el('ul', 'bars');
  for (const row of rows) {
    const chart = sparkline(row.values, row.alt);
    if (!chart) continue;

    const li = el('li', 'bar is-trend');
    li.append(barLabel(row.label));

    // SVG は器の高さいっぱいに伸びるので、高さを持つ器で包む
    const frame = el('span', 'trend-spark');
    frame.append(chart);
    li.append(frame);

    li.append(el('span', 'bar-value', row.value));
    li.append(el('span', 'bar-sub', row.sub ?? ''));
    list.append(li);
  }
  return list.children.length ? list : null;
}

/**
 * 表以外を畳む。中身は呼ぶ側が作った節点をそのまま入れる。
 *
 * 見た目は `tableDetails` と同じ `summary` にする
 * （「開くと続きがある」を1つの形に保つ。`usage.css` が2つを並べて宣言している）。
 *
 * **`tableDetails` と別にしてあるのは、あちらが「絵に添える表」だから。**
 * 表を畳むのと、絵そのものを畳むのは別の判断で、
 * 片方の口に `head` や `rows` を null で渡せる抜け道を作らない。
 *
 * @param {string} summaryText 閉じているときの見出し
 * @param {HTMLElement|null} node 中に入れる節点。null なら畳みごと作らない
 * @returns {HTMLElement|null}
 */
export function foldBlock(summaryText, node) {
  if (!node) return null;
  const box = el('details', 'usage-fold');
  box.append(el('summary', null, summaryText));
  box.append(node);
  return box;
}

/**
 * 折りたたんだ表。絵の対にする。
 *
 * 絵だけだと値が読めない。色や長さに頼らずに数を確かめられる道を、必ず横に置く。
 *
 * @param {string} summaryText 閉じているときの見出し
 * @param {string[]} head 見出しの行
 * @param {string[][]} rows 本体。列0は文字、それ以降は数値として右へ寄せる
 * @param {{total?: boolean}} [opts] total を立てると最後の行を合計として太らせる。
 *   立てないと、ただの最終行（順位の8位など）まで合計に見える
 * @returns {HTMLElement}
 */
export function tableDetails(summaryText, head, rows, { total = false } = {}) {
  const box = el('details', 'usage-table');
  box.append(el('summary', null, summaryText));

  const scroll = el('div', 'table-scroll');
  const table = el('table');

  const thead = el('thead');
  const hr = el('tr');
  head.forEach((h, i) => {
    const th = el('th', i === 0 ? null : 'n', h);
    hr.append(th);
  });
  thead.append(hr);
  table.append(thead);

  const tbody = el('tbody');
  rows.forEach((row, r) => {
    const tr = el('tr', total && r === rows.length - 1 ? 'is-total' : null);
    row.forEach((cell, i) => {
      tr.append(el('td', i === 0 ? null : 'n', cell));
    });
    tbody.append(tr);
  });
  table.append(tbody);

  scroll.append(table);
  box.append(scroll);
  return box;
}

/**
 * 表の中に入れる数の書き方。桁区切りを付けたうえで、不明は伏せる。
 *
 * `util.js` の `num()` は不明を `'?'` と書く。一覧の密な行ではそれでよいが、
 * 表の列に `?` が並ぶと入力欄のように見えるので、こちらは全角ダッシュにする。
 *
 * @param {number|null|undefined} n
 * @returns {string}
 */
export function numStrict(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return num(n);
}

/**
 * 「何が文脈を食っているか」の節。詳細ペインと横断の両方が出す。
 *
 * **もとは同じものが2枚に書かれていた。** 棒の写像（`{label, value, sub}`）と
 * 表の列・行の写像がバイト単位で一致していて、**JSDoc の本文まで同じ**だった。
 *
 * 違っていたのは4つだけなので、そこを引数で受ける。
 *
 * | | 詳細ペイン | 横断 |
 * |---|---|---|
 * | 説明 | 見出しの吹き出し（`tip`。読み方の説明なので） | 本文の注記（`note`。「集めたセッションぶんを足しています」） |
 * | 棒の本数 | 8 | 6 |
 * | 表の見出し | 「全 N 件を表で見る」 | 「ツール N 件を表で見る」 |
 * | 帰属できなかったぶんの注記 | 出す | 出さない（横断では母数が違って読めない） |
 *
 * **注記は畳まずに呼ぶ側で組んで渡す。** あれは「ツール以外」と「測れなかった回」の
 * 2種類を状況で足し引きするもので、ここで分岐させると引数が増えるだけになる。
 *
 * @param {object[]} tools ツール別の集計（`tool` / `calls` / `tokens` / `avg` / `max`）
 * @param {object} opts
 * @param {string} [opts.note] 説明文（本文の注記として出す。横断）
 * @param {string} [opts.tip] 説明文（見出しの吹き出しへ出す。右の紙。読み方の説明だけ）
 * @param {number} opts.bars 棒で出す本数
 * @param {string} opts.tableLabel 表を開く札の文字
 * @param {HTMLElement|null} [opts.extraNote] 棒と表のあいだに挟む注記
 * @returns {HTMLElement|null} 1件も無ければ null（節ごと出さない）
 */
export function toolsBlock(tools, { note = null, tip = null, bars, tableLabel, extraNote = null }) {
  if (!tools.length) return null;

  const box = block('何が文脈を食っているか', { tip });
  if (note) box.append(el('p', 'note', note));

  box.append(barList(tools.slice(0, bars).map((t) => ({
    label: t.tool,
    value: t.tokens,
    sub: `${numStrict(t.calls)} 回`,
  }))));

  if (extraNote) box.append(extraNote);

  box.append(tableDetails(
    tableLabel,
    ['ツール', '回数', '合計', '平均', '最大1回'],
    tools.map((t) => [
      t.tool, numStrict(t.calls), numStrict(t.tokens), numStrict(t.avg), numStrict(t.max),
    ]),
  ));
  return box;
}
