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

/**
 * 節を1つ作る。数値の枠の中の小見出し。
 *
 * 詳細のパネル（層3）と横断のタブ（層7）が同じ形を使う。
 * どちらかに置くともう片方から見えないので、層1に置いてある。
 *
 * @param {string} title
 * @returns {HTMLElement}
 */
export function block(title) {
  const box = el('section', 'usage-block');
  box.append(el('h4', null, title));
  return box;
}

/**
 * 読むだけの塊。散らばっていた但し書きを1つの面へまとめる。
 *
 * **1本も減らさない。** 注記は折りたたまずに常時出す決まりなので、
 * 消すのではなく「読めるが目立たない」段を面で作る。
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
 * `util.js` の `tokens()` は `if (!n) return null` なので、
 * 0 も null も同じ見た目になる。数値の画面では
 * 「実際に 0 だった」と「測れなかった」が別物なので、こちらを使う。
 * **既存の `tokens()` は変更しない**（他の表示が一斉に変わる）。
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
  return `${sign}${Math.round((abs / base) * 100)}%`;
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
 * 横棒の一覧。**1位だけアクセント、残りは control。**
 *
 * 名義カテゴリ（ツール名）なので、値の大きさで色を変えない。
 * 色に段階を付けると「赤いから悪い」のような読み方が生まれるが、
 * ここに良し悪しは無い。あるのは大小だけなので、長さで示す。
 *
 * @param {{label: string, value: number, sub?: string}[]} rows 大きい順に渡す
 * @returns {HTMLElement}
 */
export function barList(rows) {
  const list = el('ul', 'bars');
  // 最大値は先頭ではなく全件から取る。並びが崩れていても絵が壊れないように
  const max = rows.reduce((m, r) => (r.value > m ? r.value : m), 0);
  rows.forEach((row, i) => {
    const li = el('li', 'bar');
    if (i === 0) li.classList.add('is-top');
    li.append(el('span', 'bar-label', row.label));

    const track = el('span', 'bar-track');
    const fill = el('span', 'bar-fill');
    // 0 でも 1% は描く。「呼んだが測れなかった」と「呼んでいない」を見た目で分けるため
    fill.style.width = `${max > 0 ? Math.max(1, (row.value / max) * 100) : 1}%`;
    track.append(fill);
    li.append(track);

    li.append(el('span', 'bar-value', tokensStrict(row.value)));
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
    li.append(el('span', 'bar-label', row.label));

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
