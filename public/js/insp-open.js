/* 右の紙（インスペクタ）を開いて始めるか。
 *
 * 層0。**import ゼロの純関数**なので Node からテストできる（`test/insp-open.test.mjs`）。
 * `groups.js` / `next-step.js` と同じ形。読み込むときに `store.js` が1回だけ呼ぶ。
 * 材料（URL・覚えた開閉・窓の広さ）を集めて渡すのは `store.js` で、ここは決めるだけ。
 *
 * ## 決まり（画面刷新④の D10・D12）
 *
 * - **URL（`?insp=usage|basics`）が先。** 配ったブックマークを切らない。開いた紙の
 *   どれを見ているかまで URL が言っているので、覚えた開閉より強い
 * - URL が無ければ、**広い窓（1281px 以上）は覚えた開閉に従う**。覚えていなければ開く
 *   （右に数値が最初から見えている形が手本のモック。広い窓なら中央を削っても読める）
 * - **それより狭い窓は閉じて始める**（覚えた値を見ない）。1280px で一覧（27rem）と
 *   紙（23rem）を両方開くと、中央は約400px しか残らない（計算）
 *
 * **窓を広げ縮めしても開閉を動かさない**（見張らない）。一覧の開閉（`drawer.js`）と同じで、
 * 窓の広さで決めるのは始めの1回だけ。途中で勝手に開け閉めすると、読んでいる手元が
 * 窓の端を引いただけで動く。開いたまま狭くすれば、形だけが CSS で変わる
 * （861〜1280px は列のまま中央を削り、860px 以下は下から出る紙になる）。
 */

/**
 * 右の紙に出せるもの。**id は配った URL のまま**（`?insp=basics` は v0.6.0 で配っている。
 * 札と見出しは「診断」へ替えたが、id を変えるとブックマークが切れる）。
 *
 * 中央と分けてあるのは、これが「作業しながら横目で見るもの」だから。
 * 中央のタブに混ぜると、数字を見るために作業の手元（いま・経過）を隠すことになる。
 * 「成果」（out）は中央のタブへ戻した（`?insp=out` は `store.js` の `initialDetailTab` が読み替える）。
 */
export const INSPECTOR_TABS = new Set(['usage', 'basics']);

/** 覚えた開閉で開くとき・頭の「数値」の絵で初めて開くときに出す紙 */
export const INSP_DEFAULT_TAB = 'usage';

/**
 * 「広い窓」の境目。これ以上なら覚えた開閉で始め、未満なら閉じて始める。
 * 狭い窓のボトムシート（`narrow.css` の 860px 以下）より広い（テストが突き合わせている）
 */
export const INSP_WIDE_QUERY = '(min-width: 1281px)';

/**
 * 始めの右の紙。開くなら出す紙の id、閉じて始めるなら null。
 *
 * @param {object} [opts]
 * @param {string|null} [opts.insp] URL の `?insp=` の値（無ければ null）
 * @param {string|null} [opts.stored] 覚えた開閉（`localStorage` の `LS.inspOpen`。'1' / '0' / null）
 * @param {boolean} [opts.wide] 広い窓か（`INSP_WIDE_QUERY` に当たるか）
 * @returns {string|null}
 */
export function initialInspector({ insp = null, stored = null, wide = false } = {}) {
  if (INSPECTOR_TABS.has(insp)) return insp;
  if (wide !== true) return null;
  // 人が書き換えられる場所なので、'0' 以外は「閉じた」と読まない（既定の開くへ落とす）
  return stored === '0' ? null : INSP_DEFAULT_TAB;
}
