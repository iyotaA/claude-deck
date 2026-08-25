/**
 * stream-json の1行を、画面に出せる出来事へ畳む側のテスト。
 *
 * 入力は必ず `classifyStreamLine` を通す。畳んだ形だけを直に作ると、
 * 「読み方」と「畳み方」の継ぎ目がずれても気づけない。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyStreamLine } from '../src/parse/stream.mjs';
import { askKindOf, toRunEvents, TEXT_MAX, TOOL_RESULT_MAX } from '../src/run/event.mjs';
import {
  sysInit, sAssistant, sUser, sResult, sPermission, sQuestion, sControlResponse, S_ID,
} from './helpers.mjs';

/** 行を1本畳む。テストの見通しのため、JSON 化と分類をここでまとめる。 */
function fold(line) {
  return toRunEvents(classifyStreamLine(JSON.stringify(line)));
}

test('init は起動の様子を1件に畳む', () => {
  const [ev, ...rest] = fold(sysInit({ model: 'claude-opus-5', cwd: 'C:\\work\\demo' }));
  assert.equal(rest.length, 0);
  assert.equal(ev.kind, 'init');
  assert.equal(ev.sessionId, S_ID);
  assert.equal(ev.model, 'claude-opus-5');
  assert.equal(ev.cwd, 'C:\\work\\demo');
  assert.equal(ev.permissionMode, 'plan');
  assert.equal(ev.tools, 2);
});

test('assistant の地の文は text 1件になる', () => {
  const evs = fold(sAssistant('やってみるわ'));
  assert.deepEqual(evs, [{ kind: 'text', text: 'やってみるわ' }]);
});

test('assistant の道具呼びは text の後に並ぶ', () => {
  const evs = fold(sAssistant('読むね', {
    uses: [{ id: 't1', name: 'Read', input: { file_path: 'C:\\work\\a.mjs' } }],
  }));
  assert.equal(evs.length, 2);
  assert.equal(evs[0].kind, 'text');
  assert.deepEqual(evs[1], {
    kind: 'tool', id: 't1', tool: 'Read', detail: 'C:\\work\\a.mjs',
  });
});

test('1行に複数の道具が並んでもそのぶん出る', () => {
  const evs = fold(sAssistant('', {
    uses: [
      { id: 't1', name: 'Read', input: { file_path: 'a.mjs' } },
      { id: 't2', name: 'Grep', input: { pattern: 'foo', path: 'src' } },
    ],
  }));
  assert.equal(evs.length, 2);
  assert.deepEqual(evs.map((e) => e.id), ['t1', 't2']);
});

test('thinking しか無い行は0件になる（本文は持たない方針）', () => {
  const evs = fold({
    type: 'assistant',
    session_id: S_ID,
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'ふむ' }] },
  });
  assert.deepEqual(evs, []);
});

test('地の文は TEXT_MAX で切って、切ったことが分かる形にする', () => {
  const evs = fold(sAssistant('あ'.repeat(TEXT_MAX + 500)));
  assert.equal(evs[0].text.length, TEXT_MAX + 7);
  assert.ok(evs[0].text.endsWith('…（以下省略）'));
});

test('replay で返ってきた自分の行は echo になる', () => {
  const evs = fold(sUser({ text: '直して', isReplay: true }));
  assert.deepEqual(evs, [{ kind: 'echo', text: '直して', replay: true }]);
});

test('ツール結果は1件ずつ、短い要約にして持つ', () => {
  const evs = fold(sUser({
    results: [
      { id: 't1', text: 'ok' },
      { id: 't2', text: 'だめ', isError: true },
    ],
  }));
  assert.deepEqual(evs, [
    { kind: 'tool-result', id: 't1', isError: false, text: 'ok' },
    { kind: 'tool-result', id: 't2', isError: true, text: 'だめ' },
  ]);
});

test('大きなツール結果は TOOL_RESULT_MAX で切る', () => {
  const evs = fold(sUser({ results: [{ id: 't1', text: 'x'.repeat(5000) }] }));
  assert.equal(evs[0].text.length, TOOL_RESULT_MAX);
  assert.ok(evs[0].text.endsWith('…'));
});

test('replay の印はツール結果より強い', () => {
  // 印は向こうが明示的に付ける側なので、形の推測より先に見る
  const evs = fold(sUser({ text: 'これ', results: [{ id: 't1' }], isReplay: true }));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'echo');
  assert.equal(evs[0].replay, true);
});

test('印もツール結果も無い user 行は echo（replay:false）で出す', () => {
  const evs = fold(sUser({ text: '割り込み' }));
  assert.deepEqual(evs, [{ kind: 'echo', text: '割り込み', replay: false }]);
});

test('result は結末をそのまま持つ', () => {
  const [ev] = fold(sResult({ costUSD: 0.42, numTurns: 1, terminal_reason: 'completed' }));
  assert.equal(ev.kind, 'result');
  assert.equal(ev.isError, false);
  assert.equal(ev.terminalReason, 'completed');
  assert.equal(ev.costUSD, 0.42);
  assert.equal(ev.numTurns, 1);
  assert.equal(ev.text, '終わりました');
});

test('予算超過の result は理由の文字列まで持ち帰る', () => {
  const [ev] = fold(sResult({
    subtype: 'error_max_budget_usd',
    isError: true,
    text: null,
    terminal_reason: 'budget_exhausted',
    errors: ['Reached maximum budget ($0.01)'],
  }));
  assert.equal(ev.isError, true);
  assert.equal(ev.terminalReason, 'budget_exhausted');
  assert.equal(ev.errors, 'Reached maximum budget ($0.01)');
  assert.equal(ev.text, null);
});

test('読めなかった行は broken として見本だけ残す', () => {
  const evs = toRunEvents(classifyStreamLine('{"type":'));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'broken');
  assert.equal(evs[0].sample, '{"type":');
});

test('知らない type は捨てずに名前だけ残す', () => {
  const evs = fold({ type: 'rate_limit_event', session_id: S_ID, rate_limit_info: {} });
  assert.deepEqual(evs, [{ kind: 'other', type: 'rate_limit_event', subtype: null }]);
});

test('system の init 以外も other になる', () => {
  const evs = fold({ type: 'system', subtype: 'hook_started', session_id: S_ID });
  assert.deepEqual(evs, [{ kind: 'other', type: 'system', subtype: 'hook_started' }]);
});

test('サブエージェントの行には全種類に同じ形で印が付く', () => {
  const text = fold(sAssistant('調べる', { parentToolUseId: 'task-1' }));
  const tool = fold(sAssistant('', {
    parentToolUseId: 'task-1',
    uses: [{ id: 't1', name: 'Read', input: { file_path: 'a.mjs' } }],
  }));
  const res = fold(sUser({ parentToolUseId: 'task-1', results: [{ id: 't1' }] }));

  assert.equal(text[0].sub, true);
  assert.equal(tool[0].sub, true);
  assert.equal(res[0].sub, true);
});

test('親の行には印を付けない（キーごと持たない）', () => {
  const [ev] = fold(sAssistant('本流'));
  assert.equal('sub' in ev, false);
});

test('生の行を外へ出さない（大きな tool_result を持ち回らない）', () => {
  const evs = [
    ...fold(sAssistant('', { uses: [{ id: 't1', name: 'Read', input: { file_path: 'a' } }] })),
    ...fold(sUser({ results: [{ id: 't1', text: 'x'.repeat(100000) }] })),
    ...fold(sResult({})),
    ...fold(sysInit()),
  ];
  for (const ev of evs) {
    assert.equal('entry' in ev, false);
    assert.equal('info' in ev, false);
  }
});

test('何を渡しても落ちない', () => {
  assert.deepEqual(toRunEvents(null), []);
  assert.deepEqual(toRunEvents(undefined), []);
  assert.deepEqual(toRunEvents('文字列'), []);
  assert.deepEqual(toRunEvents(42), []);
  assert.equal(toRunEvents({}).length, 1);
});

/*
 * 許可要求（段1で足したぶん）
 */

test('聞かれ方は3つに分かれる', () => {
  assert.equal(askKindOf('ExitPlanMode'), 'plan');
  assert.equal(askKindOf('AskUserQuestion'), 'question');
  assert.equal(askKindOf('Bash'), 'tool');
  assert.equal(askKindOf(null), 'tool', '名前が読めなくても道具として扱う');
});

test('許可要求は permission 1件に畳む', () => {
  const [ev, ...rest] = fold(sPermission({
    requestId: 'p3', toolName: 'Bash', input: { command: 'npm test' },
  }));
  assert.equal(rest.length, 0);
  assert.equal(ev.kind, 'permission');
  assert.equal(ev.requestId, 'p3');
  assert.equal(ev.ask, 'tool');
  assert.equal(ev.tool, 'Bash');
  assert.equal(ev.detail, 'npm test');
});

test('原文の input は出来事に載せない（Write の content が数MBになる）', () => {
  // ここが「大きい行を持ち回らない」の番人。
  // 原文が要るのは答えるときだけで、それを持つのは台帳の pending のほう
  const content = 'x'.repeat(500_000);
  const [ev] = fold(sPermission({ toolName: 'Write', input: { file_path: 'C:\work\a.txt', content } }));
  assert.equal('input' in ev, false);
  assert.equal(ev.detail, 'C:\work\a.txt');
  assert.ok(JSON.stringify(ev).length < 1000, '出来事1件が原文を抱えていない');
});

test('選択肢で聞かれたら1問目だけを出す', () => {
  const [ev] = fold(sQuestion([
    { question: 'どっちで進める？', options: [{ label: 'あ' }, { label: 'い' }] },
    { question: '2問目', options: [] },
  ]));
  assert.equal(ev.ask, 'question');
  assert.equal(ev.detail, 'どっちで進める？');
  assert.equal('input' in ev, false, '選択肢の原文も台帳が持つ');
});

test('プラン承認は本文を1行に畳んで切る', () => {
  const plan = `# やること\n\n- ${'あ'.repeat(1000)}`;
  const [ev] = fold(sPermission({ toolName: 'ExitPlanMode', input: { plan } }));
  assert.equal(ev.ask, 'plan');
  assert.equal(ev.detail.includes('\n'), false, '1行に畳む');
  assert.ok(ev.detail.length < 500, '長いプランをそのまま持たない');
});

test('材料が無ければ CLI が付けてきた説明に落ちる', () => {
  // 知らないツール（MCP など）で input から何も拾えないとき。**空文字に丸めない**
  const [ev] = fold(sPermission({
    toolName: 'mcp__something__send', input: {}, description: 'よそのサービスへ送ります',
  }));
  assert.equal(ev.detail, 'よそのサービスへ送ります');
});

test('それも無ければ null。空文字で埋めない', () => {
  const [ev] = fold(sPermission({ toolName: 'mcp__something__send', input: {} }));
  assert.equal(ev.detail, null);
});

test('配線のための行は出来事にしない', () => {
  // 人が読むものではない。何が起きたか（断った・モードが変わった）は台帳が note で積む
  assert.deepEqual(fold({ type: 'control_request', request_id: 'z1', request: { subtype: 'なにこれ' } }), []);
  assert.deepEqual(fold(sControlResponse('r1', { response: { mode: 'auto' } })), []);
  assert.deepEqual(fold(sControlResponse('r2', { ok: false, error: 'だめ' })), []);
});
