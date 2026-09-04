/**
 * 画面の節点の索引。層1。
 *
 * `index.html` に置いた 102 個の id を、起動時に1回だけ引いて固定する。
 * **ここが「画面の節点の全一覧」。** 探すのに `querySelector` を書き散らさずに済む。
 *
 * もとは `store.js` に同居していた（あちらの 24% がこの塊だった）。
 * 分けたのは、持っているものの性質が違うから ―― こちらは**起動時に決まって二度と変わらない**
 * 参照の表で、あちらは**動くたびに書き換わる**状態。
 *
 * ## 外からキーを足さない
 *
 * かつて `drawer.js` が `dom.railList = railBtn` と後から差していた。
 * 1つあるだけで、この表を読んでも画面の節点が分からなくなる
 * （実際、`dom.*` の参照を全部集めて突き合わせたとき `railList` だけが定義に無かった）。
 * いまはあちらのモジュール変数に閉じてある。
 *
 * ## 引いていない id が4つある
 *
 * `split-list` / `split-insp` は `resize.js` が名前を組み立てて動的に引く（`split-${name}`）。
 * `runform-title` / `settings-title` は `aria-labelledby` の宛先で、JS からは触らない。
 * **どちらも「引き忘れ」ではない。**
 */

export const dom = {
  app: document.getElementById('app'),
  list: document.getElementById('list'),
  listCount: document.getElementById('list-count'),
  summary: document.getElementById('summary'),
  // 枠の使用率（上のバー）。list.js の renderRate() だけが書く
  rate: document.getElementById('rate'),
  detail: document.getElementById('detail'),
  // 詳細ペインそのもの。zoom.js が節点ごとモーダルへ運ぶので、器の側にも取っ手が要る。
  // **中身は組み直さない**（理由は zoom.js の冒頭）
  detailPane: document.getElementById('detail-pane'),
  // 中央下の入力欄の器。詳細ペインの外に置いてあるので replaceChildren() で消えない
  composer: document.getElementById('composer'),
  live: document.getElementById('live'),
  // 題名。脇の印（SVG）を main.js が1回だけ差す
  brand: document.getElementById('brand'),
  reload: document.getElementById('reload'),
  themeToggle: document.getElementById('theme-toggle'),
  onlyLive: document.getElementById('only-live'),
  // モードの札（mode.js）。骨格の組み替えは .app のクラスが受け持つ
  modeWork: document.getElementById('mode-work'),
  modeArchive: document.getElementById('mode-archive'),
  modeUsage: document.getElementById('mode-usage'),
  listPane: document.getElementById('list-pane'),
  listToggle: document.getElementById('list-toggle'),
  listClose: document.getElementById('list-close'),
  scrim: document.getElementById('scrim'),
  // 右のインスペクタと、その開閉をするレール。detail.js だけが使う。
  // 器は index.html に置いたまま作り直さず、中身（inspBody）だけを差し替える
  insp: document.getElementById('insp'),
  inspTitle: document.getElementById('insp-title'),
  inspClose: document.getElementById('insp-close'),
  inspBody: document.getElementById('insp-body'),
  rail: document.getElementById('rail'),
  // 左端のレール（一覧の開閉）。中身は drawer.js が1回だけ組む
  railLeft: document.getElementById('rail-left'),
  liveHead: document.getElementById('live-head'),
  archiveHead: document.getElementById('archive-head'),
  archive: document.getElementById('archive'),
  archiveQ: document.getElementById('archive-q'),
  archiveDeep: document.getElementById('archive-deep'),
  archiveSort: document.getElementById('archive-sort'),
  archiveProject: document.getElementById('archive-project'),
  archiveSkill: document.getElementById('archive-skill'),
  archiveSkillField: document.getElementById('archive-skill-field'),
  archiveDays: document.getElementById('archive-days'),
  archiveClear: document.getElementById('archive-clear'),
  archiveCount: document.getElementById('archive-count'),
  // 拡大モーダルの「作業台で開く」。書庫から開いたときだけ出す
  zoomWork: document.getElementById('zoom-work'),
  // 横断の数値。usage-tab.js だけが使う
  usageHead: document.getElementById('usage-head'),
  usageNav: document.getElementById('usage-nav'),
  usage: document.getElementById('usage'),
  usageDays: document.getElementById('usage-days'),
  usageLimit: document.getElementById('usage-limit'),
  usageModel: document.getElementById('usage-model'),
  usageCount: document.getElementById('usage-count'),
  // 通知の設定モーダル。settings.js だけが使う
  settings: document.getElementById('settings'),
  settingsOpen: document.getElementById('settings-open'),
  settingsClose: document.getElementById('settings-close'),
  settingsNav: document.getElementById('settings-nav'),
  settingsState: document.getElementById('settings-state'),
  // 「いまの様子」の節。足の1行は通知の節でしか出ないので、
  // 鳴らない理由はこちらにも置く（他の節を見ているあいだ辿り着けなくなる）
  settingsHealth: document.getElementById('settings-health'),
  settingsPath: document.getElementById('settings-path'),
  settingsMsg: document.getElementById('settings-msg'),
  settingsSave: document.getElementById('settings-save'),
  settingsTest: document.getElementById('settings-test'),
  setUrl: document.getElementById('set-url'),
  setUrlClear: document.getElementById('set-url-clear'),
  setUrlHint: document.getElementById('set-url-hint'),
  setSettle: document.getElementById('set-settle'),
  setIdle: document.getElementById('set-idle'),
  setRemind: document.getElementById('set-remind'),
  setDetail: document.getElementById('set-detail'),
  setStates: document.getElementById('set-states'),
  // 起こしてよいフォルダ（settings.js）。**足した時点で保存する**ので、
  // 下の「保存」ボタン（通知のぶん）とは経路が別
  runDirs: document.getElementById('run-dirs'),
  runDirsN: document.getElementById('run-dirs-n'),
  runDirAdd: document.getElementById('run-dir-add'),
  runDirAddBtn: document.getElementById('run-dir-add-btn'),
  runDirsHint: document.getElementById('run-dirs-hint'),
  startupState: document.getElementById('startup-state'),
  startupLegacy: document.getElementById('startup-legacy'),
  startupError: document.getElementById('startup-error'),
  startupHow: document.getElementById('startup-how'),
  // セッションを起こすフォーム。run-form.js だけが使う。
  // **URL には持たせない**（syncQuery の一覧に入れていない）。
  // 書きかけの指示文がアドレス欄に出るし、共有した URL でフォームが開く意味も無い
  runformOpen: document.getElementById('runform-open'),
  runform: document.getElementById('runform'),
  runformClose: document.getElementById('runform-close'),
  runformMsg: document.getElementById('runform-msg'),
  runformStart: document.getElementById('runform-start'),
  runformShow: document.getElementById('runform-detail'),
  runCwd: document.getElementById('run-cwd'),
  runPrompt: document.getElementById('run-prompt'),
  runMode: document.getElementById('run-mode'),
  runModelPick: document.getElementById('run-model-pick'),
  runModel: document.getElementById('run-model'),
  runEffort: document.getElementById('run-effort'),
  runBudget: document.getElementById('run-budget'),
  runNote: document.getElementById('run-note'),
  // めったに触らない3つの畳み。札にはいまの中身を書く
  // （「詳細設定」のような空の名前にすると、開かないと分からなくなる）
  runFold: document.getElementById('run-fold'),
  runFoldNote: document.getElementById('run-fold-note'),
  // 詳細ペインの拡大。zoom.js だけが使う。開いているかは dialog 自身に聞くので、
  // ここにも store にも旗を持たない
  zoom: document.getElementById('zoom'),
  zoomBody: document.getElementById('zoom-body'),
  zoomClose: document.getElementById('zoom-close'),
  // 画面の中のコマンド入力（Ctrl+K）。palette.js だけが使う。
  // 開いているかどうかも URL には持たせない（開いた状態を人に渡す意味が無い）
  palette: document.getElementById('palette'),
  palQ: document.getElementById('pal-q'),
  palList: document.getElementById('pal-list'),
  palMsg: document.getElementById('pal-msg'),
  // 更新のお知らせ。update.js だけが使う
  ver: document.getElementById('ver'),
  update: document.getElementById('update'),
  updateText: document.getElementById('update-text'),
  updateNote: document.getElementById('update-note'),
  updateAct: document.getElementById('update-act'),
  updateClose: document.getElementById('update-close'),
};
