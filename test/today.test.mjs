/**
 * 今日のまとめの判断（`src/view/today.mjs`）。
 *
 * 見たいのは「その日のぶんだけを拾う」こと。全文の digest から拾うと、
 * 前の日に書き換えたファイルや決めたことまで今日に並んでしまう。
 * ディスクを読む側（`listToday`）は実物で確かめる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayWindow, parseTodayQuery, summarizeDay, TODAY_AGO_MAX } from '../src/view/today.mjs';
import { T0, call, result, prompt, say } from './helpers.mjs';

const HOUR = 60 * 60 * 1000;
/** T0 を含む1時間を「その日」とみなす窓。窓の作り方は dayWindow のテストで別に見る */
const WIN = { from: T0, to: T0 + HOUR };

/** AskUserQuestion の1往復。選んだラベルを返したことにする */
function asked(id, ms, { header = '範囲', label = 'B: 階層化' } = {}) {
  const input = {
    questions: [{
      question: '範囲はどうする？',
      header,
      options: [{ label: 'A: 最小' }, { label }],
    }],
  };
  return [
    call('AskUserQuestion', input, { id, ms }),
    result(id, { ms: ms + 10, text: `Your questions have been answered: "範囲はどうする？"="${label}". You can now continue.` }),
  ];
}

test('その日の行だけを拾う。前の日に書いたファイルと決めたことは並べない', () => {
  const entries = [
    // 前の日（窓より前）
    prompt('きのうの指示', { ms: -2 * HOUR }),
    call('Edit', { file_path: 'C:\\w\\old.js' }, { id: 'e0', ms: -2 * HOUR + 10 }),
    result('e0', { ms: -2 * HOUR + 20 }),
    ...asked('q0', -2 * HOUR + 30, { header: '古い判断' }),
    // その日
    prompt('きょうの指示', { ms: 0 }),
    call('Write', { file_path: 'C:\\w\\new.md' }, { id: 'e1', ms: 100 }),
    result('e1', { ms: 110 }),
    ...asked('q1', 200),
    say('終わった', { ms: 300 }),
  ];
  const s = summarizeDay(entries, WIN);
  assert.deepEqual(s.files.map((f) => f.path), ['C:\\w\\new.md']);
  assert.deepEqual(s.decisions.map((d) => d.topic), ['範囲']);
  assert.equal(s.decisions[0].choice, 'B: 階層化');
  assert.equal(s.prompts, 1);
  assert.equal(s.firstAt, T0);
});

test('その日に本流の行が無ければ null（動いていない日を空の行にしない）', () => {
  const entries = [prompt('きのう', { ms: -2 * HOUR }), say('はい', { ms: -2 * HOUR + 10 })];
  assert.equal(summarizeDay(entries, WIN), null);
});

test('選択肢の「(Recommended)」は決めた中身ではないので外す', () => {
  const s = summarizeDay([prompt('x'), ...asked('q1', 100, { label: '冊④に置く (Recommended)' })], WIN);
  assert.equal(s.decisions[0].choice, '冊④に置く');
});

test('切ったぶんは数で返す。0 のときもキーを出す', () => {
  const s = summarizeDay([prompt('x')], WIN);
  assert.equal(s.filesOmitted, 0);
  assert.equal(s.decisionsOmitted, 0);
  assert.equal(s.filesTotal, 0);
  assert.equal(s.decisionsTotal, 0);

  const many = [prompt('x')];
  for (let i = 0; i < 35; i += 1) {
    many.push(call('Edit', { file_path: `C:\\w\\f${i}.js` }, { id: `e${i}`, ms: 10 + i }));
  }
  const t = summarizeDay(many, WIN);
  assert.equal(t.files.length, 30);
  assert.equal(t.filesTotal, 35);
  assert.equal(t.filesOmitted, 5);
});

test('日の窓は地方時の 0 時から次の 0 時まで。何日前かで日付が1つずつ動く', () => {
  const now = new Date(2026, 9, 15, 13, 30).getTime();
  const w = dayWindow(now, 0);
  assert.equal(w.day, '2026-10-15');
  assert.equal(w.from, new Date(2026, 9, 15).getTime());
  assert.equal(w.to, new Date(2026, 9, 16).getTime());
  // 月を跨ぐ
  assert.equal(dayWindow(new Date(2026, 10, 1, 8).getTime(), 1).day, '2026-10-31');
});

test('クエリは丸める。変な値で 400 にせず、きょうへ戻す', () => {
  const q = (s) => parseTodayQuery(new URLSearchParams(s));
  assert.deepEqual(q(''), { ago: 0 });
  assert.deepEqual(q('ago=abc'), { ago: 0 });
  assert.deepEqual(q('ago=2'), { ago: 2 });
  assert.deepEqual(q('ago=99'), { ago: TODAY_AGO_MAX });
  assert.deepEqual(q('ago=-3'), { ago: 0 });
  assert.deepEqual(parseTodayQuery(null), { ago: 0 });
});
