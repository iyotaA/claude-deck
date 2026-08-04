/**
 * 会話ログ1行（エントリ）から中身を取り出す小道具。
 *
 * state.mjs と digest.mjs の両方が使う。実測した形に合わせている:
 *
 *  assistant:
 *    message.content = [{type:"text",text}|{type:"thinking",thinking}|{type:"tool_use",id,name,input}]
 *  user（生の指示）:
 *    message.content = "文字列" もしくは [{type:"text",text}]
 *  user（ツール結果）:
 *    message.content = [{type:"tool_result",tool_use_id,content,is_error}]
 *    加えて toolUseResult に構造化された結果、却下なら toolDenialKind が付く
 */

/** 却下の種類。user-rejected だけが「本人が断った」を意味する。 */
export const DENIAL_KINDS = {
  'user-rejected': 'あなたが却下',
  'automode-blocked': '自動判定でブロック',
  'automode-unavailable': '自動判定が使えず保留',
  'permission-rule': '権限ルールで不許可',
};

/** そのセッションで「あなたを待って止まる」ツール。詳細を出したい。 */
export const ASK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** 実行中のツールを自分で止めたときに入る印。指示ではないが判断の記録にはなる。 */
const INTERRUPT_RE = /^\[Request interrupted by user/;

export function isInterrupt(entry) {
  return entry?.type === 'user' && INTERRUPT_RE.test(textOf(entry));
}

export function contentBlocks(entry) {
  const content = entry?.message?.content;
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

/** text ブロックだけを連結する。thinking は含めない。 */
export function textOf(entry) {
  return contentBlocks(entry)
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

export function toolUses(entry) {
  return contentBlocks(entry)
    .filter((b) => b?.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: b.input ?? {} }));
}

export function toolResults(entry) {
  return contentBlocks(entry)
    .filter((b) => b?.type === 'tool_result')
    .map((b) => ({
      id: b.tool_use_id,
      isError: b.is_error === true,
      text: typeof b.content === 'string'
        ? b.content
        : Array.isArray(b.content)
          ? b.content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n')
          : '',
    }));
}

/** ツール結果の行か。 */
export function isToolResultEntry(entry) {
  if (entry?.type !== 'user') return false;
  return entry.toolUseResult !== undefined || toolResults(entry).length > 0;
}

/**
 * あなたが実際に打った指示の行か。
 *
 * ツール結果、スラッシュコマンドの展開結果、ローカルコマンドの出力、
 * システムが差し込むリマインダは除く。
 */
export function isUserPrompt(entry) {
  if (entry?.type !== 'user') return false;
  if (entry.isMeta === true) return false;
  if (isToolResultEntry(entry)) return false;

  const text = textOf(entry);
  if (!text) return false;
  if (/^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|system-reminder|user-prompt-submit-hook)/.test(text)) {
    return false;
  }
  if (text.startsWith('Caveat: The messages below were generated')) return false;
  // 文脈が圧縮されたときに差し込まれる引き継ぎ要約。
  // user の行として記録されるが、実際に打った指示ではないので除く
  if (text.startsWith('This session is being continued from a previous conversation')) return false;
  // 中断の印は指示ではない。digest 側で別枠（interrupt）として扱う
  if (INTERRUPT_RE.test(text)) return false;
  return true;
}

/** スラッシュコマンドの行か（/pr-review など）。指示とは別枠で見せる。 */
export function slashCommandOf(entry) {
  if (entry?.type !== 'user') return null;
  const text = textOf(entry);
  const m = /^<command-name>([^<]+)<\/command-name>/.exec(text);
  if (!m) return null;
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text);
  return { command: m[1].trim(), args: args ? args[1].trim() : '' };
}

/** エントリの時刻をミリ秒で。取れなければ null。 */
export function timestampOf(entry) {
  const raw = entry?.timestamp;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/** 本流の行だけ（サブエージェントの発言を除く）。 */
export function isMainline(entry) {
  return entry?.isSidechain !== true;
}
