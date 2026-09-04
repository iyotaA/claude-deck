/* 設定モーダル。層7。
 *
 * 中身は3つ。通知（読んで書ける）・作業フォルダ（読んで書ける）・自動起動（読むだけ）。
 *
 * 作業フォルダだけ保存の経路が違う。**足す・消すはその場で効く**（別の窓口
 * /api/settings/rundirs を叩く）ので、下の「保存」ボタンは通知のぶんだけを送る。
 * 1つのボタンに2つの意味を持たせない代わりに、画面にそう書いてある。
 * 自動起動に入切のボタンを置かないのは、押した結果を返せないため。
 * スタブ（<install>\ClaudeDeck.exe）は子の終了コードを伝えない（実測）ので、
 * 窓口を作ってもいつも「できました」と言うことになる。
 *
 * 実際に見ているのは層0（util）と層1（store）だけなので、もっと下にも置ける。
 * それでもここに置いているのは、archive.js や stream.js と同じ「main.js が
 * 配線する独立したペイン」だから。探すときに並んでいるほうが見つけやすい。
 *
 * ここは通信をする数少ない場所。守っていることが3つある。
 *
 *  - 生の Webhook URL を持たない。サーバはマスク済みしか返さないので、
 *    こちらも「変えない（空欄）」「消す（空文字を送る）」の2つで足りる
 *  - 文字は必ず textContent で入れる。innerHTML は使わない
 *  - 書き込みには content-type: application/json を必ず付ける。
 *    これが無いとサーバの門番（src/shared/origin.mjs）に 415 で断られる
 */
import { el } from './util.js';
import { icon } from './icons.js';
import { dom, store, SUMMARY_ORDER } from './store.js';
import { getJson, postJson } from './api.js';

/**
 * 状態ごとの但し書き。
 *
 * 日本語のラベルそのものは持たない（/api/sessions の meta.stateLabels から引く）。
 * ここに置くのは「通知としてどう振る舞うか」の説明だけ。
 */
const STATE_NOTES = {
  'needs-answer': 'いまはほぼ鳴りません（Claude Code が質問中の行を書かないため）',
  'needs-approval': 'マスター判断で止まったときだけ',
  'awaiting-reply': '上の「返信待ち」の分だけ待ったら。実際に鳴るのはこれ',
};

/**
 * 左の並びに差すアイコン。
 *
 * ここでしか使わないので main.js ではなく自分で差す（上のバーのぶんはあちらが差す）。
 */
const NAV_ICONS = { notify: 'bell', dirs: 'folder', state: 'info' };

/**
 * 節ごとに足へ出す作法の1行。
 *
 * **「いつ効くか」を足に置くのが要点。** 通知の節にだけ「保存」があり、
 * 作業フォルダは押した瞬間に効く。前は9つが1枚に積んであって、
 * その違いが本文の説明文にしか書かれていなかった。
 */
const SEC_NOTE = {
  notify: '',
  dirs: '足す・消すはその場で保存されます',
  state: 'ここは読むだけです',
};

/** 送信中は押せなくする。二重に保存・二重に送信するのを防ぐ */
let busy = false;

/**
 * 足の1行にメッセージを出す。
 *
 * @param {string} text 出す文字。空で消える
 * @param {''|'good'|'bad'} [tone] 色
 */
function say(text, tone = '') {
  dom.settingsMsg.textContent = text;
  dom.settingsMsg.dataset.tone = tone;
}

/**
 * ボタンの押せる／押せないをまとめて切り替える。
 *
 * @param {boolean} on 処理中なら true
 */
function setBusy(on) {
  busy = on;
  dom.settingsSave.disabled = on;
  dom.settingsTest.disabled = on;
  // 作業フォルダの「足す」も同じ旗で止める。二重に書き込む道を作らない
  dom.runDirAddBtn.disabled = on;
}

/**
 * URL がどこから来ているかを1行で。
 *
 * 黙って画面の値が勝つと、「環境変数を設定したのに効かない」で迷うことになる。
 * 負けている環境変数が立っているなら、そう書く。
 *
 * @param {object} s /api/settings/notify の応答
 * @returns {string}
 */
function urlHint(s) {
  const from = s.sources?.webhook;
  if (from === 'config') {
    return s.envSet?.webhook
      ? 'この画面で保存した値を使っています（環境変数も立っていますが、こちらが勝ちます）'
      : 'この画面で保存した値を使っています';
  }
  if (from === 'env') {
    return '環境変数の値を使っています。ここで保存すると、そちらより優先されます';
  }
  return 'まだ設定されていません。ここに貼ると通知が始まります';
}

/**
 * いまの状態・URL の出どころ・保存先を書き換える。
 *
 * 入力中の値には触らない。テスト送信のあとに呼んでも、打ちかけが消えないようにする。
 *
 * @param {object} s /api/settings/notify の応答
 */
function fillStatus(s) {
  const h = s.health ?? {};

  // 足の1行。**短く保つ。** 隣に結果のメッセージとボタン2つが並ぶので、
  // 理由まで書くとボタンが押し出される
  dom.settingsState.textContent =
    `${s.enabled ? '有効' : '無効'} / 送信 ${h.sent ?? 0} / 失敗 ${h.failed ?? 0}`;
  dom.settingsState.dataset.on = s.enabled ? '1' : '0';

  // 「いまの様子」の節。**鳴らない理由はこちらに置く。**
  // 足は通知の節でしか出ないので、そこだけに書くと他の節から辿り着けない。
  // 止めるスイッチだけは環境変数のほうが強いので、それも必ず言う
  const why = [];
  if (s.off) why.push('環境変数 CLAUDE_DECK_NOTIFY_OFF で止めています');
  else if (!s.enabled && s.error) why.push(s.error);
  if ((h.state === 'disabled' || h.state === 'paused') && h.reason) {
    why.push(`停止中: ${h.reason}`);
  }
  why.push(`送信 ${h.sent ?? 0}`, `失敗 ${h.failed ?? 0}`);
  dom.settingsHealth.textContent =
    `${s.enabled ? '通知は有効' : '通知は無効'} / ${why.join(' / ')}`;

  // マスク済みしか来ない。生の URL はサーバが返さないので、ここに現れようがない
  dom.setUrl.placeholder = s.target ?? 'まだ設定されていません';
  dom.setUrlHint.textContent = urlHint(s);
  // 消せるのは、この画面で保存した分だけ。環境変数の値はここからは消せない
  dom.setUrlClear.disabled = s.sources?.webhook !== 'config';

  dom.settingsPath.textContent = s.configPath ? `保存先: ${s.configPath}` : '';
}

/**
 * 通知する状態のチェックボックスを組み直す。
 *
 * 並び順は上のバーのまとめと同じにする。サーバが知らない状態を増やしても
 * 落ちないよう、並びに無いものは後ろへ回す。
 *
 * @param {object} states 状態名 → 真偽値
 */
function fillStates(states) {
  const known = Object.keys(states ?? {});
  const order = [
    ...SUMMARY_ORDER.filter((k) => known.includes(k)),
    ...known.filter((k) => !SUMMARY_ORDER.includes(k)),
  ];

  dom.setStates.replaceChildren();
  for (const key of order) {
    const li = el('li');
    const label = el('label');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = states[key] !== false;
    box.dataset.state = key;

    // 日本語のラベルはサーバから来る。まだ一覧を引けていないときは素の名前で出す
    label.append(box, el('span', null, store.meta?.stateLabels?.[key] ?? key));
    const note = STATE_NOTES[key];
    if (note) label.append(el('span', 'note', note));

    li.append(label);
    dom.setStates.append(li);
  }
}

/**
 * 応答の中身を画面へ入れ直す。入力欄の値も含めて全部そろえる。
 *
 * @param {object} s /api/settings/notify の応答
 */
function fill(s) {
  fillStatus(s);
  fillStates(s.states);
  dom.setSettle.value = s.settleSec ?? '';
  dom.setIdle.value = s.idleMin ?? '';
  dom.setRemind.value = s.remindMin ?? '';
  dom.setDetail.value = s.detail === 'none' ? 'none' : 'full';
}

/** いまの設定を引いて画面へ入れる。 */
async function load() {
  try {
    fill(await getJson('/api/settings/notify'));
  } catch (err) {
    say(`設定を読めませんでした（${err.message}）`, 'bad');
  }
}

/* ------------------------------------------------------------ 作業フォルダ */

/**
 * 一覧の上に出す1行。
 *
 * **「その場で保存される」はここに書かない。** 足の1行（SEC_NOTE）へ移した。
 * 前は下に「保存」ボタンが並んでいたので本文で打ち消す必要があったが、
 * いまはこの節で保存のボタンが出ない（settings.css が data-sec で隠す）。
 */
const DIRS_HINT = '足したフォルダとその配下で、画面からセッションを起こせます。'
  + 'Claude Code が動いたことのあるフォルダは自動で使えるので、ここには出ません';

/**
 * 起こしてよいフォルダの一覧を組み直す。
 *
 * 消すボタンを出すのは、この画面で登録したぶん（source が 'config'）だけ。
 * 環境変数のぶんはここからは消せないので、押せないボタンを出す代わりに出どころを書く。
 *
 * @param {object|null} d /api/settings/rundirs の応答。読めなければ null
 * @param {string} [error] 読めなかった理由
 */
function fillDirs(d, error) {
  dom.runDirs.replaceChildren();

  if (!d) {
    // 読めなかったことを「1つも登録されていません」に読み替えない。
    // 足の1行には出さない（保存が失敗したように見えるため）。
    // 数の札も出さない（0 と「読めなかった」を同じ顔にしない）
    dom.runDirsN.hidden = true;
    dom.runDirsHint.textContent = `作業フォルダを読めませんでした（${error ?? '理由不明'}）`;
    return;
  }

  dom.runDirsHint.textContent = DIRS_HINT;

  const dirs = d.dirs ?? [];
  // 左の並びに数を出す。0 のときは札ごと消す（「0」を出すと登録できない場所に見える）
  dom.runDirsN.hidden = !dirs.length;
  dom.runDirsN.textContent = dirs.length ? String(dirs.length) : '';

  if (!dirs.length) {
    dom.runDirs.append(el('li', 'note', 'まだ登録されていません'));
    return;
  }

  for (const item of dirs) {
    const li = el('li');
    li.append(el('span', 'mono', item.path));

    if (item.source === 'env') {
      li.append(el('span', 'note', '環境変数'));
    } else {
      const del = el('button', 'btn', '消す');
      del.type = 'button';
      del.addEventListener('click', () => removeDir(item.path));
      li.append(del);
    }
    dom.runDirs.append(li);
  }
}

/**
 * いまの一覧を引いて画面へ入れる。通知とは別の窓口なので、片方が転んでももう片方は出る。
 */
async function loadDirs() {
  try {
    fillDirs(await getJson('/api/settings/rundirs'));
  } catch (err) {
    fillDirs(null, err.message);
  }
}

/**
 * 足す・消すを送る。応答は GET と同じ形なので、そのまま一覧に流し込める。
 *
 * @param {object} body {add} か {remove}
 * @param {string} okText うまくいったときに足の1行へ出す文
 * @returns {Promise<boolean>} 通ったか
 */
async function postDirs(body, okText) {
  if (busy) return false;
  setBusy(true);
  try {
    const { res, data } = await postJson('/api/settings/rundirs', body);
    if (!res.ok || !data?.ok) {
      // サーバは断る理由を日本語で返す。HTTP の番号より読めるので、あればそれを出す
      say(data?.reason ?? `保存できませんでした（HTTP ${res.status}）`, 'bad');
      return false;
    }
    fillDirs(data);
    say(okText, 'good');
    return true;
  } catch (err) {
    say(`保存できませんでした（${err.message}）`, 'bad');
    return false;
  } finally {
    setBusy(false);
  }
}

/**
 * 入力欄のフォルダを足す。
 *
 * **断られたときに入力欄を空にしない。** 打ち直しになるうえ、
 * 何を入れたのかが画面から消える。
 */
async function addDir() {
  const value = dom.runDirAdd.value.trim();
  if (!value) {
    say('足すフォルダを入れてください', 'bad');
    dom.runDirAdd.focus();
    return;
  }
  if (await postDirs({ add: value }, '足しました。起こすフォームからすぐ選べます')) {
    dom.runDirAdd.value = '';
  }
}

/**
 * 登録を1つ消す。確かめは出さない（間違えても、もう一度足せば戻る）。
 *
 * @param {string} dir 消すフォルダ
 */
function removeDir(dir) {
  postDirs({ remove: dir }, '消しました');
}

/**
 * 自動起動を登録できる起動のされ方か。
 *
 * ランチャが書く4つのうち、この3つは「入れた ClaudeDeck が動いている」を意味する。
 * 知らない状態が増えたときは登録できない側に倒す。
 * 「できます」と書いて実は登録できないほうが、逆より迷わせる。
 */
const STARTUP_DEPLOYED = new Set(['on', 'off', 'foreign']);

/**
 * 自動起動の節を書き換える。
 *
 * 日本語のラベルは持たない。state も legacy もサーバ（src/startup/state.mjs）から
 * 文字列で来るので、こちらは並べ方だけを決める。
 *
 * @param {object|null} s /api/health の startup。読めなかったときは null
 */
function fillStartup(s) {
  if (!s || !s.state) {
    // 読めなかったことを「登録されていません」に読み替えない。
    // 足の1行には出さない（保存が失敗したように見えるため）
    dom.startupState.textContent = '自動起動の様子を読めませんでした';
    dom.startupState.dataset.on = '';
    dom.startupLegacy.hidden = true;
    dom.startupError.hidden = true;
    dom.startupHow.textContent = '';
    return;
  }

  dom.startupState.textContent = s.label;
  // 緑は登録できているときだけ。off は「まだ登録していない」であって異常ではないので、
  // 赤にするのは別の場所が登録されている（＝直せなかった）ときに絞る
  dom.startupState.dataset.on = s.state === 'on' ? '1' : s.state === 'foreign' ? '0' : '';

  // none と unknown は書かない。「残っていません」「分かりません」の1行が常に出ると、
  // 旧方式を使っていなかった人にまで前のやり方の話を読ませることになる
  const legacy = s.legacy !== 'none' && s.legacy !== 'unknown';
  dom.startupLegacy.hidden = !legacy;
  dom.startupLegacy.textContent = legacy
    ? `前のやり方（スタートアップのショートカット）: ${s.legacyLabel}`
    : '';

  dom.startupError.hidden = !s.error;
  dom.startupError.textContent = s.error ?? '';

  dom.startupHow.textContent = STARTUP_DEPLOYED.has(s.state)
    ? '入切は ClaudeDeck.exe --install-startup / --uninstall-startup で切り替えます'
    : 'インストーラから入れた ClaudeDeck で起動したときだけ登録できます';
}

/**
 * 自動起動の様子を引く。
 *
 * 通知の設定とは別の窓口（/api/health）なので、こちらが読めなくても
 * 通知の設定は出す。開いたときに1回だけ。ここを毎秒更新しない。
 */
async function loadStartup() {
  try {
    const body = await getJson('/api/health');
    fillStartup(body?.startup ?? null);
  } catch {
    fillStartup(null);
  }
}

/**
 * 入力欄の中身を、送る形に組み立てる。
 *
 * 空欄の項目はキーごと送らない。サーバ側で「キーが無い＝変えない」になっている。
 * URL も同じで、空欄なら触らない。消すのは「消す」ボタンだけの役目にする。
 *
 * @returns {object}
 */
function collect() {
  const body = {};

  const url = dom.setUrl.value.trim();
  if (url) body.slackWebhookUrl = url;

  const nums = [
    ['settleSec', dom.setSettle],
    ['idleMin', dom.setIdle],
    ['remindMin', dom.setRemind],
  ];
  for (const [key, node] of nums) {
    const v = node.value.trim();
    if (v !== '') body[key] = v;
  }

  body.detail = dom.setDetail.value;

  body.states = {};
  for (const box of dom.setStates.querySelectorAll('input[type="checkbox"]')) {
    body.states[box.dataset.state] = box.checked;
  }

  return body;
}

/** 保存して、その場で効かせる。 */
async function save() {
  if (busy) return;
  setBusy(true);
  say('保存しています…');
  try {
    const { res, data } = await postJson('/api/settings/notify', collect());
    if (!res.ok || !data?.ok) {
      say(data?.reason ?? `保存できませんでした（HTTP ${res.status}）`, 'bad');
      return;
    }
    fill(data.settings);
    // 保存できた時点で入力欄の役目は終わり。残すと、次に開いたときに
    // 「もう入っている」ように見えて二重に保存することになる
    dom.setUrl.value = '';
    say('保存しました。すぐ効きます', 'good');
  } catch (err) {
    say(`保存できませんでした（${err.message}）`, 'bad');
  } finally {
    setBusy(false);
  }
}

/** 保存してある URL を消す。環境変数の値はここからは消せない。 */
async function clearUrl() {
  if (busy) return;
  if (!confirm('保存した Webhook URL を消します。よろしいですか？')) return;
  setBusy(true);
  try {
    const { res, data } = await postJson('/api/settings/notify', { slackWebhookUrl: '' });
    if (!res.ok || !data?.ok) {
      say(data?.reason ?? `消せませんでした（HTTP ${res.status}）`, 'bad');
      return;
    }
    fill(data.settings);
    dom.setUrl.value = '';
    say('消しました', 'good');
  } catch (err) {
    say(`消せませんでした（${err.message}）`, 'bad');
  } finally {
    setBusy(false);
  }
}

/** テストを1通送る。2分待たずに配線を確かめられるようにするためのもの。 */
async function sendTest() {
  if (busy) return;
  setBusy(true);
  say('送っています…');
  try {
    const { data } = await postJson('/api/settings/notify/test');
    // 打ちかけを消さないよう、状態の行だけ入れ替える
    if (data?.settings) fillStatus(data.settings);
    if (data?.ok) say('送りました。Slack を見てください', 'good');
    else say(data?.reason ?? '送れませんでした', 'bad');
  } catch (err) {
    say(`送れませんでした（${err.message}）`, 'bad');
  } finally {
    setBusy(false);
  }
}

/**
 * 節を切り替える。
 *
 * **出し入れは CSS がやる**（settings.css が `.settings[data-sec]` で絞る）。
 * ここは名前を書くのと、押した札の印を付け替えるのと、足の1行を入れ替えるだけ。
 * JS で出し入れすると、節を1つ足すたびに配線が増える。
 *
 * @param {string} name 'notify' | 'dirs' | 'state'
 */
function pickSec(name) {
  dom.settings.dataset.sec = name;
  for (const b of dom.settingsNav.querySelectorAll('.settings-navb')) {
    b.setAttribute('aria-pressed', String(b.dataset.sec === name));
  }
  // 節を移るたびに前の結果を消す。残すと「保存しました」が
  // 作業フォルダの節にも出て、どちらの話か分からなくなる
  say(SEC_NOTE[name] ?? '');
}

/** モーダルを開く。中身は開くたびに引き直す。 */
function open() {
  dom.setUrl.value = '';
  // 開くたびに通知へ戻す。前に見ていた節を覚えると、
  // 「設定を開いた」のに読むだけの節が出ることがある
  pickSec('notify');
  dom.settings.showModal();
  // 別々の窓口なので、1つが転んでも他は出る。
  // どれも中で受け止めているので、await せずに投げてよい
  load();
  loadDirs();
  loadStartup();
}

/** 設定モーダルを配線する。main.js から1回だけ呼ぶ。 */
export function initSettings() {
  // 左の並びにアイコンを差す。名前は隣の文字が持つので aria-hidden のまま置く
  for (const b of dom.settingsNav.querySelectorAll('.settings-navb')) {
    const name = NAV_ICONS[b.dataset.sec];
    if (name) b.prepend(icon(name));
  }

  dom.settingsNav.addEventListener('click', (ev) => {
    const b = ev.target.closest('.settings-navb');
    if (b) pickSec(b.dataset.sec);
  });

  dom.settingsOpen.addEventListener('click', open);
  dom.settingsClose.addEventListener('click', () => dom.settings.close());

  // 背面を押したら閉じる。dialog 自身には余白を持たせていないので、
  // ここへ来るのは背面を押したときだけになる（settings.css の padding: 0）
  dom.settings.addEventListener('click', (ev) => {
    if (ev.target === dom.settings) dom.settings.close();
  });

  dom.settingsSave.addEventListener('click', save);
  dom.settingsTest.addEventListener('click', sendTest);
  dom.setUrlClear.addEventListener('click', clearUrl);
  dom.runDirAddBtn.addEventListener('click', addDir);

  // <form> で囲っていないので、Enter は自分で拾う。
  // 囲うと Enter がモーダルを閉じてしまい、保存したつもりで消える
  dom.settings.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    if (!ev.target.matches('.settings-text, .settings-num')) return;
    ev.preventDefault();
    // 作業フォルダの追加欄だけ行き先が違う。見た目を .settings-text から借りているので
    // クラスでは見分けられない。参照で分ける（run-form.js が本文欄を分けているのと同じ）
    if (ev.target === dom.runDirAdd) addDir();
    else save();
  });
}
