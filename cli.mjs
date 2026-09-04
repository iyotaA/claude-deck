#!/usr/bin/env node
/**
 * 一覧をターミナルに出すだけの版。
 *
 * ブラウザを開かずに「いまどれが自分待ちか」だけ知りたいときに使う。
 * 中身はダッシュボードと同じ src/ を呼ぶので、判定がずれることはない。
 *
 *   node cli.mjs          … 稼働中＋直近終了を1回出す
 *   node cli.mjs --live   … 3秒ごとに出し直す
 *   node cli.mjs --all    … 終了したものも含めて全部出す
 */
import { listSessions } from './src/view/sessions.mjs';
import { configDir } from './src/read/paths.mjs';

const args = new Set(process.argv.slice(2));
const live = args.has('--live') || args.has('-l');
const showAll = args.has('--all') || args.has('-a');

/** 状態ごとの色。ANSI が使えない端末では色を付けない。 */
const COLOR = {
  'needs-answer': '[31m',
  'needs-plan-approval': '[31m',
  'needs-approval': '[31m',
  'awaiting-reply': '[33m',
  running: '[36m',
  ended: '[90m',
  unknown: '[90m',
};
const RESET = '[0m';
const DIM = '[2m';
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

/**
 * 色を付ける。TTY でないときと `NO_COLOR` のときは素のまま返す。
 *
 * @param {string} text 中身
 * @param {string} [code] 色の指定。無ければ何もしない
 * @returns {string}
 */
function paint(text, code) {
  return useColor && code ? `${code}${text}${RESET}` : text;
}

/** 全角文字を2桁として数え、見た目の幅で切る。日本語のタイトルが崩れないように。 */
function width(text) {
  let w = 0;
  for (const ch of text) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}

/**
 * 見た目の幅で切って、足りないぶんを空白で埋める。
 * 収まらなければ末尾を `…` にする（列がずれるより読めないほうがまし）。
 *
 * @param {*} text 中身。null や undefined でも落とさない
 * @param {number} size 何桁ぶんに収めるか
 * @returns {string}
 */
function pad(text, size) {
  const t = String(text ?? '');
  let w = 0;
  let out = '';
  for (const ch of t) {
    const cw = width(ch);
    if (w + cw > size) return `${out}…`;
    out += ch;
    w += cw;
  }
  return out + ' '.repeat(Math.max(0, size - w));
}

/**
 * 経過を短く言う。**取れないものは 0 秒にせず「—」**（0 と不明を分ける）。
 *
 * @param {number|null|undefined} ms 経過（ミリ秒）
 * @returns {string}
 */
function since(ms) {
  if (ms === null || ms === undefined) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}時間${m % 60}分` : `${Math.floor(h / 24)}日`;
}

/**
 * 一覧を1回書き出す。`--all` が無ければ終わったものを落とす。
 *
 * @returns {Promise<void>}
 */
async function show() {
  const { rows, meta } = await listSessions();
  const target = showAll ? rows : rows.filter((r) => r.alive || r.state !== 'ended');

  const lines = [];
  for (const row of target) {
    const mark = paint(pad(row.stateLabel, 14), COLOR[row.state]);
    const title = pad(row.title ?? row.name ?? row.sessionId, 40);
    const place = paint(pad(row.project ?? '', 22), DIM);
    const idle = paint(pad(since(row.idleMs), 8), DIM);
    lines.push(`${mark} ${title} ${place} ${idle}`);
    // 何を待っているかは状態だけでは分からないので、あるときだけ2行目に出す
    if (row.waitingFor) {
      const detail = row.waitingFor.detail ? ` ${row.waitingFor.detail}` : '';
      lines.push(paint(`${' '.repeat(15)}↳ ${row.waitingFor.tool}${detail}`, DIM));
    }
  }

  if (live) process.stdout.write('[2J[H');
  console.log(paint(`ClaudeDeck  ${configDir}`, DIM));
  console.log(lines.join('\n') || '(セッションがありません)');

  const tail = [`稼働中 ${meta.live}`, `あなた待ち ${meta.needsYou}`, `表示 ${target.length}`];
  if (meta.registryReadErrors) tail.push(`読めなかった登録 ${meta.registryReadErrors}`);
  console.log(paint(tail.join(' / '), DIM));
}

await show();
if (live) {
  setInterval(() => { show().catch((e) => console.error(e.message)); }, 3000);
}
