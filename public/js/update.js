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

/**
 * 「入れ替えました」を出し続ける期限。
 *
 * done の紙は次の確認まで上書きされない（--restarted は更新を確認しないため）。
 * 期限を切らないと、翌朝の起動でも「入れ替えました」が出る。
 */
const DONE_FRESH_MS = 600000;

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
  requested: null,
  notes: null,
  checkedAt: null,
  changedAt: null,
  error: null,
  path: null,
  canApply: false,
});

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

/**
 * 当てようとして転んだのか、ただ確認に失敗しただけかを分ける。
 *
 * 見るのは requested。素の確認（CheckAsync）はここを書かないので、
 * 入っていれば「当てにいって転んだ」と言い切れる。
 * 画面側の押した記憶に頼らないので、途中で読み込み直しても判定が残る。
 *
 * @param {object} up /api/update の応答
 * @returns {boolean}
 */
function isApplyFailure(up) {
  return (up.state === 'failed' || up.state === 'unreachable') && Boolean(up.requested);
}

/**
 * いま出す帯を決める。純粋な組み立てで、DOM は触らない。
 *
 * 並べる順に意味がある。上にあるものほど「いま伝えるべきこと」が強い。
 *
 * @param {object|null} up /api/update の応答
 * @returns {object|null} {key, tone, text, note, keep, act} 出さないなら null
 */
function bannerOf(up) {
  // 1. 諦めた。何が起きたか分からないので、確かめ方まで書く
  if (stuckAt !== null) {
    return {
      key: `stuck:${stuckAt}`,
      tone: 'warn',
      text: '更新の返事がありません',
      note: '入れ替わっているかもしれません。読み込み直すか、ClaudeDeck.exe --status で確かめてください',
      keep: true,
      act: { label: '読み込み直す', run: reloadNow },
    };
  }

  if (!up) return null;

  // 2. このサーバーが古い。窓を閉じて開き直しても直らないので、そこまで書く
  if (up.state === OUTDATED.state) {
    return {
      key: OUTDATED.state,
      tone: 'warn',
      text: 'このサーバーは古い版です',
      note: '窓を開き直しても直りません。サーバーを立ち上げ直してください',
      // 覚えない。立ち上げ直すまで直らないので、開くたびに出るのが正しい
      keep: false,
      act: null,
    };
  }

  // 3. 入れ替わった。ここで自動的に読み込み直さない。
  //    いま見えているのは前の版の画面なので、そのことを言ってから人に押させる
  if (up.state === 'done') {
    const fresh = up.changedAt === null || Date.now() - up.changedAt < DONE_FRESH_MS;
    if (!fresh) return null;
    return {
      key: `done:${up.changedAt ?? 0}`,
      tone: '',
      text: up.current ? `入れ替えました（${up.current}）` : '入れ替えました',
      note: 'この画面はまだ前の版です。読み込み直してください',
      keep: true,
      act: { label: '読み込み直す', run: reloadNow },
    };
  }

  // 4. 作業中。押せることは無いので札は出さない
  if (up.state === 'downloading') {
    return {
      key: `downloading:${up.changedAt ?? 0}`,
      tone: 'work',
      text: '新しい版を取り寄せています',
      note: up.requested
        ? `${up.requested} を取り寄せています。回線によっては数分かかります`
        : '回線によっては数分かかります',
      keep: false,
      act: null,
    };
  }
  if (up.state === 'applying') {
    return {
      key: `applying:${up.changedAt ?? 0}`,
      tone: 'work',
      text: '入れ替えています',
      note: 'サーバーがいったん止まって起き直ります。この画面はそのままでお待ちください',
      keep: false,
      act: null,
    };
  }

  // 5. 当てにいって転んだ。動いていることを必ず書き添える。
  //    ランチャは失敗したらサーバーを起こし直すので、実際に動いている
  if (isApplyFailure(up)) {
    return {
      key: `failed:${up.changedAt ?? 0}`,
      tone: 'warn',
      text: up.label,
      // 理由は括弧で終わることが多い（「…求めた 0.2.1）」）。
      // 添える一言まで括弧にすると括弧が2つ並ぶので、句点でつなぐ
      note: up.error ? `${up.error}。いまの版のまま動いています` : 'いまの版のまま動いています',
      keep: true,
      act: up.canApply ? { label: 'もう一度', run: applyNow } : null,
    };
  }

  // 6. 押したが、まだランチャが紙を書いていない。
  //    素通りさせると「更新する」がもう一度出て、二度押しを誘う
  if (pressed && up.state === 'available') {
    return {
      key: 'starting',
      tone: 'work',
      text: '更新を始めています',
      note: 'ランチャを起こしています',
      keep: false,
      act: null,
    };
  }

  // 7. 新しい版がある
  //
  // **鍵は押せるかどうかで分ける。** 同じ鍵にすると、押せないと言われて閉じた帯が、
  // 押せる状態になっても二度と出てこない（閉じた鍵は keep: true で localStorage に残り、
  // 版が変わるまで一致し続けるため）。
  //
  // 実測で踏んだ形はこう。手で立てた server.mjs の画面で
  // 「この起動の仕方では入れ替えられません」を閉じ、そのあとインストールした側から
  // 立て直して canApply が true になったのに、版が同じだから帯が出なかった。
  // 押せない知らせを閉じたことが、押せる知らせまで殺していた。
  //
  // 古い鍵（`available:<版>`）はどちらとも一致しないので、
  // 押せない帯を閉じたまま埋もれていた人も1回だけ出直す。
  if (up.state === 'available') {
    // 版が読めない紙でも知らせる意味はあるので、そこは '?' で通す
    const ver = up.available || '?';
    const text = up.available ? `新しい版があります（${up.available}）` : '新しい版があります';
    if (!up.canApply) {
      return {
        key: `available-cant:${ver}`,
        tone: 'new',
        text,
        note: 'この起動の仕方では入れ替えられません。インストールした ClaudeDeck から起動してください',
        keep: true,
        act: null,
      };
    }
    return {
      key: `available-can:${ver}`,
      tone: 'new',
      text,
      note: up.current ? `いまは ${up.current}` : '',
      keep: true,
      act: { label: '更新する', run: applyNow },
    };
  }

  // 8. 押したのに、ここまでのどれにも当てはまらない。
  //    ランチャは「新しい版は無かった」と判断して none を書いて終わることがある。
  //    黙って帯を消すと「押したのに何も起きなかった」になるので、来た言い方をそのまま出す
  if (pressed) {
    if (up.state === 'none') {
      return {
        key: 'pressed-none',
        tone: '',
        text: '最新です',
        note: '更新は取り下げられていたようです',
        keep: false,
        act: null,
      };
    }
    return {
      key: `pressed:${up.state}:${up.changedAt ?? 0}`,
      tone: 'warn',
      text: up.label,
      note: up.error ?? '',
      keep: false,
      act: null,
    };
  }

  // 確認できなかったことまで帯にすると、回線の細い日に毎回じゃまをする。
  // そちらは版の脇の印と --status に任せる
  return null;
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

  const banner = refused ?? bannerOf(up);
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
    // content-type を必ず付ける。書き込みの門番（shared/origin.mjs）は
    // application/json 以外を断る（<form> はこれを名乗れない、が守りの根拠）
    const res = await fetch('/api/update/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const data = await res.json().catch(() => null);

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
