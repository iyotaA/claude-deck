/* 時系列の1行。
 *
 * 関数1つで 130 行あまりあるが、これは分けない。
 * 種類（tool / answer / plan / compact ...）ごとに何を出すかの分岐がこの関数の全部で、
 * 切ると「どの種類でどこに何が付くか」が読めなくなる。
 *
 * 行の中で使う部品は blocks.js と waits.js にある。ここは組み立ての順番だけを持つ。
 */
import { el, dur, num, hms, markUp, marked, countHits } from '../util.js';
import { labelOf } from './kinds.js';
import { waitBadge } from './waits.js';
import { bodyText, answerBlock, planBlock, rawBlock, whenNode } from './blocks.js';

/**
 * 時系列の1行。
 *
 * @param {object} item digest の item
 * @param {object} [ctx] 描くときの文脈。{needle} 検索語 / {rawUrl} 原文の取得先を作る関数
 */
export function timelineItem(item, ctx = {}) {
  const needle = ctx.needle ?? null;
  const row = el('div', 'tl');
  row.dataset.kind = item.kind;

  if (item.kind === 'compact') {
    const body = el('div', 'tl-body');
    const from = num(item.preTokens);
    const to = num(item.postTokens);
    const trigger = item.trigger === 'auto' ? '自動' : item.trigger ?? '';
    body.append(el('div', 'tl-text',
      `ここで文脈が圧縮されました（${from} → ${to} tokens${trigger ? ` / ${trigger}` : ''}）。これより前の細部は Claude 側にも残っていません`));
    const compactRaw = rawBlock(ctx.rawUrl, item.uuid);
    if (compactRaw) body.append(compactRaw);
    row.append(body);
    return row;
  }

  row.append(whenNode(item.at));
  const body = el('div', 'tl-body');
  const kindRow = el('div', 'tl-kind');
  kindRow.append(...markUp(labelOf(item.kind, ctx), needle));
  // 前のやり取りからの間。取れていない行には何も付かない
  const wait = waitBadge(item.wait);
  if (wait) kindRow.append(wait);
  body.append(kindRow);

  switch (item.kind) {
    // 自分の指示は判断の記録そのものなので、Claude の説明より長く出す
    case 'prompt':
      body.append(...bodyText(item.text, 900, 12, null, needle));
      break;
    case 'say':
      body.append(...bodyText(item.text, 260, 4, item.fullLength, needle));
      break;
    // Claude の自己申告。時系列でもその場で断ってから本文を出す
    case 'recap':
      body.append(el('p', 'note', 'Claude 自身が書いた中間報告です。機械的に抜き出した記録ではありません'));
      body.append(...bodyText(item.text, 600, 8, item.fullLength, needle));
      break;
    // 間引きで落ちた区間の目印。何が落ちたかまで出す（足跡だけの区間かどうかが読めるように）
    case 'elided': {
      const kinds = Object.entries(item.byKind ?? {})
        .map(([k, n]) => `${labelOf(k, ctx)} ${n}`)
        .join(' / ');
      const range = item.fromAt && item.toAt
        ? `（${hms(new Date(item.fromAt))} 〜 ${hms(new Date(item.toAt))}）`
        : '';
      body.append(el('div', 'tl-text',
        `${item.count} 件を省略しました${kinds ? `　${kinds}` : ''}${range}`));
      break;
    }
    // 選んだ理由（選択肢の説明文）は判断の記録そのものなので、時系列でも省かない
    case 'answer':
      for (const a of item.answers ?? []) body.append(answerBlock(a, false, needle));
      break;
    case 'plan':
      body.append(...planBlock(item, false, needle).childNodes);
      break;
    case 'denial':
      body.append(marked('div', 'tl-text', `${item.denialLabel} — ${item.tool}`, needle));
      if (item.detail) body.append(marked('pre', 'tl-detail', item.detail, needle));
      // note は定型文を除いた残り。自分が添えたコメントがあればここに出る
      if (item.note) body.append(marked('pre', 'tl-detail', item.note, needle));
      break;
    case 'interrupt':
      body.append(el('div', 'tl-text', 'ここで実行を止めた'));
      break;
    case 'skill':
      body.append(marked('div', 'tl-text', item.args ? `/${item.skill} ${item.args}` : `/${item.skill}`, needle));
      break;
    case 'agent':
      body.append(marked('div', 'tl-text',
        [item.agentType, item.description].filter(Boolean).join(' — ') || '(説明なし)', needle));
      break;
    case 'error':
      body.append(marked('div', 'tl-text', `${item.tool}${item.detail ? ` — ${item.detail}` : ''}`, needle));
      if (item.message) body.append(marked('pre', 'tl-detail', item.message, needle));
      break;
    case 'slash':
      body.append(marked('div', 'tl-text', item.args ? `${item.command} ${item.args}` : item.command, needle));
      break;
    // 足跡。assistant の1行につき1件で、並列に呼んだ分は calls にまとまっている。
    // 既定では畳んでおく。1件ずつ広げると、ここだけで画面が埋まって判断の記録が流れる
    case 'trace': {
      const tools = item.tools?.length ? item.tools.join(' / ') : 'ツール';
      const label = [
        `${tools}${item.count > 1 ? ` ×${item.count}` : ''}`,
        typeof item.durationMs === 'number' ? dur(item.durationMs) : null,
      ].filter(Boolean).join('　');
      const d = el('details', 'more trace');
      // 畳んだ中に検索語があるときは開いて出す。閉じたままだと語が見つからない
      const inner = (item.calls ?? [])
        .map((c) => [c.tool, c.detail, c.head].filter(Boolean).join(' '))
        .join('\n');
      const hits = countHits(inner, needle);
      d.append(marked('summary', null, hits ? `${label}　一致 ${num(hits)} 件` : label, needle));
      if (hits) d.open = true;

      const ul = el('ul', 'trace-calls');
      for (const c of item.calls ?? []) {
        const li = el('li');
        const line = el('div', 'trace-head');
        line.append(marked('span', 'mono', c.tool ?? '?', needle));
        if (c.detail) line.append(marked('span', 'trace-detail', c.detail, needle));
        if (c.pending) {
          // 結果が来ていない。いま止まっているのがここだと分かる
          line.append(el('span', 'trace-n', '結果を待っています'));
        } else {
          if (typeof c.durationMs === 'number') line.append(el('span', 'trace-n', dur(c.durationMs)));
          // 0 字と「測れなかった」を分ける。null のときは何も出さない
          if (typeof c.resultChars === 'number') line.append(el('span', 'trace-n', `${num(c.resultChars)} 字`));
        }
        li.append(line);
        // 結果の先頭だけ。中身が要るときは原文へ戻る
        if (c.head) li.append(marked('div', 'trace-result', c.head, needle));
        ul.append(li);
      }
      d.append(ul);
      body.append(d);
      break;
    }
    default:
      body.append(el('div', 'tl-text', JSON.stringify(item)));
  }

  // 原文へ戻る口。同じ assistant 行から複数の item が出るので、これは「この行を開く」意味になる
  const raw = rawBlock(ctx.rawUrl, item.uuid);
  if (raw) body.append(raw);

  row.append(body);
  return row;
}
