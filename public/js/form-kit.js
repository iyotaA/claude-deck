/**
 * 設定モーダルの作法で欄を組む小道具。層0（`util.js` だけ見る）。
 *
 * 起こすフォーム（層7）・続きを起こす口（層3）・替える窓（層3）が同じものを
 * 書き写していた。`run-view.js` には**言い訳のコメント**まで付いていた:
 *
 * > 層3 → 層7 の逆向きになる。10行に満たないのでこちらに持つ
 * > （共有するなら層0の util.js へ出すことになり、そちらのほうが影響が広い）
 *
 * 実際には `fillSelect` と `gridRow` の2つで**約 20 行 × 2ファイル**あり、
 * `fillSelect` の前2つは1文字も違わなかった。だから言われたとおり層0へ出す。
 * `util.js` を膨らませずに別ファイルにしたのは、これが「フォームの作法」という
 * ひとまとまりの関心だから。
 *
 * ## say と setBusy は畳まない
 *
 * 4ファイルに同じ名前で並んでいるが、**書き込む先も止める対象も全部違う。**
 *
 * | | say の書き先 | setBusy が止めるもの |
 * |---|---|---|
 * | `run-view.js` | `ops.msg` と `ops.swMsg` の2つ | `applyEnabled()` 経由（他の条件と併せて判断） |
 * | `run-resume.js` | `ui.msg` | 起こすボタン1つ |
 * | `run-form.js` | `dom.runformMsg` | 起こすボタン ＋ 本文欄（`blockReason()` も見る） |
 * | `settings.js` | `dom.settingsMsg` | 保存・テスト送信・フォルダの「足す」の3つ |
 *
 * `settings.js` の `say` は `tone` を素で入れる（他は `text ? tone : ''`）という差もある。
 * 引数で書き先を渡す形にすると呼ぶ側が毎回それを書くことになり、**いまより長くなる。**
 * 本体が2行なので、寄せて得るものが無い。
 */
import { el } from './util.js';

/**
 * `<select>` の中身を入れ替える。
 *
 * `danger` を持つ項目には印を付ける。**値そのもの（`bypassPermissions`）で
 * 判定しない** ―― 語彙が増えたときにここも直すことになるので、
 * 危ないかどうかはサーバー側（`/api/runs/options`）が言う。
 *
 * 印を使うのは起こすフォームだけだが、判定を全員に持たせておく。
 * 持っていない側では `it.danger` が undefined なので何も起きない。
 *
 * @param {HTMLSelectElement} sel 入れ替える先
 * @param {Array<{value: string, label: string, danger?: boolean}>} items 候補
 */
export function fillSelect(sel, items) {
  sel.replaceChildren();
  for (const it of items) {
    const opt = el('option', null, it.label);
    opt.value = it.value;
    if (it.danger) opt.dataset.danger = '1';
    sel.append(opt);
  }
}

/**
 * 3列のグリッドに1行足す。**設定モーダルの `.settings-grid` をそのまま借りている。**
 *
 * `forId` を渡すのは、欄が器（`.settings-row`）に包まれていて
 * `control` 自身に id を振れないとき（モデルの「自分で入力」がそれ）。
 *
 * @param {HTMLElement} grid 足す先
 * @param {string} id 振る id。`forId` を渡したときは使わない
 * @param {string} text ラベルの文字
 * @param {HTMLElement} control 欄そのもの
 * @param {string} hint 下に出す一言
 * @param {string} [forId] ラベルが指す先を明示するとき
 */
export function gridRow(grid, id, text, control, hint, forId = '') {
  const lb = el('label', 'settings-label', text);
  if (forId) {
    lb.htmlFor = forId;
  } else {
    control.id = id;
    lb.htmlFor = id;
  }
  grid.append(lb, control, el('p', 'settings-hint', hint));
}
