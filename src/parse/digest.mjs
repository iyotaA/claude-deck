/**
 * 詳細ビューの中身を作る。
 *
 * 目的は「そのセッションで自分が何を判断したか」と「なぜそう進めているか」を、
 * ログから決定論的に抜いて時系列に並べること。要約はしない。
 *
 * 実測で分かった大事な形:
 *
 *  AskUserQuestion の「選んだ答え」は toolUseResult に入っていない。
 *  toolUseResult は質問と選択肢の控えで、実際に選ばれたラベルは
 *  tool_result の本文に次の形で埋まっている。
 *
 *    Your questions have been answered: "質問"="選んだラベル" selected preview:
 *    …（選択肢のプレビュー本文）…
 *    , "質問2"="選んだラベル2". You can now continue with these answers in mind.
 *
 *  質問文は tool_use 側に持っているので、それを鍵にして本文から引く。
 *  引けたラベルを options[].label と照合すれば、その選択肢の description まで出せる。
 *  description は「その選択が何を意味していたか」の説明なので、
 *  あとから読み返したときに判断の理由がそのまま残る。
 */
import {
  contentBlocks,
  textOf,
  toolUses,
  toolResults,
  timestampOf,
  isUserPrompt,
  isInterrupt,
  isMainline,
  slashCommandOf,
  DENIAL_KINDS,
} from './entries.mjs';
import { clip, oneLine } from '../shared/text.mjs';
import { describeTool, MAX_DETAIL } from '../shared/tools.mjs';

/** 1件あたりの上限。判断の記録になるものは長めに残し、説明文は短くする。 */
const LIMIT = {
  prompt: 6000,
  say: 1200,
  plan: 24000,
  // ツールの一行説明と同じ長さ。並べて出るものなので揃える
  detail: MAX_DETAIL,
  feedback: 2000,
};

/** 時系列に並べる項目の上限。超えたら古い説明文から落とす。 */
const MAX_ITEMS = 400;

/** ファイルを書き換えるツール。「触ったファイル」の判定に使う。 */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

/**
 * 却下されたときに機械的に入る英文。
 *
 * 中身は毎回同じで読む価値がないのに長いため、時系列を埋めてしまう。
 * 取り除いて、あとに何か残ればそれだけを出す（自分が添えたコメントがそこに来る）。
 */
const DENIAL_NOISE = [
  /The user doesn't want to proceed with this tool use\./g,
  /The tool use was rejected \([^)]*\)\./g,
  /STOP what you are doing and wait for the user to tell you how to proceed\./g,
  /Note: The user's next message may contain a correction or preference\.[\s\S]*?future sessions\./g,
  /The user doesn't want to take this action right now\./g,
  /Permission (?:for this action was denied|to use \S+ was denied)[^.]*\./g,
  /Tool use was rejected[^.]*\./g,
];

function denialNote(text) {
  let t = typeof text === 'string' ? text : '';
  for (const re of DENIAL_NOISE) t = t.replace(re, '');
  return oneLine(t, LIMIT.feedback);
}

/**
 * 選ばれた答えを tool_result の本文から取り出す。
 *
 * 本文は選択肢のプレビューが挟まって崩れた形なので、全体をパースしない。
 * 質問文を鍵に該当位置だけを読む。
 */
function extractAnswers(input, resultText) {
  const text = typeof resultText === 'string' ? resultText : '';
  const out = [];

  for (const q of input?.questions ?? []) {
    const question = typeof q?.question === 'string' ? q.question : '';
    const options = Array.isArray(q?.options) ? q.options : [];

    let chosen = null;
    const needle = `"${question}"="`;
    const at = question ? text.indexOf(needle) : -1;
    if (at !== -1) {
      const rest = text.slice(at + needle.length);
      const end = rest.indexOf('"');
      chosen = (end === -1 ? rest.slice(0, 300) : rest.slice(0, end)).trim();
    }

    // 選択肢のラベルと突き合わせる。合えばその description が判断の根拠になる。
    // 「Other」で自由入力した場合はどれにも合わないので、そのまま文字列として残す
    const picked = options.filter((o) => chosen && typeof o?.label === 'string'
      && (chosen === o.label || chosen.includes(o.label)));

    out.push({
      question,
      header: typeof q?.header === 'string' ? q.header : null,
      multiSelect: q?.multiSelect === true,
      chosen,
      // preview は大きいので落とす。label と description だけ持つ
      chosenOptions: picked.map((o) => ({ label: o.label, description: o.description ?? null })),
      freeText: Boolean(chosen) && picked.length === 0,
      otherOptions: options
        .filter((o) => !picked.includes(o))
        .map((o) => ({ label: o.label ?? '', description: oneLine(o.description, 200) })),
    });
  }

  return out;
}

/** tool_use_id から結果を引ける表を作る。承認・却下の判定に必要。 */
function indexResults(entries) {
  const byId = new Map();
  for (const entry of entries) {
    const denialKind = typeof entry?.toolDenialKind === 'string' ? entry.toolDenialKind : null;
    for (const r of toolResults(entry)) {
      if (!r.id) continue;
      byId.set(r.id, {
        text: r.text ?? '',
        isError: r.isError,
        denialKind,
        structured: entry?.toolUseResult,
        at: timestampOf(entry),
      });
    }
  }
  return byId;
}

/**
 * @param {object} params
 * @param {Array} params.entries readAll で読んだ全行
 * @returns {object} 詳細ビュー用のデータ
 */
export function buildDigest({ entries = [] } = {}) {
  const mainline = entries.filter(isMainline);
  const results = indexResults(mainline);

  const items = [];
  const files = new Map();
  const skills = [];
  const agents = [];
  const compactions = [];
  const stats = {
    prompts: 0,
    answers: 0,
    plans: 0,
    denials: 0,
    interrupts: 0,
    errors: 0,
    toolCalls: 0,
    says: 0,
    turns: 0,
    firstAt: null,
    lastAt: null,
  };

  let index = 0;

  for (const entry of mainline) {
    const at = timestampOf(entry);
    if (at !== null) {
      if (stats.firstAt === null || at < stats.firstAt) stats.firstAt = at;
      if (stats.lastAt === null || at > stats.lastAt) stats.lastAt = at;
    }

    // 文脈が圧縮された地点。ここより前の細部は Claude 側も覚えていない
    if (entry?.type === 'system' && entry.subtype === 'compact_boundary') {
      const m = entry.compactMetadata ?? {};
      const item = {
        i: index++,
        kind: 'compact',
        at,
        trigger: m.trigger ?? null,
        preTokens: m.preTokens ?? null,
        postTokens: m.postTokens ?? null,
        droppedTokens: m.cumulativeDroppedTokens ?? null,
      };
      items.push(item);
      compactions.push(item);
      continue;
    }

    if (entry?.type === 'user') {
      const slash = slashCommandOf(entry);
      if (slash) {
        items.push({ i: index++, kind: 'slash', at, command: slash.command, args: slash.args || null });
        continue;
      }
      if (isInterrupt(entry)) {
        stats.interrupts += 1;
        items.push({ i: index++, kind: 'interrupt', at });
        continue;
      }
      if (isUserPrompt(entry)) {
        stats.prompts += 1;
        items.push({ i: index++, kind: 'prompt', at, text: clip(textOf(entry), LIMIT.prompt) });
      }
      continue;
    }

    if (entry?.type !== 'assistant') continue;

    const say = textOf(entry);
    if (say) {
      stats.says += 1;
      items.push({ i: index++, kind: 'say', at, text: clip(say, LIMIT.say), full: say.length > LIMIT.say });
    }

    for (const tu of toolUses(entry)) {
      stats.toolCalls += 1;
      const result = results.get(tu.id) ?? null;

      if (WRITE_TOOLS.has(tu.name) && tu.input?.file_path) {
        const path = String(tu.input.file_path);
        const rec = files.get(path) ?? { path, count: 0, tools: new Set() };
        rec.count += 1;
        rec.tools.add(tu.name);
        files.set(path, rec);
      }

      // あなたが却下した、または権限で止められた呼び出し
      if (result?.denialKind) {
        stats.denials += 1;
        items.push({
          i: index++,
          kind: 'denial',
          at,
          tool: tu.name,
          detail: describeTool(tu.name, tu.input),
          denialKind: result.denialKind,
          denialLabel: DENIAL_KINDS[result.denialKind] ?? result.denialKind,
          // 却下時に添えたコメントがあれば、それが一番知りたい情報になる
          note: denialNote(result.text),
        });
        continue;
      }

      if (tu.name === 'AskUserQuestion') {
        const answers = extractAnswers(tu.input, result?.text);
        stats.answers += answers.length;
        items.push({ i: index++, kind: 'answer', at, answers, unanswered: !result });
        continue;
      }

      if (tu.name === 'ExitPlanMode') {
        const text = result?.text ?? '';
        const approved = /approved your plan/i.test(text);
        const saved = /saved to:\s*(.+)/.exec(text);
        stats.plans += 1;
        items.push({
          i: index++,
          kind: 'plan',
          at,
          plan: clip(tu.input?.plan ?? result?.structured?.plan, LIMIT.plan),
          approved,
          pending: !result,
          planFile: saved ? saved[1].trim() : null,
          // 却下・修正指示のときは本文にその内容が入る
          feedback: approved ? null : oneLine(text, LIMIT.feedback),
        });
        continue;
      }

      if (tu.name === 'Skill') {
        const rec = { i: index++, kind: 'skill', at, skill: tu.input?.skill ?? '?', args: tu.input?.args || null };
        items.push(rec);
        skills.push(rec);
        continue;
      }

      if (tu.name === 'Agent' || tu.name === 'Task') {
        const rec = {
          i: index++,
          kind: 'agent',
          at,
          agentType: tu.input?.subagent_type ?? null,
          description: oneLine(tu.input?.description, LIMIT.detail),
        };
        items.push(rec);
        agents.push(rec);
        continue;
      }

      // 失敗した呼び出し。却下とは別に数える
      if (result?.isError) {
        stats.errors += 1;
        items.push({
          i: index++,
          kind: 'error',
          at,
          tool: tu.name,
          detail: describeTool(tu.name, tu.input),
          message: oneLine(result.text, LIMIT.detail),
        });
      }
    }
  }

  stats.turns = mainline.filter((e) => e?.type === 'assistant').length;

  // 多すぎる場合は説明文から落とす。判断の記録（指示・選択・プラン・却下）は残す
  let dropped = 0;
  if (items.length > MAX_ITEMS) {
    const keepAlways = new Set(['prompt', 'answer', 'plan', 'denial', 'compact', 'slash', 'interrupt']);
    const trimmed = [];
    let budget = items.length - MAX_ITEMS;
    for (const item of items) {
      if (budget > 0 && !keepAlways.has(item.kind)) {
        budget -= 1;
        dropped += 1;
        continue;
      }
      trimmed.push(item);
    }
    items.length = 0;
    items.push(...trimmed);
  }

  return {
    items,
    files: [...files.values()]
      .map((f) => ({ path: f.path, count: f.count, tools: [...f.tools] }))
      .sort((a, b) => b.count - a.count),
    skills,
    agents,
    compactions,
    stats: {
      ...stats,
      elapsedMs: stats.firstAt !== null && stats.lastAt !== null ? stats.lastAt - stats.firstAt : null,
      droppedItems: dropped,
    },
  };
}
