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
  // task-notification はサブエージェントの終わりを伝える差し込み。
  // user の行として記録されるが打った指示ではない。除かないと実測 84 件が
  // 「あなたの指示」として数えられ、時系列に XML がそのまま並ぶ
  if (/^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|system-reminder|user-prompt-submit-hook|task-notification)/.test(text)) {
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

/** サブエージェントの行か。isMainline の真裏。どの行が数に入るかの解釈はここに集める。 */
export function isSidechain(entry) {
  return entry?.isSidechain === true;
}

/** 行を指す識別子。原文に戻るときの鍵になる。取れなければ null。 */
export function uuidOf(entry) {
  return typeof entry?.uuid === 'string' ? entry.uuid : null;
}

/**
 * その行がどの API 応答に属するかの識別子。
 *
 * **1回の応答が複数行に分かれて書かれる。** thinking / text / tool_use が別々の行になり、
 * そのすべてが同じ requestId と、同じ message.usage を持つ（実測）。
 * 素で足すと消費が2倍前後に膨らむので、数えるときは必ずこれで重複を潰す。
 *
 * 持っていないのは <synthetic> の行だけだった。実測 108 件を全ログで数え、
 * 「requestId 無し」「model が <synthetic>」「usage が全ゼロ」の3つが完全に一致した
 * （食い違いは0件）。だから requestId の有無だけで synthetic を弾ける。
 *
 * @param {object} entry 会話ログの1行
 * @returns {string|null}
 */
export function requestIdOf(entry) {
  return typeof entry?.requestId === 'string' ? entry.requestId : null;
}

/**
 * assistant 行の usage を、数えやすい形に直して返す。
 *
 * 実測した形（キーはすべて省略されうるので、無ければ0として扱う）:
 *
 *   usage = {
 *     input_tokens, output_tokens,
 *     cache_read_input_tokens, cache_creation_input_tokens,
 *     cache_creation: { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens },
 *     iterations: [...], service_tier, speed, ...
 *   }
 *
 * キャッシュ書き込みは平坦な cache_creation_input_tokens と入れ子の cache_creation の
 * 2箇所にある。**両方を信じてはいけない。** 実データに、平坦が 0 なのに
 * 入れ子が 132,640 という行がある。大きいほうを採る。
 *
 * 平坦のほうが大きいときは内訳が分からないので、差分を5分ぶんとして数える。
 * 1時間ぶんと見なすと、重みが 1.25 から 2.0 に変わって消費を過大に見積もることになる。
 * 既定が5分なので、そちらへ倒すのが安全側。
 *
 * usage.iterations は見ない。実測で常に長さ1で、
 * サーバ側のフォールバック時の記録らしく、ローカルでは中身が本体と同じだった。
 *
 * @param {object} entry 会話ログの1行
 * @returns {{in: number, cacheRead: number, cacheWrite5m: number, cacheWrite1h: number, out: number}|null}
 *          usage を持たない行では null
 */
export function usageOf(entry) {
  const u = entry?.message?.usage;
  if (!u || typeof u !== 'object') return null;

  // 負の値・NaN・文字列は 0 として扱う。公開仕様ではないので、
  // 知らない形が来ても落ちずに「取れなかった＝0」へ倒す
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

  const nested5m = n(u.cache_creation?.ephemeral_5m_input_tokens);
  const nested1h = n(u.cache_creation?.ephemeral_1h_input_tokens);
  const flat = n(u.cache_creation_input_tokens);

  let cacheWrite5m = nested5m;
  const cacheWrite1h = nested1h;
  if (flat > nested5m + nested1h) cacheWrite5m += flat - nested5m - nested1h;

  return {
    in: n(u.input_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheWrite5m,
    cacheWrite1h,
    out: n(u.output_tokens),
  };
}

/**
 * その行を書いたサブエージェントの識別子。
 *
 * サブエージェントのログは全行が持っている（実測59行すべて）。
 * 親のログの行には無いので、本流では常に null になる
 *
 * @param {object} entry 会話ログの1行
 * @returns {string|null}
 */
export function agentIdOf(entry) {
  return typeof entry?.agentId === 'string' ? entry.agentId : null;
}

/**
 * サブエージェントの終わりを伝える差し込みを読む。
 *
 * 非同期で起動したエージェント（呼び出しの結果が status: async_launched）は、
 * 親ログの結果に報告が入らない。終わったことは別の user の行として差し込まれる。
 * 実測した形:
 *
 *   <task-notification>
 *   <task-id>aae06781144f65807</task-id>     ← agentId と同じ値
 *   <tool-use-id>toolu_…</tool-use-id>
 *   <output-file>…</output-file>
 *   <status>completed</status>
 *   <summary>Agent "探偵A: …" finished</summary>
 *   <note>…</note>
 *   <result>…エージェントの報告本文…</result>
 *
 * status は completed 76 / killed 7 / failed 1（実測84件）。
 * これがあるので、非同期のエージェントも「終わったか」を推測せずに言える。
 *
 * 報告本文の中に <summary> や <code> のようなタグが入っていることがあるため、
 * <result> より手前だけを見る。実測 91 件のうち task-id が取れたのは 84 件で、
 * 残り7件は task-id を持たない別の形だった。取れなければ null を返す
 *
 * @param {object} entry 会話ログの1行
 * @returns {{taskId: string, toolUseId: string|null, status: string|null}|null}
 */
export function taskNotificationOf(entry) {
  if (entry?.type !== 'user') return null;
  const text = textOf(entry);
  if (!text.startsWith('<task-notification>')) return null;

  // 報告本文に入っている同名タグを拾わないよう、頭の部分だけに絞る
  const cut = text.indexOf('<result>');
  const head = cut === -1 ? text : text.slice(0, cut);

  const taskId = /<task-id>([^<]+)<\/task-id>/.exec(head);
  if (!taskId) return null;
  const toolUseId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(head);
  const status = /<status>([^<]+)<\/status>/.exec(head);

  return {
    taskId: taskId[1].trim(),
    toolUseId: toolUseId ? toolUseId[1].trim() : null,
    status: status ? status[1].trim() : null,
  };
}

/**
 * 中間報告に付く断り書き。
 *
 * 実測 183 件のうち 158 件に付いていた。付いていない行もあるので、除去は付いているときだけ。
 * 報告の中身ではなく Claude Code の案内文なので、読み物としては邪魔になる
 */
const RECAP_TAIL = '(disable recaps in /config)';

/**
 * Claude 自身が書いた中間報告（recap）を取り出す。
 *
 * 実測した形（183 件で確認）:
 *   {type:"system", subtype:"away_summary", content:"…素の文字列…", ...}
 *
 * message.content ではなく entry.content に素の文字列で入るので textOf では取れない。
 * これは Claude の自己申告であって、機械的に抽出した記録ではない。
 * 画面に出すときは同じ重さに見せない
 *
 * @param {object} entry 会話ログの1行
 * @returns {string|null} 中間報告の本文。その行でなければ null
 */
export function recapOf(entry) {
  if (entry?.type !== 'system' || entry.subtype !== 'away_summary') return null;
  const raw = entry.content;
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (text.endsWith(RECAP_TAIL)) text = text.slice(0, -RECAP_TAIL.length).trim();
  return text || null;
}
