/* 層0。アイコンの形と、それを節点にする口。
 *
 * この画面は `innerHTML` を1文字も使わないので、SVG も `createElementNS` で組む。
 * その口は `util.js` の `svgEl()`（もとは `usage-chart.js` にあった）。
 *
 * 形はすべて 16 四方の座標で書く。線は `currentColor`・太さ 1.5・塗りなしで揃える。
 * 置いた場所の字の色をそのまま継ぐので、状態色（`--warn` など）がそのまま乗る。
 *
 * **絵文字にしない。** あちらは自分の色を持つので色が乗らない（`run.css` の
 * 予算切れの印を絵文字にしなかったのと同じ理由）。
 *
 * これは層0 なので、`util.js` 以外を import しない。
 */

import { svgEl } from './util.js';

/**
 * 名前 → 中に置く子の並び。`[要素名, 属性]` の組で持つ。
 *
 * パスの文字列だけにしないのは、円や矩形が混ざるアイコンがあるため
 * （`contrast` は円＋半分の塗り、`deck` は矩形＋線）。
 *
 * **設定を歯車にしない。** 16px では歯が潰れて太陽に見える（実測）。
 * 横スライダーも試したが、線の太さ 1.5 に対してつまみの円との隙間が
 * 0.25 しか取れず、線と円がつながって「多」の字に見えた。
 * 縦のフェーダー2本なら、交わる形そのものがつまみになるので潰れない。
 */
const ICONS = {
  // 起こす
  plus: [
    ['path', { d: 'M8 3.2v9.6M3.2 8h9.6' }],
  ],
  // 再読み込み
  refresh: [
    ['path', { d: 'M13.4 7.2A5.6 5.6 0 1 0 12.6 11.2' }],
    ['path', { d: 'M13.9 3.1v4.3h-4.3' }],
  ],
  // 設定。つまみは縦線を中心に左右 1.6 ずつ。
  // これより長くすると縦線2本の間が埋まって「艹」の字に見える（実測）
  sliders: [
    ['path', { d: 'M5.4 2.4v11.2M10.6 2.4v11.2' }],
    ['path', { d: 'M3.8 5.8h3.2M9 10.6h3.2' }],
  ],
  // 配色を切り替える
  contrast: [
    ['circle', { cx: 8, cy: 8, r: 5.8 }],
    ['path', { d: 'M8 2.2a5.8 5.8 0 0 1 0 11.6z', fill: 'currentColor', stroke: 'none' }],
  ],
  // 一覧を開く（狭い画面のハンバーガー）
  menu: [
    ['path', { d: 'M2.6 4.4h10.8M2.6 8h10.8M2.6 11.6h10.8' }],
  ],
  // 更新する
  download: [
    ['path', { d: 'M8 2.4v7.6' }],
    ['path', { d: 'M4.9 7.1L8 10.2l3.1-3.1' }],
    ['path', { d: 'M2.8 13.2h10.4' }],
  ],
  // 設定モーダルの左ナビ。通知
  bell: [
    ['path', { d: 'M4.8 7.1a3.2 3.2 0 0 1 6.4 0c0 2.5.9 3.4 1.3 3.8H3.5c.4-.4 1.3-1.3 1.3-3.8z' }],
    ['path', { d: 'M6.7 13a1.4 1.4 0 0 0 2.6 0' }],
  ],
  // 同じく。作業フォルダ。**起こすフォームのラベルでも使う**ので、
  // どちらかの都合で形を変えない
  folder: [
    ['path', { d: 'M2.1 12.3V4.5a.9.9 0 0 1 .9-.9h2.9l1.5 1.7h5.6a.9.9 0 0 1 .9.9v6.1a.9.9 0 0 1-.9.9H3a.9.9 0 0 1-.9-.9z' }],
  ],
  // 同じく。いまの様子。
  // **点と棒の隙間は 1.4 しか取れない**（16px では 1.4px）。歯車が太陽に見えたのと
  // 同じ壊れ方の側にいる形なので、触るときは必ず 16px で見ること
  info: [
    ['circle', { cx: 8, cy: 8, r: 5.7 }],
    ['path', { d: 'M8 7.7v3.2' }],
    ['path', { d: 'M8 5.2h.01' }],
  ],
  // 題名の脇の印。カードが重なった形
  deck: [
    ['rect', { x: 1.4, y: 4.2, width: 7.2, height: 9.4, rx: 1.2 }],
    ['path', { d: 'M6.2 2.4h6.5a1.2 1.2 0 0 1 1.2 1.2v7.8' }],
  ],
};

/**
 * アイコンの節点を作る。
 *
 * `aria-hidden` を必ず付ける。名前は隣の文字か、押しボタン側の
 * `aria-label` が持つ約束なので、絵のほうを読み上げに乗せると二重になる。
 *
 * 知らない名前でも落ちない。空の `<svg>` を返す（`null` を返すと
 * 呼ぶ側の `append()` が「null」という文字を画面へ入れてしまう）。
 *
 * @param {string} name `ICONS` の鍵
 * @param {number} [size] 一辺の px。既定 16
 * @returns {SVGElement}
 */
export function icon(name, size = 16) {
  const svg = svgEl('svg', {
    class: 'icon',
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.5,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  for (const [tag, attrs] of ICONS[name] ?? []) svg.append(svgEl(tag, attrs));
  return svg;
}
