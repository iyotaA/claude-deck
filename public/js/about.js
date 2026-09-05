/* このアプリの説明。層7。
 *
 * 上のバーの `info` から開く `<dialog>`。器と作法は設定モーダル（`settings.js`）と同じで、
 * `<dialog>` ＋ `showModal()`（Esc・背面の膜・焦点の閉じ込めがタダで付く）。
 *
 * **中身のほとんどは `index.html` に静的に置いてある。**
 * ここが組むのは凡例2つ（状態の点・経過の印）と版の1行だけ。
 *
 * ## 凡例を画面側に持たない
 *
 * これがこのファイルの主題。印の意味を手で並べると、
 * **状態や種類が1つ増えた日に凡例だけが古くなる。**
 * このリポジトリは「表を2つ持たない」で通してきたので、ここでもそれに乗る。
 *
 * | 出すもの | 引く先 |
 * |---|---|
 * | 状態の色と形 | `store.js` の `STATE_TONE`（`toneOf` / `colorOf`） |
 * | 状態の日本語 | `/api/sessions` の `meta.stateLabels` |
 * | 止まっているか | `/api/sessions` の `meta.stateBlocking` |
 * | 群と種類の対応 | `timeline/kinds.js` の `KIND_MARK` ＋ `MARK_GROUPS` |
 * | 種類の日本語 | `timeline/kinds.js` の `KIND_LABELS` |
 * | 版 | `/api/update` の `current`（上のバーの `#ver` と同じ出どころ） |
 *
 * **形の名前（菱形・輪…）は1文字も書かない。** 実物の点をそのまま置けば、
 * 形は見れば分かるし、`list.css` を直した日にここが嘘になることもない。
 *
 * ## `timeline/kinds.js` を直に見ている
 *
 * `timeline/` の中を外から直に import してよいのは、いま3箇所
 * （`store.js`・`detail-panels.js`・ここ）。あれは層0 の語彙なので向きは崩れない。
 */
import { el } from './util.js';
import { icon } from './icons.js';
import { dom } from './dom.js';
import { closeOnBackdrop } from './modal.js';
import { store, SUMMARY_ORDER, STATE_TONE, toneOf, colorOf } from './store.js';
import { KIND_LABELS, KIND_MARK, MARK_GROUPS } from './timeline/kinds.js';

/**
 * 節の左ナビに差す絵。**この5つはここでしか使わない**ので、
 * `main.js` ではなくこちらで差す（`settings.js` と同じ流儀）。
 */
const SEC_ICON = {
  what: 'deck',
  screen: 'sidebar',
  marks: 'info',
  words: 'chart',
  about: 'gear',
};

/**
 * 札の凡例。
 *
 * **ここだけは表を持つ。** `.tag.is-*` は CSS にしか無く、
 * 「どのクラスが何を意味するか」を持っている場所が他に無いため。
 * 増やすときは `list.css` と一緒に直す。
 */
const TAGS = [
  { cls: 'is-deck', label: 'この画面から', note: 'この画面で起こしたセッション。ここから答えられます' },
  { cls: 'is-skill', label: 'スキル', note: 'そのセッションで使ったスキル' },
  { cls: 'is-plan', label: 'プラン', note: 'プランを出したセッション' },
  { cls: 'is-agents', label: 'サブエージェント', note: '子のエージェントを使ったセッション' },
];

/**
 * 状態の凡例を組む。
 *
 * **状態ごとではなく、調子（tone）ごとに1行。** 形を決めているのが調子だから
 * （`needs-answer` と `needs-approval` は同じ菱形）。
 * 同じ調子の状態は名前を並べて出す。
 *
 * 並びは `SUMMARY_ORDER`（上のバーと同じ順）。そこに無い状態は後ろへ回す
 * ―― サーバが1つ足しても黙って消えない。
 */
function fillStates() {
  const labels = store.meta?.stateLabels ?? {};
  const blocking = store.meta?.stateBlocking ?? {};
  // 一覧を1度も引けていないときは、素の状態名で出す（空にしない）
  const known = Object.keys(labels).length ? Object.keys(labels) : Object.keys(STATE_TONE);
  const order = [
    ...SUMMARY_ORDER.filter((k) => known.includes(k)),
    ...known.filter((k) => !SUMMARY_ORDER.includes(k)),
  ];

  // 調子ごとに束ねる。Map なので最初に出てきた順が保たれる
  const byTone = new Map();
  for (const key of order) {
    const tone = toneOf(key);
    const row = byTone.get(tone) ?? { tone, state: key, names: [], blocking: false };
    row.names.push(labels[key] ?? key);
    if (blocking[key] === true) row.blocking = true;
    byTone.set(tone, row);
  }

  dom.aboutStates.replaceChildren();
  for (const row of byTone.values()) {
    const li = el('li');
    // **点だけを1列目に置く。名前は本文の側へ回す。**
    // 前は名前を `.state` の中に入れていたが、あれは `white-space: nowrap` を持つので、
    // 「質問待ち / プラン承認待ち / 承認待ち」が列（8.5rem）から溢れて右の文と重なっていた。
    // 印の凡例と同じ組み（印 ／ 名前＋中身）に揃えると、その問題ごと無くなる。
    //
    // 実物の点をそのまま置く。**形の名前は1文字も書かない** ―― 見れば分かるし、古くならない
    const dot = el('span', 'state');
    dot.dataset.s = row.tone;
    dot.style.setProperty('--state-color', colorOf(row.state));
    li.append(dot);

    const body = el('span');
    body.append(el('span', 'lg-name', row.names.join(' / ')));
    // 「答えないと1行も進まない」の判定は画面側に持たない（meta.stateBlocking から引く）
    body.append(el('span', 'lg-kinds', row.blocking
      ? 'あなたが答えるまで、1行も進みません'
      : row.tone === 'calm' ? 'Claude が動いています'
        : row.tone === 'warn' ? '返事は終わっていて、次の指示を待っています'
          : '動いていません'));
    li.append(body);
    dom.aboutStates.append(li);
  }
}

/**
 * 経過の印の凡例を組む。
 *
 * 群の並びは `MARK_GROUPS`。そこに無い種類（`compact`）は最後に「印なし」として出す
 * ―― 黙って落とすと、画面に出ているのに凡例に無い印が生まれる。
 *
 * `elided`（省略）はチップにも出さない間引きの副産物なので、ここでも出さない。
 */
function fillKinds() {
  const groups = MARK_GROUPS.map((g) => ({ ...g, kinds: [] }));
  const none = { group: '', icon: null, label: '印を持たないもの', kinds: [] };
  const byGroup = new Map(groups.map((g) => [g.group, g]));

  for (const [kind, label] of Object.entries(KIND_LABELS)) {
    if (kind === 'elided') continue;
    const g = byGroup.get(KIND_MARK[kind] ?? '') ?? none;
    g.kinds.push(label);
  }

  dom.aboutKinds.replaceChildren();
  for (const g of [...groups, none]) {
    if (!g.kinds.length) continue;
    const li = el('li');
    const mark = el('span', 'about-mark');
    // 印を持たない群には data-g も絵も付けない（CSS が点に縮める）
    if (g.group) {
      mark.dataset.g = g.group;
      mark.append(icon(g.icon, 13));
    }
    li.append(mark);

    const body = el('span');
    body.append(el('span', 'lg-name', g.label));
    body.append(el('span', 'lg-kinds', g.kinds.join(' ／ ')));
    li.append(body);
    dom.aboutKinds.append(li);
  }
}

/** 札の凡例。 */
function fillTags() {
  dom.aboutTags.replaceChildren();
  for (const t of TAGS) {
    const li = el('li');
    li.append(el('span', `tag ${t.cls}`, t.label));
    li.append(el('span', 'lg-kinds', t.note));
    dom.aboutTags.append(li);
  }
}

/**
 * 版の1行。
 *
 * **出どころは `/api/update` の `current`。** 上のバーの `#ver` と同じところから取る
 * （画面に版を2つの出どころで書かない）。まだ引けていなければ名前だけ出す
 * ―― 0 と不明を分けるのと同じで、「不明」とは書かない。
 */
function fillVersion() {
  const version = store.update?.current ?? null;
  dom.aboutVersion.textContent = version ? `ClaudeDeck v${version}` : 'ClaudeDeck';
}

/**
 * 節を切り替える。**器の `data-sec` を書き替えるだけ。**
 *
 * 出し入れは CSS がやるので、ここで節点を作り直さない
 * （`settings.js` / `usage-tab.js` と同じ作法。節を1つ足しても配線が増えない）。
 *
 * @param {string} name 節の名前
 */
function pickSec(name) {
  dom.about.dataset.sec = name;
  for (const btn of dom.aboutNav.children) {
    btn.setAttribute('aria-pressed', String(btn.dataset.sec === name));
  }
}

/**
 * 開く。
 *
 * **中身は開いたときに1回だけ組む。** ここを毎秒更新しない（設定モーダルと同じ）。
 * 引く窓口は持たない ―― 材料はどれも既に `store` に載っている。
 */
function open() {
  // 開くたび先頭の節へ戻す。前に開いたかどうかを覚えると、開くたびに違う画面が出る
  pickSec('what');
  fillStates();
  fillKinds();
  fillTags();
  fillVersion();
  dom.about.showModal();
}

/** 配線。`main.js` から1回だけ呼ぶ。 */
export function initAbout() {
  for (const btn of dom.aboutNav.children) {
    const name = SEC_ICON[btn.dataset.sec];
    if (name) btn.prepend(icon(name));
  }

  dom.aboutOpen.addEventListener('click', open);
  dom.aboutClose.addEventListener('click', () => dom.about.close());
  dom.aboutNav.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.settings-navb');
    if (btn) pickSec(btn.dataset.sec);
  });
  closeOnBackdrop(dom.about);
}
