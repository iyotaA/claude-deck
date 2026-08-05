/* 時系列の外向きの口。main.js が見るのはこのファイルだけ。
 *
 * ここに無いものは外から呼ばない。足すときは「時系列の仕事か」を一度考える。
 * 詳細ペイン全体の話なら main.js 側に置く。
 *
 * answerBlock / planBlock / bodyText / waitFact を外に出しているのは、時系列の外
 * （「あなたの番」と「あなたが決めたこと」のパネル）でも同じ見せ方をするため。
 * 同じものを2通りに描くと、同じ判断が場所によって違って見える。
 *
 * 隠す種類の初期値（initialHiddenKinds / hideQueryValue）はここに無い。
 * store.js が kinds.js から直に取る。層0 の語彙なので経由する必要がなく、
 * ここを通させると index -> view -> store -> index の循環になる。
 */
export { attach, detach, setNav, filterBar, render, renderPlain } from './view.js';
export { answerBlock, planBlock, bodyText } from './blocks.js';
export { waitFact, WAIT_LABELS, WAIT_NOTE } from './waits.js';
