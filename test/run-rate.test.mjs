/**
 * 枠の使用率を紙に落とす層（src/run/rate.mjs）。
 *
 * この紙は「サーバーを立て直しても枠が出る」ためだけに在る控えで、
 * 無くても本体は動く。だから確かめたいのは正常系より**壊れた紙の読み方**。
 *
 * 前の版が書いたもの、電源が落ちた残骸、手で編集して壊したもの——
 * どれが来ても落ちず、かつ**古い数を今の数の顔で出さない**ことを押さえる。
 *
 * `update-state.test.mjs` と同じ割り切りで、判断（parseRate）を厚く見る。
 * ただし書き込みだけは1本だけ通しで見る。`saveRate` と `parseRate` が食い違うと
 * 「書いたのに読めない紙」ができ、症状が「枠が出ない」だけなので気づけないため。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRate, parseRate, ratePath, saveRate } from '../src/run/rate.mjs';

const OK = { fiveHour: 0.42, sevenDay: 0.73, resetsAt: 1787667000, at: 1787657809199 };

/* ── 読み方（判断） ─────────────────────────────────────────── */

test('そろっている紙はそのまま通る', () => {
  assert.deepEqual(parseRate(OK), OK);
});

test('紙でないものは null', () => {
  for (const v of [null, undefined, 0, '', 'x', [], true]) {
    assert.equal(parseRate(v), null, String(v));
  }
});

test('測った時刻の無い紙は丸ごと捨てる', () => {
  // 何分前の数か言えないなら、古い数を今の数の顔で出すことになる。
  // 数だけ残して「いつのものか不明」で出す道は作らない
  assert.equal(parseRate({ fiveHour: 0.42, sevenDay: 0.73 }), null);
  assert.equal(parseRate({ ...OK, at: null }), null);
  assert.equal(parseRate({ ...OK, at: '1787657809199' }), null);
  assert.equal(parseRate({ ...OK, at: NaN }), null);
});

test('どちらの枠も読めなければ null', () => {
  assert.equal(parseRate({ at: 1, fiveHour: null, sevenDay: null }), null);
  assert.equal(parseRate({ at: 1 }), null);
});

test('片方だけでも読めれば通す', () => {
  // 5時間枠だけが返る場面があるので、両方そろっていることを条件にしない
  assert.deepEqual(parseRate({ at: 1, fiveHour: 0.5 }),
    { fiveHour: 0.5, sevenDay: null, resetsAt: null, at: 1 });
  assert.deepEqual(parseRate({ at: 1, sevenDay: 0.5 }),
    { fiveHour: null, sevenDay: 0.5, resetsAt: null, at: 1 });
});

test('0 は 0 として通す。「読めなかった」に丸めない', () => {
  const r = parseRate({ at: 1, fiveHour: 0, sevenDay: 0 });
  assert.equal(r.fiveHour, 0);
  assert.equal(r.sevenDay, 0);
});

test('読めない値だけを落として、残りは通す', () => {
  // 版が上がって resetsAt の形が変わっても、枠の数までは道連れにしない
  const r = parseRate({ ...OK, resetsAt: 'あとで' });
  assert.equal(r.resetsAt, null);
  assert.equal(r.fiveHour, 0.42);
});

test('Infinity は数として扱わない', () => {
  assert.equal(parseRate({ ...OK, at: Infinity }), null);
  assert.equal(parseRate({ ...OK, fiveHour: Infinity }).fiveHour, null);
});

/* ── 置き場所 ───────────────────────────────────────────────── */

test('紙は appdata の下。~/.claude には書かない', () => {
  const p = ratePath({ LOCALAPPDATA: path.join('C:', 'x') });
  assert.equal(p, path.join('C:', 'x', 'ClaudeDeck', 'rate.json'));
  assert.equal(p.includes('.claude'), false);
});

/* ── 書き込み（1本だけ通しで） ──────────────────────────────── */

test('書いた紙は読み戻せる', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-rate-'));
  const env = { LOCALAPPDATA: dir };
  try {
    assert.equal(saveRate(OK, env), true);
    assert.deepEqual(loadRate(env), OK);
    // 一時ファイルを残さない（rename まで済んでいる）
    assert.equal(fs.existsSync(`${ratePath(env)}.tmp`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('紙がまだ無ければ null。一度も起こしていないだけで、異常ではない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-rate-'));
  try {
    assert.equal(loadRate({ LOCALAPPDATA: dir }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('壊れた紙は null。読めない設定を残しても誰も得しない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-rate-'));
  const env = { LOCALAPPDATA: dir };
  try {
    fs.mkdirSync(path.dirname(ratePath(env)), { recursive: true });
    fs.writeFileSync(ratePath(env), '{ こわれ', 'utf8');
    assert.equal(loadRate(env), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('測った時刻の無いものは書かない', () => {
  // 書けたと言い張ると、次の立ち上げで読めない紙の理由を探すことになる
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-rate-'));
  const env = { LOCALAPPDATA: dir };
  try {
    assert.equal(saveRate(null, env), false);
    assert.equal(saveRate({ fiveHour: 0.4 }, env), false);
    assert.equal(fs.existsSync(ratePath(env)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('書けなくても投げない', () => {
  // 控えの紙が書けないことを理由に、実行そのものを止める筋合いが無い。
  // ファイルをフォルダの名前に使わせて mkdir を失敗させる
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-rate-'));
  const env = { LOCALAPPDATA: dir };
  try {
    fs.writeFileSync(path.join(dir, 'ClaudeDeck'), 'これはファイル', 'utf8');
    assert.equal(saveRate(OK, env), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
