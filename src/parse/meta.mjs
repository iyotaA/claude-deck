/**
 * ログから、そのセッションの状況を表す情報を拾う。
 *
 * 一覧と詳細の両方が材料にする。
 * もとは sessions.mjs（一覧の組み立て）に置いてあり、詳細側がそこから借りていた。
 * 解析の結果を組み立ての側に置くと層の向きが逆になるので、ここへ移した。
 *
 * ai-title は毎ターン書き直されるので、末尾だけ見ても最新のものが取れる。
 * スキルは末尾に写っているものだけ。全部は詳細ビューで出す。
 *
 * type の種類は公開仕様ではない。実測で分かっているものだけを見て、
 * 知らない type は黙って飛ばす。
 */
import {
  toolUses,
  textOf,
  timestampOf,
  isUserPrompt,
  isMainline,
  slashCommandOf,
} from './entries.mjs';
import { oneLine } from '../shared/text.mjs';

/**
 * @param {Array} entries 会話ログの行
 * @returns {object} 拾えなかった項目は null（配列は空）で埋めた形
 */
export function extractMeta(entries) {
  const meta = {
    title: null,
    lastPrompt: null,
    permissionMode: null,
    mode: null,
    model: null,
    effort: null,
    version: null,
    gitBranch: null,
    cwd: null,
    slug: null,
    contextTokens: null,
    skills: [],
    agents: [],
    lastUserPrompt: null,
    lastAssistantText: null,
  };

  for (const entry of entries) {
    switch (entry?.type) {
      case 'ai-title':
        if (typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) meta.title = entry.aiTitle.trim();
        continue;
      case 'last-prompt':
        if (typeof entry.lastPrompt === 'string') meta.lastPrompt = oneLine(entry.lastPrompt);
        continue;
      case 'permission-mode':
        if (typeof entry.permissionMode === 'string') meta.permissionMode = entry.permissionMode;
        continue;
      case 'mode':
        if (typeof entry.mode === 'string') meta.mode = entry.mode;
        continue;
      default:
        break;
    }

    if (typeof entry?.cwd === 'string') meta.cwd = entry.cwd;
    if (typeof entry?.version === 'string') meta.version = entry.version;
    if (typeof entry?.gitBranch === 'string') meta.gitBranch = entry.gitBranch;
    if (typeof entry?.slug === 'string') meta.slug = entry.slug;

    if (!isMainline(entry)) continue;

    // isMainline は null を本流と見なすので、ここで type を見る前に entry の有無を確かめる。
    // ログの行が JSON として null だった場合に落ちるのを防ぐ
    if (entry?.type === 'assistant') {
      if (typeof entry.message?.model === 'string') meta.model = entry.message.model;
      if (typeof entry.effort === 'string') meta.effort = entry.effort;

      const usage = entry.message?.usage;
      if (usage) {
        // 直近リクエストの入力量。そのセッションがどれだけ文脈を抱えているかの目安になる
        const used =
          (usage.input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0);
        if (used > 0) meta.contextTokens = used;
      }

      const text = textOf(entry);
      if (text) meta.lastAssistantText = oneLine(text, 240);

      for (const tu of toolUses(entry)) {
        if (tu.name === 'Skill' && tu.input?.skill) {
          meta.skills.push({ skill: tu.input.skill, args: oneLine(tu.input.args, 60), at: timestampOf(entry) });
        } else if (tu.name === 'Agent' || tu.name === 'Task') {
          meta.agents.push({
            type: tu.input?.subagent_type ?? null,
            description: oneLine(tu.input?.description, 60),
            at: timestampOf(entry),
          });
        }
      }
      continue;
    }

    if (isUserPrompt(entry)) {
      meta.lastUserPrompt = oneLine(textOf(entry), 240);
      continue;
    }

    const slash = slashCommandOf(entry);
    if (slash) {
      meta.skills.push({ skill: slash.command.replace(/^\//, ''), args: oneLine(slash.args, 60), at: timestampOf(entry) });
    }
  }

  // 同じスキルが何度も出ていたら最後の1回だけ残す
  const seen = new Map();
  for (const s of meta.skills) seen.set(`${s.skill}|${s.args ?? ''}`, s);
  meta.skills = [...seen.values()].slice(-4);

  return meta;
}
