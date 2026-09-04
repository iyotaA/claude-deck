/* 画面の中のコマンド入力（Ctrl+K）。
 *
 * 層7。キーボードだけで「移る・出す・起こす」を通せるようにする1枚。
 *
 * **自分では何も決めない。** すでにある窓口（select / setDetailTab / setInspector /
 * setListOpen / openRunForm / openZoom / focusTerminal）を呼ぶだけの器にしてある。
 * 判定をここに持たせると、画面の押しボタンとパレットで挙動が食い違う。
 * 押したあとの後始末（URL の同期・描き直し・巻き戻し）も向こうに任せる。
 *
 * **出さないものが3つある。止める・替える・続ける。**
 * どれも子プロセスを畳む（あるいは起こす）操作で、Enter ひと押しで走ってしまう。
 * 打った文字で並びが動くので、狙っていないものを実行する事故が起きうる。
 * この3つは実行パネルの押しやすい場所にあるので、そちらで足りる。
 * 出すのは「起こす」（モーダルが開くだけで、確かめる関門が残る）と
 * 「拡大」（見え方が変わるだけ）と「ターミナルを前面に」（窓が出るだけ）の3つ。
 *
 * **個別のショートカット（Ctrl+N など）は付けない。** Ctrl+K 以外はブラウザが
 * 先に取っているものが多く、奪えないキーを画面に書くと「押しても効かないキー」を
 * 案内することになる。0 と不明を分けるのと同じ精神で、書かないほうを選ぶ。
 *
 * <dialog> + showModal() を使う。Esc・背面の膜・焦点の閉じ込めがタダで付く。
 * <form> で囲まない（入力欄で Enter を押した瞬間に閉じる）。
 */
import { el, since } from './util.js';
import { dom, store, STATE_COLOR } from './store.js';
import { idleOf } from './rows.js';
import { setListOpen } from './drawer.js';
import { openZoom } from './zoom.js';
import { focusTerminal } from './detail-head.js';
import { TAB_DEFS, INSP_DEFS, setDetailTab, setInspector } from './detail.js';
import { select } from './session.js';
import { openRunForm } from './run-form.js';
import { setMode } from './mode.js';

// モードの札。**二値に畳まない。** 三項で「監視盤か作業台か」と書くと、
// モードが1つ増えた日に文言と行き先の2箇所を直すことになる
// （store.js の MODES を集合のままにしてあるのと同じ理由）
const MODE_DEFS = [
  { id: 'work', label: '作業台', name: '作業台へ戻る', desc: 'いまの作業に集中する',
    hay: '作業台 モード work 作業' },
  { id: 'archive', label: '書庫', name: '書庫へ移る', desc: '終わったものも含めて過去を探す',
    hay: '書庫 モード archive 過去 探す 検索 アーカイブ' },
  { id: 'usage', label: '数値', name: '数値へ移る', desc: '何にトークンを使ったかを横断で見る',
    hay: '数値 モード usage トークン 集計 横断 スキル' },
];

// 開いたときに組んだ全部と、絞り込んで残ったぶんと、選んでいる位置。
// **開いているあいだは組み直さない。** 裏で一覧は毎秒動いているので、
// 組み直すと打っている最中に並びが変わり、狙っていたものがずれる
let all = [];
let items = [];
let at = 0;

/** 絞り込みに使う1本の文字列。空のものは混ぜない */
function hay(...parts) {
  return parts.filter(Boolean).join(' ').toLowerCase();
}

/**
 * いま押せるものを全部並べる。
 *
 * 押せないものは**出さない**。出しておいて何も起きないより、無いほうが正直。
 * セッションを選んでいないときの「出す・畳む」と、
 * 広い画面での「一覧」（引き出しが構造的に無い）がそれ。
 *
 * @returns {object[]} { group, state, verb, name, desc, hay, keepOpen, run } の配列
 */
function buildAll() {
  const out = [];
  const rows = store.rows ?? [];
  const cur = rows.find((r) => r.sessionId === store.selected) ?? null;

  // 一覧の絞り込み（onlyLive）は通さない。見えていないものへ跳べるのが値打ちなので。
  // 選ぶ経路が 'live' なのは、出しているのが一覧の材料そのものだから。
  // 'query' にすると一覧から落ちたあとも選択が残り、カードを押したときと挙動が変わる
  for (const row of rows) {
    if (!row.sessionId) continue;
    out.push({
      group: 'セッションへ移る',
      state: row.state,
      verb: row.project ?? null,
      name: row.title || row.name || '（まだ指示なし）',
      desc: `${row.stateLabel ?? ''} ${since(idleOf(row))}`.trim(),
      hay: hay(row.project, row.title, row.name, row.stateLabel, row.gitBranch),
      run: () => {
        select(row.sessionId, 'live');
        // 作業台の外から選んだときは作業台へ移す。監視盤も数値も中央を消しているので、
        // 移さないと「選んだのに何も起きない」に見える。
        // **モードを名指しで比べない。** 増えるたびにここを直すことになる
        if (store.mode !== 'work') setMode('work');
      },
    });
  }

  out.push({
    group: '動かす',
    verb: '起こす',
    name: '新しいセッションを起こす',
    desc: 'フォームが開く',
    hay: hay('起こす 起動 新しい セッション run new'),
    run: openRunForm,
  });

  // ターミナルの窓があるのは、生きていて pid を持っているものだけ。
  // 結果を読ませたいので、これだけは押しても閉じない
  if (cur?.alive && cur.pid) {
    out.push({
      group: '動かす',
      verb: 'ターミナルを前面に',
      name: cur.title || cur.name || '選んでいるセッション',
      desc: `pid ${cur.pid}`,
      hay: hay('ターミナル 前面 focus 窓', cur.title, cur.name),
      keepOpen: true,
      run: () => focusTerminal(cur.pid),
    });
  }

  // モードの切り替えは出してよい。替わるのは画面だけで、
  // 止める・替える・続けるのように子プロセスを畳んだり起こしたりしない。
  // 選んでいるものと無関係なので、下の if の外に置く。
  // **いま出ているモードは出さない。** 押しても何も起きないものを並べない
  for (const m of MODE_DEFS) {
    if (store.mode === m.id) continue;
    out.push({
      group: '出す・畳む',
      verb: m.label,
      name: m.name,
      desc: m.desc,
      hay: hay(m.hay),
      run: () => setMode(m.id),
    });
  }

  // 選んでいないときは出さない。押しても出す中身が無い
  if (store.selected) {
    for (const t of INSP_DEFS) {
      const on = store.inspector === t.id;
      out.push({
        group: '出す・畳む',
        verb: t.label,
        name: on ? '右の枠を畳む' : '右の枠に出す',
        desc: t.title,
        hay: hay(t.label, t.title, '右 枠 インスペクタ'),
        run: () => setInspector(t.id),
      });
    }
    for (const t of TAB_DEFS) {
      // いま見ているタブは出さない。押しても何も起きない（setDetailTab が弾く）
      if (store.detailTab === t.id) continue;
      out.push({
        group: '出す・畳む',
        verb: t.label,
        name: '中央のタブを替える',
        desc: null,
        hay: hay(t.label, '中央 タブ'),
        run: () => setDetailTab(t.id),
      });
    }

    // 拡大は出してよい側。モーダルが開くだけで子プロセスには触らない
    // （出さない3つ = 止める・替える・続ける と違う）。
    //
    // **畳むほうは出さない。** open() が「ほかの dialog が開いていたら開かない」で
    // 弾くので、拡大しているあいだパレットは出てこない。畳む口は
    // 帯のボタン・Esc・×・背面の4つで足りる
    out.push({
      group: '出す・畳む',
      verb: '拡大',
      name: '詳細を大きく開く',
      desc: '判断を求められるものを、切らずに読む',
      hay: hay('拡大 縮小 大きく 全画面 zoom 詳細'),
      run: openZoom,
    });
  }

  // 一覧は窓の広さに関わらず引き出しになったので、常に項目に出す。
  // **三本線と並ぶ、一覧へ行く2本目の道**（前は狭い窓でしか出していなかった）
  {
    const open = dom.app.classList.contains('is-list-open');
    out.push({
      group: '出す・畳む',
      verb: '一覧',
      name: open ? '一覧を畳む' : '一覧を出す',
      desc: null,
      hay: hay('一覧 list 引き出し 畳む 出す'),
      run: () => setListOpen(!open),
    });
  }

  return out;
}

/**
 * 打った文字で絞る。
 *
 * 空白で区切った語を全部含むものだけ残す。順不同なので、
 * 「deck 質問」でも「質問 deck」でも同じものに当たる
 *
 * @param {string} q 打った文字
 * @returns {object[]} 残ったもの
 */
function sift(q) {
  const s = q.trim().toLowerCase();
  if (!s) return all;
  const words = s.split(/\s+/);
  return all.filter((it) => words.every((w) => it.hay.includes(w)));
}

/** 押した結果の1行。空なら帯ごと畳む */
function say(msg) {
  dom.palMsg.textContent = msg;
  dom.palMsg.hidden = !msg;
}

/**
 * 残っているものを並べ直す。
 *
 * 選んでいる1件は aria-activedescendant で伝える。項目の id は並び順から作るので、
 * 絞り込みで作り直しても取り違えない
 */
function draw() {
  dom.palList.replaceChildren();
  if (!items.length) {
    dom.palList.append(el('p', 'pal-none', '当てはまるものがありません'));
    dom.palQ.removeAttribute('aria-activedescendant');
    return;
  }

  let group = null;
  items.forEach((it, i) => {
    if (it.group !== group) {
      group = it.group;
      dom.palList.append(el('div', 'pal-g', group));
    }

    const node = el('div', 'pal-i');
    node.id = `pal-i-${i}`;
    node.setAttribute('role', 'option');
    node.setAttribute('aria-selected', String(i === at));
    if (i === at) node.classList.add('on');
    // 状態の点は一覧のカードと同じ借り方。色は必ず CSS 変数経由で取る
    if (it.state) {
      const dot = el('span', 'state');
      dot.style.setProperty('--state-color', STATE_COLOR[it.state] ?? 'var(--off)');
      node.append(dot);
    }
    if (it.verb) node.append(el('span', 'verb', it.verb));
    node.append(el('span', 'name', it.name));
    if (it.desc) node.append(el('span', 'desc', it.desc));
    node.addEventListener('click', () => {
      at = i;
      exec();
    });
    dom.palList.append(node);
  });

  dom.palQ.setAttribute('aria-activedescendant', `pal-i-${at}`);
  // 上下キーで窓の外へ出たときだけ寄せる。
  // **直前がグループ見出しなら、そちらを寄せる。** 項目そのものを寄せると見出しが上に隠れ、
  // どの群にいるのか読めなくなる（末尾から先頭へ巻き戻ったとき、実測で 28.8px ぶん
  // 「セッションへ移る」が隠れていた）
  const on = dom.palList.querySelector('.pal-i.on');
  const head = on?.previousElementSibling;
  (head?.classList.contains('pal-g') ? head : on)?.scrollIntoView({ block: 'nearest' });
}

/**
 * 選んでいるものを実行する。
 *
 * **投げない。** 押したのに何も起きない、という見え方を作らないため。
 *
 * 閉じるのを実行より先にしているのが要点。<dialog> は閉じるときに
 * 開く前の焦点へ戻すので、焦点を動かすもの（一覧を出す）を先にやると、
 * せっかく移った焦点をこちらが奪ってしまう
 */
async function exec() {
  const it = items[at];
  if (!it) return;
  if (!it.keepOpen) dom.palette.close();
  try {
    const msg = await it.run();
    if (it.keepOpen) say(typeof msg === 'string' ? msg : '');
  } catch (err) {
    // 閉じたあとに転んでも出す場所が無い。せめて記録には残す
    if (it.keepOpen) say(`できませんでした: ${err.message}`);
    else console.error('palette', err);
  }
}

/**
 * パレットを開く。
 *
 * 中身は開くたびに組み直す（一覧も選んでいるものも動くので）。
 * 開いてから閉じるまでは組み直さない
 */
function open() {
  // ほかのモーダルが開いているあいだは重ねない。
  // 重ねると Esc がどちらに効くのか読めなくなる
  if (document.querySelector('dialog[open]')) return;
  all = buildAll();
  items = all;
  at = 0;
  dom.palQ.value = '';
  say('');
  dom.palette.showModal();
  // 並べるのは開いたあと。閉じているあいだは scrollIntoView が効かない
  draw();
  dom.palQ.focus();
}

/** 上下で選び、Enter で実行する。dialog の中だけに効かせる */
function onKey(ev) {
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    if (!items.length) return;
    at = (at + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    draw();
    return;
  }
  if (ev.key === 'Enter') {
    ev.preventDefault();
    exec();
  }
}

/** 配線。main.js から1回だけ呼ぶ */
export function initPalette() {
  // Ctrl+K は document で拾う。入力欄に居ても開けるようにしたいので、
  // 焦点の居場所で分岐しない（drawer.js の Esc と同じ流儀）。
  // Shift 付き（ev.key が 'K'）は拾わない
  document.addEventListener('keydown', (ev) => {
    if (!(ev.ctrlKey || ev.metaKey) || ev.key !== 'k') return;
    ev.preventDefault();
    if (dom.palette.open) {
      dom.palette.close();
      return;
    }
    open();
  });

  dom.palQ.addEventListener('input', () => {
    items = sift(dom.palQ.value);
    // 絞り込んだら先頭へ戻す。残った中のいちばん上が狙いのはず
    at = 0;
    say('');
    draw();
  });

  dom.palette.addEventListener('keydown', onKey);

  // 背面を押したら閉じる。dialog 自身に余白を持たせていないので、
  // ここへ来るのは本当に背面を押したときだけ（palette.css の padding: 0）
  dom.palette.addEventListener('click', (ev) => {
    if (ev.target === dom.palette) dom.palette.close();
  });
}
