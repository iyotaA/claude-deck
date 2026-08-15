/**
 * 実ポートを置く紙の、場所の決め方のテスト。
 *
 * ここが狂うと、書く側（server.mjs）と読む側（ランチャ・autostart.ps1）が
 * 別のファイルを見ることになる。症状は「起動はしているのに見つからない」で、
 * どちらが悪いのか分かりにくい形になる。
 *
 * 実際に書く・消すほうはテストしない（薄い殻なので、判断だけをここで押さえる）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolvePortFile, hasPortFileFlag } from '../src/shared/portfile.mjs';
import { appDataFile } from '../src/shared/appdata.mjs';

const ENV = { LOCALAPPDATA: 'C:\\u\\Local' };
const ROOT = 'C:\\app';
/** 引数が無いときに落ちる先。 */
const DEFAULT = appDataFile('port.json', ROOT, ENV);

test('引数が無ければ既定の場所', () => {
  assert.equal(resolvePortFile([], ENV, ROOT), DEFAULT);
});

test('--port-file <path> で明示できる', () => {
  const got = resolvePortFile(['--port-file', 'C:\\data\\port.json'], ENV, ROOT);
  assert.equal(got, path.resolve('C:\\data\\port.json'));
});

test('--port-file=<path> の形でも取れる', () => {
  const got = resolvePortFile(['--port-file=C:\\data\\port.json'], ENV, ROOT);
  assert.equal(got, path.resolve('C:\\data\\port.json'));
});

test('他の引数と混ざっていても取れる', () => {
  const got = resolvePortFile(['--no-open', '--port-file', 'C:\\d\\p.json'], ENV, ROOT);
  assert.equal(got, path.resolve('C:\\d\\p.json'));
});

test('値の前後の空白は落とす', () => {
  const got = resolvePortFile(['--port-file', '  C:\\d\\p.json  '], ENV, ROOT);
  assert.equal(got, path.resolve('C:\\d\\p.json'));
});

test('相対パスは絶対パスに直す', () => {
  const got = resolvePortFile(['--port-file', 'tmp/port.json'], ENV, ROOT);
  assert.equal(got, path.resolve('tmp/port.json'));
  assert.ok(path.isAbsolute(got));
});

test('次が別のフラグなら値として取らない', () => {
  // `--port-file --no-open` と書き間違えたとき。'--no-open' という名前のファイルを作らない
  assert.equal(resolvePortFile(['--port-file', '--no-open'], ENV, ROOT), DEFAULT);
});

test('--port-file が最後で値が無ければ既定に落ちる', () => {
  assert.equal(resolvePortFile(['--port-file'], ENV, ROOT), DEFAULT);
});

test('値が空なら既定に落ちる', () => {
  assert.equal(resolvePortFile(['--port-file='], ENV, ROOT), DEFAULT);
  assert.equal(resolvePortFile(['--port-file', '   '], ENV, ROOT), DEFAULT);
});

test('先に書いたほうを採る', () => {
  const got = resolvePortFile(['--port-file', 'a.json', '--port-file', 'b.json'], ENV, ROOT);
  assert.equal(got, path.resolve('a.json'));
});

test('文字列でない要素が混ざっても落ちない', () => {
  // 呼ぶ側が process.argv 以外を渡す場面に備える。未知の形で落ちない
  assert.equal(resolvePortFile([null, undefined, 42], ENV, ROOT), DEFAULT);
});

test('既定の場所は appdata.mjs の決め方に従う', () => {
  // ログ・設定と同じフォルダに置く。ここがずれると片方だけ別の場所を見ることになる
  assert.equal(
    path.dirname(resolvePortFile([], ENV, ROOT)),
    path.dirname(appDataFile('config.json', ROOT, ENV)),
  );
});

/*
 * 紙を書く役目かどうか。
 *
 * 紙は1枚しかないので、同じマシンで2本立つと後から立ったほうが上書きし、
 * 先に止めたほうが消す。実際に踏んだ（インストール版が 4317 で動いているのに紙だけ消えた）。
 * 書く主体を「場所を明示してきた起動」に絞ることで、取り合いそのものを起こさない。
 */

test('--port-file を渡された起動だけが書く', () => {
  assert.equal(hasPortFileFlag(['--port-file', 'C:\\d\\p.json']), true);
  assert.equal(hasPortFileFlag(['--port-file=C:\\d\\p.json']), true);
  assert.equal(hasPortFileFlag(['--no-open', '--port-file', 'C:\\d\\p.json']), true);
});

test('渡されていなければ書かない', () => {
  // 開発側の `npm start` がここに落ちる。インストール版の紙を巻き添えにしない
  assert.equal(hasPortFileFlag([]), false);
  assert.equal(hasPortFileFlag(['--no-open']), false);
});

test('引数を省いても落ちない', () => {
  assert.equal(hasPortFileFlag(), false);
});

test('書き間違いは書かない側に倒す', () => {
  // resolvePortFile が既定へ落ちるのと歩調を揃える。
  // 場所が決まらない起動が、既定の場所を勝手に掴んで上書きするのを防ぐ
  assert.equal(hasPortFileFlag(['--port-file', '--no-open']), false);
  assert.equal(hasPortFileFlag(['--port-file']), false);
  assert.equal(hasPortFileFlag(['--port-file=']), false);
  assert.equal(hasPortFileFlag(['--port-file', '   ']), false);
});

test('文字列でない要素が混ざっても、書く役目とは見なさない', () => {
  assert.equal(hasPortFileFlag([null, undefined, 42]), false);
});

test('書くと決めた起動は、書き先も決まっている', () => {
  // 真なのに既定へ落ちる（＝場所を決めた覚えがないのに書く）組み合わせを作らない。
  // 2つの判断が同じ走査から出ていることを、呼ぶ側から見て確かめる
  const argv = ['--no-open', '--port-file', 'C:\\d\\p.json'];
  assert.equal(hasPortFileFlag(argv), true);
  assert.notEqual(resolvePortFile(argv, ENV, ROOT), DEFAULT);
});
