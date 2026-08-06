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
import { buildText, scrubError } from './message.mjs';
import { postToSlack, TIMEOUT_MS } from './slack.mjs';

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
 * @returns {object} observe / flush / setBaseUrl / health / banner /
 *                   applyConfig / settings / sendTest
 */
export function createNotifier({
  config = loadNotifyConfig(),
  bootAt = Date.now(),
  post = postToSlack,
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

  // watch は設定が無くても必ず作る。有効かどうかの分岐は state だけで見る。
  // 画面から設定されたときに作り直さずに済ませるための形で、作り直すと
  // known が空になり、いま待っている分が保存した瞬間に全部もう一度鳴る
  const watch = createNotifyWatch({
    settleMs: config.settleMs,
    idleSettleMs: config.idleSettleMs,
    remindMs: config.remindMs,
    states: config.states,
    bootAt,
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
    if (state !== 'ok') return;
    watch.observe(rows, now);
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
    if (state !== 'ok' || sending) return;

    let items = [];
    try {
      items = watch.takeReady(now);
    } catch (err) {
      stop(`通知の内部で問題が起きました: ${err?.message ?? err}`);
      return;
    }

    if (items.length === 0) {
      // 上限に達していたら止める。止めたこと自体は1通だけ知らせる
      if (watch.stats().overLimit) await pauseOverLimit();
      return;
    }

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
      lastError = `送信で例外が出ました: ${err?.message ?? err}`;
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
  async function pauseOverLimit() {
    const why = '1時間に送れる数の上限に達しました。起動し直すと再開します';
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
    };
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
    if (!config.enabled) {
      // 設定していないなら黙る。書き間違えているときだけ言う
      return config.error ? `Slack 通知: 無効（${config.error}）` : null;
    }
    const where = config.source === 'env' ? '環境変数' : '設定ファイル';
    return `Slack 通知: 有効（${where} / ${config.urlMasked}）`;
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
    const wasOn = state === 'ok';
    config = next;
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
      if (!wasOn) watch.rearm(now);
    } else {
      state = 'off';
      reason = config.error ?? null;
    }
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
      lastError = scrubError(`送信で例外が出ました: ${err?.message ?? err}`, config.url);
      return { ok: false, reason: lastError };
    } finally {
      sending = false;
    }
  }

  return { observe, flush, setBaseUrl, health, banner, applyConfig, settings, sendTest };
}
