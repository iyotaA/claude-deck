/**
 * 画面から起こしたセッションの台帳と、状態機械。
 *
 * `notify/watch.mjs` と同じ作り方をしている。**閉じた状態を持つ純関数の器**で、
 * fs も spawn も触らず、**時刻は必ず外から `now` で受ける。**
 * だから「いつ止めるか」「いつ失敗と見なすか」の全分岐を `node:test` で通せる。
 *
 * 実際に子プロセスを起こして殺すのは `run/index.mjs`（薄い殻）の仕事。
 * こちらが決めて、あちらが手を動かす。`parseUpdateState`（判断）と
 * `loadUpdateState`（I/O）を分けたのと同じ形。
 *
 * ## 台帳はメモリだけ。ディスクに残さない
 *
 * 子はサーバーの子なので、サーバーが死んだ時点で台帳の意味も消える。
 * 復元を試みると失敗経路（書き込み失敗・壊れた JSON・古い記録の掃除）を3つ増やして、得るものが無い。
 * **被害も残らない。** 会話ログは CLI が `~/.claude/projects/` に書いているので、
 * 再起動後も既存の一覧・書庫・詳細から普通に読め、`--resume` で続けられる。
 *
 * ## 状態
 *
 * ```
 * starting → running → waiting（result が来た＝あなたの番）
 *                   ↘ stalled（STALL_MS 沈黙）
 * running/waiting/stalled → stopping → stopped
 *                         → failed / done
 * ```
 *
 * `stopping` はプランに無いが足してある。`stopClaude` は最大5秒かかるので、
 * そのあいだ `running` と言うのも `stopped` と言うのも嘘になる。
 *
 * ## 「1ターンで閉じる世界」に最初から備える
 *
 * 実測（claude 2.1.228）では stdin が開いている限り `-p` は終了しなかったが、
 * 版が変われば1往復ごとに閉じる作りになりうる。だから run の身元は
 * **`runId ⟷ sessionId`** に置き、子プロセスは**差し替え可能な部品**として持つ。
 *
 * `waiting` のまま子が終了コード0で閉じたら `done` にせず、
 * **`waiting` のまま `perTurn` を立てる。** 次の入力で `--resume` して起こし直せば、
 * どちらの世界でも画面の見え方は変わらない。
 *
 * ## `rows()` に毎秒動く値を入れない
 *
 * `server.mjs` の `refresh()` は、押し出すかどうかを JSON の文字列比較で決めていて、
 * 除外しているのは `idleMs` と `lastActivityAt` だけ。
 * だから経過時間・受信行数・トークン数のような**毎秒動く値をここに載せると毎秒 push が走る。**
 * それらは `get(runId)`（詳細を開いたときだけ引く側）に置いてある。
 *
 * ## import の向き
 *
 * `run/` は末端の層なので `view/` を import しない（`view/` からも import されない）。
 * ここが見てよいのは同じ層の `run/event.mjs` と、どこからでも使える `shared/`、
 * それに `parse/` の純関数（`stream.mjs` の `sameSessionId`、`state.mjs` の `ballOf`）だけ。
 * ID の比べ方も、どちらのボールかの決め方も自前で書かないのは、
 * **同じ判断を2箇所に置かない**ため。
 */
import { sameSessionId } from '../parse/stream.mjs';
import { ballOf } from '../parse/state.mjs';
import { oneLine } from '../shared/text.mjs';
import { toRunEvents } from './event.mjs';

/**
 * 同時に動かせる本数。
 *
 * 手で開いている対話セッションと同じ機械を食うので、押し間違いで10本立つ形にしない。
 */
export const RUN_MAX = 3;

/** 起動の間隔。連打や再送で二重に起こさないため。 */
export const START_MIN_INTERVAL_MS = 2000;

/**
 * 沈黙したまま「実行中」に見え続けるのを防ぐしきい値。
 *
 * 許可要求で固まる形になっても、これがあれば静かに埋もれない。
 */
export const STALL_MS = 120000;

/** 速報を貯めておく件数。溢れたら古いほうから落とし、落とした数を数える。 */
export const EVENT_MAX = 1000;

/** 終わった run を残しておく件数。 */
export const HISTORY_MAX = 20;

/** 理由の文字列の上限。一覧に載る値なので短く保つ。 */
const REASON_MAX = 200;

/** 状態の日本語。画面側に日本語を持たせないため、ここから配る（`STATE_LABELS` と同じ考え方）。 */
export const RUN_STATE_LABELS = Object.freeze({
  starting: '起動中',
  running: '実行中',
  waiting: 'あなたの番',
  stalled: '応答なし',
  stopping: '停止中',
  stopped: '停止しました',
  failed: '失敗しました',
  done: '終了しました',
});

/** もう動かない状態。ここに入ったら子プロセスはいない。 */
const OVER = new Set(['stopped', 'failed', 'done']);

/**
 * その run はもう終わっているか。
 *
 * `server.mjs` と `run/index.mjs` の両方が見るので export してある。
 * 語の一覧を2箇所に書くと、状態を1つ足したときに片方が古くなる。
 *
 * @param {string} state 状態
 * @returns {boolean}
 */
export function isRunOver(state) {
  return OVER.has(state);
}

/**
 * 台帳を1つ作る。
 *
 * @param {object} [opts] 上限のたぐい。テストから数値で確かめられるように全部外から渡せる
 * @param {number} [opts.max] 同時に動かせる本数
 * @param {number} [opts.minIntervalMs] 起動の最小間隔
 * @param {number} [opts.stallMs] 沈黙とみなすまで
 * @param {number} [opts.eventMax] 速報を貯める件数
 * @param {number} [opts.historyMax] 終わった run を残す件数
 * @returns {object} 台帳
 */
export function createRunLedger({
  max = RUN_MAX,
  minIntervalMs = START_MIN_INTERVAL_MS,
  stallMs = STALL_MS,
  eventMax = EVENT_MAX,
  historyMax = HISTORY_MAX,
} = {}) {
  /** @type {Map<string, object>} runId → run */
  const runs = new Map();
  /** @type {Array<object>} 速報のリングバッファ。**run ごとではなく1本**にしてある */
  const ring = [];

  let runSeq = 0;
  let seq = 0;
  let dropped = 0;
  let lastStartAt = null;

  /**
   * 速報を1件積む。
   *
   * `seq` を**全 run で1本**にしてあるのは、SSE の再開カーソルが1つで済むから。
   * run ごとに振ると、画面が run の数だけカーソルを持つことになる。
   * 各件に `runId` を持たせてあるので、run ごとの単調増加という性質は保たれている。
   *
   * @param {object} run 対象の run
   * @param {object} ev `toRunEvents` が作った出来事
   * @param {number} now 時刻
   * @returns {object} 積んだ記録（seq / at / runId 付き）
   */
  function pushEvent(run, ev, now) {
    const rec = { seq: ++seq, at: now, runId: run.runId, ...ev };
    ring.push(rec);
    run.counts.events += 1;
    while (ring.length > eventMax) {
      ring.shift();
      dropped += 1;
    }
    return rec;
  }

  /**
   * 台帳側から出す1行。状態が変わった理由のように、画面で見えないと困るものだけに使う。
   *
   * `starting → running` のような当たり前の遷移では出さない。
   * 状態そのものはヘッダに出るので、出すと速報がその繰り返しで埋まる。
   *
   * @param {object} run 対象の run
   * @param {string} text 本文
   * @param {number} now 時刻
   * @returns {object} 積んだ記録
   */
  function pushNote(run, text, now) {
    return pushEvent(run, { kind: 'note', text }, now);
  }

  /**
   * 終わった run が増えすぎないように古いものから落とす。
   *
   * 落とした run の速報はリングに残るが、そのうち押し出されるので放っておく。
   * ここで探して消すと、`seq` の連番に穴が空いて再開カーソルの意味が変わる。
   *
   * @returns {void}
   */
  function prune() {
    const over = [...runs.values()].filter((r) => isRunOver(r.state));
    if (over.length <= historyMax) return;
    over.sort((a, b) => a.startedAt - b.startedAt);
    for (const r of over.slice(0, over.length - historyMax)) runs.delete(r.runId);
  }

  /**
   * 一覧へ出す粗い形。**毎秒動く値を入れないこと。**
   *
   * @param {object} run 対象の run
   * @returns {object} 押し出しの差分判定を素通りしない値だけ
   */
  function toRow(run) {
    return {
      runId: run.runId,
      sessionId: run.sessionId,
      cwd: run.cwd,
      state: run.state,
      stateLabel: RUN_STATE_LABELS[run.state] ?? run.state,
      model: run.model,
      effort: run.effort,
      permissionMode: run.permissionMode,
      resume: run.resume,
      perTurn: run.perTurn,
      pid: run.pid,
      exitCode: run.exitCode,
      reason: run.reason,
      startedAt: run.startedAt,
      turns: run.turns,
    };
  }

  return {
    /**
     * いま新しく起こしてよいか。
     *
     * **`add()` の前に必ず呼ぶこと。** ここで断らないと上限が意味を失う。
     * `run/index.mjs` は canStart → add → spawn を全部同期で進めるので、
     * そのあいだに別の要求が割り込んで二重に起きることはない。
     *
     * @param {number} now 時刻
     * @returns {{ok:true}|{ok:false, reason:string}}
     */
    canStart(now) {
      let active = 0;
      for (const r of runs.values()) if (!isRunOver(r.state)) active += 1;
      if (active >= max) {
        return { ok: false, reason: `同時に動かせるのは ${max} 本までです（いま ${active} 本）` };
      }
      if (lastStartAt !== null) {
        const since = now - lastStartAt;
        // 時計が巻き戻ったとき（since が負）は通す。
        // 負を「間隔が足りない」と読むと、巻き戻った幅のあいだ起動できなくなる
        if (since >= 0 && since < minIntervalMs) {
          return { ok: false, reason: '起動が続けざまです。少し待ってからもう一度' };
        }
      }
      return { ok: true };
    },

    /**
     * run を1つ足す。
     *
     * `spec.prompt` は**持たない。** stdin へ書いたら役目は終わりで、
     * 本文は `--replay-user-messages` の戻り（`echo`）として速報に出る。
     *
     * @param {object} spec `buildRunSpec` が返した spec
     * @param {number} now 時刻
     * @returns {string} 付けた runId
     */
    add(spec, now) {
      const runId = `r${++runSeq}`;
      runs.set(runId, {
        runId,
        sessionId: spec.sessionId,
        cwd: spec.cwd,
        model: spec.model ?? null,
        effort: spec.effort ?? null,
        permissionMode: spec.permissionMode,
        budgetUsd: spec.budgetUsd ?? null,
        resume: spec.resume === true,
        state: 'starting',
        reason: null,
        pid: null,
        exitCode: null,
        perTurn: false,
        startedAt: now,
        lastLineAt: null,
        turns: 0,
        costUSD: null,
        stopRequested: false,
        counts: { lines: 0, broken: 0, events: 0 },
      });
      lastStartAt = now;
      prune();
      return runId;
    },

    /**
     * 子が起きたことを記録する。
     *
     * `waiting` からも `running` へ戻すのは、`perTurn` の run を起こし直したときのため。
     *
     * @param {string} runId 対象
     * @param {number|null} pid 子の PID
     * @returns {boolean} 記録できたか
     */
    setPid(runId, pid) {
      const run = runs.get(runId);
      if (!run || isRunOver(run.state)) return false;
      run.pid = typeof pid === 'number' && Number.isFinite(pid) ? pid : null;
      if (run.state === 'starting' || run.state === 'waiting') run.state = 'running';
      return true;
    },

    /**
     * stream-json の1行を反映する。
     *
     * @param {string} runId 対象
     * @param {object} classified `classifyStreamLine` の戻り
     * @param {number} now 時刻
     * @returns {Array<object>} 積んだ速報（呼ぶ側はこれをそのまま SSE へ流す）
     */
    apply(runId, classified, now) {
      const run = runs.get(runId);
      // 終端に落ちた後に届いた行は捨てる。
      // 止めた直後には数行が遅れて届くので、これが無いと「停止しました」の後に本文が並ぶ
      if (!run || isRunOver(run.state)) return [];

      run.lastLineAt = now;
      run.counts.lines += 1;
      if (classified?.kind === 'broken') run.counts.broken += 1;

      // 行が届いた＝動いている。沈黙から戻す
      if (run.state === 'starting' || run.state === 'stalled') run.state = 'running';

      const pushed = toRunEvents(classified).map((ev) => pushEvent(run, ev, now));

      // 別のセッションへ書き込んでいないか。
      // `session_id` はどの行にも載るので init に限らず毎行見る（init はターンごとに何度も来る）
      if (classified?.sessionId && !sameSessionId(classified.sessionId, run.sessionId)) {
        run.state = 'failed';
        run.reason = `セッションIDが一致しません（求めた ${run.sessionId} / 返った ${classified.sessionId}）`;
        pushed.push(pushNote(run, run.reason, now));
        return pushed;
      }

      for (const ev of pushed) {
        if (ev.kind !== 'result') continue;

        // `num_turns` は累積ではない（実測。2往復目も 1 に戻る）ので、こちらで数える
        run.turns += 1;
        if (typeof ev.costUSD === 'number') run.costUSD = ev.costUSD;

        if (ev.terminalReason === 'budget_exhausted') {
          // 実測で**プロセスは死なない**。台帳側から終わらせないと「実行中」のまま残り続ける
          run.state = 'failed';
          run.reason = oneLine(ev.errors, REASON_MAX) ?? '予算の上限に達しました';
          pushed.push(pushNote(run, run.reason, now));
          break;
        }

        // 予算超過以外の `is_error` では止めない。
        // 知らない `terminal_reason` で子を殺すと、動いているセッションを壊すことになる。
        // 分からないときは過小に反応する側へ倒し、理由だけ残す
        run.reason = ev.isError
          ? (oneLine(ev.errors ?? ev.text, REASON_MAX) ?? 'エラーで終わりました')
          : null;
        if (run.state === 'running') run.state = 'waiting';
      }

      return pushed;
    },

    /**
     * 指示を送ったことを記録する。
     *
     * **本文は持たない。** 積むのは「送りました」の1行だけで、
     * 中身は `--replay-user-messages` の戻りとして向こうから返ってくる。
     * こうしておくと「書けたのに読まれていない」と「読まれたが応答が無い」が切り分けられる。
     *
     * @param {string} runId 対象
     * @param {number} now 時刻
     * @returns {Array<object>} 積んだ速報
     */
    markInput(runId, now) {
      const run = runs.get(runId);
      if (!run || isRunOver(run.state)) return [];
      // 沈黙の時計を戻す。戻さないと、長く待たせた後の1通目で即 stalled になる
      run.lastLineAt = now;
      const ev = pushNote(run, '指示を送りました', now);
      if (run.state === 'waiting' || run.state === 'stalled') run.state = 'running';
      return [ev];
    },

    /**
     * 停止を頼まれたことを記録する。
     *
     * `stopClaude` は stdin を閉じてから最大5秒かけて木ごと落とす。
     * そのあいだを `running` と言うのも `stopped` と言うのも嘘になるので、状態を1つ挟む。
     *
     * @param {string} runId 対象
     * @param {number} now 時刻
     * @returns {Array<object>} 積んだ速報。既に終わっていれば空
     */
    markStopping(runId, now) {
      const run = runs.get(runId);
      if (!run || isRunOver(run.state)) return [];
      run.stopRequested = true;
      run.state = 'stopping';
      return [pushNote(run, '停止しています', now)];
    },

    /**
     * 起こせなかった・続けられなくなったことを記録する。
     *
     * 実行ファイルが無いときは `child.on('error')` にしか来ないので、その受け皿でもある。
     *
     * @param {string} runId 対象
     * @param {string} reason 理由
     * @param {number} now 時刻
     * @returns {Array<object>} 積んだ速報
     */
    fail(runId, reason, now) {
      const run = runs.get(runId);
      if (!run || isRunOver(run.state)) return [];
      run.state = 'failed';
      run.reason = oneLine(reason, REASON_MAX) ?? '失敗しました';
      run.pid = null;
      return [pushNote(run, run.reason, now)];
    },

    /**
     * 子が閉じたことを反映する。
     *
     * `waiting` のまま 0 で閉じた場合だけ**終端にしない。**
     * 1往復ごとにプロセスが閉じる作りに変わっても、続きを打てる形を保つため。
     *
     * @param {string} runId 対象
     * @param {{code?:number|null, signal?:string|null}} [info] 終了の様子
     * @param {number} now 時刻
     * @returns {Array<object>} 積んだ速報
     */
    onExit(runId, info, now) {
      const run = runs.get(runId);
      if (!run) return [];

      const code = typeof info?.code === 'number' ? info.code : null;
      const signal = typeof info?.signal === 'string' ? info.signal : null;

      run.pid = null;
      run.exitCode = code;
      // 既に終端なら状態は上書きしない。exitCode だけ記録して帰る
      if (isRunOver(run.state)) return [];

      if (run.stopRequested) {
        run.state = 'stopped';
        return [pushNote(run, '止めました', now)];
      }

      if (run.state === 'waiting' && code === 0) {
        run.perTurn = true;
        return [pushNote(run, '1往復ぶんで終了しました。続けて入力できます', now)];
      }

      if (code === 0) {
        run.state = 'done';
        return [pushNote(run, '終了しました', now)];
      }

      run.state = 'failed';
      run.reason = signal
        ? `異常終了しました（signal ${signal}）`
        : `異常終了しました（code ${code === null ? '不明' : code}）`;
      return [pushNote(run, run.reason, now)];
    },

    /**
     * 沈黙している run を `stalled` にする。
     *
     * **`running` だけが対象。** `waiting` は沈黙が正常な状態なので見ない
     * （見ると、返事を待たせているだけのものが全部「応答なし」になる）。
     *
     * 1行も来ていない run は `startedAt` から測る。
     * これが無いと「起こしたが1行も出さずに固まった」がいつまでも `starting` のままになる。
     *
     * @param {number} now 時刻
     * @returns {{changed:Array<string>, events:Array<object>}} 変わった runId と、積んだ速報
     */
    tick(now) {
      const changed = [];
      const events = [];
      for (const run of runs.values()) {
        if (run.state !== 'running' && run.state !== 'starting') continue;
        if (now - (run.lastLineAt ?? run.startedAt) < stallMs) continue;
        run.state = 'stalled';
        changed.push(run.runId);
        events.push(pushNote(run, '応答がありません', now));
      }
      prune();
      return { changed, events };
    },

    /**
     * 一覧へ出す行。粗い値だけ。
     *
     * @returns {Array<object>} 起こした順
     */
    rows() {
      return [...runs.values()].map(toRow);
    },

    /**
     * 1本ぶんの詳しい姿。詳細を開いたときだけ引く。
     *
     * @param {string} runId 対象
     * @returns {object|null} 無ければ null
     */
    get(runId) {
      const run = runs.get(runId);
      if (!run) return null;
      return {
        ...toRow(run),
        budgetUsd: run.budgetUsd,
        lastLineAt: run.lastLineAt,
        costUSD: run.costUSD,
        counts: { ...run.counts },
      };
    },

    /**
     * 溜めてある速報を返す。
     *
     * @param {number} [from] この `seq` より後。0 か未指定なら持っているぶん全部
     * @returns {{events:Array<object>, from:number, nextSeq:number, missed:number}}
     *          `missed` は落として渡せなかった件数。**黙って詰めない**
     */
    events(from) {
      const start = Number.isFinite(from) && from > 0 ? Math.floor(from) : 0;
      const oldest = ring.length ? ring[0].seq : seq + 1;
      return {
        events: ring.filter((e) => e.seq > start),
        from: start,
        nextSeq: seq,
        // 続きを求められたのに、その一部が既に押し出されている
        missed: start > 0 && oldest > start + 1 ? oldest - start - 1 : 0,
      };
    },

    /**
     * run を1つ消す。終わったものだけ。
     *
     * @param {string} runId 対象
     * @returns {boolean} 消したか
     */
    remove(runId) {
      const run = runs.get(runId);
      if (!run || !isRunOver(run.state)) return false;
      return runs.delete(runId);
    },

    /**
     * 台帳ぜんたいの様子。`/api/health` に出す。
     *
     * @returns {{active:number, total:number, seq:number, dropped:number}}
     */
    stats() {
      let active = 0;
      for (const r of runs.values()) if (!isRunOver(r.state)) active += 1;
      return { active, total: runs.size, seq, dropped };
    },
  };
}

/* ------------------------------------------------------------------ 合流 */

/**
 * 実行の状態を、一覧の語彙へ写す。
 *
 * 語彙が2つあるのは、見ているものが違うから。
 * `RUN_STATE_LABELS` は「この子プロセスがどうなっているか」、
 * `parse/state.mjs` の `STATE_LABELS` は「誰がボールを持っているか」を言っている。
 *
 * **写さずに run の語をそのまま `state` へ入れてはいけない。**
 * `STATE_RANK` にその語が無いので `?? 9` で一覧の末尾に沈み、
 * いま動いているセッションが最下部に並ぶ。
 *
 * `stalled`（応答なし）を `unknown`（rank 4）ではなく `awaiting-reply`（rank 2）へ
 * 写しているのは、あれが**人が見に行くべきもの**だから。不明の位置に沈めると気づけない。
 */
const RUN_TO_LIST_STATE = Object.freeze({
  starting: 'running',
  running: 'running',
  stopping: 'running',
  waiting: 'awaiting-reply',
  stalled: 'awaiting-reply',
  stopped: 'ended',
  failed: 'ended',
  done: 'ended',
});

/**
 * 台帳の行を、一覧の行に重ねる。
 *
 * **終わった run は状態を上書きしない。** 終わっていれば会話ログのほうが正しく、
 * `deriveState` が普通に判定できる。載せるのは「この画面から起こした」という事実だけ。
 *
 * @param {object} row 一覧の行
 * @param {object} run 台帳の行（`rows()` が返す粗い形）
 * @returns {object} 新しい行
 */
function overlay(row, run) {
  const badge = { ...run };
  if (isRunOver(run.state)) return { ...row, origin: 'deck', run: badge };

  const state = RUN_TO_LIST_STATE[run.state] ?? row.state;
  return {
    ...row,
    // headless の登録簿には `status` のキーが無く、`deriveState` の2段目・3段目が効かない。
    // 実測（2026-08-16）で、走っている最中の1本が `awaiting-reply` に見えていた
    alive: true,
    pid: run.pid ?? row.pid,
    state,
    // 画面には run の実態を出す（「あなたの番」「応答なし」など）。
    // 上の写しは並び順と色のためだけのもの
    stateLabel: run.stateLabel,
    ball: ballOf(state),
    // 台帳が正なので、ログの末尾から読んだ「待っているツール」は伏せる。
    // 残すと、実際には次の手へ進んでいるのに古い dangling が出続ける
    waitingFor: null,
    stateReason: run.reason ?? 'この画面から起こしたセッション',
    stateConfident: true,
    statusRaw: null,
    byStatus: false,
    origin: 'deck',
    run: badge,
  };
}

/**
 * 会話ログがまだ無い run から、一覧の行を組む。
 *
 * `view/shape.mjs` の `identity()` / `stateFields()` と同じキーを手で並べてある。
 * **あちらを import しない。** `run/` は末端の層で `view/` を見ないと決めてあるため。
 * 向きを崩すくらいなら、キーが2箇所に並ぶほうがまだ直しやすい。
 *
 * @param {object} run 台帳の行
 * @param {number} now 時刻
 * @returns {object} 一覧の行
 */
function synthRow(run, now) {
  const state = RUN_TO_LIST_STATE[run.state] ?? 'running';
  const cwd = run.cwd ?? null;
  const startedAt = Number.isFinite(run.startedAt) ? run.startedAt : null;

  return {
    // identity() と同じ並び
    sessionId: run.sessionId,
    pid: run.pid ?? null,
    name: run.sessionId ? run.sessionId.slice(0, 8) : '不明',
    cwd,
    project: cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : null,
    // 指示文は台帳が持っていない（`rows()` に載せていない）。
    // 会話ログが出れば次の走査で本物の見出しに入れ替わる
    title: null,
    permissionMode: run.permissionMode ?? null,
    mode: null,
    model: run.model ?? null,
    effort: run.effort ?? null,
    version: null,
    gitBranch: null,
    contextTokens: null,
    startedAt,
    alive: true,

    // stateFields() と同じ並び
    state,
    stateLabel: run.stateLabel,
    ball: ballOf(state),
    // **ここだけは動いてよい。** `refresh()` の差分判定が除外している2つなので、
    // 毎秒変わっても押し出しは起きない（それ以外の値は動かさない）
    idleMs: Number.isFinite(now) && startedAt !== null ? Math.max(0, now - startedAt) : null,
    lastActivityAt: startedAt,
    waitingFor: null,
    stateReason: 'この画面から起こしたセッション（会話ログはまだありません）',
    stateConfident: true,
    statusRaw: null,
    // 通知の鍵に混ざる値。**null にしない。**
    // `notify/watch.mjs` は返信待ちの鍵を `sessionId` ＋ `anchorId` で作るので、
    // ここが空だと鍵が生涯1つになり、2回目以降が黙って落ちる。
    // 会話ログが出れば overlay 側（ログ末尾の uuid）に入れ替わる
    anchorId: run.runId ?? null,
    byStatus: false,

    // 一覧だけが使う項目
    nameSource: null,
    lastPrompt: null,
    lastAssistantText: null,
    skills: [],
    agents: [],
    subagentCount: null,
    parseErrors: 0,
    logFile: null,
    logSize: null,
    hasLog: false,
    // 稼働中は中身が薄くても必ず出す、と listSessions が決めている。それに合わせる
    substantive: true,

    origin: 'deck',
    run: { ...run },
  };
}

/**
 * 一覧に、この画面から起こしたぶんを重ねる。
 *
 * ## なぜ合流が要るか
 *
 * headless で立てても `sessions/<PID>.json` は書かれるが、**`status` のキーが無い**（実測）。
 * だから `deriveState` は末尾の行だけで状態を決めることになり、
 * 走っている最中でも「返信待ち」に見える。`parse/state.mjs` の規則は**1行も変えず**、
 * 台帳が知っている本当の状態をここで重ねて直す。
 *
 * ## 呼ぶ場所
 *
 * `server.mjs` の `refresh()`。**`view/` の中でやらない。**
 * `view/` と `run/` はお互いを import しない決まりなので、合成の場所はサーバーだけ。
 * 並べ直しは `view/sessions.mjs` の `sortRows` を使う（比較器を2箇所に書かない）。
 *
 * ## 足すのは生きているぶんだけ
 *
 * 終わった run でログが無いものは、行を合成しない。
 * 足すと、書庫にも詳細にも出せない幽霊行が `HISTORY_MAX` 件ぶん一覧に残る。
 * 起こしてすぐ失敗したものは実行パネルとフォームの帯に出るので、そちらで足りる。
 *
 * @param {Array<object>} rows 一覧の行（`listSessions` が返したもの）
 * @param {Array<object>} runRows 台帳の行（`runner.rows()`）
 * @param {number} [now] 時刻。合成行の `idleMs` にだけ使う
 * @returns {Array<object>} 重ねた新しい配列（並べ替えはしない）
 */
export function mergeRuns(rows, runRows, now = 0) {
  const base = Array.isArray(rows) ? rows : [];
  if (!Array.isArray(runRows) || runRows.length === 0) return base;

  // 同じ sessionId で2本あるなら、後から起こしたほうを採る。
  // `--resume` で起こし直すと、前の run が終端のまま履歴に残っているため
  const bySession = new Map();
  for (const run of runRows) {
    if (run?.sessionId) bySession.set(run.sessionId, run);
  }

  const merged = base.map((row) => {
    const run = row?.sessionId ? bySession.get(row.sessionId) : null;
    if (!run) return row;
    bySession.delete(row.sessionId);
    return overlay(row, run);
  });

  for (const run of bySession.values()) {
    if (isRunOver(run.state)) continue;
    merged.push(synthRow(run, now));
  }
  return merged;
}
