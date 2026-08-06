/**
 * いつ何を送るかを決める状態機械。
 *
 * ここには I/O が一切無い。時刻も外から `now` で渡してもらう。
 * 通知でいちばん間違いやすいのは「送るかどうか」の判断なので、
 * そこだけを純粋に切り出して node:test で全分岐を通せるようにしてある。
 *
 * 鍵は sessionId ＋ tool_use.id。この鍵1つにつき生涯1通。
 * lastActivityAt を鍵にしてはいけない。あれは Math.max(mtime, 最終エントリ時刻) で
 * 作られるので、サブエージェントが走って親ログに追記が続くと、
 * 質問は同じなのに鍵が変わり、同じ質問で何通も飛ぶ。
 */

/**
 * 通知する状態と、それぞれの扱い。ball が master でも、ここに無いものは黙る。
 *
 * slow            … 落ち着き待ちを長いほう（idleSettleMs）で測る
 * requireByStatus … 登録簿が「待ち」と言っているときだけ送る
 * requireConfident … 判定に自信があるときだけ送る
 */
export const NOTIFY_RULES = {
  // 「あなたを待つ」以外の用途が無いツールなので、見えたら即断してよい。
  //
  // ただし実測（2026-08-06）では、質問を出しているあいだ
  // tool_use(AskUserQuestion) の行がディスクに書かれない。
  // 待っている2分間ずっと awaiting-reply に見えていた。
  // なので現状この2つはほぼ発火せず、実際の受け皿は下の awaiting-reply になる。
  // Claude Code 側が書くようになれば、こちらが先に立って速く鳴る
  'needs-answer': {},
  'needs-plan-approval': {},

  // 承認待ちは、登録簿が「待ち」と言っている側だけを送る。
  //
  // needs-approval には経路が2つあり、しきい値（APPROVAL_MS）だけが根拠の側は
  // 長く走る Bash と区別がつかない（実測: 50秒の Bash が同じ形になった）。
  // auto mode で Claude が自分で承認した分はそもそも止まらないので、
  // byStatus の側だけを見れば「人に聞きに来て止まっている」ものだけが残る
  'needs-approval': { requireByStatus: true },

  // Claude が喋り終えて静かになった状態。
  //
  // 上の3つが観測できないぶんをここで拾うので、長いほうの落ち着き待ちで測る。
  // 短くすると、目の前にいて少し考えているだけで鳴る。
  // 自信の無い判定（「追記が止まっている」だけが根拠のもの）は送らない
  'awaiting-reply': { slow: true, requireConfident: true },
};

/** 通知する状態の名前。表示や診断で使う。 */
export const NOTIFY_STATES = new Set(Object.keys(NOTIFY_RULES));

/** 落ち着き待ち。POLL_MS = 2000 の3倍で、最低2回の独立した走査を挟める。 */
export const SETTLE_MS = 6000;

/**
 * 返信待ちの落ち着き待ち。既定2分。
 *
 * 席を外しているときだけ鳴らしたいので長めに取る。
 * 実測した質問1件では回答までが2分8秒で、この値ならその8秒前に鳴っていた。
 */
export const IDLE_SETTLE_MS = 120000;

/** 起動からこの間に見えた待ちは種まき扱い（送らずに既通知にする）。 */
export const GRACE_MS = 10000;

/** 送信待ちの上限。溢れたら古いほうから捨てる。 */
export const QUEUE_MAX = 20;

/** 1時間に送れる通数。暴走したときの歯止め。 */
export const MAX_PER_HOUR = 30;

const HOUR_MS = 60 * 60 * 1000;

/**
 * 「1つの待ち」を表す鍵を作る。
 *
 * @param {object} row listSessions が返した行
 * @returns {string|null} sessionId が取れなければ null
 */
export function keyOf(row) {
  const sessionId = row?.sessionId;
  if (!sessionId) return null;

  const id = row?.waitingFor?.id;
  if (id) return `${sessionId}::${id}`;

  // 待っているツールが無い状態（返信待ち）はここに来る。
  // ログの最後の行の uuid を鍵にする。ターンごとに変わるので、
  // 2回目以降の返信待ちもちゃんと別の待ちとして数えられる。
  // セッション ID だけで作ると鍵が生涯1つになり、1通鳴ったきり黙る
  const anchor = row?.anchorId;
  if (anchor) return `${sessionId}::turn:${anchor}`;

  // どちらも無い形が来たときの代用。実測したログには必ずどちらか入っていたが、
  // 読んでいるのは公開仕様ではないので無い形にも備える。
  // 同じセッションで同じツールの待ちが続くと2件目を黙って落とすが、
  // 鍵が毎回変わって同じ質問で何通も鳴るよりはまし
  return `${sessionId}::fallback:${row.state}:${row.waitingFor?.tool ?? '-'}`;
}

/**
 * 行から、通知に必要なぶんだけを写し取る。
 *
 * ここで絞るのが安全装置になっている。cwd・logFile・gitBranch・title・
 * lastPrompt を持たない形にしておけば、message.mjs 側で載せようがない。
 *
 * @param {object} row 元の行
 * @param {string} key keyOf の結果
 * @returns {object}
 */
function snapshot(row, key) {
  return {
    key,
    sessionId: row.sessionId,
    name: row.name ?? null,
    project: row.project ?? null,
    stateLabel: row.stateLabel ?? row.state ?? null,
    tool: row.waitingFor?.tool ?? null,
    detail: row.waitingFor?.detail ?? null,
    // 待っている長さ。返信待ちには tool も detail も無いので、
    // これが無いと本文が見出し1行だけになる。
    // 数値であってログ本文ではないので、ここに載せてよい
    idleMs: typeof row.idleMs === 'number' ? row.idleMs : null,
    kind: 'wait',
  };
}

/**
 * 通知の状態機械を作る。
 *
 * @param {object} [opts]
 * @param {number} [opts.settleMs] 落ち着き待ち。0 で即時
 * @param {number} [opts.idleSettleMs] 返信待ちの落ち着き待ち。0 で返信待ちを通知しない
 * @param {number} [opts.graceMs] 起動直後の種まき期間
 * @param {number} [opts.remindMs] 放置リマインド。0 で無効
 * @param {number} [opts.queueMax] 送信待ちの上限
 * @param {number} [opts.maxPerHour] 1時間に送れる通数
 * @param {number} [opts.bootAt] 起動時刻。種まきの基準
 * @returns {object} observe / takeReady / giveBack / stats
 */
export function createNotifyWatch({
  settleMs = SETTLE_MS,
  idleSettleMs = IDLE_SETTLE_MS,
  graceMs = GRACE_MS,
  remindMs = 0,
  queueMax = QUEUE_MAX,
  maxPerHour = MAX_PER_HOUR,
  bootAt = 0,
} = {}) {
  /** 鍵 → {item, firstSeenAt}。落ち着き待ちの最中のもの */
  const pending = new Map();
  /** 送信を待っている項目。古い順 */
  const outbox = [];
  /** 一度でも送った（種まき含む）鍵。二度と積まない */
  const known = new Set();
  /** リマインドを1回出した鍵 */
  const reminded = new Set();
  /** 直近の observe で見えていた鍵。送る直前の確認に使う */
  let present = new Set();
  /** 送信した時刻。1時間の窓で数える */
  const sendTimes = [];

  const stats = { seeded: 0, settled: 0, taken: 0, dropped: 0, vanished: 0, reminded: 0 };
  let overLimit = false;

  /**
   * その行を通知の対象として見るか。
   *
   * @param {object} row listSessions が返した行
   * @returns {object|null} 対象なら扱いの規則、対象外なら null
   */
  function ruleFor(row) {
    const rule = NOTIFY_RULES[row?.state];
    if (!rule) return null;
    // 返信待ちは 0 分の設定で丸ごと切れる
    if (rule.slow && idleSettleMs <= 0) return null;
    // 承認待ちのうち、しきい値だけが根拠の側は送らない（長く走る Bash と区別がつかない）
    if (rule.requireByStatus && row.byStatus !== true) return null;
    if (rule.requireConfident && row.stateConfident !== true) return null;
    return rule;
  }

  /**
   * 送信待ちへ積む。溢れたら古いほうから捨てる。
   *
   * @param {object} item 送る項目
   * @param {number} now いまの時刻
   */
  function push(item, now) {
    outbox.push({ ...item, attempts: 0, readyAt: now });
    while (outbox.length > queueMax) {
      outbox.shift();
      stats.dropped += 1;
    }
  }

  /**
   * 一覧1回分を見る。同期であることが設計上の制約。
   *
   * await を挟むと server.mjs の refresh() が refreshing を立てている区間が
   * 延びて、一覧の更新が通知に引きずられる。
   *
   * @param {Array<object>} rows listSessions が返した行
   * @param {number} now いまの時刻
   */
  function observe(rows, now) {
    /** @type {Map<string, {row: object, rule: object}>} */
    const seen = new Map();
    for (const row of rows ?? []) {
      const rule = ruleFor(row);
      if (!rule) continue;
      const key = keyOf(row);
      if (!key) continue;
      seen.set(key, { row, rule });
    }
    present = new Set(seen.keys());

    for (const [key, { row, rule }] of seen) {
      if (known.has(key)) {
        // 放置リマインド。既定は無効で、設定で分を入れたときだけ1回だけ出す
        if (remindMs > 0 && !reminded.has(key) && (row.idleMs ?? 0) >= remindMs) {
          reminded.add(key);
          stats.reminded += 1;
          push({ ...snapshot(row, key), kind: 'remind' }, now);
        }
        continue;
      }
      const held = pending.get(key);
      if (held) {
        // 待っている長さだけは最新にしておく。本文に出るのは送るときの値。
        // 返信待ちは2分寝かせるので、最初に見た瞬間の 0 分のままだと嘘になる
        if (typeof row.idleMs === 'number') held.item.idleMs = row.idleMs;
        continue;
      }

      // 起動直後に見えていたものは「いま待ちに入った」ではない。
      // 朝ログオンするたびに昨夜からの待ちが全部飛ぶのを防ぐ
      if (now - bootAt < graceMs) {
        known.add(key);
        stats.seeded += 1;
        continue;
      }
      // 落ち着き待ちは状態ごとに違う。返信待ちだけ長いほうで測る
      const wait = rule.slow ? idleSettleMs : settleMs;
      pending.set(key, { item: snapshot(row, key), firstSeenAt: now, settleMs: wait });
    }

    // 落ち着き待ちの途中で消えたもの＝目の前にいて即答したもの
    for (const key of [...pending.keys()]) {
      if (!present.has(key)) {
        pending.delete(key);
        stats.vanished += 1;
      }
    }

    // 落ち着いたものを送信待ちへ移す
    for (const [key, rec] of [...pending]) {
      if (now - rec.firstSeenAt < rec.settleMs) continue;
      pending.delete(key);
      known.add(key);
      stats.settled += 1;
      push(rec.item, now);
    }
  }

  /**
   * 送るべき項目を取り出す。取り出した時点で送信済みの扱いになる。
   *
   * 取り出す直前にもう一度 present を見る。確定から送信までの数秒で
   * 答えられていることがあり、これが無いと「答えた4秒後に鳴る」が起きる。
   *
   * @param {number} now いまの時刻
   * @returns {Array<object>} 空配列なら送らない
   */
  function takeReady(now) {
    if (outbox.length === 0) return [];

    while (sendTimes.length && now - sendTimes[0] > HOUR_MS) sendTimes.shift();
    if (sendTimes.length >= maxPerHour) {
      overLimit = true;
      return [];
    }

    const out = [];
    const rest = [];
    for (const item of outbox) {
      // 再送待ちのものはまだ触らない
      if (item.readyAt > now) {
        rest.push(item);
        continue;
      }
      // リマインドも「まだ待っている」が前提なので同じ扱いでよい
      if (!present.has(item.key)) {
        stats.vanished += 1;
        continue;
      }
      out.push(item);
    }
    outbox.length = 0;
    outbox.push(...rest);

    if (out.length) {
      // 1回の取り出しが 1通の POST になる。上限は通数で数える
      sendTimes.push(now);
      stats.taken += out.length;
    }
    return out;
  }

  /**
   * 送信に失敗した項目を戻す。
   *
   * @param {Array<object>} items takeReady で取り出した項目
   * @param {number} now いまの時刻
   * @param {object} [opts]
   * @param {number} [opts.retryMs] 何ミリ秒後に再送するか
   * @param {number} [opts.maxAttempts] 何回試したらあきらめるか
   */
  function giveBack(items, now, { retryMs = 4000, maxAttempts = 2 } = {}) {
    for (const item of items ?? []) {
      const attempts = (item.attempts ?? 0) + 1;
      if (attempts >= maxAttempts) {
        stats.dropped += 1;
        continue;
      }
      outbox.push({ ...item, attempts, readyAt: now + retryMs });
    }
    while (outbox.length > queueMax) {
      outbox.shift();
      stats.dropped += 1;
    }
  }

  /**
   * /api/health に載せる数え。
   *
   * @returns {object}
   */
  function statsOf() {
    return {
      ...stats,
      pending: pending.size,
      waiting: outbox.length,
      known: known.size,
      overLimit,
    };
  }

  return { observe, takeReady, giveBack, stats: statsOf };
}
