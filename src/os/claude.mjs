/**
 * claude CLI を掴む。
 *
 * この層は**薄い殻**にしてある。プロジェクト内の import はゼロで、
 * 見ているのは node の標準モジュールだけ。
 * 判断（何を渡すか）は run/spec.mjs、解釈（返ってきた行の意味）は parse/stream.mjs にある。
 *
 * ここがやるのは3つだけ。
 *
 * - 実行ファイルを探す（`resolveClaudeBin`）
 * - 版を1回だけ確かめて、その結果を持っておく（`probeClaude` / `claudeInfo`）
 * - 届いたバイト列を行に割る（`createLineSplitter`）
 *
 * 実際に起こす `spawnClaude` は段3 #3 で足す。
 * 配線（run/index.mjs）と同時に書かないと、テストの無い行を出荷することになるため。
 *
 * ## `.cmd` / `.bat` は使わない
 *
 * 実行するには `shell: true` が要り、そうすると引数がシェルの構文として解釈される。
 * 引用符の扱いに穴が開き、指示文やパスに含まれる記号が意味を持ってしまう。
 * このアプリでいちばん危ないのは「ブラウザ越しにコードが実行されること」なので、
 * シェルを通す経路を最初から作らない。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

/** 版を確かめるときの待ち時間。localhost ですらない（ただのプロセス起動）ので短くてよい。 */
const VERSION_TIMEOUT_MS = 5000;

/**
 * 1行の上限（バイトではなく文字数）。
 *
 * 大きな `tool_result` は1行で来る。5MB のファイルを Read させれば、その中身が1行に乗る。
 * 際限なく溜めると、届いた瞬間にメモリを持っていかれる。
 * 超えた行は捨てて次の改行から読み直し、**捨てた数を数えて画面に出す**（黙って捨てない）。
 */
export const LINE_MAX = 4 * 1024 * 1024;

/**
 * 掴めたかどうかの言い方。
 *
 * 日本語を画面側に持たせないのは STATE_LABELS と同じ方針。
 * 語彙を1つ増やすときに直す場所を1箇所にしておく。
 */
export const CLAUDE_STATE_LABELS = Object.freeze({
  checking: '確認しています',
  ok: '使えます',
  missing: '見つかりません',
  error: '確かめられませんでした',
});

/**
 * いま分かっていること。`claudeInfo()` が返す中身の実体。
 *
 * 起動時に1回だけ書き換える。以降は読むだけ。
 */
let info = { state: 'checking', ok: null, path: null, source: null, version: null, reason: null };

/**
 * `PATH` を要素に割る。
 *
 * 環境変数の名前が大小まちまち（Windows は `Path`、POSIX は `PATH`）なので全部見る。
 * 要素に引用符が付いていることがあるので剥がす。
 *
 * @param {object} env 環境変数
 * @param {string} platform 'win32' など
 * @returns {string[]}
 */
function pathEntries(env, platform) {
  const raw = env?.PATH ?? env?.Path ?? env?.path ?? '';
  if (typeof raw !== 'string' || !raw) return [];
  const sep = platform === 'win32' ? ';' : ':';
  return raw.split(sep)
    .map((s) => s.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

/**
 * `.cmd` / `.bat` か。
 *
 * @param {string} file パス
 * @returns {boolean}
 */
function isBatch(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === '.cmd' || ext === '.bat';
}

/**
 * claude の実行ファイルを探す。
 *
 * 順番は「明示 → PATH → 既定の置き場所」。
 * 環境変数で指した先が無いときに**黙って次へ落ちない**のが要点で、
 * 落とすと「指定したのに違うものが動いている」という、いちばん気づきにくい形になる。
 *
 * @param {object} [opts]
 * @param {object} [opts.env] 環境変数
 * @param {string} [opts.platform] 'win32' など
 * @param {Function} [opts.exists] ファイルの有無を見る関数。テストから差し替える
 * @returns {{path:string|null, source:'env'|'path'|'home'|'none', reason:string|null}}
 */
export function resolveClaudeBin({
  env = process.env, platform = process.platform, exists = fs.existsSync,
} = {}) {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const names = win ? ['claude.exe', 'claude'] : ['claude'];

  // 1. 明示された場所。ここが外れたら理由を返して止まる
  const fromEnv = typeof env?.CLAUDE_DECK_CLAUDE_BIN === 'string'
    ? env.CLAUDE_DECK_CLAUDE_BIN.trim().replace(/^"(.*)"$/, '$1')
    : '';
  if (fromEnv) {
    if (isBatch(fromEnv)) {
      return {
        path: null,
        source: 'none',
        reason: 'CLAUDE_DECK_CLAUDE_BIN が .cmd / .bat を指しています（実行ファイルを指定してください）',
      };
    }
    if (!exists(fromEnv)) {
      return {
        path: null,
        source: 'none',
        reason: `CLAUDE_DECK_CLAUDE_BIN の場所にファイルがありません（${fromEnv}）`,
      };
    }
    return { path: fromEnv, source: 'env', reason: null };
  }

  // 2. PATH を順に見る。`where` を起こさずに自分で走査する（プロセスを1つ増やさない）
  for (const dir of pathEntries(env, platform)) {
    for (const name of names) {
      const file = p.join(dir, name);
      if (!isBatch(file) && exists(file)) return { path: file, source: 'path', reason: null };
    }
  }

  // 3. 既定の置き場所。PATH を通していない人がここに落ちる
  const home = typeof env?.USERPROFILE === 'string' ? env.USERPROFILE
    : (typeof env?.HOME === 'string' ? env.HOME : '');
  if (home) {
    for (const name of names) {
      const file = p.join(home, '.local', 'bin', name);
      if (exists(file)) return { path: file, source: 'home', reason: null };
    }
  }

  return { path: null, source: 'none', reason: 'claude が見つかりません' };
}

/**
 * `claude --version` の出力から版だけ取り出す。
 *
 * 実物はこう返す（実測 2026-08-12）。
 *
 *   2.1.228 (Claude Code)
 *
 * 括弧の中は将来変わりうるので見ない。**先頭の数字の並びだけ**を採る。
 *
 * @param {string} out 標準出力
 * @returns {string|null} 読めなければ null
 */
export function parseClaudeVersion(out) {
  if (typeof out !== 'string') return null;
  const m = out.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return m ? m[0] : null;
}

/**
 * 掴めているかどうかを同期で返す。
 *
 * **`/api/health` を同期のまま保つための窓口。** あそこはランチャの生存確認にも使われていて、
 * 即答することが前提になっている。ここで `await` すると、その前提が崩れる。
 *
 * `ok` は3値。確認中は `null` にしてある（0 と不明を分ける原則と同じで、
 * まだ確かめていないことを「使えない」と書かない）。
 *
 * @returns {{state:string, ok:boolean|null, path:string|null, source:string|null,
 *            version:string|null, reason:string|null, label:string}}
 */
export function claudeInfo() {
  return { ...info, label: CLAUDE_STATE_LABELS[info.state] ?? info.state };
}

/**
 * 版を1回だけ確かめて、結果を持っておく。
 *
 * 起動時に投げっぱなしで呼ぶ。**失敗しても本体を落とさない**（必ず解決する Promise を返す）。
 * 掴めていなくてもダッシュボードとしては動くので、ここで止める理由が無い。
 *
 * @param {object} [opts]
 * @param {object} [opts.env] 環境変数
 * @param {string} [opts.platform] 'win32' など
 * @param {Function} [opts.exists] ファイルの有無を見る関数
 * @param {Function} [opts.spawnFn] spawn。テストから差し替える
 * @returns {Promise<object>} claudeInfo() と同じ形
 */
export function probeClaude({
  env = process.env, platform = process.platform, exists = fs.existsSync, spawnFn = spawn,
} = {}) {
  const found = resolveClaudeBin({ env, platform, exists });

  if (!found.path) {
    info = {
      state: 'missing', ok: false, path: null, source: found.source,
      version: null, reason: found.reason,
    };
    return Promise.resolve(claudeInfo());
  }

  return new Promise((resolve) => {
    // focus.mjs と同じ作法。'error' と 'close' の両方が来ても1回しか確定しない
    let done = false;
    const finish = (next) => {
      if (done) return;
      done = true;
      info = next;
      resolve(claudeInfo());
    };

    let child;
    try {
      child = spawnFn(found.path, ['--version'], { windowsHide: true });
    } catch (e) {
      // spawn が同期で投げることがある（引数の型が違うときなど）
      finish({
        state: 'error', ok: false, path: found.path, source: found.source,
        version: null, reason: String(e?.message ?? e),
      });
      return;
    }

    let out = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d) => { out += d; });
    // stderr は読み捨てる。読まないと相手のパイプが詰まって終われなくなる
    child.stderr?.on('data', () => {});

    child.on('error', (e) => finish({
      state: 'error', ok: false, path: found.path, source: found.source,
      version: null, reason: String(e?.message ?? e),
    }));

    child.on('close', (code) => {
      const version = parseClaudeVersion(out);
      if (code === 0 && version) {
        finish({
          state: 'ok', ok: true, path: found.path, source: found.source, version, reason: null,
        });
        return;
      }
      finish({
        state: 'error',
        ok: false,
        path: found.path,
        source: found.source,
        // 版が読めなくても掴めてはいるので、path は残したまま理由だけ書く
        version,
        reason: code === 0 ? '版を読み取れませんでした' : `--version が ${code} で終わりました`,
      });
    });

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* すでに終わっている */ }
      finish({
        state: 'error', ok: false, path: found.path, source: found.source,
        version: null, reason: '応答がありませんでした',
      });
    }, VERSION_TIMEOUT_MS);
    child.on('close', () => clearTimeout(timer));
    child.on('error', () => clearTimeout(timer));
  });
}

/**
 * 届いたバイト列を行に割る。
 *
 * stdout は**行の切れ目とは無関係に**届く。1行が3チャンクに割れることも、
 * 5行が1チャンクで来ることもある。だから受け取った側で組み直す必要がある。
 *
 * 呼ぶ側は `child.stdout.setEncoding('utf8')` を必ず先に呼ぶこと。
 * 素の Buffer を `toString()` すると、チャンクの境目で日本語が割れる。
 *
 * 空行は落とす。parse/stream.mjs が「空行は呼ぶ側で落としてから渡すこと」と決めているので、
 * その責任をここで果たす。
 *
 * @param {object} [opts]
 * @param {number} [opts.max] 1行の上限（文字数）
 * @returns {{push:(chunk:string)=>string[], flush:()=>string[], dropped:number}}
 */
export function createLineSplitter({ max = LINE_MAX } = {}) {
  let buf = '';
  let dropped = 0;
  // 上限を超えた行を読み飛ばしている最中か。次の改行まで捨て続ける
  let skipping = false;

  const api = {
    /**
     * チャンクを1つ食わせて、確定した行を返す。
     *
     * @param {string} chunk 届いたもの
     * @returns {string[]} 完成した行（空行と上限超えは含まない）
     */
    push(chunk) {
      if (typeof chunk !== 'string' || !chunk) return [];
      const lines = [];
      let rest = chunk;

      while (rest) {
        const nl = rest.indexOf('\n');

        if (nl < 0) {
          // まだ行が終わっていない
          if (skipping) break;
          buf += rest;
          if (buf.length > max) {
            // ここで捨てると決める。次の改行まで読み飛ばす
            buf = '';
            skipping = true;
            dropped += 1;
          }
          break;
        }

        const head = rest.slice(0, nl);
        rest = rest.slice(nl + 1);

        if (skipping) {
          // 捨てている途中。この改行で再同期して、次の行から読み直す
          skipping = false;
          continue;
        }

        // \r は trim で落ちる（CRLF で来ても行の中身は変わらない）
        const line = (buf + head).trim();
        buf = '';
        if (!line) continue;
        if (line.length > max) {
          dropped += 1;
          continue;
        }
        lines.push(line);
      }

      return lines;
    },

    /**
     * 相手が閉じたときに、改行の付いていない最後の1行を取り出す。
     *
     * @returns {string[]} 残っていなければ空配列
     */
    flush() {
      if (skipping) {
        // 捨てている途中で閉じた。改行が来ないので、ここで諦める
        skipping = false;
        buf = '';
        return [];
      }
      const line = buf.trim();
      buf = '';
      if (!line) return [];
      if (line.length > max) {
        dropped += 1;
        return [];
      }
      return [line];
    },
  };

  // 捨てた数は読むだけ。外から書き換えられないようにしておく
  Object.defineProperty(api, 'dropped', { get: () => dropped, enumerable: true });
  return api;
}
