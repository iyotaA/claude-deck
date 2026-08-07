/* 通知の設定モーダル。層7。
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
import { dom, store, SUMMARY_ORDER } from './store.js';

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
  const parts = [s.enabled ? '通知は有効' : '通知は無効'];
  // 止めるスイッチだけは環境変数のほうが強い。ここで言わないと、
  // 保存しても鳴らない理由が画面のどこにも出ないことになる
  if (s.off) parts.push('環境変数 CLAUDE_DECK_NOTIFY_OFF で止めています');
  else if (!s.enabled && s.error) parts.push(s.error);
  if ((h.state === 'disabled' || h.state === 'paused') && h.reason) {
    parts.push(`停止中: ${h.reason}`);
  }
  parts.push(`送信 ${h.sent ?? 0}`, `失敗 ${h.failed ?? 0}`);
  dom.settingsState.textContent = parts.join(' / ');
  dom.settingsState.dataset.on = s.enabled ? '1' : '0';

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

/**
 * 書き込みの共通部分。
 *
 * content-type を付けるのはここ1箇所だけにする。付け忘れると門番に 415 で断られる。
 *
 * @param {string} path 窓口
 * @param {object} [body] 送る中身
 * @returns {Promise<object>} 応答の JSON。読めなければ空
 */
async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => null);
  return { res, data: data ?? {} };
}

/** いまの設定を引いて画面へ入れる。 */
async function load() {
  try {
    const res = await fetch('/api/settings/notify');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fill(await res.json());
  } catch (err) {
    say(`設定を読めませんでした（${err.message}）`, 'bad');
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
    const { res, data } = await post('/api/settings/notify', collect());
    if (!res.ok || !data.ok) {
      say(data.reason ?? `保存できませんでした（HTTP ${res.status}）`, 'bad');
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
    const { res, data } = await post('/api/settings/notify', { slackWebhookUrl: '' });
    if (!res.ok || !data.ok) {
      say(data.reason ?? `消せませんでした（HTTP ${res.status}）`, 'bad');
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
    const { data } = await post('/api/settings/notify/test');
    // 打ちかけを消さないよう、状態の行だけ入れ替える
    if (data.settings) fillStatus(data.settings);
    if (data.ok) say('送りました。Slack を見てください', 'good');
    else say(data.reason ?? '送れませんでした', 'bad');
  } catch (err) {
    say(`送れませんでした（${err.message}）`, 'bad');
  } finally {
    setBusy(false);
  }
}

/** モーダルを開く。中身は開くたびに引き直す。 */
function open() {
  dom.setUrl.value = '';
  say('');
  dom.settings.showModal();
  load();
}

/** 設定モーダルを配線する。main.js から1回だけ呼ぶ。 */
export function initSettings() {
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

  // <form> で囲っていないので、Enter は自分で拾う。
  // 囲うと Enter がモーダルを閉じてしまい、保存したつもりで消える
  dom.settings.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    if (!ev.target.matches('.settings-text, .settings-num')) return;
    ev.preventDefault();
    save();
  });
}
