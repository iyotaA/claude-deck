/* 画面のモードの出し入れ。
 *
 * 層7。作業台・書庫・数値の3つを切り替え、骨格の目印（.app のクラス）を付け替える。
 * 札は左のレール（`nav.navrail`）にあり、名前とキーの出どころは `nav.js` の `MODE_LIST`。
 * 上のバーの題（`#page-title`）にいまのモードの名前を入れるのもここ。
 *
 * **もとは board.js（監視盤）だった。** 監視盤は畳んだ。
 * あれは左の一覧とまったく同じ store.rows を4つの列へ振り分けるだけで、
 * 並べ替えもしていなかった。同じ問いに画面いっぱいを使っていたので、
 * 列を畳んで一覧の状態の見出し（list.js の buildGroupHead）に替えてある。
 *
 * 出す中身は自分で持たない。書庫は archive.js、数値は usage-tab.js が持っていて、
 * どちらも initMode({ onArchive, onUsage }) で外から差す
 * （同じ層7 どうしなので、向きを持たせずに済む形を選ぶ）。
 */
import { store, MODES, syncQuery } from './store.js';
import { dom } from './dom.js';
import { MODE_LIST, modeOfKey, modeName, modeTip } from './nav.js';
import { closeListAfterPick } from './drawer.js';
import { renderDetailIfNeeded } from './detail.js';
import { loadDetail } from './session.js';
import { renderList } from './list.js';

/** 数値モードに入ったときに呼ぶもの。main.js が showUsage を差す */
let onUsage = null;

/** 書庫モードに入ったときに呼ぶもの。main.js が showArchive を差す */
let onArchive = null;

/**
 * モードの id → レールの札。節点は dom.js の索引から引く（ここで探し直さない）。
 * @returns {Record<string, HTMLElement>}
 */
function modeButtons() {
  return { work: dom.modeWork, archive: dom.modeArchive, usage: dom.modeUsage };
}

/**
 * モードを切り替える。
 *
 * いまの札の正は aria-current 1つ。旗を2箇所に持たない。
 * **ほかの札からは属性ごと外す。** `aria-current="false"` を残す書き方もあるが、
 * 外すほうが「いまの場所は1つ」が字面でも読める。
 * 開き方の指定を URL に残すので、書庫や数値のままブックマークできる。
 *
 * 出す側を1つ選んで残りは全部隠す形にする。二値の三項に畳まない
 * （知らない値が黙って作業台へ落ちるのと、1つ足した日に書き換え忘れるのを避ける）。
 *
 * @param {string} mode MODES のどれか。知らない値は 'work' に落とす
 * @param {object} [opts]
 * @param {boolean} [opts.sync] URL を書き換えるか（起動時だけ false）
 */
export function setMode(mode, { sync = true } = {}) {
  const next = MODES.has(mode) ? mode : 'work';
  // 実際に替わったかを先に測る。起動時と押し直しで作業台を描き直さないため
  const changed = store.mode !== next;
  store.mode = next;
  const archive = next === 'archive';
  const usage = next === 'usage';

  // 目印は .app に付ける（.is-list-open と同じ流儀）。骨格の組み替えは
  // archive.css の .is-archive と usage-mode.css の .is-usage が受け持つ
  dom.app.classList.toggle('is-archive', archive);
  dom.app.classList.toggle('is-usage', usage);
  const buttons = modeButtons();
  for (const m of MODE_LIST) {
    if (m.id === next) buttons[m.id]?.setAttribute('aria-current', 'page');
    else buttons[m.id]?.removeAttribute('aria-current');
  }
  // 上のバーの題。レールの札は絵だけなので、いまどこにいるかを字で言うのはここ
  dom.pageTitle.textContent = MODE_LIST.find((m) => m.id === next)?.label ?? '';
  dom.archiveHead.hidden = !archive;
  dom.archive.hidden = !archive;
  dom.usageHead.hidden = !usage;
  dom.usage.hidden = !usage;
  if (sync) syncQuery();

  if (archive || usage) {
    // 引き出しを開けっぱなしにしない。一覧そのものが消えるので、
    // 開いたままだと中身の無い紙と膜だけが画面に残る
    closeListAfterPick();
    // どちらも開いたときだけ引く。書庫は /api/archive、数値は /api/usage で、
    // どちらもファイルを開く窓口なので見ているあいだ撃ち続けない
    // （書庫は検索語が変わったときだけ引き直す）
    if (archive) onArchive?.();
    else onUsage?.();
    return;
  }

  // 書庫・数値のあいだ、中央と左は描いていない（apply() が飛ばしている）ので、
  // 戻るときに追いつかせる。**替わったときだけ。** 起動時や押し直しでも払うと、
  // 作業台で「作業台」を押すたびに開いた <details> と打ちかけの文が消える
  if (!changed) return;
  if (store.meta) renderList();
  renderDetailIfNeeded();
  // カードから来たときは select() も撃つので fetch が2本になる。1本目は detailToken が
  // 捨てるだけの無駄だが、**それでも撃つ。** 撃たないと、選び直し（select() が早期 return
  // する経路）で戻ったときに監視盤のあいだ止めていた分がそのまま出て、次の push まで
  // 2秒古い内容を見せることになる。見える遅れより見えない1本を取る
  loadDetail(store.selected, { silent: true });
}

/**
 * 焦点が入力欄にあるか。数字キーを効かせない判定に使う（判断そのものは nav.js の modeOfKey）。
 *
 * contenteditable は属性の有無ではなく `isContentEditable` で見る
 * （`contenteditable="false"` の子まで入力欄と読まないため）。
 *
 * @param {EventTarget|null} target キーの出来事の行き先
 * @returns {boolean}
 */
function isEditable(target) {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select')) return true;
  return target instanceof HTMLElement && target.isContentEditable;
}

/**
 * レールの札に名前と吹き出しを入れる。**名前は nav.js の MODE_LIST から**
 * （index.html に書き写さない）。どの札が件数を名前に持つかも nav.js が知っていて
 * （`counts`）、ここは件数を「まだ知らない」（null）で渡すだけ。
 * 件数を持つ札（作業台）は、一覧が届いたあと list.js の renderRailBadge() が書き替える。
 */
function labelButtons() {
  const buttons = modeButtons();
  for (const m of MODE_LIST) {
    const btn = buttons[m.id];
    if (!btn) continue;
    btn.setAttribute('aria-label', modeName(m, null));
    btn.dataset.tip = modeTip(m, null);
    // 読み上げにもキーを渡す（吹き出しは目で読む人にしか届かない）
    btn.setAttribute('aria-keyshortcuts', m.key);
  }
}

/**
 * 配線。main.js から1回だけ呼ぶ。
 *
 * @param {object} [opts]
 * @param {() => void} [opts.onUsage] 数値モードに入ったときに呼ぶもの。
 *   usage-tab.js の showUsage を差す（**こちらから import しない。**
 *   同じ層7 なので、向きを持たせずに済む形を選ぶ）
 * @param {() => void} [opts.onArchive] 書庫モードに入ったときに呼ぶもの。
 *   archive.js の showArchive を差す（onUsage と同じ理由）
 */
export function initMode({ onUsage: fn = null, onArchive: fnArchive = null } = {}) {
  onUsage = fn;
  onArchive = fnArchive;
  labelButtons();
  const buttons = modeButtons();
  for (const m of MODE_LIST) {
    buttons[m.id]?.addEventListener('click', () => setMode(m.id));
  }

  // 数字キー（1・2・3）。**効かせない場面の判断は nav.js の modeOfKey が持つ。**
  // ここは DOM から「入力欄か」「モーダルが開いているか」を測って渡すだけ。
  // いまと同じモードへのキーは何もしない（押しっぱなしの連打で書庫を引き直さない）
  document.addEventListener('keydown', (ev) => {
    const next = modeOfKey(ev, {
      editable: isEditable(ev.target),
      modal: document.querySelector('dialog[open]') !== null,
    });
    if (!next || next === store.mode) return;
    ev.preventDefault();
    setMode(next);
  });

  // ?mode=archive / ?mode=usage で開いたときのために1回当てる。
  // 起動時に URL は書き換えない
  setMode(store.mode, { sync: false });
}
