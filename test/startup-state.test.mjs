/**
 * 自動起動の状態の読み替え（src/startup/state.mjs）。
 *
 * 見るのは parseStartupState の分岐すべて。紙は C# ランチャが書くものなので、
 * こちらが確かめられるのは「来た形をどう読むか」だけになる。
 *
 * update.json と違って版の照合はしない（登録先は動かないスタブなので古くならない）。
 * 代わりに大事なのが「紙が無いこと」の扱い。
 * 無いのを「登録されていない」と読み替えると、npm start で起こしたときに毎回
 * 「登録されていません」と出て、実際には登録済みなのに解除を勧めることになる。
 *
 * loadStartupState はディスクを触るが、無いファイルを読むところまでは確かめられる。
 * 「一度も調べていない」と「壊れている」を混ぜないのが要点なので、そこだけ見る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  parseStartupState,
  loadStartupState,
  startupStatePath,
  startupLabel,
  legacyLabel,
  STARTUP_LABELS,
  LEGACY_LABELS,
} from '../src/startup/state.mjs';

test('紙がまだ無ければ idle。ランチャを通さずに起動しただけで、異常ではない', () => {
  const got = parseStartupState(null, { missing: true });
  assert.equal(got.state, 'idle');
  assert.equal(got.label, STARTUP_LABELS.idle);
  // 紙が無いので旧方式の様子も分からない。none（残っていません）と言い切らない
  assert.equal(got.legacy, 'unknown');
  assert.equal(got.error, null);
});

test('読めない紙は unknown。missing と同じ扱いにしない', () => {
  // JSON.parse に失敗すると raw は null で来る
  assert.equal(parseStartupState(null, {}).state, 'unknown');
  // 形が違うものも同じ。state が取れなければそこで打ち切る
  assert.equal(parseStartupState('こわれている', {}).state, 'unknown');
  assert.equal(parseStartupState({ legacy: 'none' }, {}).state, 'unknown');
  assert.equal(parseStartupState({ state: '   ' }, {}).state, 'unknown');
});

test('ランチャが書いた値をそのまま渡す', () => {
  const got = parseStartupState({
    state: 'on',
    legacy: 'disabled',
    checkedAt: 1785750043110,
    error: null,
  }, { path: 'C:\\x\\startup.json' });

  assert.equal(got.state, 'on');
  assert.equal(got.label, STARTUP_LABELS.on);
  assert.equal(got.legacy, 'disabled');
  assert.equal(got.legacyLabel, LEGACY_LABELS.disabled);
  assert.equal(got.checkedAt, 1785750043110);
  assert.equal(got.path, 'C:\\x\\startup.json');
  assert.equal(got.error, null);
});

test('ランチャが書く4つの状態は、それぞれの言い方を持つ', () => {
  // ここが unknown に潰れると「状態が分かりません」と出て、
  // 登録できているのに壊れているように見える
  for (const state of ['on', 'off', 'foreign', 'not-installed']) {
    assert.notEqual(startupLabel(state), STARTUP_LABELS.unknown, state);
  }
});

test('旧方式の4つも、それぞれの言い方を持つ', () => {
  for (const legacy of ['none', 'active', 'disabled', 'failed']) {
    assert.notEqual(legacyLabel(legacy), LEGACY_LABELS.unknown, legacy);
  }
});

test('知らない状態は通す。言い方だけ落とす', () => {
  // ランチャが先に新しい状態を書くようになったとき、
  // ここで unknown へ潰すと「読めませんでした」と嘘をつくことになる。
  //
  // ここに書く語は「まだ実装していないもの」でなければ意味がない。
  // 語を足すときは、こちらも架空のものへ寄せ直す
  const got = parseStartupState({ state: 'pending-reboot', legacy: 'renamed' }, {});
  assert.equal(got.state, 'pending-reboot');
  assert.equal(got.label, STARTUP_LABELS.unknown);
  assert.equal(got.legacy, 'renamed');
  assert.equal(got.legacyLabel, LEGACY_LABELS.unknown);
});

test('旧方式の様子が読めなければ unknown。none に倒さない', () => {
  // 「残っていません」と言い切ると、実際には .lnk が残っていて
  // 二重に立っている状況を見逃す。分からないなら分からないと出す
  assert.equal(parseStartupState({ state: 'on' }, {}).legacy, 'unknown');
  assert.equal(parseStartupState({ state: 'on', legacy: '  ' }, {}).legacy, 'unknown');
  assert.equal(parseStartupState({ state: 'on', legacy: 42 }, {}).legacy, 'unknown');
});

test('登録できなかった理由を運ぶ', () => {
  // レジストリに書けない環境（ポリシーで塞がれている等）はここでしか分からない
  const got = parseStartupState({
    state: 'off',
    legacy: 'failed',
    error: 'レジストリに書き込めませんでした: アクセスが拒否されました。',
  }, {});

  assert.equal(got.state, 'off');
  assert.match(got.error, /アクセスが拒否/);
  assert.equal(got.legacyLabel, LEGACY_LABELS.failed);
});

test('空の理由は null。空文字を作らない', () => {
  const got = parseStartupState({ state: 'on', legacy: 'none', error: '   ' }, {});
  assert.equal(got.error, null);
});

test('時刻の 0 は「不明」として null にする', () => {
  const got = parseStartupState({ state: 'on', legacy: 'none', checkedAt: 0 }, {});
  assert.equal(got.checkedAt, null);
});

test('未知の形で落ちない', () => {
  // 手で書き換えられた紙が来ても、読めるところだけ読んで進む
  const got = parseStartupState({
    state: 'on',
    legacy: { was: 'lnk' },
    checkedAt: '1785750043110',
    error: 123,
  }, {});

  assert.equal(got.state, 'on');
  assert.equal(got.legacy, 'unknown');
  assert.equal(got.checkedAt, null);
  assert.equal(got.error, null);
});

test('置き場所は notify の設定・更新の記録と同じ親の下', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };
  assert.equal(
    startupStatePath(env),
    path.join('C:\\Users\\me\\AppData\\Local', 'ClaudeDeck', 'startup.json'),
  );
});

test('紙が無いだけなら idle。読み取りで投げない', () => {
  const env = { LOCALAPPDATA: path.join('C:\\', 'claude-deck-nothing-here') };
  const got = loadStartupState({ env });

  assert.equal(got.state, 'idle');
  assert.equal(got.path, startupStatePath(env));
});
