/* 詳細ペインの、パネルを使わない部品。
 *
 * 層1。操作ボタン（頭に出す）と「なぜこの作業をしているか」（「いま」タブの先頭に出す）の2つ。
 * どちらもパネル（panel()）を使わないので、ここは util.js しか見ない。
 * どこに置くかは detail.js が決める（目的は前は頭のすぐ下＝タブ帯より上だった）。
 */
import { el, stamp } from './util.js';
import { icon } from './icons.js';
import { postJson } from './api.js';

/**
 * ターミナルの窓を前面に出す。
 *
 * 詳細ペインのボタンとパレット（Ctrl+K）が同じ口を通る。
 * 返すのは画面に出す1行だけで、出す場所は呼ぶ側が決める。
 *
 * **投げない。** 失敗も文にして返す。押した側は必ず何か書けるので、
 * 押したのに何も起きないという見え方にならない
 *
 * @param {number} pid 出したい窓を持っているプロセス
 * @returns {Promise<string>} 結果を伝える1行
 */
export async function focusTerminal(pid) {
  try {
    const { data } = await postJson(`/api/focus?pid=${encodeURIComponent(pid)}`);
    if (!data?.ok) return `出せません: ${data?.reason ?? '応答が読めません'}`;
    // 窓は前に出るがタブは選べない。出たつもりで待たせないよう、そこは正直に書く
    if (data.tabbed) return `${data.app} を前面に出しました。タブの切り替えは手動でどうぞ`;
    return `前面に出しました（${data.detail ?? ''}）`;
  } catch (err) {
    return `出せません: ${err.message}`;
  }
}

/**
 * 押した結果の一言。**節点ではなくここに持つ。**
 *
 * 頭は `detailKeyOf()` が動くたびに作り直されるので（動いているセッションでは数秒おき）、
 * 一言を節点にだけ書くと、読む前に消える。セッションごとに1つ控えて、組み直すたびに書き戻す。
 * 別のセッションへ移れば出さない（他人の結果を出さない）。
 */
let lastHint = { sessionId: null, text: '' };
/** いま画面に出ている一言の節点と、そのセッション。await のあいだに組み直されても新しいほうへ書く */
let hintNode = null;
let hintSession = null;

/**
 * 一言を控えて、いま出ている節点にも書く。
 * @param {string} sessionId 押したときのセッション
 * @param {string} text
 */
function sayHint(sessionId, text) {
  lastHint = { sessionId, text };
  if (hintNode?.isConnected && hintSession === sessionId) hintNode.textContent = text;
}

/**
 * 詳細の頭の右上に並べる操作のうち、ここが組むもの（コピー・次の一手・押した結果の一言）。
 *
 * ☆・✎・数値は `detail.js` が組んで前に並べる（ピンとメモは層2の `marks.js`、
 * 数値は右の紙の開け閉めで、どれも層1のここからは呼べない）。
 *
 * 指示を送り込むことはしない（非公開の仕組みに乗ると壊れやすい）。
 * 窓を前面に出すところまでやって、あとは本人が打つ。それで用は足りる。
 *
 * 作り直しで消えても焦点が戻るよう、押せるものには `data-refocus` を付ける
 * （拾い直すのは `detail.js` の `renderDetail`）。
 *
 * @param {object} row 一覧の行と同じ形のもの
 * @param {{kind: string, label: string, title: string, lead: boolean}|null} step
 *   次の一手（`next-step.js` の `nextStep` が決める）。出さないなら null
 * @returns {HTMLElement[]} 右上の群へ並べる順の節点
 */
export function detailActions(row, step) {
  const out = [];
  const sessionId = row.sessionId;

  // 終了したセッションを開き直すときのコマンド。cwd を間違えると別のログになるので一緒に渡す。
  // **絵だけにする**（どの場面でも出るので、字を持たせると次の一手より目立つ）。
  // 名前は title と aria-label が持ち、title には中身のコマンドも添える（押す前に読める）
  if (sessionId) {
    const command = row.cwd
      ? `cd "${row.cwd}"; claude --resume ${sessionId}`
      : `claude --resume ${sessionId}`;
    const copy = el('button', 'ibtn detail-copy');
    copy.type = 'button';
    copy.dataset.refocus = 'copy';
    copy.setAttribute('aria-label', '再開コマンドをコピー');
    copy.title = `再開コマンドをコピー\n${command}`;
    copy.append(icon('copy', 15));
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(command);
        sayHint(sessionId, 'コピーしました');
      } catch {
        // 書き込めないときはコマンドそのものを出す（手で選んでコピーできる）
        sayHint(sessionId, command);
      }
    });
    out.push(copy);
  }

  // 次の一手。押したときにやることは3つとも同じ（窓を前面に出す）。
  // **塗るかどうかは step.lead が決める**（入力欄があれば塗らない。1画面に塗った面は1つ）
  if (step) {
    const go = el('button', step.lead ? 'btn is-lead' : 'btn', step.label);
    go.type = 'button';
    go.dataset.refocus = 'next';
    go.title = step.title;
    // 絵は文字の前。上のバーの「起こす」（icon('plus') を prepend）と同じ並び
    go.prepend(icon('front', 14));
    // 二度押しは旗で止める。**disabled にしない** … 押せなくした瞬間に焦点が body へ落ち、
    // 作り直しの拾い直し（data-refocus）が効かなくなる（☆ と同じ。実測）
    let busy = false;
    go.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      go.setAttribute('aria-busy', 'true');
      sayHint(sessionId, '呼んでいます…');
      sayHint(sessionId, await focusTerminal(row.pid));
      busy = false;
      go.removeAttribute('aria-busy');
    });
    out.push(go);
  }

  // 押した結果の一言は残す（補足ではなく、押したことへの返事）。
  // 読み上げにも届くよう polite で知らせる（コピーは絵だけなので、字の返事がここにしか無い）
  const hint = el('span', 'hint');
  hint.setAttribute('aria-live', 'polite');
  if (lastHint.sessionId === sessionId) hint.textContent = lastHint.text;
  hintNode = hint;
  hintSession = sessionId;
  out.push(hint);
  return out;
}

/**
 * 2つの文が同じものを指しているか。題名は長い指示を切ったものが来ることがあるので、
 * 末尾の「…」を落とし、空白を潰したうえで、片方がもう片方の頭になっていれば同じと見る。
 * 短すぎる題名（12字未満）は前方一致で決めない（「修正」のような語で誤って消さない）。
 *
 * @param {string} a
 * @param {string|null} b
 * @returns {boolean}
 */
function sameText(a, b) {
  if (!a || !b) return false;
  const norm = (s) => s.replace(/[…\s]+$/u, '').replace(/\s+/gu, ' ').trim();
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 12 && long.startsWith(short);
}

/**
 * 「なぜこの作業をしているか」を「いま」タブの先頭に畳んで置く。
 *
 * 下のパネルを読めば分かることでも、切り替えのたびに読み下すのは重い。
 * 目的と直近の判断だけを最初に見せて、続きは下で追えるようにする。
 *
 * **置き場所を決めるのは detail.js の fillTab。** 前はタブ帯より上（どのタブでも）に
 * 置いていたが、長さが変わるのでタブ帯が上下した。名前の「頭」は層の話（パネルを
 * 使わない部品）で、置き場所は流れる箱の中の「いま」タブ
 */
export function summaryBlock(summary, title = null) {
  if (!summary || summary.source === 'error') return null;

  // 名前を .summary にしない（前は上のバーに同じ名前があり、両方に同じ CSS が当たった）
  const box = el('div', 'purpose');
  // **題名と同じ文なら見出しを出さない。** 題名が最初の指示から作られることが多く、
  // 同じ文が見出し（3行）と引用（3行）に2回並んでいた（UI レビューの F3）
  if (summary.headline && !sameText(summary.headline, title)) {
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
      // 待ちの中身は待ちのパネル（止まっていればタブ帯の直下、返信待ちならこのすぐ下）で
      // 大きく出すので、ここでは繰り返さない。
      // 要約データ側からは消さない（画面を持たない使い道でも状態が読めるように）
      if (p.label === '待っているもの') continue;
      dl.append(el('dt', null, p.label));
      dl.append(el('dd', null, p.text));
    }
    if (dl.childElementCount > 0) box.append(dl);
  }

  return box.childNodes.length ? box : null;
}
