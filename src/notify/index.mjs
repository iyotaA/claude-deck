/**
 * 通知の配線。server.mjs が import する唯一の口。
 *
 * ここは判断を持たない。いつ送るかは watch.mjs、何を書くかは message.mjs、
 * 応答の意味づけは slack.mjs にある。この層がやるのは3つだけ。
 *
 *  - 設定を読んで、無効なら全部を空振りにする
 *  - observe と flush を別の時計で回せる形にして外へ出す
 *  - 失敗の数え方と、止めどきの判断
 *
 * src/notify/ は read → parse → view の末端に足した層で、view/ を import しない。
 * listSessions() が返した行（ただの JSON）を受け取るだけにしてある。
 */
import { loadNotifyConfig } from './config.mjs';
import { createNotifyWatch } from './watch.mjs';
import { errText } from '../shared/text.mjs';
import { buildText, scrubError, waitLabel } from './message.mjs';
import { postToSlack, TIMEOUT_MS } from './slack.mjs';
import {
  buildToastXml, buildRestXml, toastLaunchUrl, TOAST_APP_ID, POWERSHELL_APP_ID, TOAST_MAX,
} from './toast.mjs';
import { showToast } from '../os/toast.mjs';

/** 送信タイマの間隔。refresh() とは別の時計で回す。 */
export const FLUSH_MS = 1000;

/** 連続でこの回数失敗したら止める。 */
const FAIL_LIMIT = 5;

/** 失敗したときに何ミリ秒後へ回すか。再送は1回だけ。 */
const RETRY_MS = 4000;

/**
 * テスト送信の間隔。押した人が結果を見ているので短くてよいが、
 * 連打で Slack を叩き続けないだけの間は空ける。
 */
const TEST_COOLDOWN_MS = 3000;

/**
 * 通知器を作る。設定が無ければ、何もしない器を返す。
 *
 * @param {object} [opts]
 * @param {object} [opts.config] 設定。テストから差し替える
 * @param {number} [opts.bootAt] 起動時刻。種まきの基準
 * @param {Function} [opts.post] 送信関数。テストから差し替える
 * @param {Function} [opts.show] Windows の通知を出す関数。テストから差し替える
 * @param {boolean} [opts.viaLauncher] ランチャ経由で動いているか。通知の差出人と押した先が変わる
 * @returns {object} observe / flush / setBaseUrl / health / banner /
 *                   applyConfig / settings / sendTest
 */
export function createNotifier({
  config = loadNotifyConfig(),
  bootAt = Date.now(),
  post = postToSlack,
  show = showToast,
  viaLauncher = false,
  // 1時間に送れる通数。**設定の紙には出さない**（暴走の歯止めで、人が緩める値ではない）。
  // 引数で受けるのは、上限に達した先の筋道をテストから通すため
  // ―― 既定の 30 通を実際に送らせると、テストが送信の回数を数える話になる
  maxPerHour = undefined,
} = {}) {
  /** ClaudeDeck の URL。listen したあとでないと決まらないので後から入れる */
  let baseUrl = null;
  /** ok（送る） / off（設定なし） / disabled（止めた） / paused（上限） */
  let state = config.enabled ? 'ok' : 'off';
  let reason = config.error ?? null;
  let sending = false;
  let failStreak = 0;
  let sent = 0;
  let failed = 0;
  let lastOkAt = null;
  let lastErrorAt = null;
  let lastError = null;
  /** すでに本文へ書いた「捨てた件数」。差分だけを伝えるための印 */
  let reportedDropped = 0;
  /** 最後にテスト送信した時刻。連打止め */
  let lastTestAt = 0;

  // ---- Windows の通知（トースト）。Slack とは別の送り先 ----
  //
  // **Slack の止め方（state / failStreak / 再送）とは混ぜない。** 送り先が2つになっても、
  // Slack の側の筋道は1行も変えないで済むように、横に並べて持つ。
  // いつ鳴らすか（watch）は共有する。同じ待ちが Slack と右下の両方に出る
  let toastSent = 0;
  let toastFailed = 0;
  let toastStreak = 0;
  let toastLastError = null;
  /** 続けて失敗して止めた理由。null なら止めていない */
  let toastStopped = null;
  /**
   * セッション → 題名。**通知専用の写し。**
   * watch の snapshot() は Slack の安全装置として題名を落とすので、そちらへは足さない
   * （足すと Slack にも題名が乗る）。observe() で一覧の行から引いておく
   */
  const titles = new Map();

  // watch は設定が無くても必ず作る。有効かどうかの分岐は state だけで見る。
  // 画面から設定されたときに作り直さずに済ませるための形で、作り直すと
  // known が空になり、いま待っている分が保存した瞬間に全部もう一度鳴る
  const watch = createNotifyWatch({
    settleMs: config.settleMs,
    idleSettleMs: config.idleSettleMs,
    remindMs: config.remindMs,
    states: config.states,
    bootAt,
    // undefined なら watch 側の既定（MAX_PER_HOUR）に落ちる
    ...(maxPerHour === undefined ? {} : { maxPerHour }),
  });

  /**
   * 機能ごと止める。理由は /api/health から読める。
   *
   * @param {string} why 止めた理由。URL を含めない
   * @param {'disabled'|'paused'} [next] 止めたあとの状態
   */
  function stop(why, next = 'disabled') {
    state = next;
    reason = why;
  }

  /** Windows の通知を出すか。設定で入っていて、続けて失敗して止めていないとき */
  function toastOn() {
    return config.toast?.enabled === true && toastStopped === null;
  }

  /**
   * watch に一覧を見せるか。**どちらか一方の送り先が生きていれば見せる。**
   * 前は Slack の state だけで決めていたので、Slack を設定していない人には何も鳴らなかった
   */
  function watching() {
    return state === 'ok' || toastOn();
  }

  /**
   * ClaudeDeck の URL を教える。listen のコールバックから呼ぶ。
   *
   * @param {string} url 末尾に / を含む形
   */
  function setBaseUrl(url) {
    baseUrl = url;
  }

  /**
   * 一覧1回分を見せる。同期。例外を投げない。
   *
   * @param {Array<object>} rows listSessions が返した行
   * @param {number} [now] いまの時刻
   */
  function observe(rows, now = Date.now()) {
    if (!watching()) return;
    // 題名の写しは Windows の通知のためだけ。入れ替えて持つ（消えたセッションを残さない）
    if (toastOn()) {
      titles.clear();
      for (const row of rows ?? []) {
        if (row?.sessionId && row.title) titles.set(row.sessionId, row.title);
      }
    }
    watch.observe(rows, now);
  }

  /**
   * Windows の通知を出す。**例外を投げない。** 失敗は数えて、続けば止める。
   *
   * 出すのは**初めて出てきた待ちだけ**（attempts が無いもの）。Slack が再送のために
   * watch へ返した待ち（giveBack は attempts を増やした写しを戻す）を、右下に2回出さない。
   *
   * @param {Array<object>} items watch.takeReady() の戻り
   * @returns {Promise<void>}
   */
  async function sendToasts(items) {
    if (!toastOn()) return;
    const fresh = items.filter((it) => !it.attempts);
    if (fresh.length === 0) return;

    const appId = viaLauncher ? TOAST_APP_ID : POWERSHELL_APP_ID;
    const xmls = fresh.slice(0, TOAST_MAX).map((it) => {
      const wait = waitLabel(it.idleMs);
      return buildToastXml(it, {
        title: titles.get(it.sessionId) ?? null,
        launchUrl: toastLaunchUrl({ sessionId: it.sessionId, baseUrl, viaLauncher }),
        waitText: wait ? `${wait} 待っています` : null,
        detail: config.detail,
      });
    });
    // 上限を超えたぶんは1枚にまとめる。右下が通知で埋まらないように
    const rest = fresh.length - TOAST_MAX;
    if (rest > 0) xmls.push(buildRestXml(rest, toastLaunchUrl({ baseUrl, viaLauncher })));

    for (const xml of xmls) {
      let r;
      try {
        r = await show(xml, appId);
      } catch (err) {
        r = { ok: false, reason: `例外が出ました: ${errText(err)}` };
      }
      if (r?.ok) {
        toastSent += 1;
        toastStreak = 0;
        continue;
      }
      toastFailed += 1;
      toastStreak += 1;
      toastLastError = r?.reason ?? '理由が取れませんでした';
      if (toastStreak >= FAIL_LIMIT) {
        toastStopped = `${FAIL_LIMIT} 回続けて出せませんでした。${toastLastError}`;
        return;
      }
    }
  }

  /**
   * たまっているものを送る。
   *
   * refresh() を呼ばず、待たず、refreshing を触らない。
   * 例外を投げない（タイマから呼ばれるので、投げると素の unhandled になる）。
   *
   * @param {number} [now] いまの時刻
   * @returns {Promise<void>}
   */
  async function flush(now = Date.now()) {
    // **上限で止めたぶんは、窓が空いたら自分で戻る。**
    //
    // 前は `paused` から抜ける道が「起動し直す」しか無かった。
    // 忙しい日ほど1時間 30 通の上限に当たるので、**いちばん通知が要る日に黙る**
    // ことになっていた（`sendTest` を押すと解ける裏道はあったが、
    // それを知っている人しか戻せない）。
    //
    // 見るのは `watch` 側の判定だけ。あちらは呼ばれるたびに窓を掃除するので、
    // 1時間が流れていれば勝手に false へ戻る。
    if (state === 'paused' && !watch.stats(now).overLimit) {
      state = 'ok';
      reason = null;
    }

    if (!watching() || sending) return;

    let items = [];
    try {
      items = watch.takeReady(now);
    } catch (err) {
      stop(`通知の内部で問題が起きました: ${errText(err)}`);
      return;
    }

    if (items.length === 0) {
      // 上限に達していたら止める。止めたこと自体は1通だけ知らせる。
      // **Slack が生きているときだけ。** 知らせる先が Slack なので、無いのに止めると
      // 送れない Slack へ投げることになる（state を 'paused' にする道がここしか無い）
      if (state === 'ok' && watch.stats(now).overLimit) await pauseOverLimit(now);
      return;
    }

    sending = true;
    // Windows の通知は Slack より先に出す。こちらは手元なので速く、Slack の応答待ち
    // （最大 5 秒＋再送）に引きずられない
    try {
      await sendToasts(items);
    } finally {
      sending = false;
    }
    // Slack を設定していない（または止めている）なら、ここで終わり。
    // 待ちは watch から取り出し済みなので、Slack のぶんとして返さない
    if (state !== 'ok') return;

    sending = true;
    try {
      const s = watch.stats();
      const dropped = Math.max(0, s.dropped - reportedDropped);
      const text = buildText(items, { baseUrl, detail: config.detail, dropped });
      const r = await post(config.url, text, { timeoutMs: TIMEOUT_MS });

      if (r.ok) {
        sent += items.length;
        failStreak = 0;
        lastOkAt = now;
        // 伝えられたぶんだけ印を進める。次の通知で二重に書かない
        reportedDropped = s.dropped;
        return;
      }

      failed += 1;
      failStreak += 1;
      lastErrorAt = now;
      lastError = r.reason ?? '理由が取れませんでした';

      if (r.stop) {
        stop(lastError);
        return;
      }
      if (r.retry) watch.giveBack(items, now, { retryMs: RETRY_MS });
      if (failStreak >= FAIL_LIMIT) stop(`${FAIL_LIMIT} 回続けて送れませんでした。${lastError}`);
    } catch (err) {
      // post は例外を投げない作りだが、差し替えられる口なので受けておく
      failed += 1;
      failStreak += 1;
      lastErrorAt = now;
      lastError = `送信で例外が出ました: ${errText(err)}`;
      if (failStreak >= FAIL_LIMIT) stop(lastError);
    } finally {
      sending = false;
    }
  }

  /**
   * 1時間の上限に達したので止める。止めたことだけを1通送る。
   *
   * @returns {Promise<void>}
   */
  async function pauseOverLimit(now = Date.now()) {
    const untilMs = watch.stats(now).overLimitUntil;
    // **待ち時間を言う。** 「起動し直すと再開します」だけだと、
    // 人はそのとおり再起動しに行く（それが前の唯一の逃げ道だった）
    const mins = Math.max(1, Math.ceil((untilMs ?? 0) / 60000));
    const why = `1時間に送れる数の上限に達しました。あと ${mins} 分ほどで自動で再開します`;
    stop(why, 'paused');
    sending = true;
    try {
      await post(config.url, `*ClaudeDeck* 通知を止めました\n${why}`, { timeoutMs: TIMEOUT_MS });
    } catch {
      // 止めたことが届かなくても、止めた事実は /api/health に残る
    } finally {
      sending = false;
    }
  }

  /**
   * /api/health に載せる形。
   *
   * target は必ずマスク済み。生の URL をここから返してはいけない。
   *
   * @returns {object}
   */
  function health() {
    const s = watch.stats();
    return {
      enabled: config.enabled,
      source: config.source,
      target: config.urlMasked,
      state,
      reason,
      sent,
      failed,
      skipped: s.seeded + s.vanished,
      pending: s.pending,
      queued: s.waiting,
      dropped: s.dropped,
      lastOkAt,
      lastErrorAt,
      lastError,
      // Windows の通知。Slack とは別に数える
      toast: {
        enabled: config.toast?.enabled === true,
        wanted: config.toast?.wanted !== false,
        state: toastStopped ? 'disabled' : (toastOn() ? 'ok' : 'off'),
        reason: toastStopped ?? config.toast?.reason ?? null,
        sent: toastSent,
        failed: toastFailed,
        lastError: toastLastError,
      },
    };
  }

  /**
   * watch に一覧を見せているか。server.mjs の見回りの間引き（30秒に落とすか）に使う。
   * Slack だけで判断すると、Windows の通知しか入れていない人の通知が最大 30 秒遅れる
   *
   * @returns {boolean}
   */
  function active() {
    return watching();
  }

  /**
   * 起動時に出す1行。
   *
   * 自動起動されたサーバーには、ターミナルで set した環境変数が届かない。
   * 無言のまま動く事故が現実的に起きるので、有効なら必ず1行出す。
   *
   * @returns {string|null} 設定が無ければ null（黙る）
   */
  function banner() {
    const lines = [];
    if (config.enabled) {
      const where = config.source === 'env' ? '環境変数' : '設定ファイル';
      lines.push(`Slack 通知: 有効（${where} / ${config.urlMasked}）`);
    } else if (config.error) {
      // 設定していないなら黙る。書き間違えているときだけ言う
      lines.push(`Slack 通知: 無効（${config.error}）`);
    }
    // Windows の通知は既定で入りなので、入っているときは必ず言う（鳴る理由が分かるように）
    if (config.toast?.enabled) {
      lines.push(`Windows の通知: 有効（差出人 ${viaLauncher ? 'ClaudeDeck' : 'Windows PowerShell'}）`);
    } else if (config.toast?.wanted && config.toast?.reason) {
      lines.push(`Windows の通知: 無効（${config.toast.reason}）`);
    }
    // 複数行は server.mjs の字下げ（2字）に揃えて返す
    return lines.length ? lines.join('\n  ') : null;
  }

  /**
   * 設定を差し替える。再起動せずに効かせるための口。
   *
   * watch は作り直さない。作り直すと送信済みの記憶（known）が消えて、
   * いま待っている分が保存した瞬間に全部もう一度鳴る。
   *
   * 無効から有効へ変わったときだけ種まきし直す。
   * これが無いと、すでに何時間も待っているセッションが一斉に飛ぶ。
   *
   * @param {object} next 新しい設定（parseNotifyConfig の戻り）
   * @param {number} [now] いまの時刻
   */
  function applyConfig(next, now = Date.now()) {
    // 「見ていたか」で比べる。Slack だけで比べると、Windows の通知だけ入っていた人が
    // Slack を足した瞬間に種まきし直して、いま待っているぶんを落とすことになる
    const wasOn = watching();
    config = next;
    // 設定を直したのだから、続けて失敗して止めていた Windows の通知も解く
    toastStopped = null;
    toastStreak = 0;
    watch.configure({
      settleMs: config.settleMs,
      idleSettleMs: config.idleSettleMs,
      remindMs: config.remindMs,
      states: config.states,
    });

    if (config.enabled) {
      // 止まっていたなら解く。設定を直したのに止まったまま、を避ける
      state = 'ok';
      reason = null;
      failStreak = 0;
    } else {
      state = 'off';
      reason = config.error ?? null;
    }
    // 見ていなかったのが見るようになったときだけ種まきし直す。
    // これが無いと、すでに何時間も待っているセッションが一斉に飛ぶ
    if (!wasOn && watching()) watch.rearm(now);
  }

  /**
   * 設定モーダルへ返す形。
   *
   * 生の URL はどの経路でも返さない。出すのは urlMasked だけ。
   *
   * @returns {object}
   */
  function settings() {
    return {
      enabled: config.enabled,
      source: config.source,
      target: config.urlMasked,
      settleSec: Math.round(config.settleMs / 1000),
      idleMin: Math.round(config.idleSettleMs / 60000),
      remindMin: Math.round(config.remindMs / 60000),
      detail: config.detail,
      // Windows の通知。選んだ値（toast）と、実際に出せるか（toastEnabled / toastReason）を分けて返す
      toast: config.toast?.wanted !== false,
      toastEnabled: config.toast?.enabled === true,
      toastReason: config.toast?.reason ?? null,
      states: { ...config.states },
      sources: { ...config.sources },
      envSet: { ...config.envSet },
      off: config.off === true,
      configPath: config.configPath ?? null,
      error: config.error ?? null,
      health: health(),
    };
  }

  /**
   * テスト送信を1通。設定の配線を、2分待たずに確かめるためのもの。
   *
   * 1時間の上限には数えない。押した本人が結果を見ているので、
   * 暴走止めの対象にする意味がない。代わりに短いクールダウンを置く。
   *
   * 止まっている（disabled / paused）状態でも送れるようにしてある。
   * まさにそこが「直したので確かめたい」場面だから。
   *
   * @param {number} [now] いまの時刻
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async function sendTest(now = Date.now()) {
    if (!config.url) {
      return { ok: false, reason: config.error ?? 'Webhook の URL が設定されていません' };
    }
    if (now - lastTestAt < TEST_COOLDOWN_MS) {
      return { ok: false, reason: '少し待ってからもう一度押してください' };
    }
    if (sending) return { ok: false, reason: '送信中です。少し待ってからもう一度押してください' };

    lastTestAt = now;
    sending = true;
    try {
      const lines = ['*ClaudeDeck* テスト送信', 'この形で通知が届きます。'];
      if (baseUrl) lines.push(`<${baseUrl}|ClaudeDeck を開く>`);
      const r = await post(config.url, lines.join('\n'), { timeoutMs: TIMEOUT_MS });

      if (r.ok) {
        sent += 1;
        failStreak = 0;
        lastOkAt = now;
        // 通ったのだから止めておく理由が無い。押した人が結果を見ている
        if (state !== 'ok') {
          state = 'ok';
          reason = null;
        }
        return { ok: true };
      }

      failed += 1;
      lastErrorAt = now;
      lastError = r.reason ?? '理由が取れませんでした';
      return { ok: false, reason: lastError };
    } catch (err) {
      failed += 1;
      lastErrorAt = now;
      // 例外の文言には URL が埋め込まれ得る。返す前に必ず伏せる
      lastError = scrubError(`送信で例外が出ました: ${errText(err)}`, config.url);
      return { ok: false, reason: lastError };
    } finally {
      sending = false;
    }
  }

  return { observe, flush, setBaseUrl, health, banner, applyConfig, settings, sendTest, active };
}
