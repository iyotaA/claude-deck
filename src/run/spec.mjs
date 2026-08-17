/**
 * 画面から来た「こう起こしてほしい」を検証して、claude.exe へ渡す argv に組み立てる。
 *
 * ここは純関数だけにする（`shared/` 以外を import しない）。
 * 実際に起こすのは os/claude.mjs、配線するのは run/index.mjs。
 *
 * ## この層が防いでいるもの
 *
 * この機能が増やす被害は、これまでとは質が違う。
 * これまでの窓口は「読み取り専用のダッシュボードの表示が変わる」までだったが、
 * ここは**コードが実行される**。ブラウザ越しに任意のフォルダで agent を起こせる形にしてはいけない。
 *
 * だから外から来た値は、全部この1枚で受けてから先へ渡す。
 *
 * - cwd は**許可リストの配下だけ**。任意の文字列を受けない
 * - 権限モードは語彙で固定。`manual` は選ばせない（許可要求の返し方が未確認なため）
 * - `bypassPermissions` は環境変数が立っているときだけ語彙に入る
 * - **`-` で始まる値はどの項目でも弾く**。argv は配列で渡すので `shell` の穴は無いが、
 *   `--model` の値が `--dangerously-skip-permissions` だったら commander は
 *   それを**別のフラグとして読む**。値の位置に置いたつもりが、フラグが1本増える
 * - 指示文は argv に載せない。stdin へ JSON の1行として書く（組むのは parse/stream.mjs）
 *
 * ## `--verbose` は必須（実測 2026-08-12・claude 2.1.228）
 *
 * `--print --output-format stream-json` だけだと、こう言われて exit 1 になる。
 *
 *   Error: When using --print, --output-format=stream-json requires --verbose
 *
 * **stdout は1行も出ない。** 付け忘れると「起こしたのに無言で死ぬ」という
 * いちばん分かりにくい壊れ方になるので、組み立て側で必ず付ける（画面から外せる口も作らない）。
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isSwitchOn } from '../shared/env.mjs';

/**
 * 画面に出す権限モード。
 *
 * `manual` を入れない。非対話で許可要求が来たときの返し方（`control_response` の形と
 * `request_id` の対応付け）が確かめられていない。当てずっぽうで実装すると、
 * 要求に答えられないまま止まったプロセスが残り、画面には「実行中」と出続ける。
 * このアプリが最もやってはいけない壊れ方なので、分かるまで出さない。
 */
export const PERMISSION_MODES = Object.freeze(['plan', 'acceptEdits', 'auto']);

/**
 * 環境変数が立っているときだけ語彙に加わるモード。
 *
 * ブラウザから押せる「許可を一切求めずに何でも実行する」ボタンは、
 * このアプリが持ちうる最も危険なもの。既定では語彙にすら入れない。
 */
export const BYPASS_MODE = 'bypassPermissions';

/** 何も指定しなければこれ。読むだけなので何も壊れない。 */
export const DEFAULT_PERMISSION_MODE = 'plan';

/**
 * 画面に出す日本語。
 *
 * サーバー側に置くのは STATE_LABELS の前例に倣ったもの。
 * 語彙を1つ増やすときに直す場所を1箇所にしておく。
 */
export const PERMISSION_MODE_LABELS = Object.freeze({
  plan: '読むだけ（書き換えない）',
  acceptEdits: 'ファイルの変更まで自動で通す',
  auto: 'おまかせ（Claude が自分で判断する）',
  [BYPASS_MODE]: '何も聞かずに全部実行する（危険）',
});

/** CLI の `--effort` の語彙。実物の --help から採った。 */
export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/** ボタン1つで金が減る機能なので、既定で上限を掛ける。 */
export const DEFAULT_BUDGET_USD = 5;

/** 下限。これ未満だと何もできずに終わるだけなので、下限で受ける。 */
export const BUDGET_MIN_USD = 0.01;

/** 上限。押し間違いの被害を、その場で気づける額に抑える。 */
export const BUDGET_MAX_USD = 50;

/**
 * 指示文の長さの上限（文字数）。
 *
 * 窓口の受け取り上限は 256KB（RUN_BODY_MAX）。日本語は UTF-8 で1文字3バイトなので、
 * 64,000 文字なら最悪でも 192KB に収まり、他の項目を足しても body に収まる。
 */
export const PROMPT_MAX = 64000;

/** モデル名の上限。alias（'opus'）と full name の両方が来る。 */
const MODEL_MAX = 64;

/**
 * モデル名として通す形。
 *
 * **許可リストは持たない。** 新しいモデルが出るたびに古くなり、
 * 「使えるはずのモデルが画面から選べない」という直しにくい形になる。
 * ここで見るのは文字種と長さだけにして、実際に使えるかは CLI に判断させる。
 * 先頭を英数字に限っているので、`-` で始まる値はここで落ちる。
 */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** セッション ID は UUID。CLI が "must be a valid UUID" と言うので、こちらでも同じ形を見る。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 文字列として受け取り、前後の空白を落とす。
 *
 * @param {*} v 何か
 * @returns {string} 文字列でなければ空文字
 */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * argv の値として危ない形か。`-` で始まるものがそれ。
 *
 * 配列で渡している限りシェルは通らないが、commander は値の位置にあっても
 * `-` で始まる語をフラグとして読む。値のつもりが**フラグを1本増やす**ことになる。
 *
 * **空文字へ丸めて黙って落とさない。** 落とすと「指定したのに既定で動いた」になり、
 * 画面には何も出ないまま違うモデルで走る。0 と不明を分けるのと同じ理由で、断って理由を出す。
 *
 * @param {string} s str() を通した値
 * @returns {boolean}
 */
function flagLike(s) {
  return s.startsWith('-');
}

/**
 * その環境で選べる権限モードの一覧。
 *
 * @param {object} [env] 環境変数
 * @returns {string[]} 画面の選択肢にそのまま使える並び
 */
export function allowedModes(env = process.env) {
  const modes = [...PERMISSION_MODES];
  if (isSwitchOn(env?.CLAUDE_DECK_RUN_ALLOW_BYPASS)) modes.push(BYPASS_MODE);
  return modes;
}

/**
 * セッション ID の形をしているか。
 *
 * @param {*} v 何か
 * @returns {boolean}
 */
export function isSessionId(v) {
  return typeof v === 'string' && UUID_RE.test(v.trim());
}

/**
 * 新しいセッション ID を作る。
 *
 * **起こす前にこちらで決める。** ID が先に決まっていれば、起動したその瞬間から
 * 既存の一覧・詳細・`?session=` がそのまま使える。設計の土台になっている。
 *
 * @returns {string}
 */
export function newSessionId() {
  return randomUUID();
}

/**
 * 環境変数から、追加で許可するフォルダを読む。
 *
 * `;` 区切り。絶対パスでないものは黙って落とす（相対パスは
 * 「誰から見た相対か」が起動のされ方で変わるので、許可リストに使えない）。
 *
 * @param {object} [env] 環境変数
 * @param {string} [platform] 'win32' など。テストから差し替える
 * @returns {string[]}
 */
export function runDirsFromEnv(env = process.env, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  return str(env?.CLAUDE_DECK_RUN_DIRS)
    .split(';')
    .map((s) => str(s))
    .filter((s) => s && p.isAbsolute(s));
}

/**
 * base の中に target があるか。
 *
 * **`startsWith` を使わない。** 文字列の前方一致だと `C:\work` と `C:\work2` を
 * 親子と見てしまう。プランのパス検証と同じ理由で `path.relative` を使う。
 *
 * @param {object} p path.win32 か path.posix
 * @param {string} base 許可するフォルダ（絶対パス・正規化済み）
 * @param {string} target 調べるフォルダ（絶対パス・正規化済み）
 * @param {string} platform 'win32' なら大小を無視する
 * @returns {boolean} base 自身も真
 */
function contains(p, base, target, platform) {
  const a = platform === 'win32' ? base.toLowerCase() : base;
  const b = platform === 'win32' ? target.toLowerCase() : target;
  const rel = p.relative(a, b);
  // '' は base 自身。'..' で始まるものは外。絶対パスが返るのは別ドライブ
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}

/**
 * 作業フォルダを決める。許可リストの配下だけを通す。
 *
 * 入力側も許可リスト側も**絶対パスを必須**にしてある。
 * こうすると `path.resolve` が `process.cwd()` を見に行かなくなり、
 * サーバーをどこから起こしたかで判定が変わることが無くなる。
 *
 * @param {*} input 画面から来た値
 * @param {object} [opts]
 * @param {string[]} [opts.allowedDirs] 許可するフォルダ（一覧の cwd ＋ 環境変数）
 * @param {string} [opts.platform] 'win32' など
 * @returns {{ok:boolean, cwd:string|null, reason:string|null}}
 */
export function resolveCwd(input, { allowedDirs = [], platform = process.platform } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const raw = str(input);

  if (!raw) return { ok: false, cwd: null, reason: '作業フォルダが指定されていません' };
  if (flagLike(raw) || !p.isAbsolute(raw)) {
    return { ok: false, cwd: null, reason: '作業フォルダは絶対パスで指定してください' };
  }

  // 末尾の区切りと '..' はここで畳まれる
  const target = p.resolve(raw);

  for (const dir of allowedDirs) {
    const base = str(dir);
    if (!base || !p.isAbsolute(base)) continue;
    if (contains(p, p.resolve(base), target, platform)) {
      return { ok: true, cwd: target, reason: null };
    }
  }

  // どのフォルダなら通るかは返さない。画面には選択肢を別途出しているので、
  // ここで一覧を返す必要が無い
  return { ok: false, cwd: null, reason: 'このフォルダでは起動できません' };
}

/**
 * 予算を範囲に丸める。
 *
 * 400 で断らずに丸めるのは parseArchiveQuery と同じ作法。
 * 上限は下げる方向、下限は上げる方向にしか動かないので、丸めても危ないほうへは倒れない。
 *
 * @param {*} v 画面から来た値
 * @returns {number} セント単位まで
 */
function budgetUsd(v) {
  const n = typeof v === 'number' ? v : Number(str(v));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BUDGET_USD;
  const clamped = Math.min(BUDGET_MAX_USD, Math.max(BUDGET_MIN_USD, n));
  // 浮動小数のごみを CLI へ渡さない（0.1+0.2 の類）
  return Math.round(clamped * 100) / 100;
}

/**
 * argv を組む。
 *
 * **並びを変えない。** テストで丸ごと突き合わせているので、順番が変わればそこで落ちる。
 * 「動くけれど並びが違う」を黙って通すと、次に読む人が
 * どちらが正しい並びなのか確かめる手立てを失う。
 *
 * @param {object} spec 検証済みの起動指定
 * @returns {string[]}
 */
function buildArgs(spec) {
  const args = [
    '--print',
    // stream-json の出力にはこれが要る（実測。無いと exit 1 で stdout が空のまま死ぬ）
    '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    // 自分が書いた行が返ってくる。「書けたのに読まれていない」と
    // 「読まれたが応答が無い」を切り分けられる
    '--replay-user-messages',
    '--permission-mode', spec.permissionMode,
    // --print と一緒でないと効かない。こちらは常に --print なので必ず効く
    '--max-budget-usd', String(spec.budgetUsd),
  ];

  // 新規は自分で決めた ID を渡す。続きは --resume。どちらも ID は変わらない
  if (spec.resume) args.push('--resume', spec.sessionId);
  else args.push('--session-id', spec.sessionId);

  if (spec.model) args.push('--model', spec.model);
  if (spec.effort) args.push('--effort', spec.effort);

  return args;
}

/**
 * 画面から来た指定を検証して、起動に必要なものを全部組んで返す。
 *
 * セッション ID の扱いだけ、新規と続きで分けてある。
 *
 * - 新規 … **こちらで作る。** 画面から来た ID は見ない。
 *   受け取ると、既存のセッションの ID を指定して他人の会話ログへ追記させられる
 * - 続き … 画面から来た ID を使う（そのためのものなので）
 *
 * 指示文を必須にしているのは実測から。空の stdin で起こすと `system/init` すら出ずに
 * 終わるので、起こす意味が無い。
 *
 * @param {object} input 画面から来たもの（cwd / prompt / model / effort / permissionMode /
 *                       budgetUsd / resume / sessionId）
 * @param {object} [ctx]
 * @param {string[]} [ctx.allowedDirs] 許可するフォルダ
 * @param {object} [ctx.env] 環境変数
 * @param {string} [ctx.platform] 'win32' など
 * @param {Function} [ctx.newId] ID を作る関数。テストから固定するために外から渡せる
 * @returns {{ok:true, spec:object}|{ok:false, reason:string}}
 */
export function buildRunSpec(input = {}, {
  allowedDirs = [], env = process.env, platform = process.platform, newId = newSessionId,
} = {}) {
  const src = (input && typeof input === 'object') ? input : {};

  const cwd = resolveCwd(src.cwd, { allowedDirs, platform });
  if (!cwd.ok) return { ok: false, reason: cwd.reason };

  const prompt = typeof src.prompt === 'string' ? src.prompt.trim() : '';
  if (!prompt) return { ok: false, reason: '指示が空です' };
  if (prompt.length > PROMPT_MAX) {
    return { ok: false, reason: `指示が長すぎます（${PROMPT_MAX} 文字まで）` };
  }

  const modes = allowedModes(env);
  const rawMode = str(src.permissionMode) || DEFAULT_PERMISSION_MODE;
  if (!modes.includes(rawMode)) {
    // bypass だけは理由を分けて出す。語彙に無いのではなく、この環境で出していないだけなので
    const reason = rawMode === BYPASS_MODE
      ? 'このモードは環境変数で許可されていません'
      : '権限モードの指定が不正です';
    return { ok: false, reason };
  }

  const model = str(src.model);
  if (model && (flagLike(model) || model.length > MODEL_MAX || !MODEL_RE.test(model))) {
    return { ok: false, reason: 'モデルの指定が不正です' };
  }

  const effort = str(src.effort);
  if (effort && (flagLike(effort) || !EFFORTS.includes(effort))) {
    return { ok: false, reason: '思考量の指定が不正です' };
  }

  const resume = src.resume === true;
  let sessionId;
  if (resume) {
    if (!isSessionId(src.sessionId)) {
      return { ok: false, reason: '続けるセッションの指定が不正です' };
    }
    sessionId = str(src.sessionId).toLowerCase();
  } else {
    // 画面から来た ID は使わない（他人のログへ追記させられるため）
    sessionId = newId();
  }

  const spec = {
    sessionId,
    cwd: cwd.cwd,
    prompt,
    permissionMode: rawMode,
    model: model || null,
    effort: effort || null,
    budgetUsd: budgetUsd(src.budgetUsd),
    resume,
  };
  spec.args = buildArgs(spec);

  return { ok: true, spec };
}

/** 切り替えで差し替えてよいキー。ここに `cwd` と `sessionId` を足さない */
const SWITCHABLE = Object.freeze(['model', 'effort', 'permissionMode']);

/** 断るときの言い方。キー名をそのまま出すと、画面を見ている人には読めない */
const SWITCH_LABELS = Object.freeze({
  model: 'モデル',
  effort: '思考量',
  permissionMode: '権限モード',
});

/**
 * 動いている run の起動指定に、画面から来た差分を重ねる。
 *
 * 値そのものが使えるかは見ない。**そこは `buildRunSpec` の仕事で、二重に書かない。**
 * ここで決めるのは「どのキーを、どう重ねるか」だけ。
 *
 * 3通りを分けて扱う。
 *
 * - キーが無い … 変えない
 * - `null` か空文字 … 外す（`model` と `effort` だけ。既定に戻る）
 * - 文字列 … 差し替える
 *
 * `permissionMode` だけ外せないのは、外した先が「既定」だから。
 * `plan` のつもりが `acceptEdits` で走る（その逆も）という、いちばん高くつく事故になる。
 *
 * 文字列でも `null` でもない値（数値・配列・真偽値）は空へ丸めずに断る。
 * 丸めると「指定したのに外れた」が画面のどこにも出ない。
 *
 * @param {object} prev いまの spec
 * @param {object} patch 画面から来た差分
 * @returns {{ok:true, next:object, changed:string[]}|{ok:false, reason:string}}
 */
export function mergeSwitch(prev, patch) {
  const src = (patch && typeof patch === 'object' && !Array.isArray(patch)) ? patch : null;
  if (!src) return { ok: false, reason: '切り替える内容がありません' };

  const next = { ...prev };
  const changed = [];

  for (const key of SWITCHABLE) {
    if (!(key in src)) continue;
    const raw = src[key];
    if (raw !== null && typeof raw !== 'string') {
      return { ok: false, reason: `${SWITCH_LABELS[key]}の指定が不正です` };
    }

    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
      if (key === 'permissionMode') {
        return { ok: false, reason: '権限モードは外せません' };
      }
      if ((next[key] ?? null) === null) continue;
      next[key] = null;
      changed.push(key);
      continue;
    }

    if (next[key] === value) continue;
    next[key] = value;
    changed.push(key);
  }

  // 同じ指定で起こし直すのは、ただ会話を1回中断するだけで得るものが無い。
  // 続きを書きたいだけなら `POST /api/runs/:id/input` のほうが速い
  if (changed.length === 0) return { ok: false, reason: '切り替える内容がありません' };

  return { ok: true, next, changed };
}
