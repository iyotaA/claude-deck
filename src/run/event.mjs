/**
 * stream-json の1行を、画面に出せる小さな出来事に変える。
 *
 * 台帳（ledger.mjs）から呼ばれる純関数。fs も spawn も触らない。
 *
 * ## なぜ台帳と分けてあるか
 *
 * 台帳の仕事は「いつ状態が変わるか」で、こちらの仕事は「1行をどう畳むか」。
 * 一緒にすると、状態機械のテストに畳み方の都合が混ざる。
 * 分けてあるので、台帳のテストは `{kind:'result'}` のような短い入力だけで全分岐を通せる。
 *
 * ## 大きい行を持ち回らない
 *
 * `classifyStreamLine` が返す `entry` は**生の行そのもの**で、
 * 大きな `tool_result` は1行が数MBになる（Read で大きなファイルを読ませたとき）。
 * ここで必要なところだけ切り出し、**`entry` は絶対に外へ出さない。**
 * 出すと台帳のリングバッファ1000件がそのままメモリに載る。
 *
 * ## 速報であって正本ではない
 *
 * ここで作るのは「いま何が起きているか」を流すためのもの。
 * 後から読み返す正本は `~/.claude/projects/` の会話ログで、そちらは既存の詳細ビューが描く。
 * だから欠けても構わない情報（thinking の本文など）は落としてよい。
 *
 * ## thinking は落とす
 *
 * `textOf` が text ブロックだけを連結するので、thinking は自然に落ちる。
 * これは意図した挙動で、既存の時系列が thinking の本文を出さないのに合わせてある。
 * 落ちた結果その行が0件になることがあるが、**行が届いたこと自体は台帳が数える**ので、
 * 沈黙と見なされて `stalled` になることはない。
 */
import { textOf, toolUses, toolResults } from '../parse/entries.mjs';
import { clip, oneLine } from '../shared/text.mjs';
import { describeTool } from '../shared/tools.mjs';

/** assistant の地の文の上限。長い応答をまるごと持つとリングバッファが太る。 */
export const TEXT_MAX = 2000;

/**
 * ツール結果の要約の上限。
 *
 * ここだけ極端に短いのは、**ツール結果は正本を見ればよい**から。
 * 速報としては「Read が返ってきた」「エラーだった」が分かれば足りる。
 */
export const TOOL_RESULT_MAX = 200;

/**
 * 何を聞かれているのかを3つに分ける。
 *
 * **状態は分けない**（許可待ちはどれも `needs-permission` の1つ）。
 * 遷移の組み合わせを3倍にして得られるのが札の文言だけになるため、
 * 違いはこの値に持たせて、画面が見出しと押しボタンを変える。
 *
 * 台帳（`ledger.mjs`）もこの関数を使う。**判断を2箇所に書かない。**
 *
 * @param {string|null} toolName ツール名
 * @returns {'plan'|'question'|'tool'}
 */
export function askKindOf(toolName) {
  if (toolName === 'ExitPlanMode') return 'plan';
  if (toolName === 'AskUserQuestion') return 'question';
  return 'tool';
}

/**
 * stream-json の1行を、0個以上の出来事に変える。
 *
 * `seq` / `at` / `runId` は付けない。**それは台帳の仕事。**
 * ここが時刻を持つと、時刻を外から渡す（＝テストできる）という台帳の作りが崩れる。
 *
 * 返す出来事の種類:
 *
 * | kind | 中身 | いつ出るか |
 * |---|---|---|
 * | `init` | `sessionId` `model` `cwd` `permissionMode` `tools` | ターンごと（起動時の1回だけではない） |
 * | `text` | `text` | assistant の地の文 |
 * | `tool` | `id` `tool` `detail` | assistant が道具を呼んだ |
 * | `tool-result` | `id` `isError` `text` | その結果が返った |
 * | `echo` | `text` `replay` | 自分が送った行の戻り（`--replay-user-messages`） |
 * | `result` | `isError` `terminalReason` ほか | 1往復の終わり |
 * | `permission` | `requestId` `ask` `tool` `detail` | 許可を求められた |
 * | `other` | `type` `subtype` | フック系など、いま扱わないもの |
 * | `broken` | `sample` | JSON として読めなかった |
 *
 * `control` と `control-result` からは**出来事を作らない。**
 * あれは人が読むものではなく、答えるための配線。
 * 何が起きたか（断った・モードが変わった）は台帳が `note` で1行積む。
 *
 * ## 許可要求から `input` の原文を出さない
 *
 * `classifyStreamLine` は `input` を**切らずに**渡してくる（`AskUserQuestion` に答えるとき
 * `updatedInput` を組むのに原文が要るため）。だがそれを速報に載せると、
 * `Write` の `content` が数MBのままリング1000件に載る。
 * ここで載せるのは `describeTool` が返す1行だけにする。**原文は台帳が持つ。**
 *
 * サブエージェント（Task）の出力には `sub: true` を添える。
 * 親の発言と混ざって並ぶと、どちらが本流か分からなくなるため。
 *
 * @param {object|null} classified `classifyStreamLine` の戻り
 * @returns {Array<object>} 0個以上の出来事。畳んだ結果が空なら空配列
 */
export function toRunEvents(classified) {
  if (!classified || typeof classified !== 'object') return [];

  const out = [];
  // 印は全種類に同じ形で付ける。種類ごとに付けたり付けなかったりすると、
  // 画面側が「この kind には sub が無い」という暗黙の知識を持つことになる
  const sub = typeof classified.parentToolUseId === 'string' && classified.parentToolUseId
    ? { sub: true }
    : null;
  const push = (ev) => { out.push(sub ? { ...ev, ...sub } : ev); };

  switch (classified.kind) {
    case 'init': {
      const info = classified.info ?? {};
      push({
        kind: 'init',
        sessionId: classified.sessionId,
        model: info.model ?? null,
        cwd: info.cwd ?? null,
        permissionMode: info.permissionMode ?? null,
        tools: info.tools ?? null,
      });
      break;
    }

    case 'assistant': {
      const text = clip(textOf(classified.entry), TEXT_MAX);
      if (text) push({ kind: 'text', text });
      for (const t of toolUses(classified.entry)) {
        push({
          kind: 'tool',
          id: typeof t.id === 'string' ? t.id : null,
          tool: typeof t.name === 'string' ? t.name : null,
          // describeTool は材料が無ければ null を返す。null のまま持つ（空文字に丸めない）
          detail: describeTool(t.name, t.input),
        });
      }
      break;
    }

    case 'user': {
      // 順番が要点。`isReplay` は向こうが明示的に付ける印なので、いちばん強い手がかりになる。
      // 先にツール結果を見ると、万一 replay の行に結果らしい形が入っていたときに取り違える
      if (classified.isReplay) {
        push({ kind: 'echo', text: clip(textOf(classified.entry), TEXT_MAX), replay: true });
        break;
      }

      const results = toolResults(classified.entry);
      if (results.length) {
        for (const r of results) {
          push({
            kind: 'tool-result',
            id: typeof r.id === 'string' ? r.id : null,
            isError: r.isError === true,
            // 全文は持たない。何が返ったかが分かればよく、読み返すなら正本がある
            text: oneLine(r.text, TOOL_RESULT_MAX),
          });
        }
        break;
      }

      // replay の印が無く、ツール結果でもない user 行。
      // 実測では見ていないが、差し込みの類が来たときに黙って消えるより出したほうがよい
      push({ kind: 'echo', text: clip(textOf(classified.entry), TEXT_MAX), replay: false });
      break;
    }

    case 'result': {
      const info = classified.info ?? {};
      push({
        kind: 'result',
        isError: info.isError === true,
        terminalReason: info.terminalReason ?? null,
        durationMs: info.durationMs ?? null,
        numTurns: info.numTurns ?? null,
        costUSD: info.costUSD ?? null,
        text: info.text ?? null,
        errors: info.errors ?? null,
        denials: info.denials ?? null,
      });
      break;
    }

    case 'permission': {
      const info = classified.info ?? {};
      push({
        kind: 'permission',
        requestId: info.requestId ?? null,
        ask: askKindOf(info.toolName ?? null),
        tool: info.toolName ?? null,
        // **原文は載せない。** describeTool は必ず1行に畳んでから返す。
        // 知らないツールで材料が無かったときだけ、CLI が付けてきた説明に落ちる
        detail: describeTool(info.toolName, info.input) ?? oneLine(info.description, TOOL_RESULT_MAX),
      });
      break;
    }

    case 'control':
    case 'control-result':
      // 出来事にしない（この関数の説明を参照）
      break;

    case 'broken':
      push({ kind: 'broken', sample: classified.sample ?? null });
      break;

    default:
      // 知らない type は捨てずに、型の名前だけ残す。
      // 画面には出さなくてよいが、「何か流れてはいる」が見えないと切り分けができない
      push({ kind: 'other', type: classified.type ?? null, subtype: classified.subtype ?? null });
      break;
  }

  return out;
}
