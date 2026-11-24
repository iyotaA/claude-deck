/**
 * 詳細の頭の「次の一手」（`public/js/next-step.js`）。
 *
 * import ゼロの純関数なので Node から呼べる（`groups.js` / `nav.js` と同じ形）。
 * 見るのは画面刷新④の D5 の表の全場面と、2つの決まり。
 *
 * - **塗るのは1画面に1つ。** 入力欄があれば入力欄のボタン（「送る」「続きを起こす」）が塗ってあるので、
 *   頭は塗らない。入力欄が無いときだけ頭を塗る
 * - **窓を前に出せない行には出さない。** pid が無い・生きていない・画面から起こした実行
 *   （子は窓を持たない。`src/os/claude.mjs` の `spawnClaude` が `windowsHide: true` で起こす）
 *
 * 許可・質問のボタンは頭に上げない（コマンドを読む前に押せる位置に置かない）。
 * ここが返すのは「ターミナルの窓を前に出す」口だけで、押しても許可にはならない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextStep, canFocusTerminal, NEXT_STEPS } from '../public/js/next-step.js';
import { RUN_STATE_LABELS, isRunOver } from '../src/run/ledger.mjs';
import { STATE_LABELS, isBlocking } from '../src/parse/state.mjs';

/** 一覧の行。ターミナルで動いているもの（生きていて pid がある）を既定にする */
const term = (state, over = {}) => ({
  sessionId: 's1', state, blocking: isBlocking(state), alive: true, pid: 4242, ...over,
});

/** 画面から起こした実行が重なった行。merge.mjs の overlay は alive と子の pid を入れる */
const deck = (state, over = {}) => term(state, { origin: 'deck', pid: 5151, ...over });

/** 返ってきたものを比べやすい形に */
const pick = (s) => (s ? { kind: s.kind, lead: s.lead } : null);

/* ── 表の全場面（調査 712〜738 行・仕様の D5） ───────────────────── */

test('返信待ち（ターミナル）は「ターミナルで返事をする」を塗る', () => {
  const s = nextStep(term('awaiting-reply'));
  assert.deepEqual(pick(s), { kind: 'reply', lead: true });
  assert.equal(s.label, 'ターミナルで返事をする');
});

test('止まっている（ターミナル）は「ターミナルで答える」を塗る。止まっている状態の全部で同じ', () => {
  for (const state of Object.keys(STATE_LABELS).filter(isBlocking)) {
    const s = nextStep(term(state));
    assert.deepEqual(pick(s), { kind: 'answer', lead: true }, state);
    assert.equal(s.label, 'ターミナルで答える', state);
  }
});

test('実行中（ターミナル）は「ターミナルを前面に」。塗らない（あなたにやることは無い）', () => {
  const s = nextStep(term('running'));
  assert.deepEqual(pick(s), { kind: 'front', lead: false });
  assert.equal(s.label, 'ターミナルを前面に');
});

test('画面から起こした実行は、止まっている・返信待ち・実行中のどれでも頭に出さない', () => {
  // 許可・質問はカード、送る・割り込む・止めるは入力欄が持つ。子は窓を持たないので前面にも出せない
  const cases = [
    ['needs-approval', 'needs-permission'],
    ['awaiting-reply', 'waiting'],
    ['awaiting-reply', 'stalled'],
    ['awaiting-reply', 'budget'],
    ['running', 'running'],
    ['running', 'starting'],
  ];
  for (const [state, runState] of cases) {
    assert.equal(nextStep(deck(state), { runState, composer: true }), null, `${state} / ${runState}`);
  }
});

test('終了は、続きを起こせても起こせなくても頭に出さない', () => {
  // 起こせるなら入力欄の「続きを起こす」が持つ（同じことをする口を2つ並べない）
  assert.equal(nextStep(term('ended', { alive: false }), { composer: true }), null);
  assert.equal(nextStep(term('ended', { alive: false }), { composer: false }), null);
});

test('不明は頭に出さない（生きていて pid があっても）', () => {
  assert.equal(nextStep(term('unknown')), null);
  // 知らない語も同じ。断定できないものに「次の一手」を言わない
  assert.equal(nextStep(term('someday-new-state', { blocking: false })), null);
});

/* ── 塗るのは1つ ───────────────────────────────────────── */

test('入力欄があれば頭は塗らない（出すなら塗らない顔で出す）', () => {
  // ターミナル側で生きていれば入力欄は出ない作りだが、出ていたら入力欄の塗ったボタンを1つに保つ
  assert.deepEqual(pick(nextStep(term('awaiting-reply'), { composer: true })), { kind: 'reply', lead: false });
  assert.deepEqual(pick(nextStep(term('needs-approval'), { composer: true })), { kind: 'answer', lead: false });
});

test('どの場面でも、頭が塗るのは返信待ちと止まっているの2つだけ', () => {
  const states = [...Object.keys(STATE_LABELS), 'someday-new-state'];
  for (const state of states) {
    const s = nextStep(term(state));
    if (s?.lead) assert.ok(['reply', 'answer'].includes(s.kind), `${state} が ${s.kind} を塗っている`);
  }
});

/* ── 窓を前に出せない行には出さない ───────────────────────────── */

test('pid が取れない・生きていない行には出さない（押せない顔のボタンを出さない）', () => {
  for (const pid of [null, undefined, 0, -1, 1.5, '4242']) {
    assert.equal(nextStep(term('awaiting-reply', { pid })), null, `pid=${pid}`);
  }
  assert.equal(nextStep(term('awaiting-reply', { alive: false })), null);
  assert.equal(nextStep(term('awaiting-reply', { alive: 'yes' })), null);
});

test('終わった実行のあとにターミナルで開き直したものは、ターミナルの行として扱う', () => {
  // 終わった run は overlay が alive / pid を上書きしない（登録簿の値がそのまま残る）
  for (const runState of ['stopped', 'failed', 'done']) {
    assert.deepEqual(pick(nextStep(term('awaiting-reply'), { runState })), { kind: 'reply', lead: true }, runState);
  }
});

test('canFocusTerminal はパレットと頭で同じ判断（生きている・pid がある・画面から起こした実行が動いていない）', () => {
  assert.equal(canFocusTerminal(term('running')), true);
  assert.equal(canFocusTerminal(term('unknown')), true);
  assert.equal(canFocusTerminal(term('running', { pid: null })), false);
  assert.equal(canFocusTerminal(term('ended', { alive: false })), false);
  assert.equal(canFocusTerminal(deck('running'), 'running'), false);
  assert.equal(canFocusTerminal(term('running'), 'done'), true);
});

test('「画面から起こした実行が動いているか」の見方がサーバーの isRunOver と同じ', () => {
  // 終わりの語を画面に持つので、台帳が状態を1つ足した日に食い違わないよう全部の語で突き合わせる
  for (const runState of Object.keys(RUN_STATE_LABELS)) {
    const live = canFocusTerminal(term('running'), runState) === false;
    assert.equal(live, !isRunOver(runState), runState);
  }
});

/* ── 語の表 ───────────────────────────────────────────── */

test('3つの一手は名前と吹き出しを持つ。押しても許可にはならないことを「答える」の吹き出しで言う', () => {
  assert.deepEqual(Object.keys(NEXT_STEPS).sort(), ['answer', 'front', 'reply']);
  for (const [kind, def] of Object.entries(NEXT_STEPS)) {
    assert.ok(def.label, `${kind} に名前が無い`);
    assert.ok(def.title, `${kind} に吹き出しが無い`);
  }
  assert.match(NEXT_STEPS.answer.title, /許可にはなりません/);
});

test('入ってきた行を書き換えない', () => {
  const row = Object.freeze(term('awaiting-reply'));
  assert.doesNotThrow(() => nextStep(row, { composer: true }));
});
