/**
 * 今日のまとめを Markdown にする側（`public/js/today-md.js`）。
 *
 * 画面側のファイルだが import ゼロの純関数なので、Node から読める。
 * 見たいのは「画面と同じ並びで、切ったことを黙らない」こと。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TODAY_AGO_MAX_UI, isQuiet, shortPath, spanText, todayMarkdown,
} from '../public/js/today-md.js';
import { TODAY_AGO_MAX } from '../src/view/today.mjs';

const at = (h, m) => new Date(2026, 9, 15, h, m).getTime();

/** 応答の1行。何も渡さなければ「動いただけ」の行 */
function row(over = {}) {
  return {
    sessionId: 'abcdef12-0000', title: '題', cwd: 'C:\\work\\demo', project: 'demo',
    firstAt: at(10, 15), lastAt: at(10, 23), alive: false,
    decisions: [], decisionsTotal: 0, decisionsOmitted: 0, plansApproved: 0,
    files: [], filesTotal: 0, filesOmitted: 0,
    ...over,
  };
}

function data(rows, meta = {}) {
  return {
    day: '2026-10-15',
    rows,
    totals: { sessions: rows.length, projects: 1, decisions: 1, files: 1 },
    meta: { scanLimited: false, scanMax: 60, candidates: rows.length, ...meta },
  };
}

test('見出し・決めたこと・書き換えたファイルを画面と同じ順で出す。パスは作業フォルダから見た形', () => {
  const md = todayMarkdown(data([row({
    decisions: [{ topic: '範囲', choice: 'B' }, { topic: null, choice: '自由入力' }],
    decisionsTotal: 2,
    files: [{ path: 'C:\\work\\demo\\src\\a.js', count: 2, tools: ['Edit'] }],
    filesTotal: 1,
  })]));
  assert.match(md, /^# まとめ（2026-10-15）/);
  assert.match(md, /動いたセッション 1 本・置き場所 1 つ\n/);
  assert.match(md, /## demo — 題（10:15–10:23）/);
  assert.match(md, /- 範囲: B\n- 自由入力/);
  assert.match(md, /- `src\\a\.js`/);
});

test('切ったぶんは「ほか N」で残す。走査を打ち切ったことも書く', () => {
  const md = todayMarkdown(data([row({
    decisions: [{ topic: 'a', choice: 'b' }], decisionsTotal: 21, decisionsOmitted: 20,
    files: [{ path: 'x', count: 1, tools: [] }], filesTotal: 31, filesOmitted: 30,
  })], { scanLimited: true, candidates: 75 }));
  assert.match(md, /- ほか 20 件/);
  assert.match(md, /- ほか 30 個/);
  assert.match(md, /新しい 60 本だけ.*75 本中/);
});

test('決めたことも書き換えも無い行は、最後に名前だけ並べる（動いた事実は消さない）', () => {
  const md = todayMarkdown(data([row({ title: '調べただけ' })]));
  assert.ok(isQuiet(row()));
  assert.ok(!isQuiet(row({ plansApproved: 1 })));
  assert.match(md, /## そのほかに動いたもの\n\n- demo — 調べただけ（10:15–10:23）/);
  assert.doesNotMatch(md, /## demo — 調べただけ/);
});

test('作業フォルダの外のパスは元のまま。大小と区切りの違いは同じとみなす', () => {
  assert.equal(shortPath('C:\\Other\\a.js', 'C:\\work'), 'C:\\Other\\a.js');
  assert.equal(shortPath('c:/WORK/b/c.js', 'C:\\work\\'), 'b/c.js');
  assert.equal(shortPath('C:\\workspace\\a.js', 'C:\\work'), 'C:\\workspace\\a.js');
  assert.equal(shortPath('a.js', null), 'a.js');
});

test('時刻の言い方。同じ分なら1つだけ', () => {
  assert.equal(spanText(row({ lastAt: at(10, 15) })), '10:15');
  assert.equal(spanText(row({ firstAt: null })), '--:--–10:23');
});

test('選べる日数がサーバーの上限と揃っている', () => {
  assert.equal(TODAY_AGO_MAX_UI, TODAY_AGO_MAX);
});
