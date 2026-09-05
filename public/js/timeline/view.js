/* 絞り込みの帯と、描き直し。時系列の外向きのふるまいはここに集まる。
 *
 * 窓（TL_FIRST で開き、TL_MORE ずつ継ぎ足す）の状態は tlRef が持つ。
 * 描く先は attach() で預かり、detach() で外す。外からこの状態を触らせない。
 *
 * 絞り込みの帯（filterBar）は器の外に置く。中に入れると render() が入力欄まで
 * 作り直し、1文字ごとに caret が飛ぶ。
 */
import { el, num } from '../util.js';
import { mark } from '../perf.js';
import { store, syncQuery } from '../store.js';
import {
  KIND_LABELS, KIND_MARK, MARK_GROUPS, SIDECHAIN_LABELS,
  splitEdits, initialHiddenKinds, hideQueryValue,
} from './kinds.js';
import { icon } from '../icons.js';
import { filterTimeline, countKinds } from './search.js';
import { rawUrlFor } from './blocks.js';
import { timelineItem } from './item.js';

/**
 * 最初に出す件数。
 *
 * 件数で数えると短く見えるが、1行の高さがそろっていないので当てにならない。
 * 一度 12 件にしたときは目標の3倍の高さがあり、4 件まで落とした経緯がある。
 * そのときの1行は 指示 12行・Claude の説明 4行 で、実測すると4件で 666px あった。
 *
 * **行を短くしたので 12 へ戻す。** いまは 指示 4行・説明 1行・中間報告 2行。
 * 1件が1〜2行に収まるので、12 件でようやく「どんな流れで来たか」が1画面に入る。
 *
 * **順番が大事。** 予算を絞る前にここを広げると、長い行を12件ぶん組むことになって
 * 初回の描画が重くなる。触るときは item.js の予算とセットで見ること。
 *
 * 全件を前もって組むと初回の描画も重い（400件級のセッションがある）ので、
 * 窓を掛けて末尾のボタンで継ぎ足す形はそのまま残す
 */
const TL_FIRST = 12;

/**
 * 「続きを出す」1回で足す件数。
 *
 * 最初の4件と同じ刻みにすると、267件のセッションで60回以上押すことになる。
 * 押した時点で読むほうへ舵を切っているので、そこからは粗い刻みでいい
 */
const TL_MORE = 60;

/**
 * 窓の外にしか無い種類を数える。
 *
 * 「チップを押したのに何も変わらない」に見えるのを防ぐためのもの。
 * 足跡は間引きで新しい 200 件だけが残る（MAX_TRACES）ので、古い順で見ていると
 * 窓の中に1件も入らないことがある。実測した例では 383 件のうち最初の足跡が 151 件目だった。
 * この状態で足跡を出すと、見出しの件数と「続きを出す」の残り数だけが動いて、
 * 出ている行は1行も変わらない。窓を 4 件に縮めたので、この知らせはほぼ毎回出る
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
 * 種類のチップを出しているか。
 *
 * **`localStorage` にも URL にも残さない。** 開くたび畳んだ状態から始める。
 * 隠している種類そのものは `?hide=` が持っているので、状態は人へ渡せる。
 *
 * `<details>` を使わないのは、詳細ペインが 2秒ごとに丸ごと作り直されるため
 * （`detailKeyOf()` が `contextTokens` を鍵に含む）。走っているセッションでは
 * 開いた畳みが毎回閉じる
 */
let kindsOpen = false;

/* ------------------------------------------------- 絞り込み（選択形式） */

/*
 * **内部の持ち方は変えていない。** 正はいまも `store.hiddenKinds` という
 * 拒否リストで、`?hide=` に同期する。許可リストにすると、サーバが新しい種類を
 * 足したときに既定で見えなくなる ―― その理由はいまも生きている。
 *
 * 画面の「選択」は、その裏返し（`!hiddenKinds.has(kind)`）の言い換えとして扱う。
 * こうしておけば URL の契約も、新しい種類が既定で出ることも、そのまま残る。
 */

/**
 * いま既定の絞り込みか（＝「絞り込みを外す」を出さなくてよいか）。
 *
 * **判断を新しく書かない。** `hideQueryValue` が「既定と同じなら null」を
 * 返す形で既に同じことを決めているので、そちらに乗る。
 * 既定の中身を知っているのは `kinds.js` の側、という切り分けも崩れない
 *
 * @returns {boolean}
 */
function isDefaultKinds() {
  return hideQueryValue(store.hiddenKinds) === null;
}

/**
 * 素のクリック。**その種類（群）だけを見る。**
 *
 * @param {string[]} keys 出す種類
 * @param {string[]} all いま出うる種類すべて
 */
function pickOnly(keys, all) {
  const next = new Set(all);
  for (const k of keys) next.delete(k);
  store.hiddenKinds = next;
}

/**
 * Ctrl（⌘）＋クリック。足し引き。
 *
 * **最後の1つを外したら既定へ戻す。** 「0個選択」は選択形式として壊れているし、
 * 時系列が1行も出ない状態を人が作れてしまう
 *
 * @param {string[]} keys 触る種類
 * @param {boolean} hide 隠す側へ倒すか
 * @param {string[]} all いま出うる種類すべて
 */
function pickAdd(keys, hide, all) {
  for (const k of keys) {
    if (hide) store.hiddenKinds.add(k);
    else store.hiddenKinds.delete(k);
  }
  if (all.every((k) => store.hiddenKinds.has(k))) store.hiddenKinds = initialHiddenKinds();
}

/**
 * 群がいまどの状態か。**三態。**
 *
 * 既定（足跡だけ隠す）では `hand` が `some` になる。
 * **群だけを選ぶ形にできないのはここ** … `trace` と `edit` は同じ群にいるので、
 * 群の二値では既定の姿すら表せない
 *
 * @param {Array<[string, number]>} kinds その群に出ている [種類, 件数]
 * @returns {'all'|'some'|'none'}
 */
function groupSel(kinds) {
  const shown = kinds.filter(([k]) => !store.hiddenKinds.has(k)).length;
  if (!shown) return 'none';
  return shown === kinds.length ? 'all' : 'some';
}

/**
 * 種類ごとの件数を、印の群ごとに束ねる。
 *
 * 並びは `MARK_GROUPS` の順。そこに無い種類（`compact`）は最後の「印なし」へ落とす。
 * **知らない種類も落とさない** … 群を持たないだけで、絞り込みからは選べる
 * （未知の形で落ちない、と同じ扱い）。
 *
 * @param {Map<string, number>} counts `countKinds` の結果
 * @returns {Array<{group: string, icon: ?string, label: string, kinds: Array<[string, number]>, n: number}>}
 */
function groupCounts(counts) {
  const buckets = new Map(MARK_GROUPS.map((g) => [g.group, { ...g, kinds: [], n: 0 }]));
  buckets.set('', { group: '', icon: null, label: '印なし', kinds: [], n: 0 });

  for (const [kind, n] of counts) {
    // 省略はチップに出さない（下の filterBar のコメントに理由）
    if (kind === 'elided') continue;
    const b = buckets.get(KIND_MARK[kind] ?? '') ?? buckets.get('');
    b.kinds.push([kind, n]);
    b.n += n;
  }
  return [...buckets.values()].filter((b) => b.kinds.length);
}

/**
 * 時系列パネルの取っ手を差し替える。
 *
 * @param {object} ref
 * @param {HTMLElement} ref.host 時系列の器（この中だけを replaceChildren する）
 * @param {HTMLElement|null} ref.count 見出しの件数を入れる節点
 * @param {Array} ref.items 間引き後の全 item
 * @param {number} ref.dropped 間引きで落ちた件数
 */
export function attach(ref) {
  tlRef = {
    host: ref.host,
    count: ref.count ?? null,
    // 書き換えを足跡から抜き出してから持つ。**filterBar にも同じものを通す**
    // （片方だけにすると、チップの件数と実際に出る行数が食い違う）
    items: splitEdits(ref.items ?? []),
    dropped: ref.dropped ?? 0,
  };
}

/**
 * 取っ手を捨てる。
 *
 * 詳細ペインを作り直す前に呼ぶ。作り直したあとの画面に無い節点を掴んだままにしない
 */
export function detach() {
  tlRef = null;
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
export function filterBar(all) {
  // attach() と同じ派生を通す。ここを素の items のままにすると、
  // 「ファイルの書き換え」のチップが出ないうえ、足跡の件数も割る前の数になる
  const items = splitEdits(all ?? []);
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

  // **押す口だけを別の器に入れる。**
  // 選択形式では1つ押すと他の札の見た目まで変わる（「これだけ」を選ぶので）ため、
  // 帯そのものを組み直す必要がある。入力欄まで巻き込むと、
  // 打っている途中の caret が消える ―― だから作り直す範囲をここに閉じる
  const picks = el('div', 'tl-picks');
  bar.append(picks);

  // 省略はチップに出さない。自分で選ぶ種類ではなく、間引きの副産物だから
  // （落としているのは groupCounts の中）。
  //
  // 目印の中身が隠している種類だけなら、目印も一緒に落としている（elidedAllHidden）。
  // つまり出るか出ないかは他のチップで決まる。それをチップにすると、実測した例では
  // 「省略 74」と出しながら1行も出ない状態になった（74 件すべてが足跡だけの区間で、
  // 足跡は既定で隠れているため）。押しても何も起きず、件数だけが嘘になる。
  //
  // 目印ごと消したい人は URL で指定できる（?hide=elided）。そちらは効いたままにする
  const groups = groupCounts(countKinds(items));
  // いま出うる種類すべて。「これだけを見る」と「最後の1つ」の判断に要る
  const every = groups.flatMap((g) => g.kinds.map(([k]) => k));

  const repaint = () => paintPicks(picks, groups, every, repaint);
  repaint();

  return bar;
}

/** 群の状態を title に書くときの言い方。 */
const SEL_NOTE = {
  all: '全部出しています',
  some: '一部だけ出しています',
  none: '隠しています',
};

/**
 * 押したあとの後始末。**3つを必ずこの順で。**
 *
 * 残すのは URL（`?hide=`）だけ。`localStorage` に覚えさせない理由は
 * `initialHiddenKinds` に書いた
 *
 * @param {() => void} repaint 帯を組み直す口
 */
function applyPick(repaint) {
  syncQuery();
  // 当てはまる件数が変わるので窓は先頭から出し直す
  render({ reset: true });
  repaint();
}

/**
 * 種類の札1枚。
 *
 * @param {string} kind 種類
 * @param {number} n 件数
 * @param {string[]} every いま出うる種類すべて
 * @param {() => void} repaint
 */
function kindChip(kind, n, every, repaint) {
  const chip = el('button', 'tl-chip', KIND_LABELS[kind] ?? kind);
  chip.type = 'button';
  chip.dataset.pick = `k:${kind}`;
  chip.append(el('span', 'n', num(n)));

  // 押した状態は「出している」を true とする。隠す種類を持つのは store 側の拒否リスト
  const shown = !store.hiddenKinds.has(kind);
  chip.setAttribute('aria-pressed', String(shown));
  chip.title = shown
    ? 'この種類だけを見る（Ctrl+クリックで足し引き）'
    : 'この種類を出す（Ctrl+クリックで足し引き）';

  chip.addEventListener('click', (ev) => {
    if (ev.ctrlKey || ev.metaKey) pickAdd([kind], shown, every);
    else pickOnly([kind], every);
    applyPick(repaint);
  });
  return chip;
}

/**
 * 群の札1枚。**常時見えているのはこれだけ。**
 *
 * @param {object} g `groupCounts` の1件
 * @param {string[]} every いま出うる種類すべて
 * @param {() => void} repaint
 */
function groupChip(g, every, repaint) {
  const chip = el('button', 'tl-gchip');
  chip.type = 'button';
  chip.dataset.pick = `g:${g.group}`;
  // 色は CSS が data-g で当てる。**印を持たない群（compact）には付けない**
  if (g.group) chip.dataset.g = g.group;
  if (g.icon) chip.append(icon(g.icon, 14));
  chip.append(document.createTextNode(g.label), el('span', 'n', num(g.n)));

  const sel = groupSel(g.kinds);
  chip.dataset.sel = sel;
  chip.title = `${g.label} — ${SEL_NOTE[sel]}。押すとこの群だけ、Ctrl+クリックで足し引き`;

  const keys = g.kinds.map(([k]) => k);
  chip.addEventListener('click', (ev) => {
    if (ev.ctrlKey || ev.metaKey) pickAdd(keys, sel === 'all', every);
    else pickOnly(keys, every);
    applyPick(repaint);
  });
  return chip;
}

/**
 * 細目（群の中の種類）。畳みの中に出す。
 *
 * @param {object[]} groups
 * @param {string[]} every
 * @param {() => void} repaint
 */
function subPanel(groups, every, repaint) {
  const sub = el('div', 'tl-sub');
  sub.append(el('p', 'tl-sub-lead', '群の中の種類。ここで1つ外すと、上の群は「一部」になります'));
  for (const g of groups) {
    const box = el('div', 'tl-group');
    if (g.group) box.dataset.g = g.group;
    // 群の頭。**押せない見出し**なので span で置く（押す口を増やさない）
    const head = el('span', 'gh');
    head.title = g.label;
    if (g.icon) head.append(icon(g.icon, 13));
    else head.append(el('span', null, '—'));
    box.append(head);
    for (const [kind, n] of g.kinds) box.append(kindChip(kind, n, every, repaint));
    sub.append(box);
  }
  return sub;
}

/**
 * 押す口を組み直す。
 *
 * **焦点を名前で拾い直す。** 節点ごと作り直すので、押した札は消える。
 * 拾い直さないと、キーボードで操作している人の焦点が毎回 body へ飛ぶ
 *
 * @param {HTMLElement} picks 差し替える器
 * @param {object[]} groups
 * @param {string[]} every
 * @param {() => void} repaint 自分自身
 */
function paintPicks(picks, groups, every, repaint) {
  const focused = document.activeElement?.dataset?.pick ?? null;
  picks.replaceChildren();

  const line = el('div', 'tl-gchips');
  for (const g of groups) line.append(groupChip(g, every, repaint));

  // 細目の畳み。**開閉は覚えない**（開くたび畳んだ状態から始める）。
  // 何が隠れているかは、上の群の札が三態で常に出しているので、
  // 「畳んだ札には中身を書く」は形のほうで満たしている
  const fold = el('button', 'btn tl-filter-btn');
  fold.type = 'button';
  fold.dataset.pick = 'fold';
  fold.setAttribute('aria-pressed', String(kindsOpen));
  fold.title = '群の中の種類まで出す';
  // 押せば何か出ることを絵で示す。開くと 90 度回る（起こすフォームの畳みと同じ作法）
  fold.append(icon('chevron', 13), el('span', null, '細目'));
  fold.addEventListener('click', () => {
    kindsOpen = !kindsOpen;
    repaint();
  });
  line.append(fold);

  // 外す口。**既定と違うときだけ出す。** 常に出していると、
  // 何も絞っていないのに外す口があることになる。
  //
  // **見た目は書庫の `.archive-clear` をそのまま借りる**（ピル型・--accent・絵だけ）。
  // あちらは `.archive-head` を親に取っていないクラス単体なので、ここでも効く。
  // 画面に「絞り込みを外す」が3箇所（書庫・数値・ここ）できたので、宣言は1つに保つ
  if (!isDefaultKinds()) {
    const clear = el('button', 'btn archive-clear');
    clear.type = 'button';
    clear.dataset.pick = 'clear';
    clear.title = '絞り込みを外す';
    clear.setAttribute('aria-label', '絞り込みを外す');
    clear.append(icon('x', 15));
    clear.addEventListener('click', () => {
      store.hiddenKinds = initialHiddenKinds();
      applyPick(repaint);
    });
    line.append(clear);
  }
  picks.append(line);

  if (kindsOpen) picks.append(subPanel(groups, every, repaint));

  // 消えた札（外す口）に焦点があったときは、畳みの札へ落とす
  const back = focused
    ? picks.querySelector(`[data-pick="${focused}"]`) ?? picks.querySelector('[data-pick="fold"]')
    : null;
  back?.focus();
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
export function render({ reset = false } = {}) {
  if (!tlRef) return;
  const t0 = performance.now();

  // 窓を先頭に戻すのは、頼まれたときとセッションを選び直したときだけ。
  // 追記で詳細が入れ替わるたびに戻すと、動いているセッションでは2秒ごとに巻き戻る
  if (reset || store.tlShownFor !== store.selected) {
    store.tlShown = TL_FIRST;
    store.tlShownFor = store.selected;
  }

  const all = tlRef.items;
  const matched = filterTimeline(all);
  const ordered = store.newestFirst ? [...matched].reverse() : matched;
  const shown = ordered.slice(0, Math.max(TL_FIRST, store.tlShown));
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
      store.tlShown = shown.length + TL_MORE;
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

  mark('timeline', t0);
}

/**
 * 渡された時系列をそのまま描いて返す。
 *
 * 絞り込み・窓・件数の見出しは付けない。サブエージェントの記録のように
 * 「開いたその場に出すだけ」の並びのための口。
 *
 * ctx に入れるのはラベルの差し替えだけ。rawUrl を渡さないのが要点で、
 * 原文の口は親ログの1行を返すものなので、子ログの uuid を投げても見つからない。
 * rawBlock は makeUrl が無ければ null を返すので、ここでは原文ボタンが出ない。
 *
 * プランの系譜も同じ理屈で出ない。lineageOf が uuid の一致を見るため、
 * 親のプランの系譜が子のプランに貼られることはない
 *
 * @param {Array<object>} items digest.items
 * @returns {HTMLElement} .timeline の器
 */
export function renderPlain(items = []) {
  const box = el('div', 'timeline');
  // 子ログでも書き換えは抜き出す。サブエージェントに任せた作業でこそ
  // 「何を触ったのか」が読みたい（親のログには結果しか残らない）
  for (const item of splitEdits(items)) box.append(timelineItem(item, { labels: SIDECHAIN_LABELS }));
  return box;
}
