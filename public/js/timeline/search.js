/* 検索と絞り込み。当てた箇所の目印、種類ごとの数え上げ、出す並びの決定。
 *
 * 検索の相手は item から作った1本の文字列（searchTextOf）。item ごとに WeakMap で
 * 覚えるので、1文字打つたびに作り直さない。
 *
 * 目印（markUp / marked / countHits）は blocks.js と item.js が使い、
 * 絞り込みの結果（filterTimeline / countKinds）は view.js が使う。
 */
import { el } from '../util.js';
import { store } from '../store.js';
import { KIND_LABELS, DECISION_KINDS } from './kinds.js';

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
export function markUp(text, needle) {
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
export function marked(tag, className, text, needle) {
  const node = el(tag, className);
  node.append(...markUp(text, needle));
  return node;
}

/** 検索語が何回出てくるか。markUp と同じ数え方（大小は無視、重なりは数えない） */
export function countHits(text, needle) {
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
 * 省略の目印が、隠している種類だけを数えたものか。
 *
 * 間引きで落ちた区間には `elided` を1件置いていて、そこには「20 件を省略しました　足跡 20」
 * のように何が落ちたかが書いてある。区間の中身が足跡だけだったとき、足跡を隠している人に
 * この行を出すのは筋が通らない。隠したのに「足跡」という文字だけが残るので、
 * 隠れていないように見える。
 *
 * 窓を 120 件にしていたときの実測では、足跡を隠した 120 件のうち 36 件がこれだった。
 * 本編（説明・指示）より省略の目印のほうが多く並ぶ状態になっていた。
 *
 * `byKind` が無い古い形は落とさない。中身が分からないものを黙って消さないため。
 *
 * @param {object} item 時系列の1件
 * @returns {boolean} 隠す側に回すなら true
 */
function elidedAllHidden(item) {
  if (item.kind !== 'elided') return false;
  const kinds = Object.keys(item.byKind ?? {});
  if (!kinds.length) return false;
  return kinds.every((k) => store.hiddenKinds.has(k));
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
export function filterTimeline(items) {
  let out = items;
  if (store.hiddenKinds.size) {
    out = out.filter((i) => !store.hiddenKinds.has(i.kind) && !elidedAllHidden(i));
  }
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
export function countKinds(items) {
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
