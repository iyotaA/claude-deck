/**
 * stream-json の行の読み方・書き方のテスト。
 *
 * ここが狂うと、画面に出る「いま何をしているか」が丸ごとずれる。
 * しかも相手は公開仕様ではないので、**知らない形が来ても落ちないこと**が
 * 正しく読めることと同じくらい大事になる。だから未知の type と壊れた行を厚めに見る。
 *
 * 実物の claude.exe は叩かない（環境によって版が変わり、テストの前提にできない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStreamLine, encodeUserLine, sameSessionId } from '../src/parse/stream.mjs';
import { contentBlocks, textOf, toolUses, toolResults } from '../src/parse/entries.mjs';
import { S_ID, sysInit, sAssistant, sUser, sResult, sLines } from './helpers.mjs';

/** オブジェクトを1行にして読ませる。実際の経路（文字列で届く）と同じにする。 */
const read = (line) => classifyStreamLine(JSON.stringify(line));

/*
 * 知っている type
 */

test('init から、起動できたことを確かめる材料が取れる', () => {
  const got = read(sysInit({ model: 'claude-opus-5', permissionMode: 'plan' }));
  assert.equal(got.kind, 'init');
  assert.equal(got.type, 'system');
  assert.equal(got.subtype, 'init');
  assert.equal(got.sessionId, S_ID);
  assert.equal(got.info.model, 'claude-opus-5');
  assert.equal(got.info.permissionMode, 'plan');
  assert.equal(got.info.cwd, 'C:\\work\\demo');
  // ツール名の一覧そのものは要らない。掴めたかどうかが分かればよいので件数だけ
  assert.equal(got.info.tools, 2);
});

test('assistant の発言が読める', () => {
  const got = read(sAssistant('やってみる'));
  assert.equal(got.kind, 'assistant');
  assert.equal(got.sessionId, S_ID);
  assert.ok(got.entry, 'entry がある');
  assert.equal(got.info, null);
});

test('user の行が読める', () => {
  const got = read(sUser({ results: [{ id: 'call-1', text: 'ok' }] }));
  assert.equal(got.kind, 'user');
  assert.ok(got.entry, 'entry がある');
});

test('result から結末が取れる', () => {
  const got = read(sResult({ durationMs: 4200, numTurns: 3, costUSD: 0.12, text: '直しました' }));
  assert.equal(got.kind, 'result');
  assert.equal(got.subtype, 'success');
  assert.equal(got.info.isError, false);
  assert.equal(got.info.durationMs, 4200);
  assert.equal(got.info.numTurns, 3);
  assert.equal(got.info.costUSD, 0.12);
  assert.equal(got.info.text, '直しました');
});

test('result の subtype が success 以外なら失敗として読む', () => {
  // is_error が付いてこない版に備える。subtype しか手がかりが無くても結末は判断できる
  const got = read(sResult({ subtype: 'error_max_turns', text: null }));
  assert.equal(got.info.isError, true);
});

test('is_error があればそちらを優先する', () => {
  // subtype と食い違ったら、明示されているほうを信じる
  const got = read(sResult({ subtype: 'error_during_execution', isError: false }));
  assert.equal(got.info.isError, false);
});

test('result の本文は長ければ切る', () => {
  const got = read(sResult({ text: 'あ'.repeat(3000) }));
  assert.ok(got.info.text.endsWith('…（以下省略）'));
  assert.ok(got.info.text.length < 3000);
});

test('費用が付いてこなければ null。0 と混ぜない', () => {
  const got = read(sResult({ costUSD: null }));
  assert.equal(got.info.costUSD, null);

  const zero = read(sResult({ costUSD: 0 }));
  assert.equal(zero.info.costUSD, 0, '0 は実際に 0 だったの意味なので通す');
});

/*
 * 実測で分かった形（claude 2.1.228）。
 *
 * ここは推測ではなく、叩いて出てきた行を写している。
 * 公開仕様が無いので、この節がその形の唯一の記録になる。
 */

test('result から止まり方の分類が取れる', () => {
  const got = read(sResult({ terminal_reason: 'completed' }));
  assert.equal(got.info.terminalReason, 'completed');
});

test('予算に当たった result から、人が読める理由が取れる', () => {
  // `--max-budget-usd 0.01` で起こしたときに届いた行をそのまま写したもの。
  // 成功時にある `result` と `api_error_status` のキーが**無い**のが要点。
  // だからキーの有無で分岐せず、無いものは null にして進む
  const got = read({
    type: 'result',
    subtype: 'error_max_budget_usd',
    is_error: true,
    session_id: S_ID,
    duration_ms: 7961,
    num_turns: 1,
    total_cost_usd: 0.5710865,
    terminal_reason: 'budget_exhausted',
    errors: ['Reached maximum budget ($0.01)'],
    permission_denials: [],
  });

  assert.equal(got.kind, 'result');
  assert.equal(got.info.isError, true);
  assert.equal(got.info.terminalReason, 'budget_exhausted');
  // これが取れないと、画面に出せるのが error_max_budget_usd という機械の語だけになる
  assert.equal(got.info.errors, 'Reached maximum budget ($0.01)');
  assert.equal(got.info.text, null, '本文が無いことを別の文字で埋めない');
  assert.equal(got.info.costUSD, 0.5710865);
});

test('errors が無ければ null', () => {
  assert.equal(read(sResult()).info.errors, null);
  assert.equal(read(sResult({ errors: [] })).info.errors, null);
  assert.equal(read(sResult({ errors: 'こわれた' })).info.errors, null, '配列でなければ読まない');
  assert.equal(read(sResult({ errors: [null, '   '] })).info.errors, null, '中身が空なら null');
});

test('errors が複数あれば1本に畳む', () => {
  // 複数入る形は見ていない。配列のまま持たせると、呼ぶ側が並べ方を決めることになる
  const got = read(sResult({ errors: ['ひとつめ', 'ふたつめ'] }));
  assert.equal(got.info.errors, 'ひとつめ / ふたつめ');
});

test('errors が長ければ切る', () => {
  const got = read(sResult({ errors: ['あ'.repeat(3000)] }));
  assert.ok(got.info.errors.endsWith('…（以下省略）'));
  assert.ok(got.info.errors.length < 3000);
});

test('許可を断った件数は、0 と不明を分ける', () => {
  assert.equal(read(sResult({ permission_denials: [] })).info.denials, 0, '空配列は「0件だった」');
  assert.equal(read(sResult()).info.denials, null, 'キーが無ければ不明');
  // 中の形は空配列しか見ていないので仮定しない。件数だけ数える
  assert.equal(read(sResult({ permission_denials: [{ tool: 'Write' }] })).info.denials, 1);
});

test('自分が送った行には isReplay が立つ', () => {
  // --replay-user-messages の戻り。
  // これが無いと、ツール結果の行と同じ user 型で並んで区別できない
  const mine = read(sUser({ text: '直して', isReplay: true }));
  assert.equal(mine.kind, 'user');
  assert.equal(mine.isReplay, true);

  const fromTool = read(sUser({ results: [{ id: 'call-1', text: 'ok' }] }));
  assert.equal(fromTool.isReplay, false, 'ツール結果には付かない');
});

test('isReplay は印が無ければ false。null に倒さない', () => {
  // 向こうが明示的に付ける側なので、印が無い＝自分の行ではない、と読んでよい。
  // ここを null にすると呼ぶ側が3通りを扱うことになり、得るものが無い
  assert.equal(read(sAssistant('やってみる')).isReplay, false);
  assert.equal(classifyStreamLine('こわれてる').isReplay, false);
});

/*
 * 知らない形（ここが落ちると画面が丸ごと止まる）
 */

test('system でも init でなければ other。subtype は残す', () => {
  const got = read({ type: 'system', subtype: 'compact_boundary', session_id: S_ID });
  assert.equal(got.kind, 'other');
  assert.equal(got.type, 'system');
  assert.equal(got.subtype, 'compact_boundary');
  assert.equal(got.info, null);
});

test('知らない type は other にするが、生の type は捨てない', () => {
  // 許可を求めてくる行。v1 では扱わないが、扱う気になったときに読み直せるようにしておく
  const got = read({ type: 'control_request', request_id: 'r1', session_id: S_ID });
  assert.equal(got.kind, 'other');
  assert.equal(got.type, 'control_request');
  assert.equal(got.sessionId, S_ID);
});

test('type が無くても落ちない', () => {
  const got = read({ session_id: S_ID });
  assert.equal(got.kind, 'other');
  assert.equal(got.type, null);
});

test('JSON として読めない行は broken。見本を残す', () => {
  const got = classifyStreamLine('{"type":"assistant"');
  assert.equal(got.kind, 'broken');
  assert.equal(got.type, null);
  assert.equal(got.sample, '{"type":"assistant"');
});

test('broken の見本は長ければ切る', () => {
  // 4MB の壊れた行をそのまま持つと、台帳に残り続ける
  const got = classifyStreamLine(`{"x":"${'あ'.repeat(5000)}`);
  assert.ok(got.sample.length < 300);
  assert.ok(got.sample.endsWith('…（以下省略）'));
});

test('空行は broken。呼ぶ側で落としてから渡す前提', () => {
  for (const v of ['', '   ', '\n']) {
    const got = classifyStreamLine(v);
    assert.equal(got.kind, 'broken');
    assert.equal(got.sample, null);
  }
});

test('文字列以外を渡されても落ちない', () => {
  for (const v of [null, undefined, 42, {}]) {
    assert.equal(classifyStreamLine(v).kind, 'broken');
  }
});

test('JSON ではあるがオブジェクトでないものは broken', () => {
  // 配列やリテラルが1行で来ることは想定していないが、来たときに type を読もうとして落ちない
  assert.equal(classifyStreamLine('[1,2,3]').kind, 'broken');
  assert.equal(classifyStreamLine('"ok"').kind, 'broken');
  assert.equal(classifyStreamLine('null').kind, 'broken');
});

/*
 * セッション ID とサブエージェント
 */

test('session_id が無ければ null', () => {
  const got = read({ type: 'assistant', message: { role: 'assistant', content: [] } });
  assert.equal(got.sessionId, null);
});

test('camelCase の sessionId も読む', () => {
  // stream-json は snake_case。会話ログ由来の行を間違えて渡されても読めるようにしておく
  const got = read({ type: 'assistant', sessionId: 'from-log', message: { role: 'assistant', content: [] } });
  assert.equal(got.sessionId, 'from-log');
});

test('サブエージェントの出力には parentToolUseId が付く', () => {
  const child = read(sAssistant('調べてます', { parentToolUseId: 'task-1' }));
  assert.equal(child.parentToolUseId, 'task-1');

  const main = read(sAssistant('やってみる'));
  assert.equal(main.parentToolUseId, null, '本流には付かない');
});

/*
 * entries.mjs の道具がそのまま効くこと。
 *
 * ここが成り立たないなら、stream 用に解釈を書き直すことになる。
 * そうすると同じ内容が一覧・詳細・実行パネルで違って見える。
 */

test('assistant の entry に entries.mjs の道具がそのまま効く', () => {
  const got = read(sAssistant('読みます', {
    uses: [{ id: 'call-1', name: 'Read', input: { file_path: 'a.mjs' } }],
  }));

  assert.equal(textOf(got.entry), '読みます');
  assert.equal(contentBlocks(got.entry).length, 2);

  const uses = toolUses(got.entry);
  assert.equal(uses.length, 1);
  assert.equal(uses[0].name, 'Read');
  assert.equal(uses[0].id, 'call-1');
  assert.equal(uses[0].input.file_path, 'a.mjs');
});

test('user の entry からツール結果が取れる', () => {
  const got = read(sUser({
    results: [{ id: 'call-1', text: '中身', isError: true }],
  }));

  const results = toolResults(got.entry);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'call-1');
  assert.equal(results[0].text, '中身');
  assert.equal(results[0].isError, true);
});

test('entry を持つのは assistant と user だけ', () => {
  // init や result に entry を持たせると、呼ぶ側が中身を当てにして書ける形になってしまう。
  // あちらは message.content を持たないので、当てにさせない
  assert.equal(read(sysInit()).entry, null);
  assert.equal(read(sResult()).entry, null);
  assert.equal(read({ type: 'control_request' }).entry, null);
});

/*
 * こちらから送る行
 */

test('送る行は1行で、末尾に改行が付く', () => {
  const line = encodeUserLine('直して');
  assert.ok(line.endsWith('\n'));
  assert.equal(line.trimEnd().includes('\n'), false, '本体に改行が混ざらない');
});

test('改行を含む指示でも1行に収まる', () => {
  // 複数行の指示はふつうに来る。ここで割れると相手が行を確定できず、ただ待つ
  const line = encodeUserLine('1行目\n2行目\r\n3行目');
  assert.equal(line.split('\n').length, 2, '本体1行 ＋ 末尾の改行だけ');

  const back = classifyStreamLine(line);
  assert.equal(textOf(back.entry), '1行目\n2行目\r\n3行目');
});

test('送った行は、自分で読み直しても user として読める', () => {
  // --replay-user-messages で返ってくるのはこの形。読めることを往復で確かめる
  const back = classifyStreamLine(encodeUserLine('直して'));
  assert.equal(back.kind, 'user');
  assert.equal(textOf(back.entry), '直して');
});

test('content は常に配列で書く', () => {
  // 文字列でも通るかもしれないが、受け取り側の解釈の幅に賭けない
  const sent = JSON.parse(encodeUserLine('直して'));
  assert.ok(Array.isArray(sent.message.content));
  assert.equal(sent.message.content[0].type, 'text');
  assert.equal(sent.type, 'user');
  assert.equal(sent.message.role, 'user');
});

test('空の本文は投げる', () => {
  // 外から来た値は窓口で弾く。ここまで来たら組み立て側の間違いなので、黙って空行を送らない
  for (const v of ['', '   ', null, undefined, 42]) {
    assert.throws(() => encodeUserLine(v), TypeError);
  }
});

/*
 * セッション ID の突き合わせ
 */

test('大小が違っても同じセッションと見る', () => {
  // UUID の英字の大小は表記揺れで、別物を指す差ではない。
  // 厳密に比べると、表記が変わっただけで「別のセッションです」と嘘の理由を出すことになる
  assert.equal(sameSessionId('AB-12', 'ab-12'), true);
});

test('どちらかが無ければ一致とは見ない', () => {
  // 不明を一致と読み替えない。読み替えると、確かめられていないのに確かめた顔になる
  assert.equal(sameSessionId(null, 'ab'), false);
  assert.equal(sameSessionId('ab', null), false);
  assert.equal(sameSessionId('', ''), false);
  assert.equal(sameSessionId('ab', 'cd'), false);
});

/*
 * 並びとして読む
 */

test('1往復ぶんの並びを順に読める', () => {
  const text = sLines([
    sysInit(),
    sAssistant('読みます', { uses: [{ id: 'call-1', name: 'Read', input: {} }] }),
    sUser({ results: [{ id: 'call-1', text: 'ok' }] }),
    sAssistant('直しました'),
    sResult(),
  ]);

  const kinds = text.split('\n')
    .filter((l) => l.trim())
    .map((l) => classifyStreamLine(l).kind);

  assert.deepEqual(kinds, ['init', 'assistant', 'user', 'assistant', 'result']);
});
