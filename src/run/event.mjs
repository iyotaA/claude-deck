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
 * フックが成功したかを1つの値にする。
 *
 * `outcome` を先に見て、無ければ終了コードに落ちる。
 * **どちらも取れなければ `null`。** 成功と決めつけない（0 と不明を分ける）。
 * 実測では `outcome:'success'` と `exit_code:0` が両方載っていたが、
 * 版が上がって片方が消えても読めるようにしてある。
 *
 * @param {object} info `hookInfo` の戻り
 * @returns {boolean|null} 分からなければ null
 */
function hookOk(info) {
  if (info.outcome) return info.outcome === 'success';
  if (info.exitCode === null || info.exitCode === undefined) return null;
  return info.exitCode === 0;
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
 * | `hook` | `name` `event` `ok` `exitCode` `stderr` | フックが1本終わった |
 * | `other` | `type` `subtype` | まだ扱っていないもの |
 * | `broken` | `sample` | JSON として読めなかった |
 *
 * `control` と `control-result` からは**出来事を作らない。**
 * あれは人が読むものではなく、答えるための配線。
 * 何が起きたか（断った・モードが変わった）は台帳が `note` で1行積む。
 *
 * ## 数えるものは並べない（`thinking` と `rate-limit`）
 *
 * この2つも**出来事にしない。** 理由は control 系と違って「読めない」ではなく「多すぎる」。
 *
 * - `thinking` は1往復で8件流れる（実測。累計 50→700 と刻んでくる）
 * - `rate-limit` は API を叩くたびに流れる
 *
 * どちらも**最新の1つだけが意味を持つ値**で、途中経過を時系列に並べても読む人の役に立たない。
 * 段4より前はこれが `other` に落ちていて、1ターンごとに
 * 「その他 system / thinking_tokens」が8行並んで本文を押し流していた。
 * 畳んで run の行に載せるのは台帳の仕事（`ledger.mjs` の `run.thinking` / `run.rateLimit`）。
 *
 * `hook` だけは出来事にする。**ただし終わった1件（`hook_response`）だけ。**
 * 始まりと途中経過（`hook_started` / `hook_progress`）は畳んで捨てる。
 * 「どのフックが走ってどうなったか」は1行あれば足りる。
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
        // 「実行されなかった」印。**`is_error` と別に持つ。**
        // 断ったときのツール結果は普通のエラーとまったく同じ顔で返ってくるので（実測）、
        // これが無いと画面で「あなたが断った」と「ツールが失敗した」を区別できない
        const marks = new Map(
          (classified.info?.nonExecution ?? []).map((m) => [m.id, m.kind]),
        );
        for (const r of results) {
          const id = typeof r.id === 'string' ? r.id : null;
          push({
            kind: 'tool-result',
            id,
            isError: r.isError === true,
            // 印が無いときは null。**空文字に丸めない**（0 と不明を分けるのと同じ）
            nonExecution: (id !== null ? marks.get(id) : undefined) ?? null,
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
    case 'thinking':
    case 'rate-limit':
      // 出来事にしない（この関数の説明を参照）
      break;

    case 'hook': {
      const info = classified.info ?? {};
      // 終わった1件だけを出す。始まりと途中経過は畳んで捨てる。
      // **`subtype` で見る。** info 側に「どの段階か」を持たせると、
      // 同じことを2箇所に書くことになる
      if (classified.subtype !== 'hook_response') break;
      push({
        kind: 'hook',
        name: info.name ?? null,
        event: info.event ?? null,
        // `outcome` が無い版でも `exit_code` から読めるようにする。
        // どちらも取れなければ null のまま（成功と決めつけない）
        ok: hookOk(info),
        exitCode: info.exitCode ?? null,
        stderr: info.stderr ?? null,
      });
      break;
    }

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
