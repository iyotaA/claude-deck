/* 更新のお知らせ。層7。
 *
 * archive.js / stream.js / settings.js と同じ「main.js が配線する独立した部品」。
 * 見ているのは層0（util）と層1（store）だけ。
 *
 * ここは読むだけで、押しても何も起きない。
 * 更新を当てる口（POST /api/update/apply）は次の版で足す。
 * 「見えるようになる」と「動くようになる」を同じ回に混ぜると、更新が失敗したときに
 * 更新の失敗なのか表示の失敗なのか切り分けられなくなる。
 * だからこの版では、できないことを正直にそう書く。偽のボタンは置かない。
 *
 * 判断はぜんぶサーバ側（src/update/state.mjs）で済んでいる。
 * こちらの仕事は、来た state を見て出すか出さないかを決めるだけ。
 * 「新しい版か」も「紙が古いか」も画面側では判定しない。
 *
 * 例外が1つだけある。サーバが古くて /api/update そのものが無いとき（404）。
 * そのときはサーバに判断させようが無いので、画面側で 'outdated' を組む。
 */
import { query, dom, store } from './store.js';
import { stamp } from './util.js';

/**
 * 開いてすぐ、もう1回だけ引き直すまでの間。
 *
 * ランチャは窓を開けてから更新を確認する（回線が細い日に窓が最大20秒遅れて出るのを
 * 避けるため）。つまり画面が最初に引いた時点の紙は、まだ前回の結果か、そもそも無い。
 * 少し待って引き直すと、入れた直後の初回の起動でもその場で結果が出る。
 */
const RECHECK_MS = 10000;

/** ふだんの間隔。紙を読むだけなので軽いが、出す意味があるほど頻繁には変わらない */
const POLL_MS = 30 * 60 * 1000;

/** 閉じたお知らせを覚える鍵。版そのものを入れるので、版が上がればまた出る */
const SEEN_KEY = 'claude-deck.updateSeen';

/**
 * サーバが古くて窓口ごと無いときに、画面側で組む状態。
 *
 * /api/update が 404 を返すのは「このサーバは窓口を知らない」＝古い、以外にありえない。
 * 実際にこれで1度つまずいている（2026-08-12）。6日前に立てたサーバが 4317 を掴んだままで、
 * npm start も ClaudeDeck.exe も「もう動いている」を見つけて窓を開くだけで終わるため、
 * 直したはずのコードが一度も走らなかった。画面はいつもどおりに見えるので気づけない。
 *
 * 形は /api/update の応答に合わせる。読む側（render / fillVersion）に分岐を増やさないため。
 * 版は入れない。取れなかったものを埋めると、古いサーバの版を知っているように見えてしまう
 */
const OUTDATED = Object.freeze({
  state: 'outdated',
  label: 'このサーバーは古い版です',
  current: null,
  available: null,
  notes: null,
  checkedAt: null,
  changedAt: null,
  error: null,
  path: null,
});

/** 閉じられた版。「二度と出さない」ではなく「この版はもう見た」の意味 */
let dismissed = localStorage.getItem(SEEN_KEY);

/** いま帯に出している版。閉じたときにこれを覚える */
let shown = null;

/**
 * 版の脇に出す印。
 *
 * @param {string} state サーバから来た状態
 * @returns {string} 'new'（新しい版がある） / 'bad'（確認できていない） / ''（言うことは無い）
 */
function markOf(state) {
  if (state === 'available') return 'new';
  // stale と unknown は紙のほうがおかしい。どちらも「確認できていない」で足りる
  if (state === 'unreachable' || state === 'failed' || state === 'stale' || state === 'unknown') {
    return 'bad';
  }
  return '';
}

/**
 * 版の脇に出す説明。触らないと見えないので、長く書いてよい。
 *
 * @param {object} up /api/update の応答
 * @returns {string}
 */
function versionTitle(up) {
  const lines = [up.label];
  if (up.state === 'available' && up.available) lines.push(`新しい版: ${up.available}`);
  if (up.error) lines.push(up.error);
  if (up.checkedAt) lines.push(`確認: ${stamp(up.checkedAt)}`);
  return lines.join('\n');
}

/**
 * 上のバーの版を書き換える。
 *
 * 新しい版が無くても常に出す。渡された側が「自分は新しいほうか古いほうか」を
 * 確かめられる場所が、画面にはここしか無い。
 *
 * @param {object|null} up /api/update の応答。まだ読めていなければ null
 */
function fillVersion(up) {
  const version = up?.current ?? null;
  // 版が読めないときは出さない。「不明」と書いても誰も使えない
  dom.ver.hidden = !version;
  if (!version) return;

  dom.ver.textContent = `v${version}`;
  dom.ver.title = versionTitle(up);
  dom.ver.dataset.update = markOf(up.state);
}

/**
 * 帯に出す中身の鍵。閉じたかどうかの判定にも使う。
 *
 * 帯を出すのは「新しい版がある」ときと「このサーバが古い」ときだけ。
 * 確認できなかったことまで帯にすると、回線の細い日に毎回じゃまをする。
 * そちらは版の脇の印と --status に任せる。
 *
 * @param {object|null} up /api/update の応答
 * @returns {string|null} 出さないなら null
 */
function bannerKey(up) {
  if (up?.state === OUTDATED.state) return OUTDATED.state;
  // 版が読めない紙（available が空）でも知らせる意味はあるので、そこは '?' で通す
  if (up?.state === 'available') return up.available || '?';
  return null;
}

/**
 * 「新しい版があります」の帯を書く。
 *
 * @param {object} up /api/update の応答
 */
function fillAvailableBanner(up) {
  dom.update.dataset.tone = 'new';
  dom.updateText.textContent = up.available
    ? `新しい版があります（${up.available}）`
    : '新しい版があります';
  dom.updateNote.textContent = up.current
    ? `いまは ${up.current}。入れ替えはまだできません（次の版で対応します）`
    : '入れ替えはまだできません（次の版で対応します）';
}

/**
 * 「このサーバは古い」の帯を書く。
 *
 * 直し方まで書く。窓を閉じて開き直しても直らないので、そこを言わないと
 * 何度も開き直すことになる（画面は普通に動いて見えるので、なおさら分かりにくい）。
 */
function fillOutdatedBanner() {
  dom.update.dataset.tone = 'warn';
  dom.updateText.textContent = 'このサーバーは古い版です';
  dom.updateNote.textContent = '窓を開き直しても直りません。サーバーを立ち上げ直してください';
}

/** 応答を画面へ反映する。出すか出さないかもここで決める。 */
function render() {
  const up = store.update;
  fillVersion(up);

  const key = bannerKey(up);
  const show = key !== null && key !== dismissed;

  dom.update.hidden = !show;
  if (!show) return;

  shown = key;
  if (key === OUTDATED.state) fillOutdatedBanner();
  else fillAvailableBanner(up);
}

/**
 * 紙を1回読む。
 *
 * 失敗しても黙って退く。更新が見えないだけで本体は動くので、
 * ここで画面にエラーを出すと、直せないことを毎回知らせるだけになる。
 *
 * 404 だけは別。書庫（archive.js）が 404 で静かに退くのは
 * 「機能が1つ無いだけで、他は正常」だからで、こちらは事情が違う。
 * この窓口はこの版で足したものなので、404 は「見ている画面そのものが古い」を意味する。
 * 黙って退くと、直したはずのものが直っていない理由が画面のどこにも出なくなる。
 */
async function fetchUpdate() {
  try {
    const res = await fetch('/api/update');
    if (res.status === 404) {
      store.update = OUTDATED;
      render();
      return;
    }
    if (!res.ok) return;
    store.update = await res.json();
    render();
  } catch {
    // 取れなかった。前の内容をそのまま残す
  }
}

/** 更新のお知らせを配線する。main.js から1回だけ呼ぶ。 */
export function initUpdate() {
  dom.updateClose.addEventListener('click', () => {
    // 版を覚える。版が上がればまた出る
    dismissed = shown;
    // 古い版の知らせだけは覚えない。立ち上げ直すまで直らないので、
    // 開き直すたびに出るのが正しい（覚えると、一度閉じた人には二度と出なくなる）
    if (dismissed && dismissed !== OUTDATED.state) localStorage.setItem(SEEN_KEY, dismissed);
    dom.update.hidden = true;
  });

  fetchUpdate();

  // 見た目をヘッドレスで撮るときは時計を回さない。SSE と同じ扱い
  if (query.get('nolive') === '1') return;
  setTimeout(fetchUpdate, RECHECK_MS);
  setInterval(fetchUpdate, POLL_MS);
}
