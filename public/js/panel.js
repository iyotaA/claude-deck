/* 詳細ペインの共通部品。
 *
 * 層1。util.js だけを見る。
 *
 * ここを独立させているのは、panel() と SEC を detail.js・detail-wait.js・
 * detail-panels.js・agents.js の4箇所が使うため。detail.js に置くと
 * 部品側から詳細本体を import することになり、循環する。
 */
import { el } from './util.js';

/**
 * パネル1枚。
 *
 * id はパネルの身元。中央タブに割ってからは飛ぶ先ではなくなったが、
 * 目で追うときと、あとから外から掴むときの手がかりとして振っておく。
 * tone は枠と見出しの色。急ぐものだけ色を変え、他は素のままにする。
 * count は文字でも節点でもよい。節点なら素の `.count` に包まない。
 */
export function panel(title, opts = {}) {
  const section = el('section', 'panel');
  if (opts.id) section.id = opts.id;
  if (opts.tone) section.classList.add(`is-${opts.tone}`);
  const head = el('h3', null, title);
  // 状態の札のように点や印を持つものを素の `.count`（`--fg-faint` の細字）に包むと、
  // このパネルでいちばん知りたいものがいちばん薄く出ることになる
  if (opts.count instanceof Node) head.append(opts.count);
  else if (opts.count !== undefined && opts.count !== null) head.append(el('span', 'count', opts.count));
  if (opts.action) head.append(opts.action);
  section.append(head);
  const body = el('div', 'panel-body');
  section.append(body);
  return { section, body };
}

/** パネルの id。1枚ごとに1つ持たせて、身元が変わらないようにする。 */
export const SEC = {
  wait: 'sec-wait',
  run: 'sec-run',
  resume: 'sec-resume',
  decisions: 'sec-decisions',
  todo: 'sec-todo',
  outcome: 'sec-outcome',
  compact: 'sec-compact',
  timeline: 'sec-timeline',
  agents: 'sec-agents',
  files: 'sec-files',
  usage: 'sec-usage',
  basics: 'sec-basics',
};

export function toggle(label, pressed, onClick) {
  const b = el('button', 'btn', label);
  b.type = 'button';
  b.setAttribute('aria-pressed', String(pressed));
  b.addEventListener('click', onClick);
  return b;
}
