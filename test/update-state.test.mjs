/**
 * 更新の状態の読み替え（src/update/state.mjs）。
 *
 * 見るのは parseUpdateState の分岐すべて。紙は C# ランチャが書くものなので、
 * こちらが確かめられるのは「来た形をどう読むか」だけになる。
 *
 * とくに大事なのが stale。
 * 「新しい版があります」の紙は、書かれたときの版とセットでしか意味を持たない。
 * すでに入れ替わっているのに更新を勧め続ける形になっていないかを、ここで押さえる。
 *
 * loadUpdateState はディスクを触るが、無いファイルを読むところまでは確かめられる。
 * 「一度も確認していない」と「壊れている」を混ぜないのが要点なので、そこだけ見る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  parseUpdateState,
  loadUpdateState,
  updateStatePath,
  updateLabel,
  UPDATE_LABELS,
} from '../src/update/state.mjs';

test('紙がまだ無ければ idle。まだ確認していないだけで、異常ではない', () => {
  const got = parseUpdateState(null, { version: '0.2.0', missing: true });
  assert.equal(got.state, 'idle');
  assert.equal(got.label, UPDATE_LABELS.idle);
  assert.equal(got.current, '0.2.0');
  assert.equal(got.available, null);
  assert.equal(got.error, null);
});

test('読めない紙は unknown。missing と同じ扱いにしない', () => {
  // JSON.parse に失敗すると raw は null で来る
  assert.equal(parseUpdateState(null, { version: '0.2.0' }).state, 'unknown');
  // 形が違うものも同じ。state が取れなければそこで打ち切る
  assert.equal(parseUpdateState('こわれている', {}).state, 'unknown');
  assert.equal(parseUpdateState({ available: '0.2.1' }, {}).state, 'unknown');
  assert.equal(parseUpdateState({ state: '   ' }, {}).state, 'unknown');
});

test('ランチャが書いた値をそのまま渡す', () => {
  const got = parseUpdateState({
    state: 'available',
    current: '0.2.0',
    available: '0.2.1',
    notes: '直したところ',
    checkedAt: 1785750043110,
    changedAt: 1785750043110,
  }, { version: '0.2.0', path: 'C:\\x\\update.json' });

  assert.equal(got.state, 'available');
  assert.equal(got.label, UPDATE_LABELS.available);
  assert.equal(got.available, '0.2.1');
  assert.equal(got.notes, '直したところ');
  assert.equal(got.checkedAt, 1785750043110);
  assert.equal(got.path, 'C:\\x\\update.json');
  assert.equal(got.error, null);
});

test('確認したときの版が違えば stale。新しい版を落とす', () => {
  // 0.2.0 のときに書かれた紙を、0.2.1 になってから読んだ場合。
  // そのまま出すと、すでに入れ替わっているのに更新を勧め続けることになる
  const got = parseUpdateState({
    state: 'available',
    current: '0.2.0',
    available: '0.2.1',
    notes: '直したところ',
  }, { version: '0.2.1' });

  assert.equal(got.state, 'stale');
  assert.equal(got.label, UPDATE_LABELS.stale);
  assert.equal(got.available, null);
  assert.equal(got.notes, null);
  assert.match(got.error, /0\.2\.0/);
  assert.match(got.error, /0\.2\.1/);
});

test('勧めている版がいまの版と同じでも stale', () => {
  // current は合っているが、available がいまの版。当てたのに紙が残っている形
  const got = parseUpdateState({
    state: 'available',
    current: '0.2.1',
    available: '0.2.1',
  }, { version: '0.2.1' });

  assert.equal(got.state, 'stale');
  assert.equal(got.available, null);
});

test('いまの版が分からないときは stale を判定しない', () => {
  // 判定できないことを「食い違っている」と読み替えない。
  // VERSION は package.json が読めなければ null になりうる
  const got = parseUpdateState({
    state: 'available',
    current: '0.2.0',
    available: '0.2.1',
  }, { version: null });

  assert.equal(got.state, 'available');
  assert.equal(got.available, '0.2.1');
});

test('available 以外は版が食い違っても触らない', () => {
  // 「最新です」の紙が1つ前の版のものでも、次の確認で上書きされるだけで誰も困らない
  const got = parseUpdateState({
    state: 'none',
    current: '0.1.0',
  }, { version: '0.2.1' });

  assert.equal(got.state, 'none');
  assert.equal(got.error, null);
});

test('知らない状態は通す。言い方だけ落とす', () => {
  // ランチャが先に新しい状態を書くようになったとき、
  // ここで unknown へ潰すと「読めませんでした」と嘘をつくことになる。
  //
  // ここに書く語は「まだ実装していないもの」でなければ意味がない。
  // 以前は downloading を使っていたが、当てる道中の状態として実装した時点で
  // このテストが落ちた。語を足すときは、こちらも架空のものへ寄せ直す
  const got = parseUpdateState({ state: 'rolling-back' }, {});
  assert.equal(got.state, 'rolling-back');
  assert.equal(got.label, UPDATE_LABELS.unknown);
  assert.equal(updateLabel('rolling-back'), UPDATE_LABELS.unknown);
});

test('当てる道中の3つは、それぞれの言い方を持つ', () => {
  // 押してから戻るまでのあいだ、画面はこの紙だけを見て進み方を知る。
  // unknown に潰れると「状態が分かりません」と出て、更新が壊れたように見える
  for (const state of ['downloading', 'applying', 'done']) {
    assert.notEqual(updateLabel(state), UPDATE_LABELS.unknown, state);
  }
});

test('当てようとした版を運ぶ', () => {
  // done のとき、画面は「何に入れ替わったか」をここから出す。
  // 照合そのものはランチャ側でやるので、ここは通すだけ
  const got = parseUpdateState({
    state: 'done',
    current: '0.2.1',
    requested: '0.2.1',
    changedAt: 1785750043110,
  }, { version: '0.2.1' });

  assert.equal(got.state, 'done');
  assert.equal(got.requested, '0.2.1');
  assert.equal(got.changedAt, 1785750043110);
});

test('当てたのに版が変わっていなければ failed。理由も運ぶ', () => {
  // 「apply は成功と言ったのに何も起きていない」を捕まえる唯一の網。
  // requested と current が食い違ったままここへ来る形になる
  const got = parseUpdateState({
    state: 'failed',
    current: '0.2.0',
    requested: '0.2.1',
    error: '当てましたが版が変わっていません（いま 0.2.0 / 求めた 0.2.1）',
  }, { version: '0.2.0' });

  assert.equal(got.state, 'failed');
  assert.equal(got.requested, '0.2.1');
  assert.match(got.error, /0\.2\.1/);
  // failed は当てるほうでも使う。「確認に失敗」と言い切らない
  assert.doesNotMatch(got.label, /確認/);
});

test('求めた版が読めなければ null。空文字を作らない', () => {
  const got = parseUpdateState({ state: 'applying', requested: '   ' }, {});
  assert.equal(got.requested, null);
});

test('時刻の 0 は「不明」として null にする', () => {
  const got = parseUpdateState({
    state: 'none',
    checkedAt: 0,
    changedAt: '1785750043110',
  }, {});

  assert.equal(got.checkedAt, null);
  assert.equal(got.changedAt, null);
});

test('未知の形で落ちない', () => {
  // 手で書き換えられた紙が来ても、読めるところだけ読んで進む
  const got = parseUpdateState({
    state: 'available',
    current: 42,
    available: { v: '0.2.1' },
    notes: 123,
    checkedAt: -1,
    error: '',
  }, { version: '0.2.0' });

  // current が文字列として読めないので、確認したときの版は不明扱い → stale
  assert.equal(got.state, 'stale');
  assert.equal(got.available, null);
  assert.equal(got.checkedAt, null);
  assert.match(got.error, /不明/);
});

test('置き場所は notify の設定と同じ親の下', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };
  assert.equal(
    updateStatePath(env),
    path.join('C:\\Users\\me\\AppData\\Local', 'ClaudeDeck', 'update.json'),
  );
});

test('紙が無いだけなら idle。読み取りで投げない', () => {
  const env = { LOCALAPPDATA: path.join('C:\\', 'claude-deck-nothing-here') };
  const got = loadUpdateState({ env, version: '0.2.0' });

  assert.equal(got.state, 'idle');
  assert.equal(got.current, '0.2.0');
  assert.equal(got.path, updateStatePath(env));
});
