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
 * **スキル（Skill ツール）とスラッシュコマンドは別の配列に入れる。**
 * 以前は同じ配列へ push していて、全ログで Skill 82件に対しスラッシュコマンドが 85件、
 * **うち 74件が `/clear`** だった（実測）。一覧の「スキル」タグが実質 `clear` を並べる状態になる。
 * 呼んだスキルと打ったコマンドは意味がまるで違うので、混ぜると片方が読めなくなる。
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
  recapOf,
  slashCommandOf,
} from './entries.mjs';
import { oneLine } from '../shared/text.mjs';

/** skills / commands に残す件数。一覧のタグとして横に並べられる上限。 */
const KEEP = 4;

/**
 * 同じものが何度も出ていたら最後の1回だけ残し、末尾の数件に絞る。
 *
 * スキルもコマンドも同じ扱いにしたいので、違うのは鍵の作り方だけにしてある。
 * 別々に書くと、片方にだけ絞り込みが入っていない状態に必ずなる。
 *
 * @param {object[]} list 出てきた順の並び
 * @param {(item: object) => string} keyOf 同じものと見なすための鍵
 * @returns {object[]}
 */
function lastFew(list, keyOf) {
  const seen = new Map();
  for (const item of list) seen.set(keyOf(item), item);
  return [...seen.values()].slice(-KEEP);
}

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
    commands: [],
    agents: [],
    lastUserPrompt: null,
    lastAssistantText: null,
    recap: null,
    recapAt: null,
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

    // Claude 自身が書いた最後の中間報告。
    // 上の switch に case を足していないのは、case がすべて continue で抜けるため。
    // 足すと直前の cwd / version / gitBranch / slug の拾い上げを飛ばしてしまう
    const recap = recapOf(entry);
    if (recap) {
      meta.recap = oneLine(recap, 240);
      // 鮮度の判定に使う。最後の指示より古い報告は今の姿ではない
      meta.recapAt = timestampOf(entry);
      continue;
    }

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

    // 打ったスラッシュコマンド。**スキルとは別の配列へ入れる。**
    // 大半は /clear で、呼んだスキルの記録の中に混ぜると読めなくなる
    const slash = slashCommandOf(entry);
    if (slash) {
      meta.commands.push({
        command: slash.command.replace(/^\//, ''),
        args: oneLine(slash.args, 60),
        at: timestampOf(entry),
      });
    }
  }

  // 同じものが何度も出ていたら最後の1回だけ残す
  meta.skills = lastFew(meta.skills, (s) => `${s.skill}|${s.args ?? ''}`);
  meta.commands = lastFew(meta.commands, (c) => `${c.command}|${c.args ?? ''}`);

  return meta;
}
