/**
 * 起動指定の検証と argv 組み立てのテスト。
 *
 * ここは**このアプリで唯一「コードが実行される」経路の入口**なので、
 * 通す条件より**弾く条件**を厚く見る。
 * 通し漏れは画面で気づけるが、弾き漏れは踏むまで気づけない。
 *
 * 実物の claude.exe は叩かない（版で挙動が変わり、テストの前提にできない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PERMISSION_MODES, BYPASS_MODE, DEFAULT_PERMISSION_MODE, PERMISSION_MODE_LABELS,
  EFFORTS, DEFAULT_BUDGET_USD, BUDGET_MIN_USD, BUDGET_MAX_USD, PROMPT_MAX,
  allowedModes, isSessionId, newSessionId, runDirsFromEnv, resolveCwd, buildRunSpec,
  mergeSwitch,
} from '../src/run/spec.mjs';

/** テストで使う固定の ID。実物と同じ形にしておく（isSessionId を通ること自体が確認になる）。 */
const ID = '11111111-2222-4333-8444-555555555555';

/** 許可するフォルダ。win32 前提で組む。 */
const DIRS = ['C:\\work\\demo', 'D:\\src'];

/** 既定の文脈。テストごとに要るところだけ上書きする。 */
const CTX = { allowedDirs: DIRS, env: {}, platform: 'win32', newId: () => ID };

/** 最低限そろっていれば通る入力。 */
const OK = { cwd: 'C:\\work\\demo', prompt: '直して' };

/** 通ることを前提に spec だけ取り出す。 */
function spec(input, ctx = {}) {
  const got = buildRunSpec({ ...OK, ...input }, { ...CTX, ...ctx });
  assert.equal(got.ok, true, `通るはず: ${got.reason ?? ''}`);
  return got.spec;
}

/** 弾かれることを前提に理由だけ取り出す。 */
function reject(input, ctx = {}) {
  const got = buildRunSpec({ ...OK, ...input }, { ...CTX, ...ctx });
  assert.equal(got.ok, false, '弾かれるはず');
  assert.ok(got.reason, '理由が付いている');
  return got.reason;
}

/*
 * 語彙
 */

test('既定では bypass が選択肢に入らない', () => {
  assert.deepEqual(allowedModes({}), ['plan', 'acceptEdits', 'auto']);
  assert.equal(allowedModes({}).includes(BYPASS_MODE), false);
});

test('環境変数が立っているときだけ bypass が入る', () => {
  assert.equal(allowedModes({ CLAUDE_DECK_RUN_ALLOW_BYPASS: '1' }).includes(BYPASS_MODE), true);
});

test('0 や false では bypass は出ない', () => {
  // 「止めたつもり」の書き方で開いてしまうのがいちばん危ない
  for (const v of ['0', 'false', 'no', '', '  ']) {
    assert.equal(
      allowedModes({ CLAUDE_DECK_RUN_ALLOW_BYPASS: v }).includes(BYPASS_MODE), false, `値: ${v}`,
    );
  }
});

test('manual は語彙に入っていない', () => {
  // 非対話で許可要求が来たときの返し方が未確認。答えられないまま固まる形を作らない
  assert.equal(PERMISSION_MODES.includes('manual'), false);
  assert.equal(allowedModes({ CLAUDE_DECK_RUN_ALLOW_BYPASS: '1' }).includes('manual'), false);
});

test('既定は plan（読むだけ）', () => {
  assert.equal(DEFAULT_PERMISSION_MODE, 'plan');
  assert.equal(spec({}).permissionMode, 'plan');
});

test('語彙の全部に日本語のラベルがある', () => {
  // 画面側に日本語を持たせない方針なので、足し忘れると画面に生の英語が出る
  for (const m of [...PERMISSION_MODES, BYPASS_MODE]) {
    assert.ok(PERMISSION_MODE_LABELS[m], `ラベルがある: ${m}`);
  }
});

test('bypass は env 無しだと弾かれ、理由が分かれている', () => {
  const reason = reject({ permissionMode: BYPASS_MODE });
  assert.match(reason, /環境変数/, '語彙に無いのではなく、この環境で出していないと分かる');

  // 立てれば通る
  assert.equal(
    spec({ permissionMode: BYPASS_MODE }, { env: { CLAUDE_DECK_RUN_ALLOW_BYPASS: '1' } })
      .permissionMode,
    BYPASS_MODE,
  );
});

test('知らない権限モードは弾く', () => {
  for (const m of ['manual', 'dontAsk', 'yolo', 'PLAN']) {
    reject({ permissionMode: m });
  }
});

/*
 * cwd（ここが一番の関所）
 */

test('許可したフォルダそのものは通る', () => {
  const got = resolveCwd('C:\\work\\demo', { allowedDirs: DIRS, platform: 'win32' });
  assert.equal(got.ok, true);
  assert.equal(got.cwd, 'C:\\work\\demo');
});

test('許可したフォルダの配下は通る', () => {
  const got = resolveCwd('C:\\work\\demo\\src\\deep', { allowedDirs: DIRS, platform: 'win32' });
  assert.equal(got.ok, true);
});

test('win32 では大小を無視する', () => {
  // ドライブレターも含めて、表記が違うだけで別物にしない
  const got = resolveCwd('c:\\WORK\\Demo\\src', { allowedDirs: DIRS, platform: 'win32' });
  assert.equal(got.ok, true);
  assert.equal(got.cwd, 'c:\\WORK\\Demo\\src', '返すのは元の表記のまま');
});

test('末尾の区切りが付いていても通る', () => {
  for (const v of ['C:\\work\\demo\\', 'C:\\work\\demo\\\\']) {
    assert.equal(resolveCwd(v, { allowedDirs: DIRS, platform: 'win32' }).ok, true, `値: ${v}`);
  }
});

test('.. で外へ出ようとしたら弾く', () => {
  const got = resolveCwd('C:\\work\\demo\\..\\..\\Windows', { allowedDirs: DIRS, platform: 'win32' });
  assert.equal(got.ok, false);
});

test('.. が付いていても中に留まるなら通る', () => {
  // 畳んだ結果で判断する。文字列に .. があること自体は罪ではない
  const got = resolveCwd('C:\\work\\demo\\src\\..\\lib', { allowedDirs: DIRS, platform: 'win32' });
  assert.equal(got.ok, true);
  assert.equal(got.cwd, 'C:\\work\\demo\\lib');
});

test('前方一致では通さない', () => {
  // startsWith だと C:\work\demo2 が C:\work\demo の中に見える。だから path.relative で見る
  assert.equal(resolveCwd('C:\\work\\demo2', { allowedDirs: DIRS, platform: 'win32' }).ok, false);
  assert.equal(resolveCwd('C:\\work\\demoX\\a', { allowedDirs: DIRS, platform: 'win32' }).ok, false);
});

test('別のドライブは通さない', () => {
  assert.equal(resolveCwd('E:\\work\\demo', { allowedDirs: DIRS, platform: 'win32' }).ok, false);
});

test('許可リストの外は通さない', () => {
  assert.equal(resolveCwd('C:\\Windows\\System32', { allowedDirs: DIRS, platform: 'win32' }).ok, false);
});

test('許可リストが空なら何も通さない', () => {
  // 一覧がまだ空で、環境変数も無いとき。ここが通ると任意のフォルダで起こせる
  assert.equal(resolveCwd('C:\\work\\demo', { allowedDirs: [], platform: 'win32' }).ok, false);
});

test('相対パスは弾く', () => {
  // どこから見た相対かが起動のされ方で変わる。判定を揺らす材料を受けない
  for (const v of ['work\\demo', '.\\demo', '..']) {
    assert.equal(resolveCwd(v, { allowedDirs: DIRS, platform: 'win32' }).ok, false, `値: ${v}`);
  }
});

test('空や文字列でないものは弾く', () => {
  for (const v of ['', '   ', null, undefined, 42, {}]) {
    assert.equal(resolveCwd(v, { allowedDirs: DIRS, platform: 'win32' }).ok, false);
  }
});

test('許可リスト側の相対パスは無視する', () => {
  // 環境変数に相対パスを書かれても、そこを起点にしない
  const got = resolveCwd('C:\\work\\demo', { allowedDirs: ['work', ''], platform: 'win32' });
  assert.equal(got.ok, false);
});

test('posix では大小を区別する', () => {
  const dirs = ['/home/me/work'];
  assert.equal(resolveCwd('/home/me/work/src', { allowedDirs: dirs, platform: 'linux' }).ok, true);
  assert.equal(resolveCwd('/home/me/WORK/src', { allowedDirs: dirs, platform: 'linux' }).ok, false);
});

test('どのフォルダなら通るかは理由に書かない', () => {
  const reason = resolveCwd('C:\\Windows', { allowedDirs: DIRS, platform: 'win32' }).reason;
  assert.equal(reason.includes('work'), false);
  assert.equal(reason.includes('D:'), false);
});

/*
 * 環境変数からの追加
 */

test('CLAUDE_DECK_RUN_DIRS は ; で割る', () => {
  const got = runDirsFromEnv({ CLAUDE_DECK_RUN_DIRS: 'C:\\a;C:\\b' }, 'win32');
  assert.deepEqual(got, ['C:\\a', 'C:\\b']);
});

test('絶対パスでないものは黙って落とす', () => {
  const got = runDirsFromEnv({ CLAUDE_DECK_RUN_DIRS: 'C:\\a; ;rel\\path;C:\\b' }, 'win32');
  assert.deepEqual(got, ['C:\\a', 'C:\\b']);
});

test('未設定なら空', () => {
  assert.deepEqual(runDirsFromEnv({}, 'win32'), []);
  assert.deepEqual(runDirsFromEnv({ CLAUDE_DECK_RUN_DIRS: '' }, 'win32'), []);
});

/*
 * argv 注入（配列で渡していても commander は - で始まる値をフラグとして読む）
 */

test('- で始まるモデル名は弾く', () => {
  reject({ model: '--dangerously-skip-permissions' });
  reject({ model: '-x' });
});

test('- で始まる effort は弾く', () => {
  reject({ effort: '--verbose' });
});

test('- で始まる cwd は弾く', () => {
  reject({ cwd: '--add-dir' });
});

test('モデルは許可リストではなく形で見る', () => {
  // 新しいモデルが出るたびに古くなる許可リストは持たない
  for (const m of ['opus', 'claude-opus-5', 'claude-haiku-4-5-20251001', 'claude-opus-5[1m]']) {
    const got = buildRunSpec({ ...OK, model: m }, CTX);
    // 角括弧だけは形から外れる。通らないことを明示しておく（通す気になったらここが落ちる）
    if (m.includes('[')) assert.equal(got.ok, false, `記号は通さない: ${m}`);
    else assert.equal(got.ok, true, `通る: ${m}`);
  }
});

test('空白や記号が混ざったモデル名は弾く', () => {
  for (const m of ['opus 5', 'opus;rm', 'opus/../x', 'あ']) {
    reject({ model: m });
  }
});

test('長すぎるモデル名は弾く', () => {
  reject({ model: 'a'.repeat(65) });
});

test('モデルを指定しなければ null。argv にも出ない', () => {
  const s = spec({});
  assert.equal(s.model, null);
  assert.equal(s.args.includes('--model'), false);
});

test('effort は語彙で見る', () => {
  for (const e of EFFORTS) assert.equal(spec({ effort: e }).effort, e);
  reject({ effort: 'HIGH' });
  reject({ effort: 'ultra' });
});

/*
 * 指示文
 */

test('指示が空なら弾く', () => {
  for (const v of ['', '   ', '\n', null, undefined, 42]) {
    // 空 stdin で起こすと system/init すら出ずに終わる（実測）。起こす意味が無い
    reject({ prompt: v });
  }
});

test('指示の前後の空白は落とす', () => {
  assert.equal(spec({ prompt: '  直して  ' }).prompt, '直して');
});

test('長すぎる指示は弾く', () => {
  reject({ prompt: 'あ'.repeat(PROMPT_MAX + 1) });
  assert.equal(spec({ prompt: 'あ'.repeat(PROMPT_MAX) }).prompt.length, PROMPT_MAX);
});

test('指示は argv に載らない', () => {
  // stdin へ JSON で書く。コマンドラインに載せると、履歴とプロセス一覧に業務内容が出る
  const s = spec({ prompt: 'これは秘密の指示' });
  assert.equal(s.args.join(' ').includes('秘密'), false);
});

/*
 * 予算
 */

test('指定が無ければ上限なし。既定値へ丸めない', () => {
  // 画面の欄を空にしたときがこれ。DEFAULT_BUDGET_USD は「欄に最初から入る値」であって
  // 「省いたときの値」ではない（0 と不明を分ける）。
  // 丸めていたころ、上限を外したつもりが $5 で止まる形になっていた
  for (const v of [undefined, null, '', '   ']) {
    assert.equal(spec({ budgetUsd: v }).budgetUsd, null, `値: ${JSON.stringify(v)}`);
  }
  assert.equal(spec({}).budgetUsd, null, 'キーごと無い');
});

test('上限なしなら argv に --max-budget-usd を付けない', () => {
  // 付けると CLI 側で上限が効く。「上限なし」を値で表す手が無いので、フラグごと落とす
  assert.equal(spec({}).args.includes('--max-budget-usd'), false);
});

test('欄に入る既定値は範囲の中にある', () => {
  // 画面は options の default をそのまま value に入れるので、範囲の外だと
  // 押した瞬間に丸められて「入れた額と違う額で走る」ことになる
  assert.ok(DEFAULT_BUDGET_USD >= BUDGET_MIN_USD, `既定 ${DEFAULT_BUDGET_USD} が下限未満`);
  assert.ok(DEFAULT_BUDGET_USD <= BUDGET_MAX_USD, `既定 ${DEFAULT_BUDGET_USD} が上限超え`);
});

test('範囲の外は丸める。400 では断らない', () => {
  assert.equal(spec({ budgetUsd: 999 }).budgetUsd, BUDGET_MAX_USD);
  assert.equal(spec({ budgetUsd: 0.001 }).budgetUsd, BUDGET_MIN_USD);
});

test('0 や負や数として読めない値は断る', () => {
  // 黙って上限なしに倒すと、打ち間違いが「歯止め無しで走る」に化ける。
  // 丸めてよいのは範囲外の数値までで、数として読めないものは別の扱いにする
  for (const v of [0, -3, 'あ', NaN, Infinity, {}, []]) {
    assert.equal(reject({ budgetUsd: v }), '予算の指定が不正です', `値: ${String(v)}`);
  }
});

test('文字列でも数として読む', () => {
  assert.equal(spec({ budgetUsd: '2.5' }).budgetUsd, 2.5);
});

test('小数は2桁に丸める', () => {
  // 浮動小数のごみを CLI へ渡さない
  assert.equal(spec({ budgetUsd: 1.239 }).budgetUsd, 1.24);
});

/*
 * セッション ID
 */

test('新規のときは画面から来た ID を使わない', () => {
  // 受け取ると、既存のセッションを指定して他人の会話ログへ追記させられる
  const s = spec({ sessionId: '99999999-9999-4999-8999-999999999999' });
  assert.equal(s.sessionId, ID, 'こちらで作った ID になる');
  assert.equal(s.resume, false);
});

test('新規は --session-id で渡す', () => {
  const s = spec({});
  assert.equal(s.args.includes('--session-id'), true);
  assert.equal(s.args.includes('--resume'), false);
});

test('続きのときだけ画面から来た ID を使う', () => {
  const s = spec({ resume: true, sessionId: ID });
  assert.equal(s.sessionId, ID);
  assert.equal(s.args.includes('--resume'), true);
  assert.equal(s.args.includes('--session-id'), false);
});

test('続きなのに ID が無い・形が違うなら弾く', () => {
  reject({ resume: true });
  reject({ resume: true, sessionId: 'not-a-uuid' });
  reject({ resume: true, sessionId: '11111111222243338444555555555555' });
});

test('続きの ID は小文字に寄せる', () => {
  // UUID の英字の大小はただの表記揺れ。突き合わせで別物にしないため揃えておく
  const s = spec({ resume: true, sessionId: ID.toUpperCase() });
  assert.equal(s.sessionId, ID);
});

test('newSessionId は使える形の ID を返す', () => {
  const a = newSessionId();
  assert.equal(isSessionId(a), true);
  assert.notEqual(a, newSessionId(), '毎回違う');
});

test('isSessionId は大小と前後の空白を許す', () => {
  assert.equal(isSessionId(ID.toUpperCase()), true);
  assert.equal(isSessionId(` ${ID} `), true);
  for (const v of ['', 'abc', null, 42, `${ID}x`]) assert.equal(isSessionId(v), false);
});

/*
 * argv の完全一致（並びを固定する）
 */

test('いちばん素の argv', () => {
  assert.deepEqual(spec({}).args, [
    '--print',
    '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--replay-user-messages',
    '--permission-mode', 'plan',
    // **モードの直後に必ず付く。** 外すと許可要求がホストへ届かず、CLI が拒否に倒す
    '--permission-prompt-tool', 'stdio',
    // 予算を指定していないので --max-budget-usd は入らない
    '--session-id', ID,
  ]);
});

test('全部指定した argv', () => {
  const s = spec({
    permissionMode: 'acceptEdits', model: 'claude-opus-5', effort: 'high', budgetUsd: 2,
  });
  assert.deepEqual(s.args, [
    '--print',
    '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--replay-user-messages',
    '--permission-mode', 'acceptEdits',
    '--permission-prompt-tool', 'stdio',
    '--max-budget-usd', '2',
    '--session-id', ID,
    '--model', 'claude-opus-5',
    '--effort', 'high',
  ]);
});

test('続きの argv', () => {
  const s = spec({ resume: true, sessionId: ID, model: 'opus', budgetUsd: 5 });
  assert.deepEqual(s.args, [
    '--print',
    '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--replay-user-messages',
    '--permission-mode', 'plan',
    '--permission-prompt-tool', 'stdio',
    '--max-budget-usd', '5',
    '--resume', ID,
    '--model', 'opus',
  ]);
});

test('--verbose を必ず含める', () => {
  // 実測: --print と --output-format stream-json だけだと exit 1 で stdout が1行も出ない。
  // 付け忘れは「起こしたのに無言で死ぬ」という、いちばん分かりにくい壊れ方になる
  for (const input of [{}, { resume: true, sessionId: ID }, { model: 'opus', effort: 'max' }]) {
    assert.equal(spec(input).args.includes('--verbose'), true);
  }
});

test('入力が丸ごと壊れていても落ちない', () => {
  for (const v of [null, undefined, 'あ', 42, []]) {
    const got = buildRunSpec(v, CTX);
    assert.equal(got.ok, false);
    assert.ok(got.reason);
  }
});

/*
 * ---------------------------------------------------------------- 切り替え
 *
 * `mergeSwitch` が決めるのは「どのキーを、どう重ねるか」だけ。
 * 値そのものが使えるかは `buildRunSpec` の仕事なので、ここでは見ない。
 *
 * 3通り（キーが無い / 外す / 差し替える）を取り違えると、
 * **画面には「替えました」と出るのに実際は替わっていない**という形で壊れる。
 */

/** 動いている run の spec に見立てたもの。 */
const PREV = Object.freeze({
  sessionId: ID, cwd: 'C:\\work\\demo', prompt: '前の指示',
  permissionMode: 'plan', model: 'claude-opus-5', effort: 'high',
  budgetUsd: 5, resume: true, args: [],
});

/** 通ることを前提に中身を取り出す。 */
function merged(patch, prev = PREV) {
  const got = mergeSwitch(prev, patch);
  assert.equal(got.ok, true, `通るはず: ${got.reason ?? ''}`);
  return got;
}

test('キーが無いものは変えない', () => {
  const got = merged({ model: 'claude-sonnet-5' });
  assert.equal(got.next.model, 'claude-sonnet-5');
  // 触っていないキーは前のまま
  assert.equal(got.next.effort, 'high');
  assert.equal(got.next.permissionMode, 'plan');
  assert.equal(got.next.cwd, PREV.cwd);
  assert.equal(got.next.sessionId, ID);
  assert.deepEqual(got.changed, ['model']);
});

test('changed はキー名の配列。日本語のラベルではない', () => {
  // 画面側が SWITCH_LABELS で日本語にする。ここで訳すと、訳し方が2箇所に増える
  const got = merged({ model: 'claude-sonnet-5', effort: 'max' });
  assert.deepEqual(got.changed, ['model', 'effort']);
});

test('null と空文字で model と effort を外せる', () => {
  for (const raw of [null, '', '   ']) {
    const got = merged({ model: raw, effort: raw });
    assert.equal(got.next.model, null);
    assert.equal(got.next.effort, null);
    assert.deepEqual(got.changed, ['model', 'effort']);
  }
});

test('権限モードは外せない', () => {
  // 外した先が「既定」なので、plan のつもりが acceptEdits で走る（逆も）事故になる
  for (const raw of [null, '', '  ']) {
    const got = mergeSwitch(PREV, { permissionMode: raw });
    assert.equal(got.ok, false);
    assert.equal(got.reason, '権限モードは外せません');
  }
});

test('同じ値なら changed に入らない', () => {
  const got = mergeSwitch(PREV, { model: 'claude-opus-5', permissionMode: 'plan' });
  assert.equal(got.ok, false);
  assert.equal(got.reason, '切り替える内容がありません');
});

test('元から無いものを外そうとしても、替えたことにしない', () => {
  const prev = { ...PREV, model: null, effort: null };
  const got = mergeSwitch(prev, { model: '', effort: null });
  assert.equal(got.ok, false);
  assert.equal(got.reason, '切り替える内容がありません');
});

test('前後の空白は落として比べる', () => {
  const got = mergeSwitch(PREV, { model: '  claude-opus-5  ' });
  assert.equal(got.ok, false, '同じ値なので替えるところが無い');

  const changed = merged({ model: '  claude-sonnet-5  ' });
  assert.equal(changed.next.model, 'claude-sonnet-5');
});

test('文字列でも null でもない値は、空へ丸めずに断る', () => {
  // 丸めると「指定したのに外れた」が画面のどこにも出ない
  for (const raw of [42, true, [], {}, undefined]) {
    const got = mergeSwitch(PREV, { model: raw });
    assert.equal(got.ok, false, `値: ${JSON.stringify(raw)}`);
    assert.equal(got.reason, 'モデルの指定が不正です');
  }
});

test('断る理由はキー名ではなく日本語で返す', () => {
  assert.equal(mergeSwitch(PREV, { effort: 1 }).reason, '思考量の指定が不正です');
  assert.equal(mergeSwitch(PREV, { permissionMode: 1 }).reason, '権限モードの指定が不正です');
});

test('切り替えで cwd と sessionId は動かせない', () => {
  // ここが動くと、他人のログへ追記させられる・許可していないフォルダで走る
  const got = merged({ model: 'claude-sonnet-5', cwd: 'C:\\Windows', sessionId: 'x' });
  assert.equal(got.next.cwd, PREV.cwd);
  assert.equal(got.next.sessionId, ID);
  assert.deepEqual(got.changed, ['model']);
});

test('差分が丸ごと壊れていても落ちない', () => {
  for (const v of [null, undefined, 'あ', 42, [], true]) {
    const got = mergeSwitch(PREV, v);
    assert.equal(got.ok, false, `値: ${JSON.stringify(v)}`);
    assert.equal(got.reason, '切り替える内容がありません');
  }
});

/*
 * 予算だけは数値なので、上の輪（文字列のキー）とは別の道を通る。
 * ここが通らないと、上限に当たった run を上げて続ける道が無くなる
 * （予算切れは終端ではないので、続ける先はこの切り替えしかない）。
 */

test('予算を替えられる。changed にはキー名で載る', () => {
  const got = merged({ budgetUsd: 20 });
  assert.equal(got.next.budgetUsd, 20);
  assert.deepEqual(got.changed, ['budgetUsd']);
});

test('予算は丸めたあとの値で比べる', () => {
  // 画面の input は文字列を返す。生で比べると '5' !== 5 で「替えた」ことになり、
  // 何も変わらないのに子を畳んで起こし直す
  assert.equal(mergeSwitch(PREV, { budgetUsd: '5' }).ok, false, '同じ額なので替えるところが無い');
  // 範囲へ丸めた先が同じでも同じ扱い（上限は 50）
  assert.equal(mergeSwitch({ ...PREV, budgetUsd: 50 }, { budgetUsd: 999 }).ok, false);

  const got = merged({ budgetUsd: '20' });
  assert.equal(got.next.budgetUsd, 20, '数値へ直して入れる');
});

test('予算は空にすれば上限なしへ外せる', () => {
  for (const raw of [null, '', '   ']) {
    const got = merged({ budgetUsd: raw });
    assert.equal(got.next.budgetUsd, null);
    assert.deepEqual(got.changed, ['budgetUsd']);
  }
  // 元から無いものを外そうとしても、替えたことにしない
  assert.equal(mergeSwitch({ ...PREV, budgetUsd: null }, { budgetUsd: '' }).ok, false);
});

test('使えない予算は 0 へ丸めずに断る', () => {
  for (const raw of [0, -5, 'あ', true, [], {}]) {
    const got = mergeSwitch(PREV, { budgetUsd: raw });
    assert.equal(got.ok, false, `値: ${JSON.stringify(raw)}`);
    assert.equal(got.reason, '予算の指定が不正です');
  }
});

test('替えた予算がそのまま argv に出る', () => {
  const got = merged({ budgetUsd: 20 });
  const built = buildRunSpec(
    { ...got.next, prompt: '続けて', resume: true, sessionId: PREV.sessionId },
    { ...CTX, allowedDirs: [PREV.cwd] },
  );
  assert.equal(built.ok, true, built.reason ?? '');
  const i = built.spec.args.indexOf('--max-budget-usd');
  assert.ok(i >= 0, '上限を渡していない');
  assert.equal(built.spec.args[i + 1], '20');

  // 外したぶんは argv に出ない（既定の $5 で勝手に打ち切られないこと）
  const off = merged({ budgetUsd: '' });
  const b2 = buildRunSpec(
    { ...off.next, prompt: '続けて', resume: true, sessionId: PREV.sessionId },
    { ...CTX, allowedDirs: [PREV.cwd] },
  );
  assert.equal(b2.spec.args.includes('--max-budget-usd'), false);
});

test('元の spec を書き換えない', () => {
  const prev = { ...PREV };
  merged({ model: 'claude-sonnet-5', effort: null }, prev);
  assert.equal(prev.model, 'claude-opus-5');
  assert.equal(prev.effort, 'high');
});

test('切り替えた spec をそのまま buildRunSpec へ通せる', () => {
  // 実際の経路がこの形。ここが通らないと切り替えは1回も成功しない
  const got = merged({ model: 'claude-sonnet-5', effort: null });
  const built = buildRunSpec(
    { ...got.next, prompt: '続けて', resume: true, sessionId: PREV.sessionId },
    { ...CTX, allowedDirs: [PREV.cwd] },
  );
  assert.equal(built.ok, true, built.reason ?? '');
  assert.equal(built.spec.sessionId, ID);
  assert.equal(built.spec.model, 'claude-sonnet-5');
  assert.equal(built.spec.effort, null);
  assert.equal(built.spec.args.includes('--resume'), true);
  assert.equal(built.spec.args.includes('--verbose'), true);
  // 外したものはフラグごと消える（空文字で渡すと commander がフラグとして読む）
  assert.equal(built.spec.args.includes('--effort'), false);
});
