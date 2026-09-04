/**
 * `<dialog>` の開閉の作法。層0（何も import しない）。
 *
 * この画面のモーダルは5枚ある（設定・起こすフォーム・替える窓・Ctrl+K・拡大）。
 * どれも `<dialog>` ＋ `showModal()` で、**Esc・背面の膜・焦点の閉じ込めがタダで付く**
 * のがその選択の理由（`public/CLAUDE.md`）。
 *
 * その作法のうち「背面を押したら閉じる」だけは自分で配線する必要があり、
 * **5枚すべてに同じ3行と同じ2行のコメントが書き写されていた。**
 *
 * ## showModal は畳まない
 *
 * 開く前の準備が5枚とも違う。設定は中身を3本の窓口から引き、起こすフォームは
 * 畳んだ状態へ戻し、替える窓は行の値を流し込み、Ctrl+K は候補を組み直し、
 * 拡大は詳細ペインの節点ごと運ぶ。
 * **共通しているのは `showModal()` の1行だけ**なので、寄せて得るものが無い。
 */

/**
 * 背面を押したら閉じる。
 *
 * **`ev.target === dlg` で本当に背面かを見る。** `<dialog>` は中身も自分の子なので、
 * 素で click を拾うとボタンを押しただけで閉じる。
 *
 * この判定が効くのは、**モーダル自身が余白を持っていないから。**
 * `padding` を持たせると、その余白を押したのが背面を押したのと区別できなくなる
 * （`settings.css` / `run.css` / `palette.css` / `zoom.css` がどれも `padding: 0`）。
 * 余白は中身の側（`.settings-body` など）に持たせる。
 *
 * @param {HTMLDialogElement} dlg 配線する先
 * @param {Function} [onClose] 閉じ方を差し替える。
 *   拡大（`zoom.js`）は節点を詳細ペインへ戻す後始末があるので `closeZoom` を渡す。
 *   渡さなければ素の `close()`
 */
export function closeOnBackdrop(dlg, onClose = null) {
  dlg.addEventListener('click', (ev) => {
    if (ev.target !== dlg) return;
    if (onClose) onClose();
    else dlg.close();
  });
}
