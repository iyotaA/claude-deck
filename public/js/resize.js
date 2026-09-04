/* 作業台の左右の幅。つまみをドラッグして列の幅を変える。
 *
 * 層2。`drawer.js` と同じ位置で、**画面の骨だけ触る**（一覧も詳細も知らない）。
 * 配線するのは `main.js`。
 *
 * **上下限は CSS が持つ**（`base.css` の `--list-col` / `--insp-col` の clamp）。
 * 動かしているあいだ、ここが書くのは生の px 1つだけ。窓が狭いときの蓋
 * （`min(…, 40vw)`）も CSS 側なので、窓をリサイズすればその場で効き直す。
 * JS で窓幅を測って自分で丸めると追いつかない。
 *
 * **既定へ戻すときは値を書かない。** インラインの変数を削るだけにする。
 * こちらに既定値を持つと `base.css` の `:root` と二重管理になり、片方だけ古くなる。
 *
 * 監視盤・数値モードと狭い画面には効かない。あちらは `.deck` の列を丸ごと
 * 上書きしていて変数を見ないし、つまみ自体も CSS で消えている。
 */
import { dom } from './dom.js';

/** 矢印キー1回で動かす px。Shift を押していれば4倍 */
const STEP = 16;

/**
 * 左右それぞれの取り決め。
 *
 * `sign` は「つまみを右へ動かしたとき幅が増えるか」。
 * 左のペインは増えるが、右のインスペクタは減る。
 *
 * `pane` を関数にしているのは、`dom` が import 時に一度だけ引いた参照でも、
 * つまみを配線する時点で null かどうかを見たいため。
 */
const SIDES = {
  list: { varName: '--list-w', key: 'claude-deck.listW', pane: () => dom.listPane, sign: 1 },
  insp: { varName: '--insp-w', key: 'claude-deck.inspW', pane: () => dom.insp, sign: -1 },
};

/**
 * 幅を当てる。**覚えるのは別**（`commit`）。
 *
 * **有限の数でなければ何もしない。** 変な値が `--list-w` に入ると `clamp()` ごと
 * 無効になり、`grid-template-columns` が丸ごと落ちて列が消える。
 *
 * @param {object} side `SIDES` の1つ
 * @param {number} px 幅
 */
function apply(side, px) {
  if (!Number.isFinite(px)) return;
  document.documentElement.style.setProperty(side.varName, `${Math.round(px)}px`);
}

/**
 * いま出ている幅を覚える。
 *
 * **生の px ではなく、clamp を通ったあとの実際の幅を書く。** 端まで引っ張ると
 * 生の値は範囲の外へ出ていく（実測で `-556px` まで行った）。それを覚えると、
 * 次に開いたとき「読めない値」として捨てるか、範囲外の値を持ち続けるかの
 * どちらかになり、**下限に張り付けていたつもりが既定の幅に戻る。**
 * 出ている幅を覚えれば、開き直したときに見えていたとおりになる。
 *
 * 上下限は CSS が決めたままなので、こちらに範囲を書き写すことにはならない。
 * 変数も同じ値へ揃えて、覚えているものと出ているものを食い違わせない。
 *
 * 覚えるのは1回のドラッグにつき1回（`pointermove` ごとには書かない）。
 *
 * @param {object} side `SIDES` の1つ
 */
function commit(side) {
  const pane = side.pane();
  if (!pane) return;
  const px = Math.round(pane.getBoundingClientRect().width);
  // 0 は列が消えているとき（監視盤・数値モード）の値。覚える意味が無い
  if (!Number.isFinite(px) || px <= 0) return;
  const value = `${px}px`;
  document.documentElement.style.setProperty(side.varName, value);
  localStorage.setItem(side.key, value);
}

/**
 * 既定へ戻す。**値は書かない**（`base.css` の `:root` に任せる）。
 * @param {object} side `SIDES` の1つ
 */
function reset(side) {
  document.documentElement.style.removeProperty(side.varName);
  localStorage.removeItem(side.key);
}

/**
 * 覚えている幅を当てる。
 *
 * 読めない値は捨てる（`apply` と同じ理由。ここは人が手で書き換えられる場所なので、
 * 数として読めないものが入っていても列を落とさない）。
 *
 * @param {object} side `SIDES` の1つ
 */
function restore(side) {
  const raw = localStorage.getItem(side.key);
  if (!raw) return;
  const px = Number.parseFloat(raw);
  if (!Number.isFinite(px) || px <= 0) {
    localStorage.removeItem(side.key);
    return;
  }
  document.documentElement.style.setProperty(side.varName, `${Math.round(px)}px`);
}

/**
 * 掴んで動かす。
 *
 * **掴んだ時点の幅とマウスの位置を覚えて差分で動かす。** いまのマウスの位置から
 * ペインの端までを幅にすると、つまみの端を掴んだぶんだけ最初に飛ぶ。
 *
 * 待つのは window。つまみの上だけを見ていると、勢いよく動かしたときに
 * ポインタが先へ出てしまう。
 *
 * `setPointerCapture` は付けられれば付ける（掴んでいるあいだ当たり判定を
 * つまみへ寄せられる）が、**付かなくても動く形にしてある。** あれは相手の
 * ポインタが既に離れていると例外を投げるので、そこで丸ごと止めない。
 *
 * @param {object} side `SIDES` の1つ
 * @param {HTMLElement} knob つまみ
 * @param {PointerEvent} ev
 */
function startDrag(side, knob, ev) {
  const pane = side.pane();
  if (!pane) return;

  ev.preventDefault();
  const startX = ev.clientX;
  const startW = pane.getBoundingClientRect().width;
  try {
    knob.setPointerCapture(ev.pointerId);
  } catch {
    // 掴めなくても差分で動かせる
  }
  document.documentElement.classList.add('is-resizing');

  const move = (e) => apply(side, startW + side.sign * (e.clientX - startX));
  const done = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', done);
    window.removeEventListener('pointercancel', done);
    document.documentElement.classList.remove('is-resizing');
    commit(side);
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', done);
  window.addEventListener('pointercancel', done);
}

/**
 * キーでも動かす。マウスを持たない人と、細かく詰めたい人のため。
 *
 * 基準は「いま実際に出ている幅」（`getBoundingClientRect`）にする。覚えている値を
 * 基準にすると、clamp で丸められているときに1回目の押しが跳ねる。
 *
 * @param {object} side `SIDES` の1つ
 * @param {KeyboardEvent} ev
 */
function onKey(side, ev) {
  const pane = side.pane();
  if (!pane) return;

  if (ev.key === 'Home') {
    ev.preventDefault();
    reset(side);
    return;
  }

  let dir = 0;
  if (ev.key === 'ArrowRight') dir = 1;
  if (ev.key === 'ArrowLeft') dir = -1;
  if (!dir) return;

  ev.preventDefault();
  const step = STEP * (ev.shiftKey ? 4 : 1);
  apply(side, pane.getBoundingClientRect().width + side.sign * dir * step);
  commit(side);
}

/**
 * つまみを配線する。`main.js` から1回だけ呼ぶ。
 *
 * 覚えている幅を当てるのは、つまみが見つからなくてもやる
 * （HTML からつまみを外しても、前に決めた幅は生きているほうが自然）。
 */
export function initResize() {
  for (const [name, side] of Object.entries(SIDES)) {
    restore(side);

    const knob = document.getElementById(`split-${name}`);
    if (!knob) continue;
    knob.addEventListener('pointerdown', (ev) => startDrag(side, knob, ev));
    knob.addEventListener('keydown', (ev) => onKey(side, ev));
    // 両側で使い慣れられている「二度押しで既定へ」。Home と同じ行き先
    knob.addEventListener('dblclick', () => reset(side));
  }
}
