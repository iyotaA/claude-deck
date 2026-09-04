/* 詳細ペインの組み立て。
 *
 * 層4。パネル1枚ずつの中身は detail-head / detail-wait / detail-panels / agents が持ち、
 * ここは「どのタブに入れるか」と「作り直すかどうか」だけを決める。
 *
 * 以前は11枚のパネルを1本の縦棒に積んでいた。同時に置きうる情報の塊が多すぎて、
 * いま何を見ればいいのかが分からなくなっていたので、役目で割って2箇所に分けてある。
 *
 * 中央（TAB_DEFS）は「その作業をするのに要るもの」。どれか1つが必ず出ている。
 *
 *   いま … あなたの番 / この画面から起こした実行 / 続きを起こす
 *   経過 … 文脈の圧縮 / 時系列 / ここまで
 *   成果 … 決めたこと / TODO / 書き換えたファイル
 *   調査 … サブエージェントの記録
 *
 * 右のインスペクタ（INSP_DEFS）は「作業しながら横目で見るもの」。既定では閉じている。
 *
 *   数値 … 何にトークンを使ったか
 *   診断 … 困ったときに見る値
 *
 * 分けたのは、これを中央に混ぜると数字を見るために作業の手元を隠すことになるため。
 * 右なら中央と同時に見られる。**同時に開くのは1つだけ**にしてあるのは、
 * 並べると元の縦棒に戻るから。
 *
 * **「成果」は右から中央へ戻した。** あれは芯の「どうなったのか」に答えるもので、
 * 横目で見るものではない。レールを1押ししないと見えない場所に置いていたのをやめ、
 * 要約（ここまで）を経過タブの終わりに、詳しくを成果タブに置く。
 *
 * **選んだタブのぶんだけ組む。** 全部組んで CSS で隠す形にはしない。
 * timelinePanel() は必ず Timeline.attach() を呼ぶので、隠した節点を掴んだままになり、
 * 画面に出ていない時系列へ描き続けることになる。
 */
import { el, num } from './util.js';
import { mark } from './perf.js';
import { icon } from './icons.js';
import { dom, store, syncQuery, STATE_COLOR } from './store.js';
import { headOf, detailErrorNow } from './rows.js';
import { panel } from './panel.js';
import { detailActions, summaryBlock } from './detail-head.js';
import { waitingBlock } from './detail-wait.js';
import {
  decisionsPanel, todoPanel, compactionPanel, timelinePanel, filesPanel, basicsPanel,
  outcomeBlock,
} from './detail-panels.js';
import { agentsPanel } from './agents.js';
import { isZoomed, toggleZoom, closeZoom } from './zoom.js';
import { usagePanel } from './usage-panel.js';
import { runStampFor } from './runs.js';
import * as RunView from './run-view.js';
import * as RunResume from './run-resume.js';
import * as Timeline from './timeline/index.js';

/**
 * 「いま」のタブに色を付ける状態。
 *
 * **答えないと1行も進まないもの（blocking）はここに無い。** あれはタブ帯より上に
 * 出しているので、どのタブを見ていても本体が見えている。タブに色まで足すと、
 * 同じことを2箇所で言うことになる。
 *
 * 残しているのは返信待ちだけ。あれは「いま」タブの中にあり、放置しても壊れないが、
 * 別のタブを見ているあいだ手が要ることは伝えたい。
 *
 * running（Claude が動いている）には付けない。選んでいるタブの下線が --accent で、
 * 実行中の色（--calm）と同じ青なので、押されているのか色が付いているのか分からなくなる
 */
const NOW_TONE = {
  'awaiting-reply': 'is-warn',
};

/**
 * 中央タブの定義。並びがそのまま画面の並び。id は store.detailTab の値。
 *
 * count はタブの右肩に出す数。**データを直に読む。**
 * パネルの戻り値からは取れない（選んでいないタブのパネルは組まないため）。
 *
 * 0 のときは数を出さない。ほとんどのセッションはサブエージェントを持たないので、
 * すべてのタブに 0 が並ぶだけになる。空かどうかは押したときの1行で言う。
 * そこでなら「まだ読めていない」と「無い」を書き分けられる
 *
 * needsDetail は「会話ログの全文（store.detail）が無いと何も組めない」印。
 * 立っているタブは、読めていなければ既存の取得中・失敗の表示へ倒す
 */
export const TAB_DEFS = [
  { id: 'log', label: '経過', needsDetail: true, count: (c) => c.d?.digest.items.length ?? null },
  // 数はファイルの件数。決めたことと TODO を足した合計にはしない（種類の違う3つを足した数は読めない）。
  // ファイルにしたのは、芯の「どんな作業をしたか」の主指標で、いちばん動く数だから
  { id: 'out', label: '成果', needsDetail: true, count: (c) => c.d?.digest.files.length ?? null },
  { id: 'now', label: 'いま' },
  { id: 'agents', label: '調査', needsDetail: true, count: (c) => c.d?.subagents?.items?.length ?? null },
];

/**
 * いま実際に組むタブ。
 *
 * 既定は「経過」だが、あれは会話ログの全文が要る（needsDetail）。
 * **この画面から起こした直後はログが1行も無い**ので、そのままだと
 * 「ログを読んでいます…」しか出ない。実行の様子（いま）を出すほうが役に立つ。
 *
 * **store.detailTab は書き換えない。** URL に載っている指定と、
 * ログが出たあとの戻り先を保つため。ログが届けば黙って「経過」へ戻る
 *
 * @param {object|null} d 詳細（読めていなければ null）
 * @param {string|null} error 取れなかった理由（あれば失敗の表示へ倒す）
 */
function effectiveTab(d, error) {
  const def = TAB_DEFS.find((t) => t.id === store.detailTab) ?? TAB_DEFS[0];
  if (!def.needsDetail || d || error) return def;
  return TAB_DEFS.find((t) => t.id === 'now') ?? def;
}

/**
 * 右のインスペクタの定義。並びがそのままレールの並び。id は store.inspector の値。
 *
 * 形は TAB_DEFS と同じにしてある。中央と右で組み方を変えると、
 * どちらかに足したときにもう片方の作法を思い出せなくなる。
 *
 * title はインスペクタの見出し。レールのボタンは幅 2.3rem しか無いので短い語を出し、
 * 開いた先で何を見ているのかを言い直す
 */
export const INSP_DEFS = [
  { id: 'usage', label: '数値', icon: 'chart', title: '何にトークンを使ったか' },
  // **id は basics のまま。** ?insp=basics は v0.6.0 で配っているので、
  // 名前を変えると配ったブックマークが切れる。替えるのは札と見出しだけ。
  // 「状態」から替えたのは、いまの状態そのもの（あなたの番・返信待ち）は
  // 帯とヘッダに出ていて、ここに残るのが困ったときに見る値だから
  { id: 'basics', label: '診断', icon: 'info', title: '困ったときに見る値' },
];

/**
 * いま出してよい数値。
 *
 * 選び直した直後は、前のセッションの数値がまだ store に残っている。
 * id を突き合わせないと、別のセッションの数字を数秒のあいだ出し続けることになる
 * （数値は詳細とは別の窓口から、別のタイミングで届く）
 *
 * @returns {object|null}
 */
function usageNow() {
  return store.usage?.id === store.selected ? store.usage : null;
}

/** 数値を取れなかった理由。detailErrorNow と同じく、選んでいるセッションのものだけ返す */
function usageErrorNow() {
  return store.usageErrorFor === store.selected ? store.usageError : null;
}

/**
 * いま出してよい「直近の中央値」。
 *
 * 数値そのものとは別の窓口から、さらに遅れて着く（直近24本を全文読むので実測 400〜700ms）。
 * 着くまでは null で、そのあいだは札に差を書かないだけ。**推測で 0 を書かない。**
 *
 * @returns {object|null}
 */
function baselineNow() {
  return store.usageBaseline?.id === store.selected ? store.usageBaseline.baseline : null;
}

/**
 * 詳細ペインを作り直すかどうかの材料。
 *
 * 一覧の push は2秒ごとに来る。そのたびに作り直すと、開いた <details> と
 * スクロール位置が消える。実際に画面へ出している値が動いたときだけ作り直す。
 *
 * idleMs と lastActivityAt は入れない。refreshTimes() が文字だけ差し替えるので
 * 作り直す必要がなく、しかも毎秒動くので入れると条件そのものが意味を失う
 */
function detailKeyOf() {
  const row = headOf(store.selected);
  const w = row?.waitingFor ?? null;
  return [
    store.selected ?? '',
    detailErrorNow() ?? '',
    // 開いているタブ。混ぜないと、押しても renderDetailIfNeeded() が素通りする
    store.detailTab,
    // 右のインスペクタ（閉じているときは空文字）。いまは setInspector() が
    // 自分で renderDetail() を呼ぶので無くても動くが、混ぜておかないと
    // 別の経路（Ctrl+K など）から store.inspector を動かしたときに黙って素通りする
    store.inspector ?? '',
    row?.state ?? '',
    row?.stateLabel ?? '',
    row?.stateReason ?? '',
    row?.statusRaw ?? '',
    row?.alive ? '1' : '0',
    row?.pid ?? '',
    row?.contextTokens ?? '',
    w ? `${w.tool ?? ''}${w.detail ?? ''}` : '',
    // 数値は詳細より遅れて届く。入れておかないと、届いてもパネルが出ない。
    // contextTokens が既に入っているので、稼働中は元から毎ターン作り直している。
    // ここを足したことで作り直しが増えるわけではない
    usageNow()?.logSize ?? '',
    usageErrorNow() ?? '',
    // 中央値はさらに遅れて着く（別の窓口。直近24本を読むので数値より遅い）。
    // ここへ入れておかないと、着いても鍵が動かず、札に差が書き足されない
    baselineStamp(),
    // 実行の状態。**出来事が増えただけでは動かない値**を runs.js が組んでいる。
    // 速報は1ターンで数百行来るので、それを鍵に混ぜると入力中の caret まで毎回消える。
    // 画面は速報を1件も持たないので、追記の受け持ちはどこにも無い
    runStampFor(store.selected),
  ].join('');
}

/**
 * 中央値のうち、実際に画面へ出している値だけを1本にまとめる。detailKeyOf の材料。
 *
 * 有無だけでは足りない。5分ごとに引き直したときに中身が動いていても鍵が同じままになる。
 * オブジェクトそのものを見比べない（毎回別の参照で届くので、必ず不一致になる）
 *
 * @returns {string}
 */
function baselineStamp() {
  const b = baselineNow();
  if (!b) return '';
  return [b.model, b.sessions, b.ite, b.contextLast, b.hitRate, b.compactCount].join(',');
}

/** 前回 renderDetail() を通したときの材料。detail は参照そのままで見比べる */
let lastDetailRender = { detail: undefined, key: null };

/**
 * 必要なら詳細ペインを作り直す。
 *
 * apply() と loadDetail() は毎秒ここを通る。作り直すかどうかの判断は detailKeyOf() に寄せた
 */
export function renderDetailIfNeeded() {
  if (lastDetailRender.detail === store.detail && lastDetailRender.key === detailKeyOf()) return;
  renderDetail();
}

/**
 * 中央のタブを替える。
 *
 * 画面のタブとパレット（Ctrl+K）が同じ口を通る。
 * 押したあとの後始末（URL の同期・描き直し・巻き戻し）を2箇所に書かないため
 *
 * 語彙の外の id は黙って捨てる。ここは画面の外からも呼ばれるので、
 * 知らない値で落ちない形にしておく
 *
 * @param {string} id TAB_DEFS の id
 */
export function setDetailTab(id) {
  if (store.detailTab === id) return;
  if (!TAB_DEFS.some((t) => t.id === id)) return;
  store.detailTab = id;
  syncQuery();
  renderDetail();
  // 前のタブで下まで読んでいた位置が残ると、移った先の途中から始まってしまう
  dom.detail.scrollTop = 0;
}

/**
 * 中央タブの帯。
 *
 * 上に残す（sticky）。詳細は縦に長いので、下まで読んでから別のタブへ移るときに
 * 一番上まで戻らせない
 *
 * @param {{row: object, d: object|null}} ctx タブの数を出すための材料
 */
function tabBar(ctx) {
  const bar = el('nav', 'detail-tabs');
  bar.setAttribute('aria-label', 'このセッションの何を見るか');

  for (const t of TAB_DEFS) {
    const b = el('button', 'detail-tab', t.label);
    b.type = 'button';
    // 押している印は**実際に組んだタブ**に付ける。store.detailTab で付けると、
    // ログ待ちで「いま」へ倒しているあいだ、押されている札と中身が食い違う
    const on = ctx.tab.id === t.id;
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    // 「いま」だけは、別のタブを見ているあいだも手が要ることが分かるように色を付ける
    if (t.id === 'now' && NOW_TONE[ctx.row.state]) b.classList.add(NOW_TONE[ctx.row.state]);
    const n = t.count ? t.count(ctx) : null;
    if (n) b.append(el('span', 'n', num(n)));
    b.addEventListener('click', () => setDetailTab(t.id));
    bar.append(b);
  }

  // 右端に拡大。判断を求められるものを大きく読むための口。
  // **帯ごと拡大する**ので、拡大したまま経過・調査へも移れる。
  // 押したあとの札の付け替えはここでやらない。zoom.js が組み直しを呼ぶので、
  // Esc・背面・× で閉じたときも同じ経路を通る（押しボタン側で書き換えると
  // そちらの経路で「縮小」のまま残る）
  const on = isZoomed();
  const zoom = el('button', 'detail-zoom', on ? '縮小' : '拡大');
  zoom.type = 'button';
  zoom.setAttribute('aria-pressed', on ? 'true' : 'false');
  zoom.title = on ? '元の大きさに戻す' : '詳細を大きく開く';
  zoom.addEventListener('click', toggleZoom);
  bar.append(zoom);

  return bar;
}

/**
 * 選んでいるタブの中身を組んで stack へ積む。
 *
 * 空のときに黙って空白にしない。1行だけでも書いておかないと、
 * 押したのに何も起きていないように見える
 *
 * @param {HTMLElement} stack 積む先
 * @param {{row: object, d: object|null}} ctx
 */
function fillTab(stack, ctx) {
  const { row, d } = ctx;
  const add = (node) => { if (node) stack.append(node); };
  const none = (text) => stack.append(el('p', 'tab-none', text));

  switch (ctx.tab.id) {
    case 'log':
      // 圧縮を時系列の上に置く。どこで文脈が切れたかは、時系列の読み方そのものを変える
      add(compactionPanel(d));
      // timelinePanel は必ず節点を返す（Timeline.attach() を呼ぶのはここだけ）
      add(timelinePanel(d));
      // 到達点は時系列の後ろ。並び順に関わらずここへ置く（時刻を持たない累積の集計なので、
      // 時系列のどの位置とも対応しない）。onMore を差すのはここ（層3 から層4 を呼ばせない）
      add(outcomeBlock(d, { onMore: () => setDetailTab('out') }));
      break;

    case 'out': {
      const before = stack.childElementCount;
      add(decisionsPanel(d));
      add(todoPanel(d));
      add(filesPanel(d));
      if (stack.childElementCount === before) none('まだ決めたこと・TODO・書き換えたファイルはありません');
      break;
    }

    case 'agents': {
      const p = agentsPanel(d.subagents, row.sessionId);
      if (p) add(p);
      else none('このセッションはサブエージェントを呼んでいません');
      break;
    }

    default: {
      // 'now'。何を待っているか → この画面から起こした実行 → 続きを起こす。
      // if (d) の外なのは、起こした直後はまだ会話ログが1行も無いため
      // （ログが出るまで何も出ないと、押したのに何も起きていないように見える）
      const before = stack.childElementCount;
      // 答えないと1行も進まない待ちは帯より上に出しているので、ここでは出さない。
      // 出すと同じパネルが1画面に2枚並ぶ
      if (row.blocking !== true) add(waitingBlock(row, d));
      add(RunView.runPanel(row.sessionId));
      add(RunResume.resumePanel(row));
      if (stack.childElementCount === before) none('いまあなたの手が要るものはありません');
      break;
    }
  }
}

/**
 * 全文（store.detail）が無いと何も組めないタブの倒し方。
 *
 * 中央と右で同じ形にする。片方だけ言い方を変えると、同じ「読めていない」が
 * 場所によって違う顔で出ることになる
 *
 * @param {HTMLElement} stack 積む先
 * @param {string|null} error 取れなかった理由
 */
function fillPending(stack, error) {
  if (!error) {
    stack.append(el('div', 'loading', 'ログを読んでいます…'));
    return;
  }
  const p = panel('詳細を読み込めませんでした');
  p.body.append(el('p', 'note', error));
  stack.append(p.section);
}

/**
 * 右のインスペクタの中身を組んで stack へ積む。
 *
 * 中央の fillTab() と同じ作法（空なら1行だけ書く）。
 * 中身は移す前と同じものを出す（「成果」は中央のタブへ戻したので、ここには無い）
 *
 * @param {HTMLElement} stack 積む先
 * @param {{row: object, d: object|null}} ctx
 */
function fillInsp(stack, ctx) {
  const { row, d } = ctx;
  const add = (node) => { if (node) stack.append(node); };
  const none = (text) => stack.append(el('p', 'tab-none', text));

  switch (store.inspector) {
    case 'basics':
      add(basicsPanel(row, d));
      break;

    default: {
      // 'usage'。詳細（d）が読めていなくても出せる。
      // 別の窓口から来るので、詳細の失敗に巻き込む理由が無い
      const p = usagePanel(usageNow(), d, usageErrorNow(), baselineNow());
      if (p) add(p);
      else if (usageNow()) none('このセッションには数えられる要求がありません');
      else none('数値を読んでいます…');
      break;
    }
  }
}

/**
 * インスペクタの開閉を器へ当てる。
 *
 * hidden で丸ごと外すと grid の列も消える（.deck の列は開閉で2種類ある）。
 * 目印を付けるのは .app 側で、これは .is-list-open と同じ流儀
 *
 * @param {boolean} open 開くなら true
 */
function applyInspOpen(open) {
  dom.insp.hidden = !open;
  dom.app.classList.toggle('is-insp-open', open);
}

/**
 * レールのボタンの状態を合わせる。
 *
 * ボタン自体は initInspector() で1回だけ組む。**毎回作り直さない。**
 * 詳細ペインは他の理由でもよく組み直されるので、そのたびに節点を捨てると
 * キーボードで辿っている途中の focus が飛ぶ
 *
 * @param {object|null} row 選んでいるセッション（無ければ null）
 */
function syncRail(row) {
  for (const b of dom.rail.querySelectorAll('.rail-btn')) {
    b.setAttribute('aria-pressed', store.inspector === b.dataset.insp ? 'true' : 'false');
    // 出す中身がまだ無いので押させない。**隠さない**（列の幅が変わって中央が跳ねる）
    b.disabled = !row;
  }
}

/**
 * 右のインスペクタを組み直す。開いていなければ何もしない。
 *
 * 中央と同じ材料（ctx）で組む。中央だけ差し替えると、セッションを選び直したあとも
 * 右に前のセッションの数字が残る
 *
 * @param {{row: object, d: object|null, error: string|null}} ctx
 */
function renderInspector(ctx) {
  const def = INSP_DEFS.find((t) => t.id === store.inspector);
  if (!def) return;
  dom.inspTitle.textContent = def.title;

  const stack = el('div', 'stack');
  // **INSP_DEFS は needsDetail を持たない。** 右の2つは全文が無くても組める
  // （数値は別の窓口から来る・診断は一覧の行が材料）。
  // 中央タブと形を揃えて `def.needsDetail` を見に行っていたが、
  // 常に undefined で分岐が1つも通っていなかったので外した
  fillInsp(stack, ctx);
  dom.inspBody.append(stack);
}

/**
 * 右のインスペクタを開く／閉じる。
 *
 * 同じものを押したら閉じる。レールは開く口と閉じる口を兼ねている
 *
 * @param {string|null} id INSP_DEFS の id。null で閉じる
 */
export function setInspector(id) {
  store.inspector = store.inspector === id ? null : id;
  syncQuery();
  renderDetail();
}

/**
 * レールを組んで、閉じるボタンを配線する。起動時に1回だけ呼ぶ。
 *
 * レールは詳細の中身ではなく画面の枠なので、セッションを選んでいなくても出したままにする。
 * 選ぶまでは押せない（syncRail が disabled を当てる）
 */
export function initInspector() {
  for (const t of INSP_DEFS) {
    const b = el('button', 'rail-btn');
    b.type = 'button';
    b.dataset.insp = t.id;
    b.disabled = true;
    b.setAttribute('aria-pressed', 'false');
    // **絵だけにする。** 縦のレールに字を積むと1文字ずつ折り返すか、
    // レールそのものを広げることになる。名前は title と aria-label に残るので、
    // 触れば出るし読み上げにも乗る（上のバーの補助3つと同じ流儀）
    b.append(icon(t.icon, 17));
    b.title = `${t.label} — ${t.title}`;
    b.setAttribute('aria-label', b.title);
    b.addEventListener('click', () => setInspector(t.id));
    dom.rail.append(b);
  }
  dom.inspClose.addEventListener('click', () => setInspector(null));
}

/**
 * 中央下の入力欄を、いまの行に合わせる。
 *
 * **中身の節点は run-view.js / run-resume.js が module-level に1つだけ持っている。**
 * 同じものが既に入っていれば触らない。差し替えると打っている途中に caret が飛ぶ。
 * 器を詳細ペイン（`dom.detail`）の中に置いていないのはこのためで、
 * あちらは描き直しのたびに `replaceChildren()` される。
 *
 * 出す順は「続きを起こす」が先。終わった実行にも `RunView` は節点を返す
 * （「この実行はもう終わっています」の死んだ入力欄）ので、後ろに回さないと
 * 押せる「続きを起こす」が押せない欄に隠れる。
 *
 * @param {object|null} row 一覧の行と同じ形のもの
 */
function syncComposer(row) {
  const node = row
    ? (RunResume.composerFor(row) ?? RunView.composerFor(row.sessionId))
    : null;

  if (dom.composer.firstElementChild !== node) {
    dom.composer.replaceChildren();
    if (node) dom.composer.append(node);
  }
  dom.composer.hidden = !node;
}

export function renderDetail() {
  const t0 = performance.now();
  // row と呼んでいるのは一覧の行と同じ形のもの。一覧に居なければ詳細から組む
  const row = headOf(store.selected);
  // 出すものが無いなら拡大を畳む。膜の裏で一覧が触れないまま
  // 「左の一覧から選ぶと…」だけが出る状態を作らない。
  //
  // **DOM を触る前に呼ぶ。** closeZoom() は組み直し（= この関数）を呼び返すので、
  // 下の replaceChildren() より後に置くと、内側の組み立てのあとに
  // 外側がもう一度同じものを足して二重に出る
  if (!row) closeZoom();
  const error = detailErrorNow();
  lastDetailRender = { detail: store.detail, key: detailKeyOf() };
  // 前の取っ手はここで捨てる。作り直したあとの画面に無い節点を掴んだままにしない。
  // 実行パネル（RunView）は器を持たないが、焦点の控えだけは同じ合図で要る
  Timeline.detach();
  RunView.detach();
  RunResume.detach();
  dom.detail.replaceChildren();
  // 右も同じ材料で組み直す。中央だけ差し替えると、選び直したあとも
  // 右に前のセッションの数字が残ったままになる
  dom.inspBody.replaceChildren();
  syncRail(row);
  // 選ぶ前は出すものが無いので閉じる。store.inspector は残しておいて、
  // 選んだら開いた状態で戻る（URL に ?insp= で渡した指定も保たれる）
  applyInspOpen(Boolean(store.inspector) && Boolean(row));
  // 入力欄は詳細ペインの外。どのタブでも、取得に失敗していても同じ場所に留める
  syncComposer(row);

  // 入口を3つに割る。ひとまとめにすると「選んでいない」「取得中」「取得に失敗した」が
  // すべて同じ空表示になり、存在しない id を開いても何も起きていないように見える
  if (!row) {
    if (!store.selected) {
      dom.detail.append(el('div', 'detail-empty', '左の一覧からセッションを選ぶと、ここに中身が出ます'));
    } else if (error) {
      const p = panel('このセッションは開けませんでした');
      p.body.append(el('p', 'note', error));
      const id = el('p', 'note', 'セッションID ');
      id.append(el('span', 'mono', store.selected));
      p.body.append(id);
      dom.detail.append(p.section);
    } else {
      dom.detail.append(el('div', 'loading', 'ログを読んでいます…'));
    }
    mark('detail', t0);
    return;
  }

  const wrap = el('div', 'detail');
  wrap.append(el('h2', null, row.title ?? row.name ?? row.sessionId));

  const sub = el('div', 'detail-sub');
  // stateLabel が無いときに空の .state を出すと、色の点だけが残って意味を持たない
  if (row.stateLabel) {
    const state = el('span', 'state', row.stateLabel);
    state.style.color = STATE_COLOR[row.state] ?? 'var(--off)';
    // 予算切れだけは点ではなく印にする（理由は list.js の buildCard 側に書いた）
    if (row.run?.state === 'budget') state.dataset.mark = 'budget';
    sub.append(state);
  }
  if (row.cwd) sub.append(el('span', 'path', row.cwd));
  wrap.append(sub);
  wrap.append(detailActions(row));

  const d = store.detail?.sessionId === store.selected ? store.detail : null;

  // なぜこの作業をしているか。どのタブを見ていても要るので、帯より上に置く
  if (d) {
    const summary = summaryBlock(d.summary);
    if (summary) wrap.append(summary);
  }

  const ctx = { row, d, error, tab: effectiveTab(d, error) };

  // **答えないと1行も進まない待ちは、タブ帯より上に出す。**
  // 既定のタブを「経過」にしたので、ここに置かないと止まっていることが
  // タブの向こうに隠れる。判断は row.blocking だけ（headingOf と同じ出どころ）
  if (row.blocking === true) {
    const wait = waitingBlock(row, d);
    if (wait) wrap.append(wait);
  }

  wrap.append(tabBar(ctx));

  const stack = el('div', 'stack');
  // 全文が無いと何も組めないタブ。既存の取得中・失敗の表示へ倒す
  // （effectiveTab が「いま」へ倒すのは d も error も無いときだけなので、ここは error のとき）
  if (ctx.tab.needsDetail && !d) fillPending(stack, error);
  else fillTab(stack, ctx);

  wrap.append(stack);
  // 右のインスペクタ。開いていなければ何もしない
  renderInspector(ctx);
  // 時系列の中身はここで入れる。まだ document に付いていないので、
  // 120件を組んでもレイアウトの計算は1回で済む。
  // 「経過」以外のタブでは Timeline.attach() を通っていないので、何もしないで帰る
  Timeline.render();
  dom.detail.append(wrap);
  mark('detail', t0);
}
