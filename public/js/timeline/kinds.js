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
  // ふつうのツール呼び出し。既定では隠している（HIDDEN_KINDS_DEFAULT）。
  // 絞り込みのチップにも同じ語が出るので、ここを直せば両方が変わる
  trace: '足跡',
};

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
 * 「判断だけ」で残す種類。
 *
 * Claude の説明（say）を落とすと、自分が動かした所だけが縦に並ぶ。
 * 何十往復もしたセッションを思い出すときは、こちらのほうが速い。
 *
 * recap（Claude の中間報告）は入れない。自己申告であって自分の判断ではないため。
 */
export const DECISION_KINDS = new Set([
  'prompt', 'answer', 'plan', 'denial', 'interrupt', 'slash', 'skill', 'agent', 'error', 'compact',
]);
