/**
 * ボール状態の判定。このアプリの心臓部。
 *
 * 考え方:
 *   会話ログは「assistant がツールを呼ぶ → その結果の行が来る」の繰り返しで進む。
 *   結果の行が来ていない呼び出しが残っていて、かつ追記が止まっているなら、
 *   それは Claude があなたの承認や回答を待って固まっている状態。
 *   これを dangling（結果待ちのまま残った呼び出し）と呼ぶ。
 *
 * 誤判定を避けるための軸:
 *   長く走る Bash も dangling に見えるので、それだけでは承認待ちと断定できない。
 *   ただし AskUserQuestion と ExitPlanMode は「あなたを待つ」以外の用途を持たないツールなので、
 *   これが dangling なら確実にあなた待ち。ここを別扱いにして確実性を取る。
 *   ふつうのツールは 登録簿の status と、より長いしきい値の両方で見る。
 */
import {
  toolUses,
  toolResults,
  textOf,
  timestampOf,
  uuidOf,
  isMainline,
} from './entries.mjs';
import { describeTool } from '../shared/tools.mjs';

/** 追記が止まったと見なすまで。 */
export const QUIET_MS = 3000;
/** ふつうのツールが dangling のとき、承認待ちと見なすまで。長く走るコマンドとの区別用。 */
export const APPROVAL_MS = 15000;

/**
 * 登録簿の status のうち「動いている」を意味すると分かっている値。
 *
 * 実物で確認できたのは busy だけ。残りは名前から予想して入れてある。
 * 未知の値が来た場合はここに引っかからず、ログの中身だけで判定する。
 */
const BUSY_STATUSES = new Set(['busy', 'running', 'working']);
/** 「あなたを待っている」を意味すると分かっている値。実物で確認できたのは idle と waiting。 */
const WAITING_STATUSES = new Set(['idle', 'waiting', 'waiting_for_input', 'needs_input', 'ready']);

/**
 * Claude が自分で許可して進む権限モード。
 *
 * 実測（`~/.claude/projects` の 356 ファイル・125,537行を全走査）で、
 * `permission-mode` の疑似エントリに出る語は `auto` 6349 / `plan` 765 / `default` 7 の3つだけ。
 * `acceptEdits` と `bypassPermissions` は1件も無いが、この画面から起こすときの argv の語彙に
 * 前者があり、後者も `CLAUDE_DECK_RUN_ALLOW_BYPASS` で渡せるので入れてある。
 *
 * **`run/spec.mjs` の `PERMISSION_MODES` を import しない**（`parse` → `run` は
 * `view` ⇄ `run` より悪い辺）。読み替え表も作らない。
 * `system/init` が `default` と名乗り argv が `manual` と名乗る食い違いは、
 * **どちらも「人に聞く」側なので両方この集合に入らない**。だから食い違いが誤った抑制を生む道が無い。
 */
const AUTO_APPROVE_MODES = new Set(['auto', 'acceptEdits', 'bypassPermissions']);

export const STATE_LABELS = {
  running: '実行中',
  'needs-answer': '質問待ち',
  'needs-plan-approval': 'プラン承認待ち',
  'needs-approval': '承認待ち',
  'awaiting-reply': '返信待ち',
  ended: '終了',
  unknown: '不明',
};

/** 一覧の並び順。小さいほど上（＝先に手をつけるべき）。 */
export const STATE_RANK = {
  'needs-answer': 0,
  'needs-plan-approval': 0,
  'needs-approval': 1,
  'awaiting-reply': 2,
  running: 3,
  unknown: 4,
  ended: 5,
};

/** どちらのボールか。表示の色分けに使う。 */
export function ballOf(kind) {
  if (kind === 'running') return 'claude';
  if (kind === 'ended') return 'none';
  if (kind === 'unknown') return 'none';
  return 'master';
}

/**
 * その状態のあいだ、あなたが答えないと1行も進まないか。
 *
 * `ballOf`（誰のコートにボールがあるか）とは**別の問い**。
 * 返信待ちは確かにあなたのコートだが、黙っていて困るのは自分だけで、
 * Claude は「終わって待っている」だけ。赤で急かす対象を
 * 「押さないと1行も進まない」ものだけに絞るために、軸を2本に分けてある。
 *
 * `STATE_RANK <= 1` で数える案は採らない。並び順という数字に2つ目の意味を載せることになり、
 * `sortRows` の `?? 9` のせいで**未知の状態が事故で「非ブロッキング」に落ちる**。
 */
export const STATE_BLOCKING = {
  running: false,
  'needs-answer': true,
  'needs-plan-approval': true,
  'needs-approval': true,
  // 返信待ちは急かさない。Claude は応答を返し終えていて、放置しても壊れるものが無い
  'awaiting-reply': false,
  ended: false,
  unknown: false,
};

/** 未知の状態は false（＝急かさない）に倒す。断定できないものを赤にしない。 */
export function isBlocking(kind) {
  return STATE_BLOCKING[kind] === true;
}

/** 未解決のまま残った tool_use を探す。 */
function findDangling(entries) {
  const resolved = new Set();
  const resolvedAssistantUuids = new Set();

  for (const entry of entries) {
    const results = toolResults(entry);
    for (const r of results) {
      if (r.id) resolved.add(r.id);
    }
    // tool_result ブロックが無いのに結果だけ入っている形に備えた保険。
    // sourceToolAssistantUUID は結果の元になった assistant 行を指す。
    if (results.length === 0 && entry?.toolUseResult !== undefined && entry.sourceToolAssistantUUID) {
      resolvedAssistantUuids.add(entry.sourceToolAssistantUUID);
    }
  }

  let dangling = null;
  for (const entry of entries) {
    if (entry?.type !== 'assistant') continue;
    if (resolvedAssistantUuids.has(entry.uuid)) continue;
    for (const tu of toolUses(entry)) {
      if (resolved.has(tu.id)) continue;
      dangling = { ...tu, at: timestampOf(entry), assistantUuid: entry.uuid };
    }
  }
  return dangling;
}

/**
 * 状態を決める。
 *
 * @param {object|null} registry 登録簿の1件（無ければ null）
 * @param {object} tail readTail の結果
 * @param {number} now 現在時刻
 * @param {string|null} permissionMode 権限モード（`extractMeta` の `permissionMode`）。
 *   **文字列だけを受ける。`meta` ごと渡さない。** ここは毎秒走る経路で、
 *   `meta` を渡すと心臓部が `extractMeta` の17項目の形に依存し、
 *   「ついでに model も effort も見る」の入口ができる。
 *   既定が null なので、渡さない呼び出しは今までと1ビットも変わらない
 */
export function deriveState({ registry, tail, now = Date.now(), permissionMode = null }) {
  const entries = (tail?.entries ?? []).filter(isMainline);

  let lastEntryAt = null;
  for (const entry of entries) {
    const at = timestampOf(entry);
    if (at !== null && (lastEntryAt === null || at > lastEntryAt)) lastEntryAt = at;
  }

  const lastActivityAt = Math.max(tail?.mtimeMs ?? 0, lastEntryAt ?? 0) || null;
  const idleMs = lastActivityAt ? Math.max(0, now - lastActivityAt) : null;
  const quiet = idleMs === null ? false : idleMs >= QUIET_MS;

  const dangling = findDangling(entries);
  const statusRaw = registry?.status ?? null;
  const busy = statusRaw !== null && BUSY_STATUSES.has(statusRaw);
  const waitingByStatus = statusRaw !== null && WAITING_STATUSES.has(statusRaw);
  // null・undefined・未知の語はすべて false ＝ 今までの挙動。
  // 読めなかったものを auto 扱いにすると、いちばん危ない側（見落とし）へ倒れる
  const autoApproved = typeof permissionMode === 'string' && AUTO_APPROVE_MODES.has(permissionMode);

  const lastEntry = entries[entries.length - 1] ?? null;

  const base = {
    idleMs,
    lastActivityAt,
    statusRaw,
    // 「いまのターン」を指す錨。ログの最後の行の uuid。
    //
    // 通知は sessionId ＋ tool_use.id を鍵にするが、返信待ちには待っている
    // ツールが無いので id が取れない。セッション ID だけで鍵を作ると
    // 生涯1つになり、2回目以降の返信待ちが黙って落ちる。
    // 追記が止まっているあいだ最後の行は動かないので、待ちのあいだ安定する
    anchorId: uuidOf(lastEntry),
    // 登録簿自身が「動いていない」と言っているか。
    //
    // needs-approval には経路が2つある。これはその見分け。
    //   true  … Claude が自分で止まったと言っている＝マスターの判断を待っている
    //   false … しきい値（APPROVAL_MS）だけが根拠。長く走る Bash も同じ形になる
    // auto mode で Claude が自分で承認した分はそもそも止まらないので、
    // true の側だけを見れば「人に聞きに来ている承認待ち」だけを拾える
    byStatus: waitingByStatus && quiet,
    // 判定の根拠を持たせておく。表示の説明にも、しきい値を詰めるときの手がかりにも使う
    waitingFor: dangling
      ? {
        // tool_use の id。呼び出しごとに一意なので「同じ待ちかどうか」の鍵になる。
        //
        // 通知はこの id で重複を弾く。lastActivityAt では弾けない。
        // あれは Math.max(ファイルの更新時刻, 最終エントリ時刻) なので（上の行を参照）、
        // サブエージェントが走っているあいだ親ログに追記が続いて動き続ける。
        // 質問は1つのままなのに鍵だけが変わり、同じ質問で何通も飛ぶことになる。
        //
        // 実測したログには必ず入っていたが、無い形が来ても落ちないように null に倒す
        id: dangling.id ?? null,
        tool: dangling.name,
        detail: describeTool(dangling.name, dangling.input),
      }
      : null,
  };

  // 登録簿に居ない、またはプロセスが死んでいる
  if (!registry || registry.alive !== true) {
    return { ...base, kind: 'ended', confident: true, reason: registry ? 'プロセスが終了' : '登録簿に無し' };
  }

  // AskUserQuestion と ExitPlanMode は「あなたを待つ」専用のツール。
  // 未解決ならそれ以外の解釈が無いので、しきい値も status も見ずに確定させる
  if (dangling?.name === 'AskUserQuestion') {
    return { ...base, kind: 'needs-answer', confident: true, reason: '質問を出して停止中' };
  }
  if (dangling?.name === 'ExitPlanMode') {
    return { ...base, kind: 'needs-plan-approval', confident: true, reason: 'プランの承認を待って停止中' };
  }

  // 登録簿がはっきり「待ち」と言っているなら従う。
  //
  // **ここは権限モードで抑えない。** auto でも本物の許可プロンプトは起きる
  // （`spec.mjs` の「危ないものだけ確認」／実測で拒否の痕跡が auto に32件）。
  // そのとき CLI は本当に手が止まるので、CLI 自身が書く登録簿の status が待ち系に落ちる。
  // つまりここが auto での唯一の受け皿で、通知が信じている経路でもある（byStatus: true）
  if (waitingByStatus && quiet) {
    const kind = dangling ? 'needs-approval' : 'awaiting-reply';
    return { ...base, kind, confident: true, reason: `登録簿の status が ${statusRaw}` };
  }

  // 登録簿が busy なら、dangling でも単に長く走っているだけと見る
  if (busy && !quiet) {
    return { ...base, kind: 'running', confident: true, reason: `status=${statusRaw} で追記も直近` };
  }

  if (dangling) {
    if (idleMs !== null && idleMs >= APPROVAL_MS) {
      // auto 系のモードでは Claude が自分で許可して進むので、止まって見える根拠が
      // 「時間」しか無い。ここで承認待ちと決めない。
      //
      // 実測でこの段の的中率が 1:10 より悪い（上位10ログ・7,432往復のうち
      // 人待ち以外の15秒超が301件 ↔ auto での本物の許可プロンプトの痕跡は全ログで32件）。
      // 上の段（登録簿の status が待ち系）は抑えていないので、本物はそちらで拾える。
      //
      // **「もっと長いしきい値でいつか赤くする」安全弁は足さない。** それは数字を大きくした
      // この段そのもので、誤報を消すのではなく遅らせるだけ。実測で長い側の5分超11件のうち
      // 7件が `Agent` ＝ いちばん信用したい長時間の自律実行で鳴る
      if (autoApproved) {
        return {
          ...base,
          kind: 'running',
          confident: true,
          // 経過秒を入れない。毎秒動く値を reason に置くと `refresh()` の差分に載って
          // 詳細ペインが毎秒作り直される（除外は idleMs と lastActivityAt の2つだけ）。
          // permissionMode を埋めても安全なのは、ここへ来る時点で値が集合の語に確定しているため
          reason: `${dangling.name} を実行中（${permissionMode} なので承認待ちと決めない）`,
        };
      }
      return {
        ...base,
        kind: 'needs-approval',
        // status の値が未知だと断定しきれない。長く止まっている事実だけが根拠
        confident: !busy,
        reason: `${dangling.name} の結果が来ないまま停止`,
      };
    }
    return { ...base, kind: 'running', confident: true, reason: `${dangling.name} を実行中` };
  }

  // dangling が無い＝ツールの往復は終わっている。末尾が assistant の発言なら返信待ち
  if (lastEntry?.type === 'assistant' && textOf(lastEntry)) {
    if (quiet) {
      return { ...base, kind: 'awaiting-reply', confident: true, reason: '応答を返し終えて停止' };
    }
    return { ...base, kind: 'running', confident: true, reason: '応答の途中' };
  }

  if (busy) {
    return { ...base, kind: 'running', confident: true, reason: `status=${statusRaw}` };
  }
  if (quiet) {
    return { ...base, kind: 'awaiting-reply', confident: false, reason: '追記が止まっている' };
  }
  return { ...base, kind: 'running', confident: false, reason: '追記が続いている' };
}
