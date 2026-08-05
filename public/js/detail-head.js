/* 詳細ペインの頭。パネルを積むより前に出るもの。
 *
 * 層1。操作ボタンと「なぜこの作業をしているか」の2つ。
 * どちらもパネル（panel()）を使わないので、ここは util.js しか見ない。
 */
import { el, stamp } from './util.js';

/**
 * 詳細の操作ボタン。
 *
 * 指示を送り込むことはしない（非公開の仕組みに乗ると壊れやすい）。
 * 窓を前面に出すところまでやって、あとは本人が打つ。それで用は足りる。
 */
export function detailActions(row) {
  const box = el('div', 'detail-actions');
  const hint = el('span', 'hint');

  if (row.alive && row.pid) {
    const focus = el('button', 'btn', 'ターミナルを前面に');
    focus.type = 'button';
    focus.addEventListener('click', async () => {
      focus.disabled = true;
      hint.textContent = '呼んでいます…';
      try {
        const res = await fetch(`/api/focus?pid=${encodeURIComponent(row.pid)}`, { method: 'POST' });
        const data = await res.json();
        if (!data.ok) {
          hint.textContent = `出せません: ${data.reason}`;
        } else if (data.tabbed) {
          // 窓は前に出るがタブは選べない。出たつもりで待たせないよう、そこは正直に書く
          hint.textContent = `${data.app} を前面に出しました。タブの切り替えは手動でどうぞ`;
        } else {
          hint.textContent = `前面に出しました（${data.detail ?? ''}）`;
        }
      } catch (err) {
        hint.textContent = `出せません: ${err.message}`;
      } finally {
        focus.disabled = false;
      }
    });
    box.append(focus);
  }

  // 終了したセッションを開き直すときのコマンド。cwd を間違えると別のログになるので一緒に渡す
  if (row.sessionId) {
    const copy = el('button', 'btn', '再開コマンドをコピー');
    copy.type = 'button';
    const command = row.cwd
      ? `cd "${row.cwd}"; claude --resume ${row.sessionId}`
      : `claude --resume ${row.sessionId}`;
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(command);
        hint.textContent = 'コピーしました';
      } catch {
        hint.textContent = command;
      }
    });
    box.append(copy);
  }

  box.append(hint);
  return box;
}

/**
 * 「なぜこの作業をしているか」を先頭に畳んで置く。
 *
 * 下のパネルを読めば分かることでも、切り替えのたびに読み下すのは重い。
 * 目的と直近の判断だけを最初に見せて、続きは下で追えるようにする。
 */
export function summaryBlock(summary) {
  if (!summary || summary.source === 'error') return null;

  // 上のバーの .summary とは別物。名前を分けておかないと両方に同じ CSS が当たる
  const box = el('div', 'purpose');
  if (summary.headline) {
    box.append(el('div', 'purpose-head', summary.headline));
    // 出どころが Claude の中間報告なら、そう断る。
    // 機械的に抜き出した指示やタイトルと同じ重さに見せてはいけない（自己申告なので）
    if (summary.headlineSource === 'recap') {
      const mark = el('div', 'purpose-src');
      mark.append(el('span', 'claim', 'Claude の申告'));
      mark.append(document.createTextNode(summary.headlineAt
        ? `${stamp(summary.headlineAt)} 時点で Claude 自身が書いた中間報告です`
        : 'Claude 自身が書いた中間報告です'));
      box.append(mark);
    }
  }

  if (summary.compacted) {
    // 圧縮されている場合、上の見出しは本当の始まりではないかもしれない
    box.append(el('div', 'purpose-warn', '途中で文脈が圧縮されているため、これより前の指示は残っていません'));
  }

  if (summary.points?.length) {
    const dl = el('dl', 'purpose-points');
    for (const p of summary.points) {
      // 待ちの中身はすぐ下の「あなたの番」で大きく出すので、ここでは繰り返さない。
      // 要約データ側からは消さない（画面を持たない使い道でも状態が読めるように）
      if (p.label === '待っているもの') continue;
      dl.append(el('dt', null, p.label));
      dl.append(el('dd', null, p.text));
    }
    if (dl.childElementCount > 0) box.append(dl);
  }

  return box.childNodes.length ? box : null;
}
