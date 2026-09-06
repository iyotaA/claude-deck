/**
 * 構文チェック（`node --check` 相当）。
 *
 * **このプロジェクトには構文エラーを捕まえる網が1枚も無かった。**
 * `npm test` は `server.mjs`（1,691行）も `cli.mjs` も一度も import しないし、
 * `public/js/` の下は DOM を触るのでテストから import できない。
 * つまり `server.mjs` の `}` を1つ落としても、`list.js` を壊しても、**テストは全部通る。**
 * 気づくのはサーバーを立てたときか、ブラウザで開いたときになる。
 *
 * リンタを置かない方針（`CLAUDE.md`）はそのままでよいが、
 * 「構文として読めるか」だけは道具を増やさずに見られる。ここがその1枚。
 *
 * **`import()` では代わりにならない。** あれはモジュールを実行するので、
 * 画面側は `document` が無くて落ち、`server.mjs` は listen を始めてしまう。
 * `node --check` は解析だけして実行しない。
 *
 * `public/js/` の `.js` も **ESM として**解析される。ルートの `package.json` が
 * `"type": "module"` を宣言しているため（`.mjs` に揃えないのは、`public/` に置くと
 * `server.mjs` の MIME に無くて `octet-stream` で返るから ―― ルートの `CLAUDE.md` にある）。
 *
 * 実測で 107 ファイル・1.1 秒（8並列）。`node --test` 全体が 0.8 秒なので、
 * ここだけで倍になる。**それでも置くだけの価値がある**（落ちるときは本番でしか落ちない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 同時に立てる子プロセスの数。増やしても頭打ちになるうえ、CI の細い機械で詰まる。 */
const CONCURRENCY = 8;

/**
 * 拡張子で絞って再帰的に集める。
 *
 * **`node_modules` を避ける枝は要らない。** `dependencies` が空のままなので、
 * ここで渡すフォルダの下に外から来たコードは1行も無い。
 *
 * @param {string} dir root からの相対パス
 * @param {string} ext 拾う拡張子（`.mjs` など）
 * @returns {string[]} root からの相対パスの配列
 */
function collect(dir, ext) {
  const out = [];
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return out;
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.posix.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...collect(rel, ext));
    else if (ent.name.endsWith(ext)) out.push(rel);
  }
  return out;
}

/**
 * 1ファイルを解析させる。**中身は実行されない。**
 *
 * @param {string} rel root からの相対パス
 * @returns {Promise<string|null>} 通れば null、駄目なら stderr
 */
function check(rel) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--check', path.join(root, rel)], (err, _out, stderr) => {
      resolve(err ? (stderr || String(err)).trim() : null);
    });
  });
}

/**
 * 上限つきで並べて回す。
 *
 * @param {string[]} files
 * @returns {Promise<string[]>} 落ちたぶんの説明。全部通れば空
 */
async function checkAll(files) {
  const bad = [];
  let at = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (at < files.length) {
      const rel = files[at];
      at += 1;
      const err = await check(rel);
      if (err) bad.push(`${rel}\n${err}`);
    }
  }));
  return bad.sort();
}

test('サーバー側（server.mjs・cli.mjs・src/）が構文として読める', async () => {
  const files = ['server.mjs', 'cli.mjs', ...collect('src', '.mjs')];
  // 集め方そのものが壊れていたら「0件で成功」になる。数のほうも見る
  assert.ok(files.length > 40, `対象が少なすぎる（${files.length} 件）。集め方が壊れていないか`);

  const bad = await checkAll(files);
  assert.deepEqual(bad, [], `構文エラー:\n${bad.join('\n\n')}`);
});

test('画面側（public/js/）が構文として読める', async () => {
  const files = collect('public/js', '.js');
  assert.ok(files.length > 30, `対象が少なすぎる（${files.length} 件）。集め方が壊れていないか`);

  const bad = await checkAll(files);
  assert.deepEqual(bad, [], `構文エラー:\n${bad.join('\n\n')}`);
});

test('スクリプト（scripts/）が構文として読める', async () => {
  // `.ps1` はここでは見られない（PowerShell の解析器が要る）。
  // BOM の有無だけは contract.test.mjs が見ている
  const files = collect('scripts', '.mjs');
  const bad = await checkAll(files);
  assert.deepEqual(bad, [], `構文エラー:\n${bad.join('\n\n')}`);
});
