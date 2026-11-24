/* 層0。数値モードの「日ごとの実消費」の線グラフに、どの日をどう描くか（画面刷新⑤の D2〜D5）。
 *
 * **純関数**（DOM を触らない）で、import は層0 の `day-text.js`（日付の言い方）だけなので、`.js` のまま
 * Node から import してテストできる（`test/usage-days.test.mjs`）。描くのは層1 の `usage-chart.js` の `dayChart`、
 * 置くのは層7 の `usage-tab.js`。
 *
 * ## 描いてよい日
 *
 * 横断（`/api/usage`）は新しい順に上限まで（期間で絞ったうえで）しか開かない。開かなかったログのぶんは
 * 日ごとの合計（`daily`）に入っていないので、**左端の日は一部しか数えていない**。それを全部数えた日と
 * 同じ顔で線に並べると、左が低く出て右肩上がりに読める（実測で同じ 11-18 が 30 本では 46.2M、60 本では 82.0M）。
 *
 * だから**サーバーが返す境目（`meta.scanFrom`。全部数えてある最初の日）から今日までだけを描く。**
 * 境目の決め方はサーバー側（`src/view/CLAUDE.md`）。ここは境目を信じて、その前を描かないだけ。
 *
 *   - **境目が null（決められない）・キーが無い（古いサーバー）なら描かない**（0 と不明を分ける。
 *     推測で左端を決めると、一部しか数えていない日を混ぜることになる）
 *   - **境目より後で行の無い日は 0 で描く。** そこは全部数えた範囲なので、行が無いのは「使っていない」で
 *     「読んでいない」ではない（測って 0）。サーバーの「使わなかった日は行ごと出さない」は、
 *     この区別が付かない場所（全範囲）で 0 を並べないための約束で、ここの 0 とは矛盾しない
 *   - **今日は `meta.now` からサーバーと同じ丸め方（地方時の日）で出す。** 窓口は 127.0.0.1 で、
 *     画面とサーバーは同じ機械の時計と時間帯を見ている。`meta.now` が無ければ行のいちばん新しい日まで
 *     （知らない日を 0 で足さない）
 */
import { dayText, weekdayOf } from './day-text.js';

/**
 * 描く日数の上限。
 *
 * 境目が昔になりすぎる場合がある。全部読めたとき（ログが上限より少ない人・期間で絞って上限に届かないとき）、
 * 境目は「いちばん古い日ごとの行」になり、何か月も前まで遡る。1年ぶんを1本の線に詰めると点が潰れ、
 * 目盛りも読めなくなる。
 *
 * **30 日にしたのは、ふだんの読む範囲を大きく超えて、なお目盛りが読めるところだから。**
 * 実測（2026-11-24）で、既定の 30 本が触っていたのは 5 日ぶん、上限の 60 本でも 6.5 日ぶん。
 * 上限に当たるのは「全部読めた」ときだけで、そのとき見たいのは直近の月の形。
 * 全幅（1200px 前後）で1日 40px、狭い窓（360px）でも1日 10px 残る。切ったぶんは日数で返して添える。
 */
export const DAY_CHART_MAX = 30;

/** 線を引くのに要る日数。1日では点にしかならず、形が読めない */
const DAY_LINE_MIN = 2;

/**
 * 目盛り（日付の字）を毎日に付けるのは何日まで。それより多いと間引く。
 *
 * 14 日（2週）までは毎日でも重ならない（全幅で1日 80px 前後）。間引くときは**今日から数えて**等間隔にする
 * ―― いちばん新しい日にはいつも日付が付く。
 */
export const DAY_TICKS_ALL = 14;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 時刻を地方時の日の鍵（`YYYY-MM-DD`）にする。
 *
 * **サーバーの `src/parse/usage.mjs` の `localDay` と同じ組み方。** 画面は `src/` を import できないので
 * 写してある。食い違うと境目（`scanFrom`）と行の鍵が1日ずれるので、`test/usage-days.test.mjs` が
 * 両方を呼んで突き合わせている。
 *
 * @param {number} ms
 * @returns {string}
 */
export function localDay(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 日の鍵を地方時の 0 時の Date にする。読めなければ null。
 *
 * **在りもしない日（2026-02-31）を黙って繰り上げない。** `Date` は 3/3 にしてしまうので、組み直して突き合わせる。
 *
 * @param {unknown} day
 * @returns {Date|null}
 */
function dateOf(day) {
  const m = typeof day === 'string' ? day.match(DAY_RE) : null;
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return localDay(d.getTime()) === day ? d : null;
}

/**
 * 日の鍵を n 日ずらす。日付を足した 0 時から組むので、月末・年末・夏時間の日でも暦どおりに進む
 * （24時間を足すと、夏時間の切り替わる日に同じ日へ戻ることがある）。
 *
 * @param {string} day 読める日の鍵
 * @param {number} n
 * @returns {string}
 */
function shiftDay(day, n) {
  const d = dateOf(day);
  return localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime());
}

/**
 * 2つの日の鍵のあいだの日数（b − a）。夏時間で 23/25 時間の日があっても丸めで吸収する。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function daysBetween(a, b) {
  return Math.round((dateOf(b).getTime() - dateOf(a).getTime()) / 86400000);
}

/**
 * 日の名前（`11/18（水）`）。吹き出しと注記と読み上げで使う。
 * 組み方は `day-text.js` の `dayText`（今日のまとめの窓の題 `today-md.js` の `agoDate` と同じ言い方）。
 *
 * @param {string} day 日の鍵
 * @returns {string} 読めなければ受け取った字のまま
 */
export function dayLabel(day) {
  const d = dateOf(day);
  if (!d) return String(day ?? '');
  return dayText(d);
}

/**
 * 目盛りの上端。1・2・5 の刻みで切り上げる（82.0M → 100M、36.6M → 50M）。
 *
 * **線は 0 から描く。** 下端を最小値に寄せると、小さな差が崖に見える（使った量の線なので、
 * 0 からの高さそのものに意味がある）。上端だけを切りのよい数へ上げる。
 *
 * @param {number} n いちばん多い日の量
 * @returns {number} 0 以下（使っていない）なら 0
 */
export function niceMax(n) {
  if (!(n > 0)) return 0;
  const p = 10 ** Math.floor(Math.log10(n));
  for (const s of [1, 2, 5, 10]) {
    if (s * p >= n) return s * p;
  }
  return 10 * p;
}

/**
 * 線グラフに描くもの。
 *
 * `status` で5つに分ける。描くのは `ok` だけ。
 *
 *   - `ok` … 2日以上描ける
 *   - `short` … 描けるのが1日だけ（点にしかならないので線は引かない）
 *   - `none` … 描ける日が0日（境目が今日より後。今日のぶんも一部しか読んでいない）
 *   - `unknown` … 境目が決められない（null・日として読めない）
 *   - `old` … 境目のキーが無い（古いサーバー）。決められないのと同じ側に倒す
 *
 * @param {object} d `/api/usage` の応答（読むのは `daily.list`・`meta`・`limit`・`days` だけ）
 * @returns {{
 *   status: 'ok'|'short'|'none'|'unknown'|'old',
 *   scanFrom: string|null,
 *   from: string|null, to: string|null,
 *   days: Array<{day: string, ite: number, requests: number, x: number, y: number,
 *                tick: string|null, weekday: string|null}>,
 *   peak: {day: string, ite: number, index: number, label: string}|null,
 *   max: number, cut: boolean, clipped: number, canWiden: boolean, canLengthen: boolean,
 * }}
 *   x / y は 0〜1（x は日の列の真ん中、y は上端からの割合）。cut は「境目より前に一部しか数えていない日がある」。
 *   clipped は上限で描かなかった（全部数えてある）日の数。canWiden は本数を増やせば読む範囲が広がるか、
 *   canLengthen は期間を広げれば読む範囲が広がるか（描かないときの一言 `chartNote` が何を変えればよいかを言うのに使う）
 */
export function dayChartView(d) {
  const meta = d?.meta ?? {};
  const list = Array.isArray(d?.daily?.list) ? d.daily.list : [];
  const scanFrom = meta.scanFrom ?? null;
  // 境目を左へ動かせる絞り込みはどれか。境目は「数えなかったログのうち、いちばん新しい最終更新の次の日」
  // （src/view/CLAUDE.md）なので、そのログを外した絞り込みを緩めれば動く。
  //   - 本数 … 上限に当たっていて、まだ上限（scanMax）まで選んでいないとき。上限で外したログは期間の内側なので、
  //     上限に当たっているあいだは期間を広げても境目は動かない（いちばん新しい外れものは上限の外のまま）
  //   - 期間 … 上限に当たっておらず（期間の中は全部読めた）、期間で外したログがあるとき
  //     （索引の本数 indexed が、読みに行った本数 scanned より多い）
  const canWiden = Boolean(meta.scanLimited)
    && typeof d?.limit === 'number' && typeof meta.scanMax === 'number' && d.limit < meta.scanMax;
  const canLengthen = meta.scanLimited === false
    && typeof d?.days === 'number' && d.days > 0
    && typeof meta.indexed === 'number' && typeof meta.scanned === 'number' && meta.indexed > meta.scanned;
  const base = {
    status: 'unknown', scanFrom, from: null, to: null, days: [], peak: null, max: 0,
    cut: true, clipped: 0, canWiden, canLengthen,
  };

  if (!('scanFrom' in meta)) return { ...base, status: 'old' };
  if (!dateOf(scanFrom)) return base;

  const last = list.length ? list[list.length - 1].day : null;
  const to = Number.isFinite(meta.now) ? localDay(meta.now) : (dateOf(last) ? last : scanFrom);

  // 境目より前に一部しか数えていない日があるか。**行が境目より前にあれば必ずそう**（全部読めたときの境目は
  // いちばん古い行の日なので、その前に行は無い）。行が無くても、開かなかったログがあれば左は欠けている
  const cut = list.some((r) => typeof r.day === 'string' && r.day < scanFrom)
    || (typeof meta.indexed === 'number' && typeof meta.scanned === 'number' && meta.indexed > meta.scanned);

  if (scanFrom > to) return { ...base, status: 'none', to, cut: true };

  let from = scanFrom;
  let clipped = 0;
  const earliest = shiftDay(to, -(DAY_CHART_MAX - 1));
  if (from < earliest) {
    clipped = daysBetween(from, earliest);
    from = earliest;
  }

  const byDay = new Map(list.map((r) => [r.day, r]));
  const raw = [];
  for (let day = from; day <= to; day = shiftDay(day, 1)) {
    const r = byDay.get(day);
    raw.push({
      day,
      ite: Number.isFinite(r?.ite) ? r.ite : 0,
      requests: Number.isFinite(r?.requests) ? r.requests : 0,
    });
  }

  // 山。**0 を山と呼ばない。** 同じ量なら新しい日（いまに近いほう）
  let peak = null;
  raw.forEach((x, index) => {
    if (x.ite > 0 && (!peak || x.ite >= peak.ite)) peak = { day: x.day, ite: x.ite, index };
  });
  const max = niceMax(peak?.ite ?? 0);

  const n = raw.length;
  const step = n <= DAY_TICKS_ALL ? 1 : Math.ceil(n / DAY_TICKS_ALL);
  let prevMonth = null;
  const days = raw.map((x, i) => {
    const date = dateOf(x.day);
    const ticked = (n - 1 - i) % step === 0;
    let tick = null;
    if (ticked) {
      // 月は最初の目盛りと、月が変わったところにだけ書く（毎回書くと字が長くなって重なる）
      const month = date.getMonth();
      tick = month === prevMonth ? String(date.getDate()) : `${month + 1}/${date.getDate()}`;
      prevMonth = month;
    }
    return {
      ...x,
      x: (i + 0.5) / n,
      y: max > 0 ? 1 - x.ite / max : 1,
      tick,
      weekday: ticked ? weekdayOf(date) : null,
    };
  });

  return {
    ...base,
    status: n < DAY_LINE_MIN ? 'short' : 'ok',
    from,
    to,
    days,
    peak: peak ? { ...peak, label: dayLabel(peak.day) } : null,
    max,
    cut,
    clipped,
  };
}

/**
 * 「これより前は一部しか読んでいません」の一言。**誤読を防ぐ注記なので消さない**（D2）。
 *
 * 線グラフ（概要）と、横棒＋表（節「推移」）の両方が同じ文を出す。横棒は新しい順に並ぶので
 * 「これより前」では向きが読めない。だから日付を名指しする。
 *
 * @param {ReturnType<typeof dayChartView>} view
 * @returns {string|null} 一部の日が無ければ（全部読めた）null
 */
export function partialNote(view) {
  switch (view?.status) {
    case 'old':
      return 'サーバーが古いので、どの日から全部そろっているかが分かりません。左端の日は一部しか数えていないかもしれません。';
    case 'unknown':
      return 'どの日から全部そろっているかが分かりません。左端の日は一部しか数えていないかもしれません。';
    case 'none':
      return '全部そろっている日がまだありません。今日のぶんも一部しか読んでいません。';
    default:
      return view?.cut
        ? `${dayLabel(view.scanFrom)}より前は一部しか読んでいません。読まなかったログのぶんが抜けています。`
        : null;
  }
}

/**
 * 線を描けないとき（そろう日が0日・1日だけ）に、上の絞り込みで何を変えればそろう日が増えうるかの一言。
 * **何をすれば描けるかを言う。** 変えても境目が動かない手は勧めない（押しても変わらないことを言わない）。
 *
 * 期間の一言は1日だけ（`short`）のときしか出さない。期間で外したログは最終更新が「いま − 期間」より前
 * （少なくとも1日前）なので、境目を今日より後へは押し出さない。そろう日が0日（`none`）なら、
 * 境目を決めているのは上限で外したログか読めなかったログで、期間を広げても動かない。
 *
 * @param {ReturnType<typeof dayChartView>} view
 * @returns {string} 勧める手が無ければ空文字
 */
function widenHint(view) {
  if (view.canWiden) return '上で本数を増やすと、そろう日が増えることがあります。';
  if (view.canLengthen && view.status === 'short') {
    return '上で期間を広げる（または「期間を絞らない」にする）と、そろう日が増えることがあります。';
  }
  return '';
}

/**
 * 線を描かないときに、概要の線グラフの場所へ置く一言。**空の箱を置かない。**
 * 描けない理由のあとに、上の絞り込みで何を変えればよいか（`widenHint`）を続ける。
 *
 * @param {ReturnType<typeof dayChartView>} view
 * @returns {string|null} 描けるときは null
 */
export function chartNote(view) {
  switch (view?.status) {
    case 'old':
    case 'unknown':
      return 'どの日から全部そろっているかが分からないので、日ごとの線は描いていません。';
    case 'none':
      return '全部そろっている日がまだないので、日ごとの線は描いていません（今日のぶんも一部しか読んでいません）。'
        + widenHint(view);
    case 'short':
      return `全部そろっているのは ${dayLabel(view.from)}の1日だけなので、線は描いていません。` + widenHint(view);
    default:
      return null;
  }
}

/**
 * 上限で切ったときの一言。**切ったことは黙らない。**
 *
 * @param {ReturnType<typeof dayChartView>} view
 * @returns {string|null} 切っていなければ null
 */
export function clipNote(view) {
  if (!(view?.clipped > 0)) return null;
  return `直近 ${view.days.length} 日だけを描いています。それより前の ${view.clipped} 日ぶんは、節「推移」の表にあります。`;
}
