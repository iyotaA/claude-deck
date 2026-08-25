/**
 * 詳細ビューの中身を作る。
 *
 * 目的は「そのセッションで自分が何を判断したか」と「なぜそう進めているか」を、
 * ログから決定論的に抜いて時系列に並べること。要約はしない。
 *
 * 決定論であることは性能の前提でもある。
 * read/cache.mjs の memo と画面側の detailCache が「同じログなら同じ結果」に依存している。
 * だから現在時刻は受け取らない。進行中の待ちは state.mjs の idleMs が持っているので、
 * ここでは終わった待ちだけを扱う。
 *
 * このファイルに残しているのは、走査の本体（buildDigest）と、
 * 走査の前に1回だけ作る索引（indexResults / indexNotifications / agentStatus）だけ。
 * 走査から呼ぶ判断は digest/ の4枚に分けてある。
 *
 *   digest/limits.mjs    上限と、超えたときに落とす順
 *   digest/answers.mjs   選んだ答えの取り出し・却下文の整形（実測した形はこちらに書いた）
 *   digest/waits.mjs     待ちの区間と集計
 *   digest/trim.mjs      間引き
 *
 * buildDigest 本体は分けない。1つの走査ループで items と files と stats を同時に埋めており、
 * 切ると「どの順で何を数えているか」が読めなくなる。
 */
import {
  textOf,
  toolUses,
  toolResults,
  timestampOf,
  uuidOf,
  agentIdOf,
  recapOf,
  taskNotificationOf,
  isUserPrompt,
  isInterrupt,
  isMainline,
  isSidechain,
  isToolResultEntry,
  slashCommandOf,
  DENIAL_KINDS,
} from './entries.mjs';
import { clip, oneLine } from '../shared/text.mjs';
import { describeTool } from '../shared/tools.mjs';
import { LIMIT, TRACE_HEAD, WRITE_TOOLS } from './digest/limits.mjs';
import { denialNote, pickAnswers } from './digest/answers.mjs';
import { collectBarriers, waitOf, emptyWaitStats, addWait } from './digest/waits.mjs';
import { trimItems } from './digest/trim.mjs';

/**
 * サブエージェントの終わりの記録を agentId から引ける表にする。
 *
 * 非同期で起動したエージェントは、呼び出しの結果には「起動した」までしか入らない。
 * 終わりは別の行として差し込まれるので、そこを拾って結び直す。
 * これがあるので「走っているかどうか」を mtime や推測で当てなくて済む
 *
 * @param {Array} scoped 対象の行
 * @returns {Map<string, {status: string|null, at: number|null}>}
 */
function indexNotifications(scoped) {
  const byAgent = new Map();
  for (const entry of scoped) {
    const note = taskNotificationOf(entry);
    if (!note) continue;
    // 同じエージェントが何度も止まると通知も複数出る（差し込みの note 自身がそう書いている）。
    // あとから来たほうが最後の状態なので上書きする
    byAgent.set(note.taskId, { status: note.status, at: timestampOf(entry) });
  }
  return byAgent;
}

/**
 * サブエージェントの状態を決める。
 *
 * 言い切れないものを言い切らないための関数。上から順に見る。
 *
 *  1. 終わりの記録があればそれが最終（completed / killed / failed）
 *  2. 呼び出しの結果が completed なら、同期で走って報告まで返っている
 *  3. async_launched のまま終わりの記録が無ければ launched。
 *     **「走っている」とは言わない。** セッションがもう終わっていれば走ってもいない。
 *     この記録から言えるのは「起動したところまでは分かる」だけ
 *  4. 結果そのものが無ければ pending（呼んだ直後で、まだ返ってきていない）
 *
 * 知らない値が来たらそのまま返す。黙って既知の値に丸めない
 *
 * @param {object|null} result 呼び出しに対応する結果
 * @param {object|null} done 終わりの記録
 * @returns {string|null}
 */
function agentStatus(result, done) {
  if (done?.status) return done.status;
  const raw = result?.structured?.status;
  if (raw === 'completed') return 'completed';
  if (raw === 'async_launched') return 'launched';
  if (!result) return 'pending';
  return typeof raw === 'string' ? raw : null;
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
        // 原文に戻るとき、呼び出した行ではなく結果の行を開きたい場面がある
        uuid: uuidOf(entry),
      });
    }
  }
  return byId;
}

/**
 * @param {object} params
 * @param {Array} params.entries readAll で読んだ全行
 * @param {'main'|'sidechain'} [params.scope] どちらの流れを組むか。既定は本流。
 *   サブエージェントのログは全行が isSidechain:true なので、main のままだと1件も残らない
 * @param {string|null} [params.agentId] sidechain のとき、この agentId の行だけに絞る。
 *   1エージェント1ファイルなので通常は要らないが、混ざったログを渡されても正しく組めるようにしておく
 * @returns {object} 詳細ビュー用のデータ
 */
export function buildDigest({ entries = [], scope = 'main', agentId = null } = {}) {
  const scoped = scope === 'sidechain'
    ? entries.filter((e) => isSidechain(e) && (agentId === null || agentIdOf(e) === agentId))
    : entries.filter(isMainline);
  const results = indexResults(scoped);
  const barriers = collectBarriers(scoped);
  const notifications = indexNotifications(scoped);

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
    waits: emptyWaitStats(),
  };

  let index = 0;
  /**
   * 返信待ちの起点。Claude が発言して止まった時刻。
   *
   * ここのリセット条件に罠がある。{"type":"system","subtype":"turn_duration"} が
   * 毎ターンの直後に必ず入る（実測405件）ので、「assistant 以外なら全部リセット」に
   * すると返信待ちが1件も測れない。リセットするのはツール結果・圧縮・中断・
   * スラッシュコマンドのときだけにする
   */
  let replyFrom = null;
  /**
   * 最後の発言。押し込んだ項目そのものと、切る前の全文。
   *
   * 「いま」タブの待ちブロックはここを出すので、末尾が「…（以下省略）」で
   * 終わると答えるための材料が足りなくなる。走査のあとで幅を広げ直すために控える。
   * 参照を持つのは、間引き（trimItems）で落とされたかどうかを照合するため
   */
  let lastSay = null;

  for (const entry of scoped) {
    const at = timestampOf(entry);
    const uuid = uuidOf(entry);
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
        uuid,
        trigger: m.trigger ?? null,
        preTokens: m.preTokens ?? null,
        postTokens: m.postTokens ?? null,
        droppedTokens: m.cumulativeDroppedTokens ?? null,
      };
      items.push(item);
      compactions.push(item);
      replyFrom = null;
      continue;
    }

    // Claude 自身が書いた中間報告。
    // これは自己申告であって、機械的に抽出した記録ではない。
    // 間引きでは落とさない（数が少なく、抜けると「報告があった事実」まで消える）
    const recap = recapOf(entry);
    if (recap) {
      items.push({
        i: index++,
        kind: 'recap',
        at,
        uuid,
        text: clip(recap, LIMIT.recap),
        fullLength: recap.length,
      });
      continue;
    }

    if (entry?.type === 'user') {
      const slash = slashCommandOf(entry);
      if (slash) {
        items.push({ i: index++, kind: 'slash', at, uuid, command: slash.command, args: slash.args || null });
        replyFrom = null;
        continue;
      }
      if (isInterrupt(entry)) {
        stats.interrupts += 1;
        items.push({ i: index++, kind: 'interrupt', at, uuid });
        replyFrom = null;
        continue;
      }
      if (isUserPrompt(entry)) {
        stats.prompts += 1;
        // Claude が発言して止まってから、この指示を打つまでの間
        const wait = waitOf('reply', replyFrom, at, barriers);
        addWait(stats.waits, wait);
        items.push({ i: index++, kind: 'prompt', at, uuid, text: clip(textOf(entry), LIMIT.prompt), wait });
        replyFrom = null;
        continue;
      }
      // ツール結果が来たなら Claude は動いている。返信を待っていたわけではない
      if (isToolResultEntry(entry)) replyFrom = null;
      continue;
    }

    if (entry?.type !== 'assistant') continue;

    const say = textOf(entry);
    if (say) {
      stats.says += 1;
      const item = {
        i: index++,
        kind: 'say',
        at,
        uuid,
        text: clip(say, LIMIT.say),
        // 切る前の長さ。切られた本文から長さを計ると「全文」の字数が嘘になる
        fullLength: say.length,
      };
      items.push(item);
      lastSay = { item, raw: say };
      if (at !== null) replyFrom = at;
    }

    /**
     * この行ぶんのふつうの呼び出し（足跡の材料）。
     *
     * assistant の1行につき1件の足跡にまとめる。1呼び出し1件にすると、
     * 並列で6本呼んだ行が6件になって、判断の記録が水増しの中に埋もれる。
     * 却下・質問・プラン・スキル・エージェント・失敗は自分の項目を持つので、ここには入れない
     */
    const calls = [];

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
        const wait = waitOf('denial', at, result.at, barriers);
        addWait(stats.waits, wait);
        items.push({
          i: index++,
          kind: 'denial',
          at,
          uuid,
          resultUuid: result.uuid,
          tool: tu.name,
          detail: describeTool(tu.name, tu.input),
          denialKind: result.denialKind,
          denialLabel: DENIAL_KINDS[result.denialKind] ?? result.denialKind,
          // 却下時に添えたコメントがあれば、それが一番知りたい情報になる
          note: denialNote(result.text),
          wait,
        });
        continue;
      }

      if (tu.name === 'AskUserQuestion') {
        const answers = pickAnswers(tu.input, result);
        stats.answers += answers.length;
        const wait = waitOf('answer', at, result?.at ?? null, barriers);
        addWait(stats.waits, wait);
        items.push({
          i: index++,
          kind: 'answer',
          at,
          uuid,
          resultUuid: result?.uuid ?? null,
          answers,
          unanswered: !result,
          wait,
        });
        continue;
      }

      if (tu.name === 'ExitPlanMode') {
        const text = result?.text ?? '';
        const approved = /approved your plan/i.test(text);
        const saved = /saved to:\s*(.+)/.exec(text);
        stats.plans += 1;
        const wait = waitOf('plan', at, result?.at ?? null, barriers);
        addWait(stats.waits, wait);
        const body = tu.input?.plan ?? result?.structured?.plan;
        // 承認された結果には filePath が必ず入っていた（実測46件すべて）。
        // 本文から拾う正規表現は、その形が無い古い版のための控え
        const filePath = typeof result?.structured?.filePath === 'string'
          ? result.structured.filePath
          : saved ? saved[1].trim() : null;
        items.push({
          i: index++,
          kind: 'plan',
          at,
          uuid,
          resultUuid: result?.uuid ?? null,
          // 承認された時刻。ファイルの更新時刻と比べるのに使う。
          // wait.toAt にも同じ値が入るが、区切りを跨ぐと null になるのでこちらに別で持つ
          resultAt: result?.at ?? null,
          plan: clip(body, LIMIT.plan),
          // 切る前の長さ。ディスクの本文と突き合わせるとき、切られた本文で比べると必ず不一致になる
          planChars: typeof body === 'string' ? body.length : null,
          // 実測では true のときだけ書かれ、false は一度も出ない。
          // キーが無いことを「編集なし」と読み替えられないよう、無いときは null で渡す
          edited: result?.structured?.planWasEdited === true ? true : null,
          approved,
          pending: !result,
          planFile: filePath,
          // 却下・修正指示のときは本文にその内容が入る。次に何をするかの指示なので改行ごと残す
          feedback: approved ? null : clip(text, LIMIT.feedback),
          wait,
        });
        continue;
      }

      addWait(stats.waits, waitOf('tool', at, result?.at ?? null, barriers));

      if (tu.name === 'Skill') {
        const rec = {
          i: index++,
          kind: 'skill',
          at,
          uuid,
          skill: tu.input?.skill ?? '?',
          args: tu.input?.args || null,
        };
        items.push(rec);
        skills.push(rec);
        continue;
      }

      if (tu.name === 'Agent' || tu.name === 'Task') {
        // 結果には2つの形がある（実測140件）。
        //   同期  59件 … status:"completed"。content に報告本文、totalDurationMs / totalTokens /
        //                 totalToolUseCount / toolStats / usage が付く
        //   非同期 81件 … status:"async_launched"。起動したことしか入らない。
        //                 終わりは別の <task-notification> の行に出る（indexNotifications で拾う）
        const s = result?.structured ?? null;
        const agentId = typeof s?.agentId === 'string' ? s.agentId : null;
        const done = agentId ? notifications.get(agentId) ?? null : null;
        // items と agents で同じオブジェクトを共有している。間引きで items から
        // 消えても agents には残る形にしたいので、ここをコピーに変えてはいけない
        // （提案10 の subagents.items がこの参照に依存している）
        const rec = {
          i: index++,
          kind: 'agent',
          at,
          uuid,
          resultUuid: result?.uuid ?? null,
          // サブエージェントの記録と突き合わせる鍵。呼び出し側の id と、結果に入る agentId
          toolUseId: tu.id ?? null,
          agentId,
          // 呼び出しに subagent_type が無い形もあるので、結果側の agentType にも落とす
          agentType: tu.input?.subagent_type ?? (typeof s?.agentType === 'string' ? s.agentType : null),
          description: oneLine(tu.input?.description, LIMIT.detail),
          model: typeof s?.resolvedModel === 'string' ? s.resolvedModel : null,
          status: agentStatus(result, done),
          // 同期完了のときだけ入る。取れなければ null（0 と混ぜない）
          durationMs: typeof s?.totalDurationMs === 'number' ? s.totalDurationMs : null,
          tokens: typeof s?.totalTokens === 'number' ? s.totalTokens : null,
          toolUseCount: typeof s?.totalToolUseCount === 'number' ? s.totalToolUseCount : null,
          // 報告本文そのものは積まない。長さだけ出して、中身は「開く」の応答へ回す
          reportChars: typeof s?.content === 'string' ? s.content.length : null,
          doneAt: done?.at ?? null,
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
          uuid,
          resultUuid: result.uuid,
          tool: tu.name,
          detail: describeTool(tu.name, tu.input),
          message: oneLine(result.text, LIMIT.detail),
        });
        continue;
      }

      calls.push({
        tool: tu.name,
        detail: describeTool(tu.name, tu.input),
        // 呼んでから結果が返るまで。承認待ちの時間も含む（分けられない）
        durationMs: typeof at === 'number' && typeof result?.at === 'number' ? result.at - at : null,
        // 結果がまだ来ていない。いま止まっているのがここだと分かる
        pending: !result,
        // 0 と「取れなかった」を分ける。結果が無い行は null にする
        resultChars: typeof result?.text === 'string' ? result.text.length : null,
        head: oneLine(result?.text, TRACE_HEAD),
        resultUuid: result?.uuid ?? null,
      });
    }

    if (calls.length) {
      // 一番遅い結果まで。1本も測れなければ null。取れた分があればその最長を出す
      const durations = calls.map((c) => c.durationMs).filter((v) => typeof v === 'number');
      items.push({
        i: index++,
        kind: 'trace',
        at,
        uuid,
        count: calls.length,
        // 畳んだ見出しに出す。同じツールを並列で呼んだ行を「Read ×4」と読めるようにする
        tools: [...new Set(calls.map((c) => c.tool))],
        durationMs: durations.length ? Math.max(...durations) : null,
        calls,
      });
    }
  }

  stats.turns = scoped.filter((e) => e?.type === 'assistant').length;

  const trimmed = trimItems(items);

  // 最後の発言だけ、切る幅を LIMIT.sayLast まで広げ直す。
  // ここでやるのは、間引きに落とされていないことを確かめてからにするため
  // （落ちていれば elided の印に畳まれていて、画面が拾うのは1つ前の発言になる）。
  // 項目を作り直して差し替える。走査中に mutate すると、間引きの判断が
  // 「広げたあとの長さ」を見ることになり、落とす順が入力に依らなくなる
  if (lastSay && lastSay.raw.length > LIMIT.say) {
    const at = trimmed.items.indexOf(lastSay.item);
    if (at !== -1) trimmed.items[at] = { ...lastSay.item, text: clip(lastSay.raw, LIMIT.sayLast) };
  }

  return {
    items: trimmed.items,
    files: [...files.values()]
      .map((f) => ({ path: f.path, count: f.count, tools: [...f.tools] }))
      .sort((a, b) => b.count - a.count),
    skills,
    agents,
    compactions,
    stats: {
      ...stats,
      elapsedMs: stats.firstAt !== null && stats.lastAt !== null ? stats.lastAt - stats.firstAt : null,
      droppedItems: trimmed.dropped,
    },
  };
}
