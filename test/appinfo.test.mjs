/**
 * 版の読み取りのテスト。
 *
 * 見ているのは1点だけ。**読めなかったときに嘘の版を返さないこと。**
 * '0.0.0' のような既定を置くと、更新の照合（求めた版と実際の版を比べる）が
 * 静かに成立してしまい、「当てたのに変わっていない」を見逃す。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVersion, VERSION } from '../src/shared/appinfo.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');

test('既定ではこのアプリの package.json から読む', () => {
  const v = readVersion();
  assert.equal(typeof v, 'string');
  // SemVer の形をしていること。値そのものは版上げのたびに変わるので固定しない
  assert.match(v, /^\d+\.\d+\.\d+/);
});

test('VERSION は起動時に1回だけ決まり、readVersion() と同じ', () => {
  assert.equal(VERSION, readVersion());
});

test('ファイルが無ければ null', () => {
  assert.equal(readVersion(path.join(repoRoot, 'no-such-file.json')), null);
});

test('JSON でなければ null', () => {
  // 配布物が壊れている・別のファイルを指してしまった場面
  assert.equal(readVersion(path.join(repoRoot, 'README.md')), null);
});

test('version が無い JSON なら null', () => {
  const file = path.join(os.tmpdir(), `claude-deck-appinfo-${process.pid}.json`);
  try {
    fs.writeFileSync(file, '{"name":"x"}', 'utf8');
    assert.equal(readVersion(file), null);
  } finally {
    try { fs.unlinkSync(file); } catch { /* 消えていればそれでよい */ }
  }
});

test('version が空や文字列でなければ null。前後の空白は落とす', () => {
  const file = path.join(os.tmpdir(), `claude-deck-appinfo-2-${process.pid}.json`);
  try {
    fs.writeFileSync(file, '{"version":"  "}', 'utf8');
    assert.equal(readVersion(file), null);

    fs.writeFileSync(file, '{"version":123}', 'utf8');
    assert.equal(readVersion(file), null);

    fs.writeFileSync(file, '{"version":" 1.2.3 "}', 'utf8');
    assert.equal(readVersion(file), '1.2.3');
  } finally {
    try { fs.unlinkSync(file); } catch { /* 消えていればそれでよい */ }
  }
});
