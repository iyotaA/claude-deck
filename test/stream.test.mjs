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
import {
  classifyStreamLine,
  encodeControlError,
  encodeControlRequest,
  encodePermissionResponse,
  encodeUserLine,
  sameSessionId,
} from '../src/parse/stream.mjs';
import { contentBlocks, textOf, toolUses, toolResults } from '../src/parse/entries.mjs';
import {
  S_ID, sysInit, sAssistant, sUser, sResult, sLines, sPermission, sQuestion, sControlResponse,
} from './helpers.mjs';

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

test('init が名乗った機能をそのまま持つ', () => {
  const caps = ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1'];
  const got = read(sysInit({ capabilities: caps }));
  assert.deepEqual(got.info.capabilities, caps);
});

test('名乗りが無ければ null。空配列に丸めない', () => {
  // 「名乗らない版」と「何も持たない版」を混ぜると、
  // 前者で使えるはずの割り込みを永久に断ることになる
  const got = read(sysInit());
  assert.equal(got.info.capabilities, null);
});

test('名乗りに文字列でないものが混ざっていても落とすだけ', () => {
  const got = read(sysInit({ capabilities: ['interrupt_receipt_v1', 42, null, ''] }));
  assert.deepEqual(got.info.capabilities, ['interrupt_receipt_v1']);
});

test('スラッシュコマンドは2つの一覧をそのまま持つ。**ここでは引かない**', () => {
  // 引き算（どれが使えるか）は判断なので台帳の仕事。この層は行を読むだけ
  const got = read(sysInit({
    slash_commands: ['compact', 'context', 'doctor'],
    terminal_slash_commands: ['doctor', 'color'],
  }));
  assert.deepEqual(got.info.slashCommands, ['compact', 'context', 'doctor']);
  assert.deepEqual(got.info.terminalSlashCommands, ['doctor', 'color']);
});

test('スラッシュコマンドが無ければ null。空配列に丸めない', () => {
  // 空配列にすると「1つも使えない」と読めてしまう。「名乗らない」とは別のこと
  const got = read(sysInit());
  assert.equal(got.info.slashCommands, null);
  assert.equal(got.info.terminalSlashCommands, null);
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
  // **実在の type を例に使わない。** 拾う気になった日にこのテストが落ちる。
  // ここには `control_request` が居て許可の道になった日に落ち、
  // 次に置いた `rate_limit_event` も段4で拾った日に落ちた。二度あったので架空の名前にする
  const got = read({ type: 'not_a_real_type', session_id: S_ID });
  assert.equal(got.kind, 'other');
  assert.equal(got.type, 'not_a_real_type');
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

/*
 * 許可を求められる（control_request）と、答える（control_response）
 */

test('can_use_tool は permission として読む', () => {
  const got = read(sPermission({
    requestId: 'p9', toolName: 'Bash', input: { command: 'npm test' }, toolUseId: 'toolu_7',
  }));
  assert.equal(got.kind, 'permission');
  assert.equal(got.type, 'control_request');
  assert.equal(got.subtype, 'can_use_tool');
  assert.equal(got.sessionId, S_ID);
  assert.equal(got.info.requestId, 'p9');
  assert.equal(got.info.toolName, 'Bash');
  assert.equal(got.info.toolUseId, 'toolu_7');
  assert.deepEqual(got.info.input, { command: 'npm test' });
  assert.deepEqual(got.info.suggestions, []);
});

test('input は切らずに渡す（updatedInput を組むのに原文が要る）', () => {
  // 切るのはここから先（run/event.mjs）。この層で切ると、選択肢に答えられなくなる
  const long = 'x'.repeat(50_000);
  const got = read(sPermission({ toolName: 'Write', input: { file_path: 'a.txt', content: long } }));
  assert.equal(got.info.input.content.length, 50_000);
});

test('選択肢で聞かれたぶんも同じ道を通る', () => {
  const got = read(sQuestion([{ question: 'どっち？', options: [{ label: 'あ' }, { label: 'い' }] }]));
  assert.equal(got.kind, 'permission');
  assert.equal(got.info.toolName, 'AskUserQuestion');
  assert.equal(got.info.input.questions[0].options.length, 2);
});

test('permission_suggestions はそのまま持つ', () => {
  // 実測で入っていたのは destination:'session'。撃っても ~/.claude には触らない
  const s = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
  const got = read(sPermission({ suggestions: s }));
  assert.deepEqual(got.info.suggestions, s);
});

test('知らない subtype の control_request でも request_id は必ず取る', () => {
  // **ここが一番大事。** 答えないとその子は永久に待つので、
  // 「読めなかったから捨てる」を許さない
  const got = read({ type: 'control_request', request_id: 'z9', request: { subtype: 'なにこれ' } });
  assert.equal(got.kind, 'control');
  assert.equal(got.subtype, 'なにこれ');
  assert.equal(got.info.requestId, 'z9');
});

test('request_id が読めない control_request は other へ落とす', () => {
  // 答えようが無いので、答える道に載せない
  const got = read({ type: 'control_request', request: { subtype: 'can_use_tool', tool_name: 'Bash' } });
  assert.equal(got.kind, 'other');
  assert.equal(got.type, 'control_request');
});

test('control_response は control-result。request_id は response の中にある', () => {
  const got = read(sControlResponse('req_1', { response: { mode: 'acceptEdits' } }));
  assert.equal(got.kind, 'control-result');
  assert.equal(got.info.requestId, 'req_1');
  assert.equal(got.info.ok, true);
  assert.deepEqual(got.info.response, { mode: 'acceptEdits' });
});

test('断られた control_response は ok が偽で理由が残る', () => {
  const got = read(sControlResponse('req_2', { ok: false, error: '知らないモードです' }));
  assert.equal(got.kind, 'control-result');
  assert.equal(got.info.ok, false);
  assert.equal(got.info.error, '知らないモードです');
});

test('allow は替えるときだけ updatedInput を載せる', () => {
  const bare = JSON.parse(encodePermissionResponse('p1', { behavior: 'allow' }));
  assert.equal(bare.type, 'control_response');
  assert.equal(bare.response.subtype, 'success');
  assert.equal(bare.response.request_id, 'p1');
  assert.deepEqual(bare.response.response, { behavior: 'allow' });

  const withInput = JSON.parse(encodePermissionResponse('p1', {
    behavior: 'allow', updatedInput: { answers: ['あ'] },
  }));
  assert.deepEqual(withInput.response.response.updatedInput, { answers: ['あ'] });
});

test('deny のときは updatedInput も updatedPermissions も落とす', () => {
  // 混ざった形は向こうの検証がどう転ぶか分からず、こちらのバグが「たまに通る」形で残る
  const line = JSON.parse(encodePermissionResponse('p1', {
    behavior: 'deny',
    message: 'いまは要らない',
    updatedInput: { command: 'rm -rf /' },
    updatedPermissions: [{ type: 'setMode' }],
  }));
  assert.deepEqual(line.response.response, { behavior: 'deny', message: 'いまは要らない' });
});

test('deny の理由は空でもよい（止めたいときに文章を考えさせない）', () => {
  const line = JSON.parse(encodePermissionResponse('p1', { behavior: 'deny', message: '  ' }));
  assert.equal(typeof line.response.response.message, 'string');
  assert.ok(line.response.response.message.length > 0);
});

test('答えの行は末尾に改行が付く', () => {
  assert.ok(encodePermissionResponse('p1', { behavior: 'allow' }).endsWith('\n'));
  assert.ok(encodeControlError('p1').endsWith('\n'));
  assert.ok(encodeControlRequest('r1', 'interrupt').endsWith('\n'));
});

test('扱えない要求は subtype:error で断る', () => {
  const line = JSON.parse(encodeControlError('z9', 'この画面では なにこれ を扱えません'));
  assert.equal(line.response.subtype, 'error');
  assert.equal(line.response.request_id, 'z9');
  assert.equal(line.response.error, 'この画面では なにこれ を扱えません');
});

test('こちらから撃つ要求は params に subtype を上書きされない', () => {
  const line = JSON.parse(encodeControlRequest('r1', 'set_permission_mode', {
    mode: 'auto', subtype: 'end_session',
  }));
  assert.equal(line.type, 'control_request');
  assert.equal(line.request_id, 'r1');
  assert.equal(line.request.subtype, 'set_permission_mode');
  assert.equal(line.request.mode, 'auto');
});

test('壊れた引数では組まずに投げる', () => {
  assert.throws(() => encodePermissionResponse('', { behavior: 'allow' }), TypeError);
  assert.throws(() => encodePermissionResponse('p1', null), TypeError);
  assert.throws(() => encodePermissionResponse('p1', { behavior: 'maybe' }), TypeError);
  assert.throws(() => encodeControlError(null), TypeError);
  assert.throws(() => encodeControlRequest('r1', ''), TypeError);
  assert.throws(() => encodeControlRequest('', 'interrupt'), TypeError);
});

/*
 * 数えて畳む行（thinking / rate_limit / hook）と、実行されなかった印
 *
 * どれも段4より前は `other` に落ちていた。落ちていること自体は害が無かったが、
 * 1往復で8件流れる `thinking_tokens` が「その他」として並び、本文を押し流していた。
 */

test('thinking_tokens は累計と刻みを持つ', () => {
  const got = read({
    type: 'system', subtype: 'thinking_tokens', session_id: S_ID,
    estimated_tokens: 700, estimated_tokens_delta: 50,
  });
  assert.equal(got.kind, 'thinking');
  assert.deepEqual(got.info, { tokens: 700, delta: 50 });
});

test('考えた量が読めなければ null。0 に丸めない', () => {
  const got = read({ type: 'system', subtype: 'thinking_tokens', session_id: S_ID });
  assert.deepEqual(got.info, { tokens: null, delta: null });
});

test('rate_limit_event は 0〜1 の割合をそのまま持つ', () => {
  // 百分率に直すのは画面の仕事。ここで掛けると、掛ける場所が2つになる
  const got = read({
    type: 'rate_limit_event', session_id: S_ID,
    rate_limit_info: {
      status: 'allowed', resetsAt: 1787667000,
      unifiedWindows: {
        five_hour: { utilization: 0.06, resetsAt: 1787667000 },
        seven_day: { utilization: 0.69, resetsAt: 1787763600 },
      },
    },
  });
  assert.equal(got.kind, 'rate-limit');
  assert.deepEqual(got.info, {
    status: 'allowed', fiveHour: 0.06, sevenDay: 0.69, resetsAt: 1787667000,
  });
});

test('5時間枠が無ければ7日枠の時刻に倒す', () => {
  const got = read({
    type: 'rate_limit_event', session_id: S_ID,
    rate_limit_info: { unifiedWindows: { seven_day: { utilization: 0.69, resetsAt: 1787763600 } } },
  });
  assert.equal(got.info.fiveHour, null);
  assert.equal(got.info.resetsAt, 1787763600);
});

test('枠の形が変わっても落ちない', () => {
  const got = read({ type: 'rate_limit_event', session_id: S_ID, rate_limit_info: 'まだ大丈夫' });
  assert.equal(got.kind, 'rate-limit');
  assert.deepEqual(got.info, { status: null, fiveHour: null, sevenDay: null, resetsAt: null });
});

test('hook は3段階とも hook。どの段階かは subtype に残る', () => {
  for (const sub of ['hook_started', 'hook_progress', 'hook_response']) {
    const got = read({ type: 'system', subtype: sub, session_id: S_ID, hook_name: 'format' });
    assert.equal(got.kind, 'hook', sub);
    assert.equal(got.subtype, sub);
    assert.equal(got.info.name, 'format');
  }
});

test('フックの出力は持たない。標準エラーだけ持つ', () => {
  // 実測で `output` と `stdout` に同じ 1484 文字が二重に入っていた。
  // 人が読むのは失敗したときの stderr だけなので、本文は捨てる
  const got = read({
    type: 'system', subtype: 'hook_response', session_id: S_ID,
    hook_name: 'format', hook_event: 'PostToolUse', outcome: 'success', exit_code: 0,
    output: 'x'.repeat(1484), stdout: 'x'.repeat(1484), stderr: '警告',
  });
  assert.equal(got.info.stderr, '警告');
  assert.equal(got.info.output, undefined);
  assert.equal(got.info.stdout, undefined);
});

test('user の tool_result_meta から「実行されなかった」印を取る', () => {
  // 断ったときのツール結果は、普通のエラーとまったく同じ顔で返ってくる（実測）。
  // 区別できるのはこの印だけ
  const got = read(sUser({
    results: [{ id: 't1', text: 'Error: だめ', isError: true }],
    tool_result_meta: [{ id: 't1', non_execution_kind: 'permission-rule' }],
  }));
  assert.equal(got.kind, 'user');
  assert.deepEqual(got.info.nonExecution, [{ id: 't1', kind: 'permission-rule' }]);
});

test('印は id と種類が揃ったものだけ拾う', () => {
  const got = read(sUser({
    results: [{ id: 't1' }],
    tool_result_meta: [
      { id: 't1' },
      { non_execution_kind: 'permission-rule' },
      null,
      { tool_use_id: 't2', nonExecutionKind: 'permission-rule' },
    ],
  }));
  assert.deepEqual(got.info.nonExecution, [{ id: 't2', kind: 'permission-rule' }]);
});

test('印が無い user 行でも形は変わらない', () => {
  // 画面側が `?.` を書き忘れても落ちないよう、いつも配列で持つ
  assert.deepEqual(read(sUser({ results: [{ id: 't1' }] })).info.nonExecution, []);
  assert.deepEqual(read(sUser({ text: 'これ', tool_result_meta: 'こわれ' })).info.nonExecution, []);
});
