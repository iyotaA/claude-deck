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
 * id は上のジャンプ用リンクから飛ぶために振る。
 * tone は枠と見出しの色。急ぐものだけ色を変え、他は素のままにする。
 */
export function panel(title, opts = {}) {
  const section = el('section', 'panel');
  if (opts.id) section.id = opts.id;
  if (opts.tone) section.classList.add(`is-${opts.tone}`);
  const head = el('h3', null, title);
  if (opts.count !== undefined && opts.count !== null) head.append(el('span', 'count', opts.count));
  if (opts.action) head.append(opts.action);
  section.append(head);
  const body = el('div', 'panel-body');
  section.append(body);
  return { section, body };
}

/** パネルの id。ジャンプ用リンクと対で使う。 */
export const SEC = {
  wait: 'sec-wait',
  run: 'sec-run',
  decisions: 'sec-decisions',
  todo: 'sec-todo',
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

/**
 * 上に置くジャンプ用のリンク。
 *
 * 詳細は縦に長いので、下にある TODO や時系列は開いた時点では見えない。
 * 何が入っているかを先に並べておけば、あると分かってから探しに行ける。
 * スクロールしても上に残すので、戻る手間もない。
 *
 * @param {Array<{id:string,label:string,count?:string|number,tone?:string}>} sections
 */
export function navBlock(sections) {
  // 2つ以下なら見れば分かる。目次のほうが目立ってしまう
  if (sections.length < 3) return null;

  const nav = el('nav', 'deck-nav');
  nav.setAttribute('aria-label', 'この詳細に入っているもの');

  for (const s of sections) {
    const b = el('button', 'nav-chip', s.label);
    b.type = 'button';
    // あとから件数だけ差し替えるための目印。時系列は絞り込みで数が動く
    b.dataset.sec = s.id;
    if (s.tone) b.classList.add(`is-${s.tone}`);
    if (s.count !== undefined && s.count !== null) b.append(el('span', 'n', s.count));
    b.addEventListener('click', () => {
      const target = document.getElementById(s.id);
      if (!target) return;
      // 動きを減らす設定は CSS では効かない指定なので、ここで見て切り替える
      const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
    });
    nav.append(b);
  }
  return nav;
}
