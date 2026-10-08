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
import { el, stamp } from './util.js';
import { postJson } from './api.js';
import { OUTDATED, STEPS, bannerOf, stepsOf } from './update-banner.js';

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
 * 入れ替わったあと、自分で読み込み直すまでの秒数。
 *
 * すぐに読み込み直さないのは、何が起きたかを一度は見せるため。
 * 長くすると、前の版の画面で何かを押してしまう隙が広がる。
 */
const RELOAD_SECONDS = 5;

/** 経過時間とカウントダウンを書き直す間隔 */
const TICK_MS = 1000;

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

/**
 * 見張りを始めたときの紙の鍵。紙がここから動くまでは「落ち着いた」と読まない。
 *
 * 失敗のあとの「もう一度」がこれで止まっていた。押した直後の紙はまだ failed のままなので、
 * 1拍目で「もう終わっている」と読んで見張りを畳み、そのあとランチャが書いた
 * downloading も applying も、次の30分おきの確認まで画面に届かなかった（実測）
 */
let watchFrom = null;

/** いま札を押したときに走らせる仕事。null なら札を出さない */
let actRun = null;

/**
 * この窓で道中を追いかけているか。
 *
 * 押したときのほか、開いた時点で既に取り寄せ・入れ替えの最中だったときも立てる
 * （別の窓が押した・途中で読み込み直した）。覆いを出すのと、終わったら読み込み直すのは
 * これが立っているときだけ。**立っていない窓で done を見ても読み込み直さない。**
 * 読み込み直した先でも done の紙は10分残るので、ここで止めないと読み込みが止まらなくなる
 */
let following = false;

/** 覆いを畳んだか（Esc・「裏で続ける」・「あとで」・「閉じる」）。畳んだら帯で見せる */
let minimized = false;

/** 追いかけ始めた時刻と、段ごとに初めて見た時刻 */
let startedAt = 0;
let stageAt = {};

/** 最後に見た段の位置（STEPS の添字）。転んだときにどの段で止まったかを出すのに使う */
let reached = 0;

/** 入れ替え中に問い合わせが失敗した回数。止まっているあいだも見張っていることを数で見せる */
let waits = 0;

/** 経過時間とカウントダウンの時計。0 は「回していない」 */
let ticker = 0;

/** 読み込み直すまでの残り秒数。null は「数えていない」 */
let countLeft = null;

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
  // 取り寄せの進み方も混ぜる。ランチャは progress を書いても changedAt を据え置くので、
  // 混ぜないと 10% ずつ進んでいても「紙が動いていない」と読み、時間切れの時計が巻き戻らない
  return up ? `${up.state}:${up.changedAt ?? 0}:${up.progress ?? ''}` : '';
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

  // 道中は回る印と経過時間を付ける。止まっていないことを形で見せる。
  // 追いかけていない窓（置き去りの古い紙を見ているだけ）では付けない ――
  // 始まった時刻を知らないうえ、本当に動いているのかも分からない。閉じる口も残す
  const busy = following && isBusy(banner);
  dom.update.toggleAttribute('data-busy', busy);
  dom.updateTime.hidden = !busy;
  if (busy) dom.updateTime.textContent = mmss(Date.now() - startedAt);
  // 道中は閉じさせない。閉じると、進んでいることを知る手がかりが画面から消える
  dom.updateClose.hidden = busy;

  // 段は追いかけているときだけ。追いかけていない窓は、どの段を通ったかを知らない
  const steps = following && Boolean(banner.stage);
  dom.updateSteps.hidden = !steps;
  if (steps) fillSteps(dom.updateSteps, banner.stage);
}

/**
 * まだ終わっていない道中の帯か。
 *
 * @param {object} banner bannerOf の戻り
 * @returns {boolean}
 */
function isBusy(banner) {
  return banner.stage === 'starting' || banner.stage === 'downloading' || banner.stage === 'applying';
}

/**
 * 経過を「分:秒」にする。
 *
 * @param {number} ms 経過ミリ秒。負は 0 に丸める
 * @returns {string}
 */
function mmss(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/**
 * 開いた時点で既に道中だったら、この窓でも追いかけ始める。
 *
 * 押していない窓（別の窓が押した・途中で読み込み直した）でも、
 * 30分おきの見張りのままだと何も動かない帯が残るので、ここで見張りを速める。
 *
 * @param {object|null} up /api/update の応答
 */
function adopt(up) {
  // 見張っている最中と、諦めたあと（紙が動くまで）は拾い直さない。
  // 諦めたあとに拾うと、時間切れを出した直後に見張りが始まり直して時間切れが消える
  if (following && (watch || stuckAt !== null)) return;
  if (up?.state !== 'downloading' && up?.state !== 'applying') return;
  // 置き去りの紙は拾わない。ランチャが道中で落ちると downloading / applying のまま残り、
  // 開くたびに覆いが出ることになる。見張りの時間切れと同じ長さを古さの線にする。
  // 書いた時刻が読めない紙は拾う（不明を「古い」と読み替えない）
  // 古さは最後に書かれた時刻で測る。取り寄せの進み方を書くたびに動くのは checkedAt のほう
  // （changedAt は状態が変わったときだけ動く）。長い取り寄せの最中に開いた窓が「古い」と読まないため
  const limit = up.state === 'downloading' ? STUCK_DOWNLOAD_MS : STUCK_MS;
  const wroteAt = Math.max(up.changedAt ?? 0, up.checkedAt ?? 0);
  if (wroteAt && Date.now() - wroteAt >= limit) return;
  following = true;
  minimized = false;
  startedAt = Date.now();
  stageAt = {};
  reached = 0;
  beginWatch();
  startTicker();
}

/**
 * 段を初めて見た時刻を控える。段ごとの所要時間と、転んだ段の位置に使う。
 *
 * @param {string|undefined} stage 帯の stage
 */
function noteStage(stage) {
  if (!following || !stage) return;
  if (stageAt[stage] === undefined) stageAt[stage] = Date.now();
  const at = STEPS.findIndex((s) => s.stage === stage);
  if (at > reached) reached = at;
}

/**
 * 1段ぶんの所要時間。まだ始まっていない段と、始まりを見ていない段は空にする。
 *
 * @param {number} i STEPS の添字
 * @param {string} mark stepsOf の値
 * @returns {string}
 */
function stepTime(i, mark) {
  if (mark === 'todo') return '';
  // 準備は押した瞬間に始まっている。開いた時点で道中だった窓は、押した時刻を知らない
  const from = i === 0 ? (pressed ? startedAt : undefined) : stageAt[STEPS[i].stage];
  if (from === undefined) return '';
  if (mark === 'now') {
    // 取り寄せの最中は進み方を添える。進み方を書かない古いランチャの紙では時間だけ
    const pct = STEPS[i].stage === 'downloading' ? progressOf() : null;
    return pct === null ? mmss(Date.now() - from) : `${pct}% ・ ${mmss(Date.now() - from)}`;
  }
  // 終わった段は、次に見た段（無ければ終わった時刻）までを数える
  const next = STEPS.slice(i + 1).map((s) => stageAt[s.stage]).find((t) => t !== undefined);
  const to = next ?? stageAt.done ?? stageAt.failed ?? stageAt.stuck;
  return to === undefined ? '' : mmss(to - from);
}

/**
 * 段の並びを書く。帯の2行目と覆いの中で同じものを使う。
 *
 * **節点は1回だけ作り、あとは印と時間の字だけを書き換える。**
 * 前は呼ぶたびに `replaceChildren` で組み直していた。これは毎秒の時計と
 * 1.5秒ごとの見張りの両方から呼ばれるので、そのたびに「いま」の丸が作り直され、
 * 回転が 0 度からやり直しになって、丸がカクついて見えた（実測の指摘）。
 * `data-mark` に同じ値を入れ直しても回転は途切れない。
 *
 * @param {HTMLElement} list 書き込む先（<ol>）
 * @param {string} stage いまの帯の stage
 */
function fillSteps(list, stage) {
  if (list.children.length !== STEPS.length) {
    list.replaceChildren(...STEPS.map((step) => {
      const li = el('li', 'upd-step');
      const dot = el('span', 'upd-dot');
      dot.setAttribute('aria-hidden', 'true');
      li.append(dot, el('span', 'upd-name', step.label), el('span', 'upd-time'));
      return li;
    }));
  }
  const marks = stepsOf(stage, reached);
  STEPS.forEach((_, i) => {
    const li = list.children[i];
    if (li.dataset.mark !== marks[i]) li.dataset.mark = marks[i];
    const time = stepTime(i, marks[i]);
    const span = li.lastElementChild;
    if (span.textContent !== time) span.textContent = time;
  });
}

/**
 * 覆いを書いて、閉じていれば開く。
 *
 * 入れ替わったら数え始め、数え終わったら読み込み直す。
 * 帯のときは人に押させているが、覆いは「この窓で押して見届けている」場面なので、
 * 押す手間を省いてよい。止めたければ「あとで」で畳む。
 *
 * @param {object} banner bannerOf の戻り（stage を持つもの）
 */
function fillOverlay(banner) {
  const stage = banner.stage;
  const busy = isBusy(banner);
  dom.updov.dataset.stage = stage;
  dom.updovTitle.textContent = banner.text;
  dom.updovNote.textContent = banner.note;
  fillSteps(dom.updovSteps, stage);
  fillRing(stage);

  dom.updovBack.textContent = busy ? '裏で続ける' : stage === 'done' ? 'あとで' : '閉じる';
  dom.updovAct.hidden = !banner.act;
  if (banner.act) {
    dom.updovAct.textContent = stage === 'done' ? '今すぐ読み込み直す' : banner.act.label;
    dom.updovAct.disabled = false;
  }

  if (stage !== 'done') {
    countLeft = null;
  } else if (countLeft === null) {
    countLeft = RELOAD_SECONDS;
    // 時計を回し直して、拍を数え始めに揃える。揃えないと最初の1秒が
    // 前の拍の残りぶん（実測 0.5 秒）縮んで、5秒と言いながら 4.5 秒で読み込み直す
    clearInterval(ticker);
    ticker = 0;
    startTicker();
  }
  fillOverlayTime(busy);

  if (!dom.updov.open) dom.updov.showModal();
}

/**
 * いまの取り寄せの進み方（％）。取り寄せ中でない・書かれていないときは null。
 *
 * @returns {number|null}
 */
function progressOf() {
  const up = store.update;
  return up?.state === 'downloading' && Number.isInteger(up.progress) ? up.progress : null;
}

/**
 * 覆いの大きい輪を書く。取り寄せの進み方が分かるときは、回すのをやめて％で埋める。
 *
 * 節点は作り直さない（作り直すと回転が 0 度に戻ってカクつく。fillSteps と同じ理由）。
 * 形の出し分けは CSS（`.updov-ring[data-pct]`）がやり、ここは値を書くだけ。
 *
 * @param {string} stage いまの帯の stage
 */
function fillRing(stage) {
  const ring = dom.updovRing;
  const pct = stage === 'downloading' ? progressOf() : null;
  if (pct === null) {
    if (ring.hasAttribute('data-pct')) {
      ring.removeAttribute('data-pct');
      ring.style.removeProperty('--upd-pct');
      ring.textContent = '';
    }
    return;
  }
  ring.dataset.pct = String(pct);
  ring.style.setProperty('--upd-pct', String(pct));
  ring.textContent = `${pct}%`;
}

/**
 * 覆いの足の字を書く。経過時間か、読み込み直すまでの残りか。
 *
 * @param {boolean} busy 道中か
 */
function fillOverlayTime(busy) {
  if (busy) dom.updovTime.textContent = `経過 ${mmss(Date.now() - startedAt)}`;
  else if (countLeft !== null) dom.updovTime.textContent = `${countLeft}秒後に読み込み直します`;
  else dom.updovTime.textContent = '';
}

/** 覆いを閉じる。数えていたら止める */
function closeOverlay() {
  countLeft = null;
  if (dom.updov.open) dom.updov.close();
}

/** 覆いを畳んで帯へ移す。Esc・「裏で続ける」・「あとで」・「閉じる」が通る */
function minimize() {
  minimized = true;
  render();
}

/** 経過時間とカウントダウンの時計を回す。追いかけ始めたら回しっぱなしでよい（字を書くだけ） */
function startTicker() {
  if (ticker) return;
  ticker = setInterval(tick, TICK_MS);
}

/**
 * 時計の1拍。
 *
 * 紙を読み直すのは見張り（pulse）の仕事で、ここは字を書き直すだけ。
 * 帯や覆いを丸ごと組み直さないのは、押そうとしている札の焦点を奪わないため。
 */
function tick() {
  const banner = showing;
  if (!banner?.stage) return;

  if (dom.updov.open) {
    if (countLeft !== null) {
      countLeft -= 1;
      if (countLeft <= 0) {
        // 時計を止めてから離れる。止めないと、再起動直後のサーバーが遅くて
        // 読み込みが1秒を超えたとき、次の拍でもう一度 reload が走り、毎秒やり直しになる
        countLeft = null;
        clearInterval(ticker);
        ticker = 0;
        reloadNow();
        return;
      }
    }
    fillOverlayTime(isBusy(banner));
    // いまの段の所要時間だけが伸びる
    fillSteps(dom.updovSteps, banner.stage);
    return;
  }

  if (dom.update.hidden || !isBusy(banner)) return;
  dom.updateTime.textContent = mmss(Date.now() - startedAt);
  if (!dom.updateSteps.hidden) fillSteps(dom.updateSteps, banner.stage);
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
    waits = 0;
  }

  adopt(up);
  // 入れ替えを見届けているあいだは、SSE が切れても「更新中」と言い換えてもらう（stream.js）
  store.updating = following && up?.state === 'applying';
  // 見張っていて、紙が始めたときのままなら「まだ動いていない」
  const unmoved = watch !== 0 && key === watchFrom;
  const banner = refused ?? bannerOf(up, { stuckAt, pressed, waits, unmoved, reloadNow, applyNow });
  noteStage(banner?.stage);

  // 道中は覆いで見せる。閉じた帯の鍵（dismissed）はここでは見ない ――
  // 前に同じ鍵の帯を閉じていても、いま追いかけている道中は隠さない
  if (following && banner?.stage && !minimized) {
    dom.update.hidden = true;
    showing = banner;
    actRun = banner.act?.run ?? null;
    fillOverlay(banner);
    return;
  }
  closeOverlay();

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
  watchFrom = watchKey;
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
  } else if (up && !PENDING.has(up.state) && paperKey(up) !== watchFrom) {
    // 落ち着いた。あとはふだんの間隔でよい。
    // 始めたときの紙のままなら、まだランチャが書いていないだけなので待つ
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
  dom.updovAct.disabled = true;
  pressed = true;
  following = true;
  minimized = false;
  startedAt = Date.now();
  stageAt = {};
  reached = 0;
  waits = 0;
  beginWatch();
  startTicker();
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
  // 始まってもいないので、道中を追いかける話にしない。断りは帯に出す
  following = false;
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
    if (!res.ok) {
      countWait();
      return;
    }
    store.update = await res.json();
    // 届いた。サーバーは戻っているので「止まっています（確認 N回目）」を下ろす
    waits = 0;
    render();
  } catch {
    // 取れなかった。前の内容をそのまま残す
    countWait();
  }
}

/**
 * 入れ替え中の問い合わせの失敗を数える。
 *
 * 入れ替えのあいだはサーバーが止まっているので、失敗するのが正常。
 * 黙って捨てると画面が固まって見えるので、待っている回数として出す。
 */
function countWait() {
  if (!following || store.update?.state !== 'applying') return;
  waits += 1;
  render();
}

/** 更新のお知らせを配線する。main.js から1回だけ呼ぶ。 */
export function initUpdate() {
  dom.updateAct.addEventListener('click', () => {
    const run = actRun;
    if (!run) return;
    // async の窓口に受け皿を必ず付ける。付け忘れると拾われない拒否になる
    Promise.resolve().then(run).catch(() => {});
  });

  // 覆いの札。帯の札と同じ仕事（actRun）を走らせる
  dom.updovAct.addEventListener('click', () => {
    const run = actRun;
    if (!run) return;
    Promise.resolve().then(run).catch(() => {});
  });
  dom.updovBack.addEventListener('click', minimize);
  // Esc は閉じずに畳む。閉じるだけだと、次の render でまた開いてしまう。
  // 実測（Chrome）では Esc で cancel しか来ないので、cancel で受ける（public/CLAUDE.md の拡大と同じ）
  dom.updov.addEventListener('cancel', (ev) => {
    ev.preventDefault();
    minimize();
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
