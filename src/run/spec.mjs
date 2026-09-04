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
 * - 権限モードは語彙で固定。値を確かめるのは `checkPermissionMode()` の1箇所
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
import { isPlainObject } from '../shared/objects.mjs';

/**
 * 画面に出す権限モード。**危なくない順に並べる。** 画面の選択肢もこの順で出る。
 *
 * **argv の語彙と control の語彙は別物**（どちらも実測）。
 * `--permission-mode manual` で起こしても `system/init` は `"default"` と名乗り、
 * `set_permission_mode` の側は `manual` を受け付けて `default` に正規化する。
 * 逆に argv 側には `default` が無い。
 *
 * **それでも読み替え表は作らない。** 台帳は `system/init` の `permissionMode` を読んでいない
 * （`run.permissionMode` が動くのは起動指定と `set_permission_mode` の受理だけ）ので、
 * 食い違う場所が無い。使われない読み替え表が一番古くなる。
 */
export const PERMISSION_MODES = Object.freeze(['plan', 'manual', 'acceptEdits', 'auto']);

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
 * 画面に出す言い方。**CLI の名前を主にして、日本語は括弧で補う。**
 *
 * 普段ターミナルで見ているのは `plan mode on` のような英語のほうで、
 * 日本語だけだと画面と手元が別の言葉になる。並べるのは同じものだと分かるようにする。
 *
 * `on` は「いま入っている」という状態の話なので**ここには入れない。**
 * 画面が「いま: 」を前に置く。語彙を2本（選択肢用と状態用）にすると直す場所が2箇所になる。
 *
 * `acceptEdits` の括弧が変わったのは文言の好みではなく、**挙動が実際に変わったから。**
 * 前の「ファイルの変更まで自動で通す」は「Bash は断って先へ進む」を前提にしていて、
 * `--permission-prompt-tool stdio` を付けた時点で嘘になっている（いまは確認が画面に出る）。
 *
 * サーバー側に置くのは STATE_LABELS の前例に倣ったもの。
 * 語彙を1つ増やすときに直す場所を1箇所にしておく。
 */
export const PERMISSION_MODE_LABELS = Object.freeze({
  plan: 'plan mode（読むだけ・書き換えない）',
  manual: 'manual mode（毎回確認する）',
  acceptEdits: 'accept edits（ファイル変更は自動・コマンドは確認）',
  auto: 'auto mode（Claude が判断・危ないものだけ確認）',
  [BYPASS_MODE]: 'bypass permissions（何も確認しない・危険）',
});

/** CLI の `--effort` の語彙。実物の --help から採った。 */
export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * 予算の既定（USD）。**画面の欄に最初から入る値**でもある。
 *
 * 5 では足りなかった。実プロジェクト（1指示の途中で compact が2回走る規模）で
 * 13往復・$6.52 かかって予算切れになり、`--resume` で起こし直したほうも $6.09 で同じ死に方をした。
 * 合計 $12.6 使って1つも仕事が終わらないので、実測の3倍を既定にしてある。
 *
 * ボタン1つで金が減る機能なので、既定では上限を掛ける側に倒す。
 * 掛けたくなければ欄を空にする（`budgetUsd()` を見よ）。
 */
export const DEFAULT_BUDGET_USD = 20;

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
 * 権限モードの値を1つ確かめる。
 *
 * **`buildRunSpec()`（起こすとき）と `POST /api/runs/:id/mode`（途中で替えるとき）で共有する。**
 * bypass だけ断り方が違うので、2箇所に書くと必ず片方が古くなる。
 *
 * 既定へ倒すのは呼び出し側の仕事にしてある。起こすときは `plan` に倒すが、
 * 途中で替えるときに空を `plan` と読むと**押し間違いで読み取り専用に落ちる。**
 *
 * @param {*} raw 画面から来た値
 * @param {object} [env] 環境変数
 * @returns {{ok: true, mode: string} | {ok: false, reason: string}}
 */
export function checkPermissionMode(raw, env = process.env) {
  const mode = str(raw);
  if (!mode) return { ok: false, reason: '権限モードの指定がありません' };
  if (allowedModes(env).includes(mode)) return { ok: true, mode };
  // bypass だけは理由を分けて出す。語彙に無いのではなく、この環境で出していないだけなので
  return {
    ok: false,
    reason: mode === BYPASS_MODE
      ? 'このモードは環境変数で許可されていません'
      : '権限モードの指定が不正です',
  };
}

/**
 * モデルの値を1つ確かめる。こちらも起こすときと途中で替えるときで共有する。
 *
 * **空を通さない。** 起こすときは指定しない道（CLI の既定に任せる）があるので、
 * 呼ぶかどうかを呼び出し側が決める。
 *
 * @param {*} raw 画面から来た値
 * @returns {{ok: true, model: string} | {ok: false, reason: string}}
 */
export function checkModel(raw) {
  const model = str(raw);
  if (!model) return { ok: false, reason: 'モデルの指定がありません' };
  if (flagLike(model) || model.length > MODEL_MAX || !MODEL_RE.test(model)) {
    return { ok: false, reason: 'モデルの指定が不正です' };
  }
  return { ok: true, model };
}

/**
 * 指示文を確かめる。前後の空白は落とす。
 *
 * 起こすとき（`buildRunSpec`）・1行送るとき・切り替えるときの3箇所で同じ検証をしていた。
 * **文言まで同じ**だったので、片方だけ上限を変えると
 * 同じ長さの指示が窓口によって通ったり通らなかったりする形になっていた。
 *
 * `flagLike` は見ない。指示文は argv に乗らず stdin へ流すので、
 * `-` 始まりでも旗と解釈される余地が無い。
 *
 * @param {*} raw 画面から来た指示文
 * @returns {{ok:true, prompt:string}|{ok:false, reason:string}}
 */
export function checkPrompt(raw) {
  const prompt = typeof raw === 'string' ? raw.trim() : '';
  if (!prompt) return { ok: false, reason: '指示が空です' };
  if (prompt.length > PROMPT_MAX) {
    return { ok: false, reason: `指示が長すぎます（${PROMPT_MAX} 文字まで）` };
  }
  return { ok: true, prompt };
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
 * 予算を決める。**指定が無ければ「上限なし」。**
 *
 * 以前は未指定も壊れた値もまとめて既定（当時 $5）へ倒していた。
 * それだと「上限を外したつもりが $5 で止まる」ことになり、実際にそれで踏んだ
 * （画面の欄には既定値が最初から入るので、消しても既定へ戻っていた）。
 * **0 と不明を分けるのと同じ扱いで、指定が無いことを値に化けさせない。**
 *
 * 3通りに分ける。
 *
 * - キーが無い・`null`・空文字 … `null`（`--max-budget-usd` を付けない）
 * - 読める数値 … 範囲に丸める。400 で断らないのは parseArchiveQuery と同じ作法で、
 *   上限は下げる方向・下限は上げる方向にしか動かないので危ないほうへは倒れない
 * - 読めない値 … **断る。** 黙って上限なしにすると、打ち間違いが「歯止め無しで走る」に化ける。
 *   丸めてよいのは範囲外の数値までで、数として読めないものは別の扱いにする
 *
 * @param {*} v 画面から来た値
 * @returns {{ok:true, value:number|null}|{ok:false, reason:string}} value は USD かセント単位、
 *          または上限なしの null
 */
function budgetUsd(v) {
  // str() は文字列以外を '' にするので、数値より先に通してはいけない（20 が「上限なし」に化ける）
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v === 'string' && v.trim() === '') return { ok: true, value: null };

  const n = typeof v === 'number' ? v : Number(str(v));
  if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: '予算の指定が不正です' };

  const clamped = Math.min(BUDGET_MAX_USD, Math.max(BUDGET_MIN_USD, n));
  // 浮動小数のごみを CLI へ渡さない（0.1+0.2 の類）
  return { ok: true, value: Math.round(clamped * 100) / 100 };
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
    // 許可要求をこちらへ寄越させる（実測 2026-08-25・claude 2.1.243）。
    // **受け取る値は `stdio` の1語だけ。** 実物の検証関数がそれ以外を unsupported で弾くので、
    // 画面から選ばせずここに文字列で書く（`--verbose` と同じ扱い）。
    //
    // **外すと plan で起こしたセッションが Bash / Edit の手前で必ず止まる。**
    // 許可要求がホストへ届かず CLI が拒否に倒すため。実際にそれで踏んだ
    '--permission-prompt-tool', 'stdio',
  ];

  // 上限を指定したときだけ付ける。**付けなければ CLI 側も上限なしで走る。**
  // 空欄を既定値へ化けさせないための分岐で、ここだけは並びが動く（テストに両方の形がある）。
  // --print と一緒でないと効かない。こちらは常に --print なので必ず効く
  if (spec.budgetUsd !== null) args.push('--max-budget-usd', String(spec.budgetUsd));

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

  const checkedPrompt = checkPrompt(src.prompt);
  if (!checkedPrompt.ok) return { ok: false, reason: checkedPrompt.reason };
  const prompt = checkedPrompt.prompt;

  // 起こすときだけ、空を既定へ倒してから確かめる
  const rawMode = str(src.permissionMode) || DEFAULT_PERMISSION_MODE;
  const checkedMode = checkPermissionMode(rawMode, env);
  if (!checkedMode.ok) return { ok: false, reason: checkedMode.reason };

  // モデルは指定しない道がある（CLI の既定に任せる）ので、空のときは確かめない
  const model = str(src.model);
  if (model) {
    const checkedModel = checkModel(model);
    if (!checkedModel.ok) return { ok: false, reason: checkedModel.reason };
  }

  const effort = str(src.effort);
  if (effort && (flagLike(effort) || !EFFORTS.includes(effort))) {
    return { ok: false, reason: '思考量の指定が不正です' };
  }

  const budget = budgetUsd(src.budgetUsd);
  if (!budget.ok) return { ok: false, reason: budget.reason };

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
    budgetUsd: budget.value,
    resume,
  };
  spec.args = buildArgs(spec);

  return { ok: true, spec };
}

/**
 * 切り替えで差し替えてよい文字列のキー。ここに `cwd` と `sessionId` を足さない。
 *
 * **`budgetUsd` はここに入れない。** 数値なので、この輪の中では
 * 「文字列でも null でもない値は断る」に引っかかる。下で別に扱う。
 */
const SWITCHABLE = Object.freeze(['model', 'effort', 'permissionMode']);

/** 断るときの言い方。キー名をそのまま出すと、画面を見ている人には読めない */
const SWITCH_LABELS = Object.freeze({
  model: 'モデル',
  effort: '思考量',
  permissionMode: '権限モード',
  budgetUsd: '予算',
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
 * `budgetUsd` は数値なので輪の外で扱う。**替えられる形にしてあるのは、予算切れが終端ではないから。**
 * 上限に当たった run を上げて続ける道がここしか無い（そのまま送ると同じ上限で走り直す。
 * 実測で上限は子ごとに数え直す）。空にすれば上限なしへ外せる。
 *
 * 文字列でも `null` でもない値（数値・配列・真偽値）は空へ丸めずに断る。
 * 丸めると「指定したのに外れた」が画面のどこにも出ない。
 *
 * @param {object} prev いまの spec
 * @param {object} patch 画面から来た差分
 * @returns {{ok:true, next:object, changed:string[]}|{ok:false, reason:string}}
 */
export function mergeSwitch(prev, patch) {
  const src = (isPlainObject(patch)) ? patch : null;
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

  // 予算だけは数値。**丸めたあとの値で比べる**（`budgetUsd()` は範囲へ丸めて小数2桁に切る）。
  // 生の値で比べると、画面から来た '20' といまの 20 が違って見えて、
  // 何も変わらないのに子を畳んで起こし直すことになる
  if ('budgetUsd' in src) {
    const res = budgetUsd(src.budgetUsd);
    if (!res.ok) return { ok: false, reason: res.reason };
    if ((next.budgetUsd ?? null) !== res.value) {
      next.budgetUsd = res.value;
      changed.push('budgetUsd');
    }
  }

  // 同じ指定で起こし直すのは、ただ会話を1回中断するだけで得るものが無い。
  // 続きを書きたいだけなら `POST /api/runs/:id/input` のほうが速い
  if (changed.length === 0) return { ok: false, reason: '切り替える内容がありません' };

  return { ok: true, next, changed };
}
