/* 「あなたの番」のパネル。
 *
 * 層3。このアプリの目的そのもの（ボールの所在）を出す場所なので、
 * 他のパネルとは別のファイルにして、待ちの種類ごとの見せ方をここだけで完結させる。
 */
import { el } from './util.js';
import { panel, SEC } from './panel.js';
import * as Timeline from './timeline/index.js';

/**
 * 待ちの種類ごとの、見出しと「何をすれば進むのか」。
 *
 * ここに無い状態（実行中・終了）は待っていないので、パネルそのものを出さない。
 */
const WAIT_GUIDE = {
  'needs-answer': {
    title: '質問に答える',
    tone: 'hot',
    lead: '選択肢を選ぶまで、この先へ進みません',
  },
  'needs-plan-approval': {
    title: 'プランを承認する',
    tone: 'hot',
    lead: 'この計画で進めてよいかを決めてください',
  },
  'needs-approval': {
    title: '実行を許可する',
    tone: 'hot',
    lead: 'このツールを実行してよいかを決めてください',
  },
  'awaiting-reply': {
    title: '次の指示を出す',
    tone: 'warn',
    lead: 'Claude は応答を返し終えて止まっています',
  },
};

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
 * @returns {{section: HTMLElement, nav: object}|null} 待っていなければ null
 */
export function waitingBlock(row, d) {
  const guide = WAIT_GUIDE[row.state];
  if (!guide) return null;

  const p = panel(`あなたの番 — ${guide.title}`, { id: SEC.wait, tone: guide.tone });
  p.section.classList.add('is-wait');
  p.body.append(el('p', 'note', guide.lead));

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
    if (plan?.plan) p.body.append(...Timeline.bodyText(plan.plan, 1400, 18));
    else if (d) p.body.append(el('p', 'note', 'プランの本文はログから取れませんでした'));
  } else if (row.state === 'needs-approval') {
    if (row.waitingFor) {
      p.body.append(el('div', 'wait-tool', row.waitingFor.tool));
      if (row.waitingFor.detail) p.body.append(el('pre', null, row.waitingFor.detail));
    }
  } else if (row.state === 'awaiting-reply') {
    const say = lastOf((i) => i.kind === 'say' && i.text);
    if (say) {
      p.body.append(el('div', 'wait-lead', 'Claude の最後の応答'));
      p.body.append(...Timeline.bodyText(say.text, 700, 8));
    }
  }

  return { section: p.section, nav: { id: SEC.wait, label: 'あなたの番', tone: guide.tone } };
}
