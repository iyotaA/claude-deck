/* 更新のお知らせと、更新の適用。層7。
 *
 * archive.js / stream.js / settings.js と同じ「main.js が配線する独立した部品」。
 * 見ているのは層0（util）と層1（store）だけ。
 *
 * 判断はほとんどサーバ側（src/update/state.mjs）と C# ランチャで済んでいる。
 * こちらの仕事は3つだけ。
 *
 *  - 来た state を見て、帯を出すか出さないかを決める
 *  - 押されたら POST /api/update/apply を1回投げる
 *  - 投げたあと、紙（update.json）が動くのを見張る
 *
 * 見張りが要る理由。当てる作業はサーバの外（C# の別プロセス）で走るので、
 * 押したあとサーバは何も知らない。しかも作業の途中でサーバ自身が落ちて起き直る。
 * つまり「押したのに何も起きない」を捕まえられるのは画面側しかない。
 * だから無音のまま終わらせず、時間切れを必ず出す。
 *
 * 例外が1つだけある。サーバが古くて /api/update そのものが無いとき（404）。
 * そのときはサーバに判断させようが無いので、画面側で 'outdated' を組む。
 */
import { query, store } from './store.js';
import { dom } from './dom.js';
import { stamp } from './util.js';
import { postJson } from './api.js';
import { OUTDATED, bannerOf } from './update-banner.js';

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

/** 押したあとの間隔。作業のあいだだけこの速さで引く */
const BUSY_POLL_MS = 1500;

/**
 * 紙が動かなくなってから諦めるまで。
 *
 * server.mjs の APPLY_GUARD_MS と同じ 120 秒にしてある。
 * こちらが諦めた時点で向こうの札も降りるので、そのまま押し直せる。
 */
const STUCK_MS = 120000;

/**
 * 取り寄せ中だけは長く待つ。
 *
 * 初回の配布物は 45MB ほどあり、細い回線では 2 分では終わらない。
 * ここを 120 秒のままにすると、正常に落としている最中に
 * 「返事がありません」を出すことになる。
 */
const STUCK_DOWNLOAD_MS = 600000;

/** 閉じたお知らせを覚える鍵 */
const SEEN_KEY = 'claude-deck.updateSeen';

/**
 * 押したあと「まだ終わっていない」と読む状態。
 *
 * available が入っているのが要点。押した直後はランチャがまだ何も書いていないので、
 * 紙は available のままになる。ここを「終わった」と読むと、
 * 作業が始まる前に見張りが終わってしまう。
 */
const PENDING = new Set(['available', 'downloading', 'applying']);

/** 閉じた帯の鍵。「二度と出さない」ではなく「これはもう見た」の意味 */
let dismissed = localStorage.getItem(SEEN_KEY);

/** いま帯に出しているもの。閉じたときにこれを覚える */
let showing = null;

/** この窓で更新を押したか。押してから紙が追いつくまでの空白を埋めるために持つ */
let pressed = false;

/**
 * 断られたことを直に出す帯。
 *
 * 押した直後に断られた場合、紙には何も書かれない。
 * サーバの返事はこの変数にしか残らないので、ここから出すしかない。
 * 紙が動いたら取り下げる（render の頭）
 */
let refused = null;

/**
 * 時間切れになったときの紙の鍵。null は「まだ諦めていない」。
 *
 * 真偽値で持ってはいけない。紙が動いても下ろせなくなり、
 * 「入れ替えています」の帯が永久に残るか、逆に done を覆い隠すかのどちらかになる。
 * 鍵で持てば、紙が1文字でも動いた瞬間に自動で取り下げられる
 */
let stuckAt = null;

/** 見張りの時計。0 は「見張っていない」 */
let watch = 0;

/** 最後に見た紙の鍵と、そうなった時刻。動くたびに時計を巻き戻す */
let watchKey = null;
let watchSince = 0;

/** いま札を押したときに走らせる仕事。null なら札を出さない */
let actRun = null;

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
 * 紙が動いたかどうかを見るための鍵。
 *
 * changedAt を混ぜるのが要点。ランチャ側の Save() は
 * state と available の**両方**が一致するときだけ changedAt を据え置く。
 * つまり downloading → applying でも値が動くので、進んだことがここで分かる。
 *
 * @param {object|null} up /api/update の応答
 * @returns {string}
 */
function paperKey(up) {
  return up ? `${up.state}:${up.changedAt ?? 0}` : '';
}

/** いま出している帯を「見た」ことにする。閉じるときと、読み込み直す前に通す。 */
function rememberShown() {
  if (!showing) return;
  dismissed = showing.key;
  // 覚えてよいのは、鍵が一度きりのものだけ。
  // starting のように使い回される鍵を覚えると、次に押したとき帯が出なくなる
  if (showing.keep) localStorage.setItem(SEEN_KEY, dismissed);
}

/** 帯を画面へ書く。 */
function fillBanner(banner) {
  showing = banner;
  dom.update.dataset.tone = banner.tone;
  dom.updateText.textContent = banner.text;
  dom.updateNote.textContent = banner.note;

  actRun = banner.act?.run ?? null;
  dom.updateAct.hidden = !banner.act;
  if (banner.act) {
    dom.updateAct.textContent = banner.act.label;
    dom.updateAct.disabled = false;
  }
}

/** 応答を画面へ反映する。出すか出さないかもここで決める。 */
function render() {
  const up = store.update;
  fillVersion(up);

  // 紙が動いたら、時間切れの申告と断りの帯を取り下げて時計を巻き戻す。
  // ここを1箇所に寄せておくと、動いた瞬間に古い言い分が消える
  const key = paperKey(up);
  if (key !== watchKey) {
    watchKey = key;
    watchSince = Date.now();
    stuckAt = null;
    refused = null;
  }

  const banner = refused ?? bannerOf(up, { stuckAt, pressed, reloadNow, applyNow });
  const show = banner !== null && banner.key !== dismissed;

  dom.update.hidden = !show;
  if (!show) {
    showing = null;
    actRun = null;
    return;
  }
  fillBanner(banner);
}

/** 見張りを始める。押したときだけ通る。 */
function beginWatch() {
  stuckAt = null;
  watchKey = paperKey(store.update);
  watchSince = Date.now();
  if (watch) return;
  watch = setInterval(pulse, BUSY_POLL_MS);
}

/** 見張りを畳む。pressed は落とさない（結果を出し終えるまで要る）。 */
function endWatch() {
  if (!watch) return;
  clearInterval(watch);
  watch = 0;
}

/**
 * 見張りの1拍。
 *
 * render() を先に呼ぶのが要点。fetchUpdate() の成功時だけに任せてはいけない。
 * 入れ替えの最中はサーバーが黙っているので fetch は失敗し続け、
 * いちばん時間切れを出すべき場面で時間切れが永久に発火しなくなる。
 */
function pulse() {
  const up = store.update;
  const limit = up?.state === 'downloading' ? STUCK_DOWNLOAD_MS : STUCK_MS;

  if (Date.now() - watchSince >= limit) {
    stuckAt = watchKey;
    endWatch();
  } else if (up && !PENDING.has(up.state)) {
    // 落ち着いた。あとはふだんの間隔でよい
    endWatch();
  }

  render();
  fetchUpdate();
}

/**
 * 更新を当てにいく。
 *
 * 見張りは投げる前に始める。断られたら failNow が畳むので、
 * 「投げたのに返事が来ない」で無音になる隙間ができない。
 */
async function applyNow() {
  // 押した瞬間に止める。返事が来るまでのあいだの二度押しを防ぐ
  dom.updateAct.disabled = true;
  pressed = true;
  beginWatch();
  render();

  try {
    const { res, data } = await postJson('/api/update/apply');

    if (res.ok) return;

    // 別の窓が先に押していた。断られてはいるが、作業そのものは走っている
    if (data?.state === 'applying') return;

    failNow(data?.reason ?? `更新を始められませんでした（${res.status}）`);
  } catch {
    failNow('サーバーに届きませんでした');
  }
}

/**
 * 断られたことを帯に出す。
 *
 * 札は残して押せる状態に戻す。そのまま「もう一度」になる。
 *
 * @param {string} reason 断られた理由。サーバの言い方をそのまま出す
 */
function failNow(reason) {
  pressed = false;
  endWatch();
  stuckAt = null;
  refused = {
    key: `refused:${reason}`,
    tone: 'warn',
    text: '更新を始められませんでした',
    note: reason,
    keep: false,
    act: { label: 'もう一度', run: applyNow },
  };
  render();
}

/** 読み込み直す。出していた帯は見たことにしてから離れる（戻ってきて同じ帯が出ない） */
function reloadNow() {
  rememberShown();
  location.reload();
}

/**
 * 紙を1回読む。
 *
 * 失敗しても黙って退く。更新が見えないだけで本体は動くので、
 * ここで画面にエラーを出すと、直せないことを毎回知らせるだけになる。
 * 入れ替えの最中はサーバーが止まっているので、ここは必ず失敗する道でもある。
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
  dom.updateAct.addEventListener('click', () => {
    const run = actRun;
    if (!run) return;
    // async の窓口に受け皿を必ず付ける。付け忘れると拾われない拒否になる
    Promise.resolve().then(run).catch(() => {});
  });

  dom.updateClose.addEventListener('click', () => {
    rememberShown();
    // 断りの帯は閉じたら取り下げる。
    // 残すと紙のほうの帯（新しい版があります）まで隠れたままになる。
    // 紙は動いていないので、render の頭の取り下げでは戻らない
    refused = null;
    dom.update.hidden = true;
  });

  fetchUpdate();

  // 見た目をヘッドレスで撮るときは時計を回さない。SSE と同じ扱い。
  // 押したときの見張り（pulse）はここで止めない。人が押したときにしか動かないうえ、
  // 止めると「押したのに無音」という、いちばん避けたい形になる
  if (query.get('nolive') === '1') return;
  setTimeout(fetchUpdate, RECHECK_MS);
  setInterval(fetchUpdate, POLL_MS);
}
