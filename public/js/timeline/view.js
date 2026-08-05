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
import { KIND_LABELS, SIDECHAIN_LABELS } from './kinds.js';
import { filterTimeline, countKinds } from './search.js';
import { rawUrlFor } from './blocks.js';
import { timelineItem } from './item.js';

/**
 * 最初に出す件数。
 *
 * 時系列は詳細のいちばん縦に長い場所で、下にあるサブエージェントの記録や
 * ファイルへ行くのに何度もスクロールすることになっていた。
 *
 * 件数で数えると短く見えるが、1行の高さがそろっていないので当てにならない。
 * 指示（prompt）は最大12行、Claude の説明は最大4行、省略の目印は1行。
 * 12 件にしたときの実測で目標の3倍の高さがあったので、4 件まで落とした。
 *
 * 全件を前もって組むと初回の描画も重い（400件級のセッションがある）ので、
 * 窓を掛けて末尾のボタンで継ぎ足す形はそのまま残す
 */
const TL_FIRST = 4;

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
export function detach() {
  tlRef = null;
}

/**
 * 目次の件数の差し替え先を教える。
 *
 * パネルが3枚に届かないと目次自体が出ないので、null が来ることもある
 * @param {HTMLElement|null} node
 */
export function setNav(node) {
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
export function filterBar(all) {
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
  // 目次の件数も絞り込みで動く。放っておくと古い数が上に残る
  if (tlRef.nav) tlRef.nav.textContent = num(matched.length);

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
  for (const item of items) box.append(timelineItem(item, { labels: SIDECHAIN_LABELS }));
  return box;
}
