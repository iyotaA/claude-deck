/* 「あなたの番」のパネル。
 *
 * 層3。このアプリの目的そのもの（ボールの所在）を出す場所なので、
 * 他のパネルとは別のファイルにして、待ちの種類ごとの見せ方をここだけで完結させる。
 *
 * プランと最後の応答は Markdown として、切らずに全部描く（mdView）。
 * 以前は bodyText で 1,400 字・18 行の頭出しにして残りを畳んでいたが、ここは
 * 承認するかどうかを決める場所なので、読むのに1手増えるのが惜しい。
 * 記法の途中で切った断片を Markdown として描くと崩れる、という事情もある。
 * 画面が埋まらないよう、高さの上限は markdown.css の `.is-block .md` が持つ。
 */
import { el } from './util.js';
import { mdView } from './md-view.js';
import { panel, SEC } from './panel.js';
import { askBlock } from './run-ask.js';

/**
 * 待ちの種類ごとの、見出し（何をすれば進むのか）と色。
 *
 * ここに無い状態（実行中・終了）は待っていないので、パネルそのものを出さない。
 *
 * **案内文（見出しの下の1行）は持たない。** 前は「このツールを実行してよいかを
 * 決めてください」のような1行を添えていたが、見出し（「あなたの番 — 実行を許可する」）と
 * 同じことを言うだけだった（補足と重複をしまう）。中身のほうを先に読ませる。
 */
const WAIT_GUIDE = {
  'needs-answer': { title: '質問に答える', tone: 'hot' },
  'needs-plan-approval': { title: 'プランを承認する', tone: 'hot' },
  'needs-approval': { title: '実行を許可する', tone: 'hot' },
  'awaiting-reply': { title: '次の指示を出す', tone: 'warn' },
};

/**
 * パネルの見出しを組む。
 *
 * 「あなたの番」は状態ラベルではなく**このアプリの目的の語**なので、ここが持つ。
 * 止まらない側は状態名を `row.stateLabel`（サーバーの `STATE_LABELS`）から引く。
 * これで「状態ラベルの日本語は画面側に持たない」を守れる。
 *
 * **判断は `row.blocking` だけ。** `row.state` で分岐すると、どの状態が
 * 「答えないと1行も進まない」かを画面側が2枚目の表として持つことになり、
 * サーバーの `meta.stateBlocking` と必ずずれる（実際に一覧・監視盤・詳細の
 * 3箇所で食い違っていた）。
 *
 * @param {object} row 一覧の1行
 * @param {object} guide WAIT_GUIDE の1件
 * @returns {string}
 */
function headingOf(row, guide) {
  if (row.blocking === true) return `あなたの番 — ${guide.title}`;

  // 状態名が取れないときは説明だけ出す。**代わりの日本語をここで作らない**
  const label = typeof row.stateLabel === 'string' ? row.stateLabel : null;
  return label ? `${label} — ${guide.title}` : guide.title;
}

/**
 * まだ答えていない質問。
 *
 * 選択肢は説明つきで全部出す。ここで選ぶわけではないが、
 * 何を訊かれているか分かればターミナルへ戻ってすぐ答えられる。
 * 決めた答え（decision-a）とは見せ方を変えて、選んだものと混同させない。
 */
function pendingQuestion(a) {
  const wrap = el('div', 'decision');
  wrap.append(el('div', 'decision-q', a.question || '(質問文なし)'));

  const options = a.otherOptions ?? [];
  if (options.length) {
    const ul = el('ul', 'choices');
    for (const o of options) {
      const li = el('li');
      li.append(el('span', 'label', o.label));
      if (o.description) li.append(document.createTextNode(` — ${o.description}`));
      ul.append(li);
    }
    wrap.append(ul);
  }
  return wrap;
}

/**
 * 「いま何を待たれているか」を目的のすぐ下に置く。
 *
 * 状態の名前だけでは動けない。返信待ちなら何に返すのか、承認待ちなら何を承認するのか、
 * そこまで出さないと結局ターミナルへ戻って読み直すことになる。
 * 待ちの種類ごとに、判断に必要なものをここへ持ってくる。
 *
 * @param {object} row 一覧の1行
 * @param {object|null} d 詳細（まだ読めていなければ null）
 * @returns {HTMLElement|null} 待っていなければ null
 */
export function waitingBlock(row, d) {
  // 許可要求が来ているときは、待ちの中身も操作もあちらが持つ。
  // **この画面から起こした実行のときしか返らない**ので、ターミナル側のセッションは
  // 1行も新しいコードを通らない（`runFor()` が null を返す）
  const ask = askBlock(row);
  if (ask) return ask;

  const guide = WAIT_GUIDE[row.state];
  if (!guide) return null;

  const p = panel(headingOf(row, guide), { id: SEC.wait, tone: guide.tone });
  p.section.classList.add('is-wait');
  // 答えないと1行も進まないものだけ、左の縁を太くして見出しを1段上げる。
  // 色は `.panel.is-hot` の見出しの字だけが持つ（太い線は無彩色）。ここで新しい色を作らない
  if (row.blocking === true) p.section.classList.add('is-block');

  const items = d?.digest?.items ?? [];
  const lastOf = (pred) => {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (pred(items[i])) return items[i];
    }
    return null;
  };

  if (row.state === 'needs-answer') {
    const ask = lastOf((i) => i.kind === 'answer' && i.unanswered);
    for (const a of ask?.answers ?? []) p.body.append(pendingQuestion(a));
    // 詳細がまだ来ていない間は、一覧が持っている質問文だけ出しておく
    if (!ask && row.waitingFor?.detail) p.body.append(el('div', 'wait-q', row.waitingFor.detail));
  } else if (row.state === 'needs-plan-approval') {
    const plan = lastOf((i) => i.kind === 'plan' && i.pending);
    if (plan?.planFile) {
      const line = el('div', 'wait-lead', 'プランの保存先 ');
      line.append(el('span', 'mono', plan.planFile));
      p.body.append(line);
    }
    if (plan?.plan) p.body.append(mdView(plan.plan));
    else if (d) p.body.append(el('p', 'note', 'プランの本文はログから取れませんでした'));
  } else if (row.state === 'needs-approval') {
    if (row.waitingFor) {
      p.body.append(el('div', 'wait-tool', row.waitingFor.tool));
      if (row.waitingFor.detail) p.body.append(el('pre', null, row.waitingFor.detail));
    }
  } else if (row.state === 'awaiting-reply') {
    // 最後の応答だけを出す。**「Claude の最後の応答」の札は付けない** ―― 見出しが
    // 「返信待ち — 次の指示を出す」と言っている以上、その下に来る本文が何かは札なしで読める。
    // 札ではなくパスそのものが中身の「プランの保存先」（上の枝）とは扱いが違う
    const say = lastOf((i) => i.kind === 'say' && i.text);
    if (say) p.body.append(mdView(say.text));
  }

  return p.section;
}
