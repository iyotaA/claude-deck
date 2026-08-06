/**
 * 書き込み先の解決のテスト。
 *
 * 自動起動のログと通知の設定ファイルが同じ場所を指すことが要点。
 * 片方だけ別の場所を見ていると、設定したのに読まれない事故になる。
 *
 * 環境変数は引数で渡す形にしてあるので、process.env を汚さずに確かめられる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { appDataDir, appDataFile } from '../src/shared/appdata.mjs';

test('LOCALAPPDATA を最優先で見る', () => {
  const env = { LOCALAPPDATA: 'C:\\u\\Local', XDG_STATE_HOME: '/xdg', HOME: '/home/u' };
  assert.equal(appDataDir('C:\\app', env), path.join('C:\\u\\Local', 'ClaudeDeck'));
});

test('LOCALAPPDATA が無ければ XDG_STATE_HOME に落ちる', () => {
  const env = { XDG_STATE_HOME: '/xdg', HOME: '/home/u' };
  assert.equal(appDataDir('/app', env), path.join('/xdg', 'ClaudeDeck'));
});

test('XDG_STATE_HOME も無ければ HOME に落ちる', () => {
  assert.equal(appDataDir('/app', { HOME: '/home/u' }), path.join('/home/u', 'ClaudeDeck'));
});

test('環境変数がどれも無ければ、渡された既定に落ちる', () => {
  // 配布先でどれも立っていない場面に備えた最後の受け皿。ここで落ちてはいけない
  assert.equal(appDataDir('C:\\app', {}), path.join('C:\\app', 'ClaudeDeck'));
});

test('空文字は「無い」として扱う', () => {
  // set LOCALAPPDATA= のように空で立っていることがある。そのまま使うと相対パスになる
  const env = { LOCALAPPDATA: '', HOME: '/home/u' };
  assert.equal(appDataDir('/app', env), path.join('/home/u', 'ClaudeDeck'));
});

test('ファイル名までつなげる', () => {
  const env = { LOCALAPPDATA: 'C:\\u\\Local' };
  assert.equal(
    appDataFile('autostart.log', 'C:\\app', env),
    path.join('C:\\u\\Local', 'ClaudeDeck', 'autostart.log'),
  );
});

test('ログと設定は同じフォルダを指す', () => {
  const env = { LOCALAPPDATA: 'C:\\u\\Local' };
  assert.equal(
    path.dirname(appDataFile('autostart.log', 'C:\\app', env)),
    path.dirname(appDataFile('config.json', 'C:\\app', env)),
  );
});
