/**
 * セッションのカードの共通部分。層2（`store` を見るのでここ）。
 *
 * 一覧（`list.js`）・書庫（`archive.js`）・数値（`usage-tab.js`）が
 * 同じ骨格を3回書いていた。完全に一致していた行がこれだけある。
 *
 * ```
 * card.type = 'button';
 * card.dataset.sessionId = row.sessionId ?? '';
 * if (!row.title) title.classList.add('is-empty');
 * if (row.project) meta.append(el('span', 'path', row.project));
 * if (meta.childElementCount > 0) card.append(meta);
 * ```
 *
 * ## 1本の buildCard に畳まない
 *
 * `public/CLAUDE.md` には「書庫のカードは `list.js` の `buildCard` を借りる」と
 * 書いてあったが、**実際には借りていなかった**（`archive.js` が独自に組んでいた）。
 * 実物を3つ並べて分かったのは、借りられなかった理由のほう:
 *
 * | | 上段に出すもの | 札 | 押したあと |
 * |---|---|---|---|
 * | 一覧 | 状態・名前・経過 | 権限モード・スキル・ctx | 引き出しを閉じる |
 * | 書庫 | 日時・ログの大きさ | スキル・サブエージェント | 作業台へ移る |
 * | 数値 | 実消費・要求の回数 | モデル・混在の断り | モードを移して選ぶ |
 *
 * **問いが違うので出すものが違う。** 1本に畳むと `variant` で分岐する塊になり、
 * どのカードに何が出るのかを読むのに3通りの分岐を追うことになる。
 *
 * だから畳むのは**定型だけ**。「何を出すか」は呼ぶ側に残す。
 */
import { el } from './util.js';
import { store } from './store.js';

/**
 * カードの器を作る。
 *
 * `type = 'button'` を忘れるとフォームの中で submit に化ける。
 * `dataset.sessionId` は、組み直さずに中身だけ差し替えるときの目印
 * （書庫が遅れて届いた数値を1枚だけ入れ替えるのに使う）。
 *
 * @param {object} row セッションの行
 * @param {object} [opts]
 * @param {string} [opts.variant] `is-archive` / `is-usage` など。付けなければ素の `.card`
 * @param {boolean} [opts.current] `aria-current` を付けるか。
 *   **数値のカードには付けない** ―― あちらは押すとモードごと移るので、
 *   「いま見ているもの」の意味が一覧・書庫と違う
 * @returns {{li: HTMLElement, card: HTMLElement}}
 */
export function cardShell(row, { variant = '', current = true } = {}) {
  const li = el('li');
  const card = el('button', variant ? `card ${variant}` : 'card');
  card.type = 'button';
  card.dataset.sessionId = row.sessionId ?? '';
  if (current) card.setAttribute('aria-current', String(row.sessionId === store.selected));
  return { li, card };
}

/**
 * カードの見出し。
 *
 * **`is-empty` を付ける判断は `row.title` の有無で決める。** 渡す `label` ではない
 * ―― あちらは「（まだ読んでいません）」のような代わりの文が入っているので、
 * 中身の有無を見分ける材料にならない。
 *
 * @param {object} row セッションの行
 * @param {string} label 出す文字。指示が無いときの代わりの文は呼ぶ側が決める
 * @returns {HTMLElement}
 */
export function cardTitle(row, label) {
  const title = el('div', 'card-title', label);
  if (!row.title) title.classList.add('is-empty');
  return title;
}

/**
 * 札の並びを閉じてカードへ付ける。**1枚も無ければ付けない。**
 *
 * 空の `.card-meta` を置くと、`gap` のぶんだけ隙間が空いて
 * カードの背が理由なく伸びる。
 *
 * @param {HTMLElement} card 付ける先
 * @param {HTMLElement} meta 札の器
 */
export function closeCardMeta(card, meta) {
  if (meta.childElementCount > 0) card.append(meta);
}

/**
 * 置き場所の札。3つのカードで同じものを出している。
 *
 * @param {object} row セッションの行
 * @returns {HTMLElement|null} `project` が無ければ null
 */
export function metaPath(row) {
  return row.project ? el('span', 'path', row.project) : null;
}

/**
 * git のブランチの札。**`HEAD` は出さない**（切り離された状態で、読み方が変わらない）。
 *
 * 一覧と書庫で同じ判定をしていた。
 *
 * @param {object} row セッションの行
 * @returns {HTMLElement|null}
 */
export function metaBranch(row) {
  const b = row.gitBranch;
  return b && b !== 'HEAD' ? el('span', 'tag', b) : null;
}
