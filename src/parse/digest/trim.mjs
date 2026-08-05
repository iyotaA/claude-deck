/**
 * 時系列の間引き。上限を超えた分を落として、落とした位置に印を残す。
 *
 * 落とすのは説明文だけ。判断の記録（指示・選択・プラン・却下・圧縮）は落とさない。
 * 何を落とすかは limits.mjs の DROP_ORDER が決めていて、そこに無い種類は残る側に倒れる。
 */
import { MAX_ITEMS, MAX_TRACES, DROP_ORDER } from './limits.mjs';

/**
 * 上限を超えた分を落とし、落とした位置に省略の印（elided）を残す。
 *
 * 枠は2つ。足跡は MAX_TRACES の独立枠で、本編は MAX_ITEMS。
 * elided は**どちらの枠の外**に置く。枠の中だと、印を作るために本体をもう1件落とす循環になる
 *
 * @param {Array} items 組み終わった時系列
 * @returns {{items: Array, dropped: number}}
 */
export function trimItems(items) {
  const traces = items.filter((it) => it.kind === 'trace');
  const rest = items.length - traces.length;
  const drop = new Set();

  // 足跡は古いものから落とす。新しい足跡のほうが今の作業に近い
  for (let k = 0; k < traces.length - MAX_TRACES; k += 1) drop.add(traces[k]);

  let budget = rest - MAX_ITEMS;
  for (const kinds of DROP_ORDER) {
    if (budget <= 0) break;
    for (const item of items) {
      if (budget <= 0) break;
      if (drop.has(item) || !kinds.includes(item.kind)) continue;
      drop.add(item);
      budget -= 1;
    }
  }

  if (drop.size === 0) return { items, dropped: 0 };

  const out = [];
  let run = null;
  for (const item of items) {
    if (drop.has(item)) {
      // 連続して落ちた区間は1つの印にまとめる。1件ずつ印を出すと本体より数が増える
      if (!run) {
        // i は落ちた先頭の位置をそのまま使う。生き残った項目とはぶつからない
        run = { i: item.i, kind: 'elided', uuid: null, count: 0, fromAt: null, toAt: null, byKind: {} };
      }
      run.count += 1;
      run.byKind[item.kind] = (run.byKind[item.kind] ?? 0) + 1;
      if (typeof item.at === 'number') {
        if (run.fromAt === null) run.fromAt = item.at;
        run.toAt = item.at;
      }
      continue;
    }
    if (run) {
      out.push(run);
      run = null;
    }
    out.push(item);
  }
  if (run) out.push(run);

  return { items: out, dropped: drop.size };
}
