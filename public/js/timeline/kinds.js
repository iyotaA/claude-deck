/* 時系列の語彙。種類のラベルと、隠す種類の既定。
 *
 * ここは層0（誰にも依存しない）。timeline/ の中にあるが、
 * **timeline/ の外から直に import してよい唯一のファイル**でもある。
 * store.js が初期値（隠している種類）を決めるのに要るため。
 *
 * store.js から timeline/index.js を経由させると index → view → store の循環になる。
 * ここが層0 のままであることが、その循環を切っている根拠。
 */

/* --------------------------------------------------------------- 隠す種類 */

/**
 * 時系列で既定から隠す種類。
 *
 * 足跡（trace）は件数が桁で多い。既定で出すと判断の記録が埋もれる。
 *
 * 拒否リストで持つのが要点。許可リストにすると、サーバが新しい種類を足したときに
 * 既定で見えなくなる。「未知の形で落ちない」は、黙って消えないことも含む。
 * 副産物として「足跡は既定オフ」が特別扱いではなく初期値1つで済む
 */
export const HIDDEN_KINDS_DEFAULT = ['trace'];

/**
 * 隠している種類の初期値を決める。
 *
 * **localStorage には覚えさせない。** ここだけ他の設定（並び順・テーマ・稼働中だけ）と扱いを分ける。
 * 覚えさせると、足跡をいちど押して中を見ただけで既定が永久に壊れる。
 * 「判断の記録が埋もれない」はこのアプリの土台なので、開き直したら既定に戻すほうが安全。
 *
 * 出したままにしたい人は ?hide= を空で付けた URL を開く。
 * 「キーが無い」と「空で付いている」は分けて見るので、空は「何も隠さない」の指定になる。
 * これで「既定のまま」「何も隠さない」「これだけ隠す」の3つを人に渡せる
 *
 * @param {string|null} fromUrl ?hide= の値。付いていなければ null（空文字とは別もの）
 * @returns {Set<string>}
 */
export function initialHiddenKinds(fromUrl = null) {
  if (fromUrl === null) return new Set(HIDDEN_KINDS_DEFAULT);
  return new Set(fromUrl.split(',').map((s) => s.trim()).filter(Boolean));
}

/**
 * ?hide= に書く値。
 *
 * 既定と同じなら null を返す（キーを付けない）。空文字は「何も隠さない」の指定なので、
 * null とは分けて返す。syncQuery() の側でこの2つを見分けてもらう。
 *
 * 隠している種類を引数で受け取るのは、ここから store を見に行くと
 * store.js → kinds.js → store.js の循環になるため。
 * 既定の中身を知っているのはこちらなので、判断だけをここに置く
 *
 * @param {Set<string>} hiddenKinds いま隠している種類（store.hiddenKinds）
 * @returns {string|null}
 */
export function hideQueryValue(hiddenKinds) {
  const hide = [...hiddenKinds].sort().join(',');
  return hide === [...HIDDEN_KINDS_DEFAULT].sort().join(',') ? null : hide;
}

/* ------------------------------------------------------------- 種類のラベル */

export const KIND_LABELS = {
  prompt: 'あなたの指示',
  answer: 'あなたの回答',
  plan: 'プラン',
  denial: '却下・不許可',
  skill: 'スキル',
  agent: 'サブエージェント',
  say: 'Claude',
  compact: '文脈の圧縮',
  error: 'エラー',
  slash: 'コマンド',
  interrupt: 'あなたが中断',
  // Claude 自身が書いた中間報告。機械的に抜き出した記録ではないので、語を分けておく
  recap: 'Claude の中間報告',
  elided: '省略',
  // 足跡から抜き出したファイルの書き換え（splitEdits）。
  // 足跡の直前に置くのは countKinds が宣言順でチップを並べるため。
  // 「何をしたか」の側に寄せて、隠してある足跡と隣り合わせにする
  edit: 'ファイルの書き換え',
  // ふつうのツール呼び出し。既定では隠している（HIDDEN_KINDS_DEFAULT）。
  // 絞り込みのチップにも同じ語が出るので、ここを直せば両方が変わる
  trace: '足跡',
};

/* --------------------------------------------------------------- 印 */

/**
 * 種類 → 印の群。**16 ある種類を5つに丸める。**
 *
 * 種類ごとに割らないのは、13px の丸に 16 通りを描き分けるのが無理だから。
 * それに**種類の名前は印のすぐ右に字で出ている**ので、印の役目は
 * 「読み飛ばすときの手がかり」まででいい。
 *
 * | 群 | 何が入るか | 印 |
 * |---|---|---|
 * | `me`   | 指示・回答・中断・コマンド・却下 | 人 |
 * | `mark` | プラン・スキル・サブエージェント | 書類 |
 * | `hand` | ファイルの書き換え・足跡 | 鉛筆 |
 * | `say`  | Claude の説明・中間報告 | 吹き出し |
 * | `note` | エラー・圧縮・省略 | 三角 |
 *
 * **ここに無い種類は印を持たない**（`markOf` が null を返す）。
 * サーバが種類を1つ足しても、印が消えるだけで行そのものは出る
 * （未知の形で落ちない、と同じ扱い）。
 */
export const KIND_MARK = {
  prompt: 'me',
  answer: 'me',
  interrupt: 'me',
  slash: 'me',
  denial: 'me',

  plan: 'mark',
  skill: 'mark',
  agent: 'mark',

  edit: 'hand',
  trace: 'hand',

  say: 'say',
  recap: 'say',

  error: 'note',
  elided: 'note',
};

/* **`compact` はここに無い。** あれだけは `timelineItem` が列を組む前に
   早期 return する全幅の帯で、時刻も印も出さない。
   書いても誰も引かない ―― 使わないものを表に残すと、次に触る人が
   「なぜ効かないのか」を探すことになる。 */

/**
 * 群そのものの並び・名前・絵。
 *
 * **`KIND_MARK` の値として現れる5つを、ここで1度だけ表にする。**
 * 前は群の名前が上の表のコメントにしか無く、
 * 絞り込みの帯にも説明モーダルの凡例にも出せなかった。
 *
 * 並びは「あなた → 判断 → 手 → 言葉 → 但し書き」で、
 * **自分が動かしたものから順**に置く（読み飛ばすときの手がかり、という印の役目に合わせる）。
 *
 * 絵は `icons.js` の形を借りるだけで、新しくは持たない。
 */
export const MARK_GROUPS = [
  { group: 'me', icon: 'user', label: 'あなた' },
  { group: 'mark', icon: 'doc', label: '判断の節目' },
  { group: 'hand', icon: 'pencil', label: '手が動いた' },
  { group: 'say', icon: 'bubble', label: 'Claude の言葉' },
  { group: 'note', icon: 'alert', label: '但し書き' },
];

/**
 * 群 → アイコンの名前。
 *
 * **上の表から作る。** 手で書くと群を1つ足した日に片方だけ古くなる
 * （色の表と形の表を2つ持たない、と同じ話）。
 */
const MARK_ICON = Object.fromEntries(MARK_GROUPS.map((g) => [g.group, g.icon]));

/**
 * その種類の印を引く。
 *
 * @param {string} kind item.kind
 * @returns {?{group: string, icon: string}} 知らない種類なら null
 */
export function markOf(kind) {
  const group = KIND_MARK[kind];
  return group ? { group, icon: MARK_ICON[group] } : null;
}

/**
 * ファイルを書き換えるツール。
 *
 * **`detail` の中身で判定しない。必ずツール名で割る。**
 * `describeTool`（src/shared/tools.mjs）は Edit / Write / Read / NotebookEdit を
 * 同じ枝で扱っていて、どれも `file_path` をそのまま `detail` に入れる。
 * つまり「パスらしい文字列か」で見ると、読んだだけの Read が書き換えに化ける。
 *
 * MultiEdit は既定の枝に落ちるが、そちらも `file_path` を拾うので同じように出せる
 */
export const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

/**
 * 足跡から「ファイルの書き換え」を独立した種類として抜き出す。
 *
 * 書き換えは足跡（trace）の calls に混ざっていて、足跡は既定で隠れている。
 * つまり **「どのファイルを書き換えたか」が既定では1件も画面に出ていない**。
 * 実測したセッション（489件）では 44 件の書き換えが全部そこに埋まっていた。
 *
 * サーバ側に新しい kind を足さずに済むのは、`calls[].detail` にパスがもう入っているため。
 *
 * **形を trace と同じに保つ**（count / tools / calls）。こうしておくと
 * search.js の searchableOf が calls[].tool と calls[].detail を既に舐めているので、
 * 検索は1行も触らずにパスへ当たる。item.js の畳みも同じ材料で組める。
 *
 * 並びは元のまま。1つの足跡から2件に割れるときは書き換えを先に置く（そちらが読ませたい側）。
 *
 * `durationMs` は書き換え側に持たせない。あれは assistant 1行ぶんの所要で、
 * 並列に呼んだ分を含むため、割った側の所要としては嘘になる。
 * `wait`（前のやり取りからの間）は先に来る側にだけ残す（両方に付けると二重に出る）
 *
 * @param {Array<object>} items digest.items
 * @returns {Array<object>} 同じ並びで、書き換えを含む足跡だけが2件に割れたもの
 */
export function splitEdits(items = []) {
  const out = [];
  for (const item of items) {
    const calls = item?.calls;
    if (item?.kind !== 'trace' || !Array.isArray(calls) || !calls.length) {
      out.push(item);
      continue;
    }

    const writes = calls.filter((c) => WRITE_TOOLS.has(c?.tool));
    if (!writes.length) {
      out.push(item);
      continue;
    }

    const rest = calls.filter((c) => !WRITE_TOOLS.has(c?.tool));
    const toolsOf = (list) => [...new Set(list.map((c) => c?.tool).filter(Boolean))];

    out.push({
      ...item,
      kind: 'edit',
      calls: writes,
      count: writes.length,
      tools: toolsOf(writes),
      durationMs: null,
    });

    // 読むだけの呼び出しが残っていれば、足跡として元の場所に置く
    if (rest.length) {
      out.push({
        ...item,
        calls: rest,
        count: rest.length,
        tools: toolsOf(rest),
        wait: null,
      });
    }
  }
  return out;
}

/**
 * サブエージェントのログでだけ意味が変わる種類。
 *
 * 子ログの先頭に入っている user 行は、あなたが打ったものではない。
 * Agent ツールを呼んだ親の Claude が書いた指示文がそのまま入っている。
 * 「あなたの指示」と出すと、自分が言っていないことを言ったことにしてしまう
 */
export const SIDECHAIN_LABELS = {
  prompt: 'Claude からの指示',
};

/**
 * 種類のラベルを引く。
 *
 * ctx.labels は差し替えたい種類だけを持つ（全部を書き写すと、KIND_LABELS に
 * 1つ足したときに片方だけ古くなる）
 *
 * @param {string} kind item.kind
 * @param {object} [ctx] timelineItem の ctx
 */
export function labelOf(kind, ctx) {
  return ctx?.labels?.[kind] ?? KIND_LABELS[kind] ?? kind;
}

/**
 * 「要点だけ」で残す種類。
 *
 * Claude の説明（say）を落とすと、自分が動かした所だけが縦に並ぶ。
 * 何十往復もしたセッションを思い出すときは、こちらのほうが速い。
 *
 * **edit（ファイルの書き換え）を入れている。** 思い出したいのは
 * 「どう判断して、その結果どのファイルが変わったか」で、判断だけを残すと
 * 後半が抜ける。読むだけの足跡（trace）は入れない。
 *
 * recap（Claude の中間報告）は入れない。自己申告であって自分の判断ではないため。
 */
export const DECISION_KINDS = new Set([
  'prompt', 'answer', 'plan', 'denial', 'interrupt', 'slash', 'skill', 'agent', 'error', 'compact',
  'edit',
]);
