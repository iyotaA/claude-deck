/**
 * 画面から起こすセッションの配線。
 *
 * `server.mjs` が触るのはここだけ。判断は他の3枚に置いてあり、ここに残るのは
 * 「起こして、読んで、渡して、止める」だけの薄い殻にしてある。
 *
 * | 置き場所 | 何を決めているか |
 * |---|---|
 * | `run/spec.mjs` | 何を起こしてよいか（cwd の許可・語彙・argv） |
 * | `run/event.mjs` | 1行をどう畳むか |
 * | `run/ledger.mjs` | いつ状態が変わるか |
 * | ここ | どの順で手を動かすか |
 *
 * ## `view/` を import しない
 *
 * `notify/` と同じ末端の層。合流（起こした run を一覧へ混ぜる）は `server.mjs` の
 * `refresh()` の仕事で、そこが合成の場所と決めてある。
 *
 * ## 時計を自分で持たない
 *
 * `tick()` は `server.mjs` の `refresh()`（2秒）から呼ぶ。ここに `setInterval` を置くと、
 * 一覧の時計と沈黙判定の時計が2本になり、止め忘れの経路も増える。
 *
 * ## HTTP のステータスをここで決めている理由
 *
 * 断る理由が4種類あって（見つからない・指定が悪い・多すぎる・起こせない）、
 * `server.mjs` 側で理由の文字列から分岐させたくないため。
 * 理由の文言を直すたびに窓口の分岐が壊れる、という形を作らない。
 */
import { spawn } from 'node:child_process';

import { classifyStreamLine, encodeUserLine } from '../parse/stream.mjs';
import { oneLine } from '../shared/text.mjs';
import { LINE_MAX, claudeInfo, createLineSplitter, spawnClaude, stopClaude } from '../os/claude.mjs';
import { PROMPT_MAX, buildRunSpec } from './spec.mjs';
import { createRunLedger, isRunOver } from './ledger.mjs';

/**
 * 標準エラーから拾う理由の上限。
 *
 * 全文は持たない。ここに欲しいのは1行目の「Error: …」だけで、
 * 続くスタックトレースは画面に出しても判断の材料にならない。
 */
const STDERR_MAX = 200;

/**
 * 実行の配線を作る。
 *
 * @param {object} [opts]
 * @param {object} [opts.ledger] 台帳。テストから作り替えるために外から渡せる
 * @param {Function} [opts.claude] CLI を掴めたかを返す関数（`claudeInfo`）
 * @param {object} [opts.env] 環境変数
 * @param {string} [opts.platform] 'win32' など
 * @param {Function} [opts.spawnFn] `child_process.spawn` の差し替え口
 * @param {Function} [opts.stopFn] `stopClaude` の差し替え口
 * @param {Function} [opts.clock] いまの時刻を返す関数
 * @param {number} [opts.lineMax] 1行の上限
 * @returns {object} `server.mjs` が触る口
 */
export function createRunner({
  ledger = createRunLedger(),
  claude = claudeInfo,
  env = process.env,
  platform = process.platform,
  spawnFn = spawn,
  stopFn = stopClaude,
  clock = () => Date.now(),
  lineMax = LINE_MAX,
} = {}) {
  /**
   * runId → いま動かしているものの材料。
   *
   * 終端になったら消す。**`perTurn`（1往復で子が閉じる形）のときは消さない。**
   * 次の入力で `--resume` して起こし直すのに、そのときの起動指定が要るため。
   */
  const live = new Map();

  /** 速報の届け先。SSE がここに乗る */
  const listeners = new Set();

  /**
   * 速報を届ける。
   *
   * 購読側の失敗をここで飲むのは、SSE の書き込みが失敗しても
   * 子プロセスの読み取りを止めないため。片方の窓が閉じただけで実行が壊れる形にしない。
   *
   * @param {Array<object>} events 台帳が積んだ出来事
   * @returns {void}
   */
  function emit(events) {
    if (!Array.isArray(events) || events.length === 0) return;
    for (const fn of listeners) {
      try {
        fn(events);
      } catch { /* 届け先の都合で本体を落とさない */ }
    }
  }

  /**
   * 台帳が「もう終わり」と決めた run の子を落とす。
   *
   * 予算超過とセッションIDの食い違いがこれに当たる。**どちらもプロセスは死なない**
   * （予算超過は実測）ので、殻の側から止めないと動き続ける。
   *
   * 判断は台帳、手を動かすのはこちら。この向きを混ぜない。
   *
   * @param {string} runId 実行の識別子
   * @returns {void}
   */
  function reapIfOver(runId) {
    const entry = live.get(runId);
    if (!entry?.child) return;
    const row = ledger.get(runId);
    if (!row || !isRunOver(row.state)) return;
    entry.stopping = true;
    Promise.resolve(stopFn(entry.child, { spawnFn, platform })).catch(() => {});
  }

  /**
   * 子との接続を外す。
   *
   * @param {string} runId 実行の識別子
   * @returns {void}
   */
  function detach(runId) {
    const entry = live.get(runId);
    if (!entry) return;
    entry.child = null;
    entry.splitter = null;
    const row = ledger.get(runId);
    // 終わった run の起動指定は捨てる。`perTurn` は終端ではないので残る
    if (!row || isRunOver(row.state)) live.delete(runId);
  }

  /**
   * 起きた子に受け皿を付ける。
   *
   * **stdout と stderr の `data` は、返ってきたその場（同じ tick）で両方付ける。**
   * 遅れると付ける前に届いた分が消え、片方でも読まないとパイプが詰まって相手が終われなくなる。
   * `setEncoding('utf8')` と `stdin` の `error` は `spawnClaude` が済ませてあるので重ねない。
   *
   * @param {string} runId 実行の識別子
   * @param {object} child 子プロセス
   * @param {object} spec 起動指定（起こし直しに使う）
   * @returns {void}
   */
  function attach(runId, child, spec) {
    const splitter = createLineSplitter({ max: lineMax });
    const entry = { child, splitter, spec, stopping: false, stderr: null };
    live.set(runId, entry);

    child.stdout?.on('data', (chunk) => {
      const at = clock();
      for (const line of splitter.push(chunk)) {
        emit(ledger.apply(runId, classifyStreamLine(line), at));
      }
      reapIfOver(runId);
    });

    // 標準エラーは速報に混ぜない。CLI の警告が本文の間に並ぶと読めなくなる。
    // ただし読み捨てないとパイプが詰まるので、失敗したときの理由として最後のぶんだけ覚えておく。
    // `--verbose` を外したときの「requires --verbose」はここにしか出ない（実測）ので、
    // 拾えないと「異常終了しました（code 1）」だけが残って原因が分からなくなる
    child.stderr?.on('data', (chunk) => {
      const text = oneLine(chunk, STDERR_MAX);
      if (text) entry.stderr = text;
    });

    // 実行ファイルが無いときはここにしか来ない
    child.on('error', (e) => {
      emit(ledger.fail(runId, String(e?.message ?? e), clock()));
      detach(runId);
    });

    child.on('close', (code, signal) => {
      const at = clock();
      // 改行の付いていない最後の1行を拾ってから閉じる
      for (const line of splitter.flush()) {
        emit(ledger.apply(runId, classifyStreamLine(line), at));
      }
      // 止めたのでない異常終了のときだけ、標準エラーを理由に使う。
      // 先に `fail` を通すと `onExit` は状態を上書きせず終了コードだけ記録する
      if (code !== 0 && !entry.stopping && entry.stderr) {
        emit(ledger.fail(runId, entry.stderr, at));
      }
      emit(ledger.onExit(runId, { code, signal }, at));
      detach(runId);
    });
  }

  /**
   * 子の stdin へ指示を1行書く。
   *
   * @param {string} runId 実行の識別子
   * @param {string} text 指示文
   * @param {number} at いまの時刻
   * @returns {{ok:true}|{ok:false, status:number, reason:string}}
   */
  function write(runId, text, at) {
    const child = live.get(runId)?.child;
    if (!child?.stdin || child.stdin.destroyed) {
      const reason = '入力を送れませんでした（相手が閉じています）';
      emit(ledger.fail(runId, reason, at));
      return { ok: false, status: 409, reason };
    }
    try {
      // 指示文は必ず stdin へ。argv には載せない
      child.stdin.write(encodeUserLine(text));
    } catch (e) {
      const reason = `入力を送れませんでした（${String(e?.message ?? e)}）`;
      emit(ledger.fail(runId, reason, at));
      return { ok: false, status: 500, reason };
    }
    emit(ledger.markInput(runId, at));
    return { ok: true };
  }

  /**
   * 子が閉じている run を `--resume` で起こし直す。
   *
   * セッション ID は変えない。変えると一覧・詳細・`?session=` が全部切れる。
   *
   * @param {string} runId 実行の識別子
   * @param {string} prompt 指示文
   * @param {number} at いまの時刻
   * @returns {{ok:true}|{ok:false, status:number, reason:string}}
   */
  function restart(runId, prompt, at) {
    const prev = live.get(runId)?.spec;
    if (!prev) return { ok: false, status: 409, reason: '起こし直せません（起動指定が残っていません）' };

    const found = claude();
    if (!found?.path) {
      return { ok: false, status: 503, reason: found?.reason ?? 'claude が見つかりません' };
    }

    // cwd は起こしたときに一度通してある。ここで許可リストを引き直さないのは、
    // 途中で一覧から消えたフォルダの続きが書けなくなるのを避けるため
    const built = buildRunSpec(
      { ...prev, prompt, resume: true, sessionId: prev.sessionId },
      { allowedDirs: [prev.cwd], env, platform },
    );
    if (!built.ok) return { ok: false, status: 400, reason: built.reason };

    const started = spawnClaude({
      bin: found.path, args: built.spec.args, cwd: built.spec.cwd, env, spawnFn,
    });
    if (!started.ok) {
      emit(ledger.fail(runId, started.reason, at));
      return { ok: false, status: 500, reason: started.reason };
    }

    attach(runId, started.child, built.spec);
    ledger.setPid(runId, started.child.pid ?? null);
    return write(runId, prompt, at);
  }

  /**
   * 新しく1本起こす。
   *
   * **canStart → add → spawn → setPid までを全部同期で進める。**
   * 途中に `await` を挟むと、連打で割り込まれたときに上限も間隔も素通りする。
   *
   * @param {object} input 画面から来たもの
   * @param {object} [ctx]
   * @param {string[]} [ctx.allowedDirs] 許可するフォルダ
   * @returns {{ok:boolean, status:number, runId?:string, row?:object, reason?:string}}
   */
  function start(input, { allowedDirs = [] } = {}) {
    const at = clock();

    // 掴めていないことは `/api/health` にも出ているが、押した場から理由が見えるほうがよい
    const found = claude();
    if (!found?.path) {
      return { ok: false, status: 503, reason: found?.reason ?? 'claude が見つかりません' };
    }

    const built = buildRunSpec(input, { allowedDirs, env, platform });
    if (!built.ok) return { ok: false, status: 400, reason: built.reason };

    const gate = ledger.canStart(at);
    if (!gate.ok) return { ok: false, status: 429, reason: gate.reason };

    const spec = built.spec;
    const runId = ledger.add(spec, at);

    const started = spawnClaude({ bin: found.path, args: spec.args, cwd: spec.cwd, env, spawnFn });
    if (!started.ok) {
      emit(ledger.fail(runId, started.reason, at));
      return { ok: false, status: 500, reason: started.reason, runId, row: ledger.get(runId) };
    }

    attach(runId, started.child, spec);
    ledger.setPid(runId, started.child.pid ?? null);

    const wrote = write(runId, spec.prompt, at);
    if (!wrote.ok) return { ...wrote, runId, row: ledger.get(runId) };

    return { ok: true, status: 202, runId, row: ledger.get(runId) };
  }

  /**
   * 動いている run に続きの指示を送る。
   *
   * 子が閉じていれば `--resume` で起こし直す。呼ぶ側から見ると
   * 「stdin が開き続ける世界」と「1往復ごとに閉じる世界」の区別が要らない形にしてある。
   *
   * @param {string} runId 実行の識別子
   * @param {string} text 指示文
   * @returns {{ok:boolean, status:number, row?:object, reason?:string}}
   */
  function input(runId, text) {
    const at = clock();
    const row = ledger.get(runId);
    if (!row) return { ok: false, status: 404, reason: 'その実行は見つかりません' };
    if (isRunOver(row.state)) return { ok: false, status: 409, reason: 'その実行はもう終わっています' };

    const body = typeof text === 'string' ? text.trim() : '';
    if (!body) return { ok: false, status: 400, reason: '指示が空です' };
    if (body.length > PROMPT_MAX) {
      return { ok: false, status: 400, reason: `指示が長すぎます（${PROMPT_MAX} 文字まで）` };
    }

    const sent = live.get(runId)?.child ? write(runId, body, at) : restart(runId, body, at);
    if (!sent.ok) return { ...sent, row: ledger.get(runId) };
    return { ok: true, status: 202, row: ledger.get(runId) };
  }

  /**
   * 止める。
   *
   * `stdin.end()` → `taskkill /T` → `taskkill /T /F` の3段は `stopClaude` の中。
   * こちらは台帳に「止めにいった」と書いてから任せるだけ。
   *
   * @param {string} runId 実行の識別子
   * @returns {Promise<{ok:boolean, status:number, row?:object, reason?:string}>}
   */
  async function stop(runId) {
    const row = ledger.get(runId);
    if (!row) return { ok: false, status: 404, reason: 'その実行は見つかりません' };
    // もう終わっているものを止めるのは失敗ではない。連打で 409 を返さない
    if (isRunOver(row.state)) return { ok: true, status: 200, row };

    const entry = live.get(runId);
    if (entry) entry.stopping = true;
    emit(ledger.markStopping(runId, clock()));

    if (!entry?.child) {
      // 子がいない（`perTurn` で閉じている）。台帳だけ閉じる
      emit(ledger.onExit(runId, { code: null, signal: null }, clock()));
      live.delete(runId);
      return { ok: true, status: 200, row: ledger.get(runId), closed: true };
    }

    const res = await stopFn(entry.child, { spawnFn, platform });
    if (!res.closed) {
      // 止めきれなかった。`close` は来ないので台帳をこちらで閉じ、残っていることを理由に書く。
      // 「止めました」と嘘をつくより、残骸があることを伝えるほうが役に立つ
      emit(ledger.fail(runId, res.reason ?? '止めきれませんでした', clock()));
      live.delete(runId);
    }
    return { ok: true, status: 200, row: ledger.get(runId), closed: res.closed };
  }

  /**
   * 沈黙を見る。`server.mjs` の `refresh()` から呼ぶ。
   *
   * @returns {string[]} 状態が変わった runId
   */
  function tick() {
    const { changed, events } = ledger.tick(clock());
    emit(events);
    return changed;
  }

  /**
   * 速報を購読する。
   *
   * @param {Function} fn 出来事の配列を受け取る関数
   * @returns {Function} 購読をやめる関数
   */
  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /**
   * 全部止める。サーバーを畳むときに呼ぶ。
   *
   * @returns {Promise<void>}
   */
  async function shutdown() {
    const ids = [...live.keys()];
    await Promise.all(ids.map((id) => stop(id).catch(() => {})));
    listeners.clear();
  }

  return {
    start,
    input,
    stop,
    tick,
    subscribe,
    shutdown,
    /** @returns {Array<object>} 一覧に混ぜる行 */
    rows: () => ledger.rows(),
    /**
     * @param {string} runId 実行の識別子
     * @returns {object|null} 1本ぶんの詳しい形
     */
    get: (runId) => ledger.get(runId),
    /**
     * @param {number} from この seq より後を返す
     * @returns {object} 速報と、押し出された件数
     */
    events: (from) => ledger.events(from),
    /** @returns {object} 本数と通し番号 */
    stats: () => ledger.stats(),
  };
}
