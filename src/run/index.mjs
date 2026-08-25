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
 * ## stdin へ書く手はここに1本だけ
 *
 * 台帳（`ledger.mjs`）は「送るべき意図」を `outbox` に積むだけで、行は組まない。
 * 行を組むのは `parse/stream.mjs`、**書くのはここ**。
 * `emit()` を直に呼ばず `commit()` に通すのは、台帳を動かしたどの経路でも
 * 積まれたぶんが必ず捌けるようにするため。**書き忘れが構造的に起きない形にしてある。**
 *
 * ## HTTP のステータスをここで決めている理由
 *
 * 断る理由が5種類あって（見つからない・指定が悪い・もう動いている・多すぎる・起こせない）、
 * `server.mjs` 側で理由の文字列から分岐させたくないため。
 * 理由の文言を直すたびに窓口の分岐が壊れる、という形を作らない。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import {
  classifyStreamLine,
  encodeControlError,
  encodeControlRequest,
  encodePermissionResponse,
  encodeUserLine,
} from '../parse/stream.mjs';
import { oneLine } from '../shared/text.mjs';
import { LINE_MAX, claudeInfo, createLineSplitter, spawnClaude, stopClaude } from '../os/claude.mjs';
import { PERMISSION_MODES, PROMPT_MAX, buildRunSpec, mergeSwitch } from './spec.mjs';
import { RUN_MAX, createRunLedger, isChildDone, isRunOver } from './ledger.mjs';

/**
 * 標準エラーから拾う理由の上限。
 *
 * 全文は持たない。ここに欲しいのは1行目の「Error: …」だけで、
 * 続くスタックトレースは画面に出しても判断の材料にならない。
 */
const STDERR_MAX = 200;

/**
 * 台帳が返す断り方を、HTTP の番号と日本語に直す表。
 *
 * **台帳に番号を持たせない。** あちらが番号を知ると、窓口を1つ足すたびに
 * 判断の側まで直すことになる。断る理由の切り分けは台帳、番号付けはここ。
 *
 * `answered` を 404 にしないのは、2つのタブから同時に押したときに
 * 片方が「別の窓で答えられました」と出せるようにするため。**run は在る。**
 */
const ANSWER_DENY = Object.freeze({
  'no-run': { status: 404, reason: 'その実行は見つかりません' },
  over: { status: 409, reason: 'その実行はもう終わっています' },
  'no-request': { status: 400, reason: 'どの要求への答えか分かりません' },
  answered: { status: 409, reason: 'その要求はもう答えました（別の窓で答えられたかもしれません）' },
  bad: { status: 400, reason: '答え方が不正です' },
});

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

  /** こちらから撃つ要求に振る番号。**こだまと本物の応答を見分ける鍵になる** */
  let reqSeq = 0;

  /**
   * こちらから撃つ `control_request` の ID を採番する。
   *
   * 台帳ではなくここで振るのは、あちらが「時刻すら外から受ける純関数の器」だから。
   * `randomUUID` を1本入れるだけでその性質が崩れる。
   *
   * @returns {string} 他と衝突しない ID
   */
  function nextRequestId() {
    return `req_${++reqSeq}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }

  /**
   * 台帳が積んだ意図を、stdin へ書ける1行に組む。
   *
   * 組めなかったら `null`。**ここで投げない。**
   * 1件の形が壊れているだけで、同じ束の他の答えまで届かなくなるのは割に合わない。
   *
   * @param {object} item `takeOutbox()` が返した1件
   * @returns {string|null} 末尾に改行を含む1行。組めなければ null
   */
  function encodeOutbox(item) {
    try {
      switch (item?.kind) {
        case 'permission-response':
          return encodePermissionResponse(item.requestId, item.decision);
        case 'control-error':
          return encodeControlError(item.requestId, item.message);
        case 'control-request':
          return encodeControlRequest(item.requestId, item.subtype, item.params);
        default:
          return null;
      }
    } catch {
      // エンコーダは壊れた引数で TypeError を投げる（`encodeUserLine` と同じ作法）
      return null;
    }
  }

  /**
   * 権限モードが替わったことを起動指定にも書き戻す。
   *
   * **忘れると `restart()` と `switchRun()` が古いモードで建て直す。**
   * 画面には替わったと出ているのに、次の子は plan で立つ——
   * 「替えたのに戻っていた」という、いちばん気づきにくい壊れ方になる。
   *
   * 見るのは `ev.mode`（受理の知らせに1つだけ付く）。
   * 新しい kind を作らないのは、画面側が知らない kind を空の本文で描くため。
   *
   * @param {Array<object>} events 台帳が積んだ出来事
   * @returns {void}
   */
  function syncMode(events) {
    for (const ev of events) {
      if (typeof ev?.mode !== 'string' || !ev.mode) continue;
      const spec = live.get(ev.runId)?.spec;
      if (spec) spec.permissionMode = ev.mode;
    }
  }

  /**
   * 台帳を動かしたぶんを、書いて・直して・配る。
   *
   * 順に意味がある。
   *
   * 1. **stdin へ書くのが先。** 相手は答えを待って1行も進めていない
   * 2. 受理された権限モードを起動指定へ書き戻す
   * 3. 速報を配る（配布の失敗で子の読み取りを止めない）
   *
   * @param {Array<object>} events 台帳が積んだ出来事
   * @returns {string[]} 書けなかった runId。ふつうは空
   */
  function commit(events) {
    const list = Array.isArray(events) ? events : [];
    const failed = [];
    const extra = [];

    for (const item of ledger.takeOutbox()) {
      const line = encodeOutbox(item);
      const child = live.get(item.runId)?.child;
      // 書く先が無い（子が閉じた）。捨てる。台帳側は pending を消してあるので取りこぼしにはならない
      if (!line || !child?.stdin || child.stdin.destroyed) {
        if (!failed.includes(item.runId)) failed.push(item.runId);
        continue;
      }
      try {
        child.stdin.write(line);
      } catch (e) {
        if (!failed.includes(item.runId)) failed.push(item.runId);
        extra.push(...ledger.fail(item.runId, `答えを送れませんでした（${String(e?.message ?? e)}）`, clock()));
      }
    }

    const all = extra.length > 0 ? [...list, ...extra] : list;
    syncMode(all);
    emit(all);
    return failed;
  }

  /**
   * 台帳が「もう子は要らない」と決めた run の子を落とす。
   *
   * 予算超過とセッションIDの食い違いがこれに当たる。**どちらもプロセスは死なない**
   * （予算超過は実測）ので、殻の側から止めないと動き続ける。
   *
   * **見るのは `isChildDone` で、`isRunOver` ではない。** 予算切れは終端にしないので、
   * 終端で判定すると畳む手が出ず、上限に当たった子が機械と `RUN_MAX` の枠を
   * 掴んだまま残る（実測でプロセスは生きている）。
   *
   * 判断は台帳、手を動かすのはこちら。この向きを混ぜない。
   *
   * @param {string} runId 実行の識別子
   * @returns {void}
   */
  function reapIfDone(runId) {
    const entry = live.get(runId);
    if (!entry?.child) return;
    // 誰かが既に畳んでいるなら重ねない。stdout の `data` ごとに来るので、
    // 予算切れの `result` の後ろにもう1行届くだけで2回目が走る
    // （実測で `system/hook_response` が `result` の後に来ることがある）
    if (entry.stopping) return;
    const row = ledger.get(runId);
    if (!row || !isChildDone(row.state)) return;
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
    // 終わった run の起動指定は捨てる。終端でないものは残す
    // （`perTurn` と予算切れ。どちらも子はいないが、同じ指定で続きを打てる）
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
        commit(ledger.apply(runId, classifyStreamLine(line), at));
      }
      reapIfDone(runId);
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
      commit(ledger.fail(runId, String(e?.message ?? e), clock()));
      detach(runId);
    });

    child.on('close', (code, signal) => {
      const at = clock();
      // 改行の付いていない最後の1行を拾ってから閉じる
      for (const line of splitter.flush()) {
        commit(ledger.apply(runId, classifyStreamLine(line), at));
      }
      // 止めたのでない異常終了のときだけ、標準エラーを理由に使う。
      // 先に `fail` を通すと `onExit` は状態を上書きせず終了コードだけ記録する
      if (code !== 0 && !entry.stopping && entry.stderr) {
        commit(ledger.fail(runId, entry.stderr, at));
      }
      commit(ledger.onExit(runId, { code, signal }, at));
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
      commit(ledger.fail(runId, reason, at));
      return { ok: false, status: 409, reason };
    }
    try {
      // 指示文は必ず stdin へ。argv には載せない
      child.stdin.write(encodeUserLine(text));
    } catch (e) {
      const reason = `入力を送れませんでした（${String(e?.message ?? e)}）`;
      commit(ledger.fail(runId, reason, at));
      return { ok: false, status: 500, reason };
    }
    commit(ledger.markInput(runId, at));
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
      commit(ledger.fail(runId, started.reason, at));
      return { ok: false, status: 500, reason: started.reason };
    }

    attach(runId, started.child, built.spec);
    ledger.setPid(runId, started.child.pid ?? null);
    return write(runId, prompt, at);
  }

  /**
   * 続きを起こしてよいか。
   *
   * `--resume` を同じセッションへ2本当てると会話ログが壊れる。
   * だから「いま動いていないこと」を確かめてからでないと通さない。
   *
   * **`null`（分からない）を「誰も動いていない」と読み替えない。**
   * 一覧をまだ一度も読めていない時期にそれをやると、ちょうど動いている
   * セッションへ2本目を当てることになる。0 と不明を分けるのと同じ扱い。
   *
   * @param {string} sessionId 続けたいセッション
   * @param {Set<string>|null} liveSessions いま動いているセッションの ID。分からなければ null
   * @returns {string|null} 断る理由。通してよければ null
   */
  function resumeBlocked(sessionId, liveSessions) {
    if (!(liveSessions instanceof Set)) {
      return 'いま動いているセッションを確かめられません。少し待ってからもう一度';
    }
    if (liveSessions.has(sessionId)) {
      return 'そのセッションはまだ動いています（ターミナル側を終えてからにしてください）';
    }
    // 画面から起こしたぶんは一覧に出るまで間があるので、台帳も見る。
    // refresh() のタイミングに関わらず二重起動を塞げる
    for (const row of ledger.rows()) {
      if (row.sessionId === sessionId && !isRunOver(row.state)) {
        return 'そのセッションはこの画面から動かしている最中です';
      }
    }
    return null;
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
   * @param {Set<string>|null} [ctx.liveSessions] いま動いているセッションの ID（続きを起こすときだけ見る）
   * @returns {{ok:boolean, status:number, runId?:string, row?:object, reason?:string}}
   */
  function start(input, { allowedDirs = [], liveSessions = null } = {}) {
    const at = clock();

    // 掴めていないことは `/api/health` にも出ているが、押した場から理由が見えるほうがよい
    const found = claude();
    if (!found?.path) {
      return { ok: false, status: 503, reason: found?.reason ?? 'claude が見つかりません' };
    }

    const built = buildRunSpec(input, { allowedDirs, env, platform });
    if (!built.ok) return { ok: false, status: 400, reason: built.reason };

    if (built.spec.resume) {
      const busy = resumeBlocked(built.spec.sessionId, liveSessions);
      if (busy) return { ok: false, status: 409, reason: busy };
    }

    const gate = ledger.canStart(at);
    if (!gate.ok) return { ok: false, status: 429, reason: gate.reason };

    const spec = built.spec;
    const runId = ledger.add(spec, at);

    const started = spawnClaude({ bin: found.path, args: spec.args, cwd: spec.cwd, env, spawnFn });
    if (!started.ok) {
      commit(ledger.fail(runId, started.reason, at));
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
    // **許可待ちに user 行を送っても1行も進まない。** 相手が待っているのは control_response で、
    // 指示文ではない。通すと「送ったのに動かない」——今回直したバグと同じ壊れ方を再生産する
    if (row.state === 'needs-permission') {
      return { ok: false, status: 409, reason: '許可を聞かれています。先にその確認へ答えてください' };
    }

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
   * 許可要求に答える。
   *
   * **断る判断を全部済ませてから台帳を動かす。** 順は `switchRun` と揃えてある。
   *
   * `body.then` は「答えたあと権限モードも替える」ぶん。
   * **`ExitPlanMode` を許可しただけではモードは plan のまま**なので（実測）、
   * 承認と `set_permission_mode` を続けて撃つ。撃つ順は台帳が守る（allow が先）。
   *
   * 語彙を確かめるのはここ。台帳は検証済みの1語を受け取るだけにしてある。
   *
   * @param {string} runId 実行の識別子
   * @param {string} requestId どの要求への答えか
   * @param {object} body 画面から来た答え
   * @returns {{ok:boolean, status:number, row?:object, reason?:string}}
   */
  function answer(runId, requestId, body) {
    const at = clock();
    const row = ledger.get(runId);
    if (!row) return { ok: false, status: 404, reason: 'その実行は見つかりません' };
    // 見るのは `isChildDone`。予算切れは終端ではないが、子がいないので答えを書く先が無い
    if (isChildDone(row.state)) return { ok: false, status: 409, reason: 'その実行はもう終わっています' };

    const id = typeof requestId === 'string' ? requestId.trim() : '';
    if (!id) return { ok: false, status: 400, reason: 'どの要求への答えか分かりません' };

    const behavior = body?.behavior;
    if (behavior !== 'allow' && behavior !== 'deny') {
      return { ok: false, status: 400, reason: '答え方が不正です（allow か deny）' };
    }

    const decision = {
      behavior,
      message: body?.message,
      updatedInput: body?.updatedInput,
      updatedPermissions: body?.updatedPermissions,
    };

    const then = typeof body?.then === 'string' ? body.then.trim() : '';
    if (then) {
      if (!PERMISSION_MODES.includes(then)) {
        return {
          ok: false,
          status: 400,
          reason: `権限モードの指定が不正です（${PERMISSION_MODES.join(' / ')}）`,
        };
      }
      decision.then = then;
      decision.thenRequestId = nextRequestId();
    }

    const res = ledger.answer(runId, id, decision, at);
    if (!res.ok) {
      const deny = ANSWER_DENY[res.code] ?? { status: 500, reason: '答えを送れませんでした' };
      return { ok: false, status: deny.status, reason: deny.reason };
    }

    // 書けたかどうかはここで初めて分かる。**書けていないのに 202 を返さない**
    if (commit(res.events).includes(runId)) {
      return { ok: false, status: 500, reason: '答えを送れませんでした', row: ledger.get(runId) };
    }
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
    commit(ledger.markStopping(runId, clock()));

    if (!entry?.child) {
      // 子がいない（`perTurn` で閉じている）。台帳だけ閉じる
      commit(ledger.onExit(runId, { code: null, signal: null }, clock()));
      live.delete(runId);
      return { ok: true, status: 200, row: ledger.get(runId), closed: true };
    }

    const res = await stopFn(entry.child, { spawnFn, platform });
    if (!res.closed) {
      // 止めきれなかった。`close` は来ないので台帳をこちらで閉じ、残っていることを理由に書く。
      // 「止めました」と嘘をつくより、残骸があることを伝えるほうが役に立つ
      commit(ledger.fail(runId, res.reason ?? '止めきれませんでした', clock()));
      live.delete(runId);
    }
    return { ok: true, status: 200, row: ledger.get(runId), closed: res.closed };
  }

  /**
   * モデル・思考量・権限モードを替えて、同じセッションの続きを起こす。
   *
   * **画面から2手（停止 → 起動）にしない。** あいだが空くと、前の子がまだ畳まれないうちに
   * 次が起きて、同じ会話ログに2つのプロセスが書きうる。
   * こちらで `close` を待ってから起こせば、その競合は構造的に起きない。
   *
   * `--fork-session` は使わない。ID が変わると一覧・詳細・`?session=` が全部切れる。
   *
   * 手を動かす順にも理由がある。
   *
   * 1. **検証は畳む前。** 通らないと分かっているのに子を殺すと、
   *    断るだけで済んだはずのものが「止まっただけ」で終わる
   * 2. 畳んだ後にもう一度台帳を見る。あいだに停止を頼まれていたら起こし直さない
   *
   * @param {string} runId 実行の識別子
   * @param {object} patch 画面から来た差分（model / effort / permissionMode）
   * @param {string} text 切り替えた先へ送る指示文。空では起こせない（実測）
   * @returns {Promise<{ok:boolean, status:number, runId?:string, row?:object,
   *                    changed?:string[], reason?:string}>}
   */
  async function switchRun(runId, patch, text) {
    const at = clock();
    const row = ledger.get(runId);
    if (!row) return { ok: false, status: 404, reason: 'その実行は見つかりません' };
    if (isRunOver(row.state)) return { ok: false, status: 409, reason: 'その実行はもう終わっています' };

    const entry = live.get(runId);
    const prev = entry?.spec;
    if (!prev) {
      return { ok: false, status: 409, reason: '切り替えられません（起動指定が残っていません）' };
    }

    const merged = mergeSwitch(prev, patch);
    if (!merged.ok) return { ok: false, status: 400, reason: merged.reason };

    const body = typeof text === 'string' ? text.trim() : '';
    if (!body) return { ok: false, status: 400, reason: '指示が空です' };
    if (body.length > PROMPT_MAX) {
      return { ok: false, status: 400, reason: `指示が長すぎます（${PROMPT_MAX} 文字まで）` };
    }

    const found = claude();
    if (!found?.path) {
      return { ok: false, status: 503, reason: found?.reason ?? 'claude が見つかりません' };
    }

    const built = buildRunSpec(
      { ...merged.next, prompt: body, resume: true, sessionId: prev.sessionId },
      { allowedDirs: [prev.cwd], env, platform },
    );
    if (!built.ok) return { ok: false, status: 400, reason: built.reason };

    commit(ledger.markSwitching(runId, built.spec, at));

    // 子が生きていれば畳む。`perTurn` で既に閉じているなら、この工程は要らない
    if (entry.child) {
      entry.stopping = true;
      const res = await stopFn(entry.child, { spawnFn, platform });
      if (!res.closed) {
        commit(ledger.fail(runId, res.reason ?? '前の子を止めきれませんでした', clock()));
        live.delete(runId);
        return { ok: false, status: 500, reason: '前の子を止めきれませんでした' };
      }
    }

    // 畳んでいるあいだに停止を頼まれていたら、起こし直さない。
    // 見るのは「まだ切り替え中か」の1点。`isRunOver` だけでは `stopping` を素通りして、
    // 止めろと言われた run の子だけが生き残る
    if (ledger.get(runId)?.state !== 'switching') {
      return { ok: false, status: 409, reason: '切り替えの途中で止まりました' };
    }

    const started = spawnClaude({
      bin: found.path, args: built.spec.args, cwd: built.spec.cwd, env, spawnFn,
    });
    if (!started.ok) {
      commit(ledger.fail(runId, started.reason, clock()));
      return { ok: false, status: 500, reason: started.reason, runId, row: ledger.get(runId) };
    }

    attach(runId, started.child, built.spec);
    ledger.setPid(runId, started.child.pid ?? null);

    const wrote = write(runId, body, clock());
    if (!wrote.ok) return { ...wrote, runId, row: ledger.get(runId) };

    return { ok: true, status: 202, runId, row: ledger.get(runId), changed: merged.changed };
  }

  /**
   * いま抱えている子の PID。
   *
   * サーバーが畳まれるときの最後の後始末に使う。`shutdown()` は3段の停止を待てる（最長5秒）が、
   * `process.on('exit')` は**同期しか走れない**ので、そこからは PID を配って
   * `killTreeSync` に任せるしかない。
   *
   * @returns {number[]} 生きている子の PID
   */
  function livePids() {
    const pids = [];
    for (const entry of live.values()) {
      const pid = entry.child?.pid;
      if (typeof pid === 'number' && Number.isFinite(pid)) pids.push(pid);
    }
    return pids;
  }

  /**
   * 沈黙を見る。`server.mjs` の `refresh()` から呼ぶ。
   *
   * @returns {string[]} 状態が変わった runId
   */
  function tick() {
    const { changed, events } = ledger.tick(clock());
    commit(events);
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
    answer,
    stop,
    // `switch` は予約語だが、プロパティ名としては使える。
    // 窓口の名前（`POST /api/runs/:id/switch`）と揃えるほうが読みやすい
    switch: switchRun,
    tick,
    subscribe,
    shutdown,
    livePids,
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
    /**
     * 本数と通し番号。上限（RUN_MAX）はここで足す。
     *
     * **`ledger.stats()` の側に足さない。** あちらはテストが deepEqual で
     * 形を丸ごと固定していて、キーを1つ増やすだけで落ちる。
     * そもそも上限は台帳が数えた値ではなく設定なので、
     * 台帳の集計結果に混ぜず、口を組むこの層で足すほうが素直でもある。
     *
     * @returns {object} 本数・通し番号・上限
     */
    stats: () => ({ ...ledger.stats(), max: RUN_MAX }),
  };
}
