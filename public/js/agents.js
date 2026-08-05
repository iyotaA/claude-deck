/* サブエージェントの記録のパネル。
 *
 * 層3。1件ずつの本文は押されたときに /api/sessions/:id/subagents/:agentId から取る。
 * パネルを開いた時点では1件も読まない（記録は最大20件、1件が最大 2.6MB）。
 */
import { el, hms, dur, num, kb, mb } from './util.js';
import { panel, SEC } from './panel.js';
import * as Timeline from './timeline/index.js';

/**
 * サブエージェントの状態の日本語。
 *
 * 「実行中」を作らない。終わったセッションの記録を見ているのに走っていることになる。
 * 起動しか分かっていないものは「起動した」までしか言わない。
 *
 * 未知の値はそのまま出す（黙って消さない）
 */
const AGENT_STATUS = {
  completed: '完了',
  launched: '起動した',
  pending: '結果なし',
  killed: '打ち切り',
  failed: '失敗',
};

/** これを超えたらボタンに大きさを添える。止めはしない、驚かせないだけ */
const AGENT_BIG_BYTES = 2 * 1024 * 1024;

/**
 * サブエージェント1件の行。
 *
 * 押されたときだけ取りに行く。パネルを開いた時点では1件も本文を読まない。
 * 記録は最大20件あり、1件が最大 2.6MB になる
 *
 * @param {object} a detail.subagents.items の1件
 * @param {string} sessionId いま開いているセッション
 * @returns {HTMLElement}
 */
function agentRow(a, sessionId) {
  const li = el('li', 'agent');
  if (!a.log.exists) li.classList.add('is-gone');

  const head = el('div', 'agent-head');
  head.append(el('span', 'agent-type', a.agentType ?? '種類不明'));

  const mid = el('span', 'agent-desc');
  mid.append(el('span', 'agent-desc-text', a.description ?? '（指示の記録がありません）'));

  // 添える事実は取れたものだけ。取れなかったものを 0 と書かない
  const facts = [];
  if (a.at) facts.push(hms(new Date(a.at)));
  if (a.status) facts.push(AGENT_STATUS[a.status] ?? a.status);
  if (typeof a.durationMs === 'number') facts.push(dur(a.durationMs));
  if (typeof a.toolUseCount === 'number') facts.push(`ツール ${num(a.toolUseCount)} 回`);
  if (typeof a.reportChars === 'number') facts.push(`報告 ${num(a.reportChars)} 字`);
  if (typeof a.log.size === 'number') facts.push(kb(a.log.size));
  if (facts.length) mid.append(el('span', 'agent-meta', facts.join('　')));

  // 入れ子は親ログに toolUseId が無いので結びつかない。それが正常だと分かる書き方にする
  if (!a.linked) {
    mid.append(el('span', 'agent-note', a.spawnDepth && a.spawnDepth > 1
      ? `入れ子（深さ ${a.spawnDepth}）なので、親のログに呼び出しの記録がありません`
      : '親のログに対応する呼び出しが見つかりません'));
  }
  head.append(mid);

  if (!a.log.exists) {
    head.append(el('span', 'agent-note', '記録が見つかりません'));
    li.append(head);
    return li;
  }

  // <details> にしない。頭が3列のグリッドで、<summary> を器にすると
  // マーカーの扱いがブラウザ間で揃わない。原文（<details>）との不一致は意図したもの
  const big = typeof a.log.size === 'number' && a.log.size > AGENT_BIG_BYTES;
  const btn = el('button', 'btn', big ? `開く（${mb(a.log.size)}）` : '開く');
  btn.type = 'button';
  btn.setAttribute('aria-expanded', 'false');
  const body = el('div', 'agent-body');
  body.hidden = true;
  head.append(btn);
  li.append(head, body);

  let loaded = false;
  let loading = false;
  btn.addEventListener('click', async () => {
    const open = btn.getAttribute('aria-expanded') === 'true';
    if (open) {
      btn.setAttribute('aria-expanded', 'false');
      body.hidden = true;
      return;
    }
    btn.setAttribute('aria-expanded', 'true');
    body.hidden = false;
    // 2回目以降は hidden の付け外しだけ
    if (loaded || loading) return;

    loading = true;
    body.replaceChildren(el('div', 'loading', '記録を読んでいます…'));
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(a.agentId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const nodes = [];
      if (data.log?.truncated) {
        nodes.push(el('div', 'note', 'ログが大きいので先頭だけ読んでいます。最終報告は親のログ側に入っています'));
      }
      nodes.push(Timeline.renderPlain(data.digest?.items ?? []));
      body.replaceChildren(...nodes);
      loaded = true;
    } catch (err) {
      // 失敗しても閉じられるままにする。押し直せば取り直せる
      body.replaceChildren(el('div', 'empty-note', `記録が取れません: ${err.message}`));
    } finally {
      loading = false;
    }
  });

  return li;
}

/**
 * サブエージェントの記録のパネル。
 *
 * 組むのは詳細を開いたときだけ。材料の listSubagents が1件ごとに stat と
 * .meta.json を読むので、一覧（毎秒走る経路）では呼べない。
 * 一覧に出している「サブエージェント N」のタグは、readdir 1回だけで数える
 * 別経路（countSubagents）から来ている
 *
 * @param {object} subagents detail.subagents
 * @param {string} sessionId いま開いているセッション
 * @returns {{section: HTMLElement, nav: object}|null} 出すものが無ければ null
 */
export function agentsPanel(subagents, sessionId) {
  const items = subagents?.items ?? [];
  if (!items.length && !subagents?.readError) return null;

  const p = panel('サブエージェントの記録', { id: SEC.agents, count: `${num(items.length)} 件` });
  if (subagents.readError) {
    p.body.append(el('p', 'note', `記録の置き場所を読めませんでした: ${subagents.readError}`));
  }

  const missing = subagents.counts?.missingLog ?? 0;
  if (missing) {
    p.body.append(el('p', 'note', `${num(missing)} 件は呼び出しだけが残っていて、記録のファイルがありません`));
  }

  const ul = el('ul', 'agents');
  for (const a of items) ul.append(agentRow(a, sessionId));
  p.body.append(ul);

  return {
    section: p.section,
    nav: { id: SEC.agents, label: 'サブエージェントの記録', count: items.length },
  };
}
