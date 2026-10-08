/* Markdown をブロックの並びへ直す。ここは純関数で、DOM を1つも触らない。
 *
 * だから Node からそのまま import できて、test/md.test.mjs で全分岐を通せる。
 * 判断（文字 → ブロック）と I/O（ブロック → 節点）を分ける形は、
 * parseUpdateState / loadUpdateState や run/spec.mjs / os/claude.mjs と同じ。
 * 描くのは md-view.js の仕事で、こちらは何も知らない。
 *
 * 自作なのは、依存パッケージを増やせないため（同僚にフォルダごと渡して動くことが要件）。
 * marked や markdown-it が使えないのは、それ以前に innerHTML を使わないから。
 * あれらが返すのは HTML の文字列なので、受け取っても流し込む先が無い。
 *
 * 最初の9つは実測で決めた（~/.claude/projects の大きい順 40 ログ・2026-08-23）。
 * assistant の発言 3,278 件のうち 47.8% が何らかの記法を含み、内訳は
 * インラインコード 41.9% / 太字 23.2% / フェンス 9.5% / 箇条書き 8.2% /
 * 見出し 7.7% / 表 7.1% / 水平線 2.7% / 番号付き 2.1%。
 *
 * チェックリスト（`- [ ]` / `- [x]` / `- [~]`）は後から足した。
 * assistant の発言には1件も無いが（0 件 / 2,534 件）、プランの本文と
 * ユーザーの指示文には来る（実測 2026-08-24。指示文 40 ログで 129 行・15 件、
 * プラン 40 ログで 5 行・1 件）。承認待ちのプランは切らずに全部描く場所なので、
 * そこに素の `- [ ]` が並ぶと、どこまで終わったのかが読めない。
 *
 * リンク・素の URL・引用・打ち消し・太字の中の記法・表のセルの <br> も後から足した
 * （実測 2026-10-08。件数は public/CLAUDE.md の「Markdown を描く」の表を見る。
 * 2箇所に書くと片方だけ古くなる）。前はリンクを「javascript: を弾く検証を 0.2% のために
 * 抱えたくない」で見送っていたが、表の中の `[表示名](URL)` が記号ごと出ていて読めず、
 * 素の URL もそれより多かった。弾く検証は http / https だけを通す1本の正規表現で済む。
 * 引用は assistant にはまれだが、時系列の指示文も Markdown で描いているので効く。
 *
 * 出さない記法は素の文字として残る。斜体（* 1つ）・Wiki リンク（[[x]]）・画像・HTML。
 * 作らなくても「いまと同じ見え方」なので、作らないことによる害が無い。
 *
 * 入力は途中で切られていることがある。サーバ側が clip() で「…（以下省略）」を
 * 足すので、閉じていないコードフェンスが普通に来る。
 * 落ちずに「開いたまま」として返す（未知の形で落ちない、の原則）。
 *
 * ブロックの形。
 *   { type: 'p',     spans }              段落
 *   { type: 'h',     level, spans }       見出し
 *   { type: 'code',  lang, text, open }   コードフェンス（open は閉じていない印）
 *   { type: 'list',  items }              箇条書き・番号付き
 *   { type: 'table', align, head, rows }  表（head は spans の並び、rows はその並び）
 *   { type: 'quote', blocks }             引用（中身はブロックの並びそのもの）
 *   { type: 'hr' }                        水平線
 *
 * 項目（list.items の1件）の形。
 *   { depth, ordered, num, task, gap, spans }
 *   task は null（ふつうの項目）か 'todo' / 'doing' / 'done'
 *   gap は空行を1つ挟んだ直後の項目なら true（画面で塊を離す）。それ以外は false
 *
 * 装飾（spans の1件）の形。**平らな run に印を付ける**（木にしない）。
 *   { type: 'text' | 'code', v, strong?: true, del?: true, href?: string }
 *   印は真のときだけ持つ。**太字の中のリンク**のような入れ子も、run ごとに印を重ねて表す。
 *   木にしないのは、spansText / cutSpans（頭出し）/ blocksText（検索件数の物差し）が
 *   v を繋ぐだけで今のまま動くため。まとめて1つの器に入れるのは md-view.js の仕事。
 */

/** 見出し。# の後の空白は必須。#見出し や #!/bin/sh を見出しにしない */
const HEAD_RE = /^ {0,3}(#{1,6})[ \t]+(.*)$/;

/** 水平線。同じ記号が3つ以上で、他に何も無い行 */
const HR_RE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;

/** 箇条書き。先行空白はネストの深さを決めるのに使う */
const UL_RE = /^([ \t]*)([-*+])[ \t]+(.*)$/;

/** 番号付き。1. と 1) の両方を受ける */
const OL_RE = /^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$/;

/**
 * チェックリストの印。箇条書き・番号付きの本文の頭に来る。
 *
 * 受けるのは4つだけ（`[ ]` `[x]` `[X]` `[~]`）。中を1文字なら何でも通す形にすると、
 * `- [2] 消す対象の一覧とサイズを記録` のような手順の番号が
 * 空のチェックボックスに化ける（実測4件。ユーザーの指示文）。
 *
 * `[~]`（進行中）は GFM に無く、Claude が独自に書くもの。実測1件で、
 * TODO の in_progress と同じ意味で使われていた。
 *
 * 印の後ろは空白か行末。`- [x]abc` を読まないのは、記法として曖昧なため。
 */
const TASK_RE = /^\[([ xX~])\](?:[ \t]+|$)/;

/** 印 → 状態。TODO パネル（pending / in_progress / completed）と同じ3つに寄せる */
const TASK_STATE = { ' ': 'todo', x: 'done', X: 'done', '~': 'doing' };

/**
 * 引用。行頭（先行空白 0〜3）の `>`。外すのは `>` と直後の空白1つまで
 * （それより後ろの空白は中身の字下げなので残す。外すと引用の中の箇条書きの深さが崩れる）。
 */
const QUOTE_RE = /^ {0,3}>[ \t]?/;

/** コードフェンスの開き。``` と ~~~ の両方を受け、後ろの語を言語として拾う */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/;

/** 表の区切りセル。--- と :--- と ---: と :---: だけを通す */
const DIV_CELL_RE = /^(:?)-+(:?)$/;

/** ネストの深さの上限。これより深くても字下げは増やさない（画面が右へ逃げる） */
const MAX_DEPTH = 3;

/**
 * コードフェンスの閉じか。
 *
 * 閉じる側に言語などの語は付かないので、記号だけの行であることを見る。
 * 本数は開いたとき以上（``` で開いて ```` で閉じることもできる）。
 *
 * @param {string} line 1行
 * @param {string} mark 開いたときの記号。バッククォートか ~
 * @param {number} need 開いたときの本数
 */
function isFenceClose(line, mark, need) {
  const s = line.trim();
  if (s.length < need) return false;
  for (const ch of s) {
    if (ch !== mark) return false;
  }
  return true;
}

/**
 * 表の1行をセルに割る。
 *
 * 両端の | は飾りなので落とす。\| はセルの中の | として通す
 * （表の中でパイプそのものを書いている行があるため）。
 *
 * @param {string} line 1行
 * @returns {Array<string>} 前後の空白を落としたセル
 */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);

  const out = [];
  let buf = '';
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      buf += '|';
      i += 1;
      continue;
    }
    if (s[i] === '|') {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += s[i];
  }
  out.push(buf);
  return out.map((c) => c.trim());
}

/**
 * 表の区切り行（|---|:--:|）なら、列ごとの寄せを返す。
 *
 * 表かどうかはこの行だけで決まる。1行目に | があっても区切りが無ければ表にしない
 * （文の中で | を使った行が表に化けるのを防ぐ）。
 *
 * | を含まない --- は水平線なので通さない。通すと、| を含む行の次に水平線が来ただけで
 * 1列の表に化ける。
 *
 * @param {string|undefined} line 2行目
 * @returns {Array<string|null>|null} 表でなければ null
 */
function dividerCells(line) {
  if (typeof line !== 'string' || !line.includes('-') || !line.includes('|')) return null;

  const cells = splitRow(line);
  if (!cells.length) return null;

  const align = [];
  for (const c of cells) {
    const m = DIV_CELL_RE.exec(c);
    if (!m) return null;
    if (m[1] && m[2]) align.push('center');
    else if (m[2]) align.push('right');
    else if (m[1]) align.push('left');
    else align.push(null);
  }
  return align;
}

/**
 * リンクとして通してよい URL か。http と https だけ。
 *
 * javascript: を弾くのが本命。相対パス（`./a.md`）や mailto: も通さない ――
 * ClaudeDeck は会話ログの置き場所とは別のところから配信しているので、相対パスは開けない。
 * md-view.js も a を作る直前に同じ式でもう一度確かめる（境界を1枚にしない）。
 */
export const SAFE_HREF_RE = /^https?:\/\//i;

/**
 * 素の URL に使う文字。ASCII の URL 文字だけ。
 *
 * 日本語の 」 や 、 で自然に止まるので、「〜は https://x.com」のような文が
 * 句読点ごとリンクに飲まれない。`*` `[` `]` と バッククォートは外してある。
 * URL に来ることはまれで、来るとすれば `https://x.com/**太字**` のような
 * 記法との境目なので、そこで止まるほうが外れが小さい。
 */
const URL_CHAR_RE = /[A-Za-z0-9\-._~:/?#@!$&'()+,;=%]/;

/** URL の末尾から外す記号。文の句読点と引用符で、URL の一部であることはまれ */
const URL_TAIL = '.,;:!?\'"';

/** 素の URL の直前に来てはいけない文字。`xhttps://` のような語の途中を拾わない */
const WORD_CHAR_RE = /[A-Za-z0-9]/;

/** 何でも読む。太字・打ち消し・リンクの中では、そこで使ったものを1つずつ外していく */
const ALL_INLINE = { strong: true, del: true, link: true, url: true };

/**
 * リンクの表示名と URL を探しに行く長さの上限。
 *
 * 無いと `[a](x[a](x[a](x…` のような入力で、`[` のたびに行末まで走査して
 * 2乗の時間になる（1行が長いログ本文は普通に来る）。実物の表示名と URL はこれより十分短い。
 */
const LINK_LABEL_MAX = 1000;
const LINK_URL_MAX = 2048;

/**
 * `[表示名](URL)` を読む。読めなければ null。
 *
 * 表示名は同じ行の `]` まで（中に `[` `]` は来ない前提。来たら読まない）。
 * URL は `(` の直後から、**対応の取れた** `)` までで、空白を含まない。
 * `[Foo](https://en.wikipedia.org/wiki/Foo_(bar))` を最初の `)` で切ると、
 * 別のページへリンクしてしまう（readUrl が括弧の対応を見るのと同じ流儀）。
 * スキームの判断はここではしない（呼ぶ側が http / https だけをリンクにする）。
 *
 * @param {string} t 塊の文字
 * @param {number} i `[` の位置
 * @returns {{label: string, url: string, end: number}|null} end は `)` の次
 */
function readLink(t, i) {
  const labelEnd = Math.min(t.length, i + 1 + LINK_LABEL_MAX);
  let j = i + 1;
  while (j < labelEnd && t[j] !== ']' && t[j] !== '[' && t[j] !== '\n') j += 1;
  if (t[j] !== ']' || j === i + 1 || t[j + 1] !== '(') return null;

  const urlEnd = Math.min(t.length, j + 2 + LINK_URL_MAX);
  let depth = 0;
  let k = j + 2;
  for (; k < urlEnd; k += 1) {
    const c = t[k];
    // 空白なら URL ではない。ASCII は字の番号で見て、正規表現は非 ASCII（全角空白など）にだけ使う
    // （1文字ごとに正規表現を通すと、上限まで走る入力でこの1行が時間の大半を食う）
    const code = t.charCodeAt(k);
    if (code <= 32 || (code > 127 && /\s/.test(c))) return null;
    if (c === '(') depth += 1;
    else if (c === ')') {
      if (depth === 0) break;
      depth -= 1;
    }
  }
  if (t[k] !== ')' || k === j + 2 || k >= urlEnd) return null;
  return { label: t.slice(i + 1, j), url: t.slice(j + 2, k), end: k + 1 };
}

/**
 * 素の URL を読む。読めなければ null。
 *
 * 末尾の句読点と、対応する `(` の無い `)` は外す。
 * `（https://x.com）` や `(https://x.com)` の閉じ括弧までリンクに飲まないため
 * （括弧の入った URL ―― Wikipedia の `Foo_(bar)` など ―― は対応が取れているので残る）。
 *
 * @param {string} t 塊の文字
 * @param {number} i 読み始める位置
 * @returns {string|null} URL
 */
function readUrl(t, i) {
  // 1文字目で先に断る（地の文の1文字ごとに呼ばれるので、slice を作らずに済ませる）
  if (t[i] !== 'h' && t[i] !== 'H') return null;
  // スキームの判断は SAFE_HREF_RE の1つに寄せる（md-view.js が確かめるのと同じ式）
  const head = t.slice(i, i + 8);
  if (!SAFE_HREF_RE.test(head)) return null;
  if (i > 0 && WORD_CHAR_RE.test(t[i - 1])) return null;
  const schemeLen = head[4] === ':' ? 7 : 8;

  let j = i;
  let open = 0;
  let close = 0;
  while (j < t.length && URL_CHAR_RE.test(t[j])) {
    if (t[j] === '(') open += 1;
    else if (t[j] === ')') close += 1;
    j += 1;
  }
  // 末尾を1文字ずつ外す。括弧の数は先に数えておき、外すたびに差し引く
  // （外すたびに数え直すと、`)` が何万も並んだ入力で2乗の時間になる）
  let end = j;
  while (end > i) {
    const last = t[end - 1];
    if (URL_TAIL.includes(last)) {
      end -= 1;
      continue;
    }
    if (last === ')' && open < close) {
      end -= 1;
      close -= 1;
      continue;
    }
    break;
  }
  // `https://` だけで中身が無いものはリンクにしない
  return end - i > schemeLen ? t.slice(i, end) : null;
}

/**
 * 1つの塊を読んで、印つきの run を out へ積む。
 *
 * mark はこの塊の全 run に付ける印（太字の中なら { strong: true }）。
 * allow は読む記法。太字の中では太字を、リンクの表示名の中ではリンクと素の URL を外して呼ぶ。
 *
 * @param {string} t 塊の文字
 * @param {object} allow { strong, del, link, url }
 * @param {object} mark 付ける印
 * @param {Array<object>} out 積む先
 */
function readInline(t, allow, mark, out) {
  let buf = '';
  const flush = () => {
    if (buf) out.push({ type: 'text', v: buf, ...mark });
    buf = '';
  };

  let i = 0;
  while (i < t.length) {
    const ch = t[i];

    if (ch === '`') {
      // ``code`` のように2本以上で囲む形もある。開いた本数と同じ並びで閉じる。
      // コードの中は何も解釈しない（リンクも素の URL も読まない）
      let n = 1;
      while (t[i + n] === '`') n += 1;
      const close = t.indexOf('`'.repeat(n), i + n);
      if (close > i + n) {
        flush();
        out.push({ type: 'code', v: t.slice(i + n, close), ...mark });
        i = close + n;
        continue;
      }
      buf += t.slice(i, i + n);
      i += n;
      continue;
    }

    // 太字と打ち消しは同じ形。閉じがあれば中身をもう一度インラインとして読む。
    // 閉じが無ければ素の文字（切られた入力で、そこから先が全部太字になるのを防ぐ）
    const pair = (allow.strong && ch === '*' && t[i + 1] === '*' && 'strong')
      || (allow.del && ch === '~' && t[i + 1] === '~' && 'del');
    if (pair) {
      const close = t.indexOf(ch + ch, i + 2);
      if (close > i + 2) {
        flush();
        readInline(t.slice(i + 2, close), { ...allow, [pair]: false }, { ...mark, [pair]: true }, out);
        i = close + 2;
        continue;
      }
      buf += ch + ch;
      i += 2;
      continue;
    }

    if (allow.link && ch === '[') {
      // 画像（![alt](url)）は丸ごと素の文字にする。中の URL を素の URL として拾うと、
      // 画像を描かないのに URL だけがリンクになって半端に見える
      const link = readLink(t, i);
      if (link && t[i - 1] === '!') {
        buf += t.slice(i, link.end);
        i = link.end;
        continue;
      }
      // Wiki リンク（[[x]]）は readLink が `[` の重なりで断るので、素の文字のまま
      if (link) {
        flush();
        const inner = { ...allow, link: false, url: false };
        // http / https 以外は表示名だけを出す。記号と URL は捨てる
        const href = SAFE_HREF_RE.test(link.url) ? { href: link.url } : {};
        readInline(link.label, inner, { ...mark, ...href }, out);
        i = link.end;
        continue;
      }
    }

    if (allow.url) {
      const url = readUrl(t, i);
      if (url) {
        flush();
        out.push({ type: 'text', v: url, ...mark, href: url });
        i += url.length;
        continue;
      }
    }

    buf += ch;
    i += 1;
  }
  flush();
}

/**
 * 1つの塊の文字を、装飾の区切りへ割る。
 *
 * バッククォートを先に見る。コードの中の ** は装飾しない
 * （** を含むコードを画面に出したときに太字へ化けないため。Markdown の決まりでもある）。
 *
 * 太字（**）と打ち消し（~~）は中身をもう一度読む。`**チェッカー（`x.py`）**` の形が
 * assistant の 4.4% にあり、前はバッククォートがそのまま太字で出ていた。
 * 太字の中の太字は見ない（閉じは最初の ** なので、来ようがない）。
 *
 * リンクは http / https だけ。素の URL もリンクにする（太字の中でも）。
 *
 * 閉じていない記号はただの文字として残す。切られた入力が普通に来るので、
 * 開いたまま終わったものを装飾に化かすと、そこから先が全部太字になる。
 *
 * 斜体（* 1つ）は出さない。箇条書きの記号と衝突するうえ、*.js のような
 * ふつうの文字列が斜体に化ける。実測でも太字ばかりで斜体はほとんど無い。
 *
 * @param {string|null} text
 * @returns {Array<object>} spans（印つきの平らな run）
 */
export function inlineSpans(text) {
  const out = [];
  readInline(String(text ?? ''), ALL_INLINE, {}, out);
  return out;
}

/**
 * 表のセルを読む。インラインに加えて、テキストの `<br>` を改行にする。
 *
 * 表の1セルの中で改行したいとき、Markdown には書き方が無いので `<br>` が使われる
 * （実測 assistant・指示文で各1件）。HTML としては描かないが、改行の意味だけは拾う。
 * コードの中の `<br>` は書いたとおりに出す（コードの中は何も解釈しない、と同じ）。
 *
 * @param {string} cell セルの文字
 */
function cellSpans(cell) {
  return inlineSpans(cell).map((s) => (
    s.type === 'text' ? { ...s, v: s.v.replace(/<br\s*\/?>/gi, '\n') } : s
  ));
}

/**
 * 続いている箇条書きを1つのブロックへまとめる。
 *
 * 深さは空白の量そのものではなく「前の行より深いか浅いか」で決める。
 * 2つ字下げする人と4つ字下げする人がいて、量を信じると片方が崩れる。
 *
 * 記号の無い継続行（字下げされた文の続き）は、直前の項目へ足す。
 * 空行は1つだけ飲む。2つ続いたらリストの終わり
 * （項目のあいだに空行を1つ挟む書き方が実際にあるため、1つで切ると ul が分かれる）。
 *
 * 飲んだ空行の直後の項目には gap を立てる。書いた人は空行で塊を分けているので、
 * 画面でもそこだけ離す（項目の間は詰めてあるので、離さないと区切りが消える）。
 * リストは分けない。番号付きの番号も続けたまま。
 *
 * @param {Array<string>} lines 全行
 * @param {number} from 開始行
 * @returns {{ block: object, next: number }} next は最後に読んだ行
 */
function readList(lines, from) {
  const items = [];
  const stack = [];
  let blank = 0;
  let i = from;

  for (; i < lines.length; i += 1) {
    const line = lines[i];
    const ul = UL_RE.exec(line);
    const ol = ul ? null : OL_RE.exec(line);

    if (ul || ol) {
      const gap = blank > 0 && items.length > 0;
      blank = 0;
      const m = ul ?? ol;
      const indent = m[1].length;
      while (stack.length && indent < stack[stack.length - 1]) stack.pop();
      if (!stack.length || indent > stack[stack.length - 1]) stack.push(indent);
      const text = m[3].trim();
      const task = TASK_RE.exec(text);
      items.push({
        depth: Math.min(stack.length - 1, MAX_DEPTH),
        ordered: !!ol,
        num: ol ? Number(ol[2]) : null,
        task: task ? TASK_STATE[task[1]] : null,
        gap,
        // 印は本文から剥がす。残すと画面に `□ [ ] やること` と二重に出るうえ、
        // blocksText（切る予算と「一致 N 件」の物差し）にも入ってしまう
        text: task ? text.slice(task[0].length) : text,
      });
      continue;
    }

    if (!line.trim()) {
      blank += 1;
      if (blank > 1) break;
      continue;
    }

    // 字下げされた文は直前の項目の続き。字下げが無ければリストの外
    if (!/^[ \t]/.test(line) || !items.length) break;
    blank = 0;
    items[items.length - 1].text += `\n${line.trim()}`;
  }

  return {
    block: {
      type: 'list',
      items: items.map((it) => ({
        depth: it.depth,
        ordered: it.ordered,
        num: it.num,
        task: it.task,
        gap: it.gap,
        spans: inlineSpans(it.text),
      })),
    },
    next: i - 1,
  };
}

/**
 * 引用の入れ子の上限。これより深い `>` は引用にせず、素の文字の段落として残す。
 *
 * 引用は中身を再帰で読むので、上限が無いと `>>>>…` を数千並べた1行で
 * 呼び出しが深くなり、RangeError で時系列の描画ごと落ちる（描く側も再帰で積むので同じ）。
 * 実物の入れ子は2〜3段なので、8 で困ることはない。
 */
const MAX_QUOTE_DEPTH = 8;

/**
 * Markdown を1本読んで、ブロックの並びを返す。
 *
 * @param {string|null} text 本文。null / 空なら空配列
 * @returns {Array<object>} ブロックの並び
 */
export function parseMarkdown(text) {
  return parseBlocks(text, 0);
}

/**
 * parseMarkdown の本体。depth は引用の入れ子の深さ（外が 0）。
 *
 * @param {string|null} text 本文
 * @param {number} depth 引用の深さ
 * @returns {Array<object>} ブロックの並び
 */
function parseBlocks(text, depth) {
  const src = String(text ?? '');
  if (!src.trim()) return [];

  const lines = src.split('\n');
  const blocks = [];
  let para = [];

  const flushPara = () => {
    const joined = para.join('\n').trim();
    para = [];
    if (joined) blocks.push({ type: 'p', spans: inlineSpans(joined) });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // コードフェンス。閉じるまで中身を1文字も解釈しない
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushPara();
      const mark = fence[1][0];
      const need = fence[1].length;
      const body = [];
      let closed = false;
      i += 1;
      for (; i < lines.length; i += 1) {
        if (isFenceClose(lines[i], mark, need)) {
          closed = true;
          break;
        }
        body.push(lines[i]);
      }
      blocks.push({ type: 'code', lang: fence[2] || null, text: body.join('\n'), open: !closed });
      continue;
    }

    if (!line.trim()) {
      flushPara();
      continue;
    }

    // 引用。続いている `>` の行を集めて、中身をもう一度 Markdown として読む。
    // 空行か `>` の無い行で終わる（`>` の無い続きの行を引用へ含める書き方は読まない。
    // 切れ目が見た目で分からず、指示文の地の文を引用へ飲み込むほうが害が大きい）。
    // フェンスの中の `>` は上のフェンスの処理が先に飲むので、ここへは来ない。
    // 上限より深いぶんは読まずに下へ流す（段落の素の文字になる）
    if (depth < MAX_QUOTE_DEPTH && QUOTE_RE.test(line)) {
      flushPara();
      const inner = [];
      for (; i < lines.length && QUOTE_RE.test(lines[i]); i += 1) {
        inner.push(lines[i].replace(QUOTE_RE, ''));
      }
      i -= 1;
      const quoted = parseBlocks(inner.join('\n'), depth + 1);
      if (quoted.length) blocks.push({ type: 'quote', blocks: quoted });
      continue;
    }

    if (HR_RE.test(line)) {
      flushPara();
      blocks.push({ type: 'hr' });
      continue;
    }

    const head = HEAD_RE.exec(line);
    if (head) {
      flushPara();
      blocks.push({ type: 'h', level: head[1].length, spans: inlineSpans(head[2].trim()) });
      continue;
    }

    // 表。この行に | があって、次の行が区切りのときだけ
    if (line.includes('|')) {
      const align = dividerCells(lines[i + 1]);
      if (align) {
        flushPara();
        const headCells = splitRow(line).map(cellSpans);
        const rows = [];
        i += 2;
        for (; i < lines.length; i += 1) {
          if (!lines[i].trim() || !lines[i].includes('|')) break;
          rows.push(splitRow(lines[i]).map(cellSpans));
        }
        i -= 1;
        blocks.push({ type: 'table', align, head: headCells, rows });
        continue;
      }
    }

    if (UL_RE.test(line) || OL_RE.test(line)) {
      flushPara();
      const { block, next } = readList(lines, i);
      blocks.push(block);
      i = next;
      continue;
    }

    para.push(line);
  }

  flushPara();
  return blocks;
}

/* ------------------------------------------------------------ 頭出し（切る） */

/** spans の中身を繋いで、描いたときの文字にする */
function spansText(spans) {
  return spans.map((s) => s.v).join('');
}

/** 行数。空の文字は0行と数える（hr のように文字を持たないブロックがある） */
function countLines(text) {
  return text ? text.split('\n').length : 0;
}

/**
 * ブロック1つを、描いたときの文字へ直す。
 *
 * 測るのも数えるのも同じこの関数を通す。切る予算（頭出し）と検索の一致件数が
 * 別の物差しで測られると、「一致 3 件」と出ているのに画面に色が付かない状態になる。
 * 記法の記号（** や | や #）は描かれないので、ここでも落とす。
 *
 * @param {object} b ブロック
 */
function blockText(b) {
  if (b.type === 'code') return b.text;
  if (b.type === 'hr') return '';
  if (b.type === 'list') return b.items.map((it) => spansText(it.spans)).join('\n');
  // 表はセルを \t で繋ぐ。空文字で繋ぐと、隣のセルと跨いだ語が一致してしまう
  if (b.type === 'table') return [b.head, ...b.rows].map((r) => r.map(spansText).join('\t')).join('\n');
  if (b.type === 'quote') return blocksText(b.blocks);
  return spansText(b.spans);
}

/**
 * ブロックの並びを、描いたときの文字へ直す。
 *
 * 使うのは検索の一致件数を数えるところだけ。素の文字列を数えると記号まで数に入る。
 *
 * @param {Array<object>} blocks ブロックの並び
 */
export function blocksText(blocks) {
  return blocks.map(blockText).filter(Boolean).join('\n');
}

/**
 * ブロック1つの大きさ。文字数と行数で測る。
 *
 * ピクセルではなく文字で測るのは、ここが DOM を触らない層だから。
 * 目当ては「1件が画面を埋めない」ことなので、この粗さで足りる。
 *
 * @param {object} b ブロック
 */
function blockSize(b) {
  // 引用は中のブロックを足し合わせる。中の hr も1行と数えるため（外と同じ数え方になる）
  if (b.type === 'quote') {
    return b.blocks.map(blockSize).reduce(
      (a, x) => ({ chars: a.chars + x.chars, lines: a.lines + x.lines }),
      { chars: 0, lines: 0 },
    );
  }
  const t = blockText(b);
  // hr は文字を持たないが、1行ぶんの場所は取る
  return { chars: t.length, lines: b.type === 'hr' ? 1 : countLines(t) };
}

/**
 * 行数の予算を文字数へ直す。maxLines 本目の改行までの長さ。
 *
 * @param {string} text 対象
 * @param {number} maxLines 行数の予算
 */
function charsForLines(text, maxLines) {
  if (maxLines <= 0) return 0;
  let at = -1;
  for (let k = 0; k < maxLines; k += 1) {
    const next = text.indexOf('\n', at + 1);
    if (next < 0) return text.length;
    at = next;
  }
  return at;
}

/** 文字数と行数、どちらの予算にも収まる長さ */
function roomChars(text, room) {
  return Math.min(room.chars, charsForLines(text, room.lines));
}

/**
 * spans を頭から n 文字ぶんだけ取る。
 *
 * 返すのは必ず新しい span なので、呼ぶ側が中身を書き換えてよい
 * （末尾の空白を落とすのに使う）。印（strong / del / href）は `...s` で持っていく。
 * 落とすと、頭出しだけリンクや太字が消えて「全文」と見え方が食い違う。
 *
 * 装飾の途中で切れることはある。**太字** の途中で切れれば途中まで太字で描かれるが、
 * それは描いた結果を切っているだけで、記号が本文へ漏れることはない。
 *
 * @param {Array<object>} spans md.js の spans
 * @param {number} n 取る文字数
 */
function cutSpans(spans, n) {
  if (n <= 0) return [];
  const out = [];
  let left = n;
  for (const s of spans) {
    if (s.v.length <= left) {
      out.push({ ...s });
      left -= s.v.length;
      continue;
    }
    const v = s.v.slice(0, left);
    if (v) out.push({ ...s, v });
    break;
  }

  // 末尾の空白と改行は落とす。切り跡の「…」の前に隙間が空くと、切ったのか
  // もともと空いているのかが読めない
  const last = out[out.length - 1];
  if (last) {
    last.v = last.v.replace(/\s+$/, '');
    if (!last.v) out.pop();
  }
  return out;
}

/**
 * ブロック1つを、予算に収まるところまで切る。
 *
 * 切り方は種類ごとに違う。共通しているのは「途中で終わったことが読めるようにする」で、
 * 中途半端な単位で終わらせない。
 *
 * @param {object} b ブロック
 * @param {{chars: number, lines: number}} room 残りの予算
 * @returns {object|null} 切ったブロック。1文字も入らなければ null
 */
function trimBlock(b, room) {
  if (room.chars <= 0 || room.lines <= 0) return null;

  // 線だけが残っても何も伝えない
  if (b.type === 'hr') return null;

  if (b.type === 'p' || b.type === 'h') {
    const spans = cutSpans(b.spans, roomChars(spansText(b.spans), room));
    if (!spans.length) return null;
    return b.type === 'h' ? { ...b, spans } : { type: 'p', spans };
  }

  if (b.type === 'code') {
    let text = b.text.split('\n').slice(0, room.lines).join('\n');
    if (text.length > room.chars) text = text.slice(0, room.chars);
    text = text.replace(/\s+$/, '');
    if (!text) return null;
    // open はそのまま持っていく。あれは「源のフェンスが閉じていない」印なので、
    // 頭出しで切ったことをここで立ててはいけない（意味が2つになる）
    return { ...b, text };
  }

  if (b.type === 'list') {
    const items = [];
    let chars = 0;
    let lines = 0;
    for (const it of b.items) {
      const t = spansText(it.spans);
      const size = { chars: t.length, lines: countLines(t) };
      if (chars + size.chars <= room.chars && lines + size.lines <= room.lines) {
        items.push(it);
        chars += size.chars;
        lines += size.lines;
        continue;
      }
      // 1件目が単体で入りきらないときだけ、その項目を切って入れる。
      // 2件目以降は切らずに止める（項目の途中で終わると、次の項目があるように見える）
      if (!items.length) {
        const spans = cutSpans(it.spans, roomChars(t, room));
        if (spans.length) items.push({ ...it, spans });
      }
      break;
    }
    // 深さの並びは先頭から取れば必ず有効（md-view.js のスタックは
    // 「深さは1つずつしか増えない」ことだけを前提にしている）
    return items.length ? { type: 'list', items } : null;
  }

  if (b.type === 'table') {
    // 見出しの行は予算を超えても残す。見出しの無い表は表として読めない
    const rows = [];
    let chars = blockText({ ...b, rows: [] }).length;
    // 行数は blockSize と同じく countLines で数える。セルの <br>（\n に直したもの）があると
    // 1行が何行にもなるので、1行 = 1 と数えると頭出しの予算が blockSize と食い違う。
    // 空のセルだけの行も1行ぶんの場所は取るので、0 にはしない
    const rowLines = (r) => Math.max(1, countLines(r.map(spansText).join('\t')));
    let lines = rowLines(b.head);
    for (const row of b.rows) {
      const t = row.map(spansText).join('\t');
      const n = rowLines(row);
      if (chars + t.length > room.chars || lines + n > room.lines) break;
      rows.push(row);
      chars += t.length;
      lines += n;
    }
    return { type: 'table', align: b.align, head: b.head, rows };
  }

  if (b.type === 'quote') {
    // 中身はブロックの並びそのものなので、頭出しと同じ切り方を中へ当てる
    const inner = headBlocks(b.blocks, room.chars, room.lines);
    return inner.blocks.length ? { type: 'quote', blocks: inner.blocks } : null;
  }

  return null;
}

/**
 * ブロックの並びを、頭から予算ぶんだけ取る。
 *
 * 時系列は「ざっと目で追える」ことが値なので、1件が画面を埋めてはいけない。
 * 以前は文字数で切っていたが、それだと記法の途中で切れた断片
 * （** が片方だけ・表の途中・フェンスが開いたまま）を描くことになる。
 * 切る単位をブロックへ移すと、頭出しも Markdown として描ける。
 *
 * 測るのは描いたあとの文字数なので、記号のぶんだけ以前より多く入る。
 * つまり前は畳まれていた本文が、そのまま全部出ることがある。
 *
 * @param {Array<object>} blocks parseMarkdown の結果
 * @param {number} limit 文字数の予算
 * @param {number} maxLines 行数の予算
 * @returns {{blocks: Array<object>, cut: boolean}} cut は続きがあるか
 */
export function headBlocks(blocks, limit, maxLines) {
  const out = [];
  let chars = 0;
  let lines = 0;

  for (const b of blocks) {
    const size = blockSize(b);
    if (chars + size.chars <= limit && lines + size.lines <= maxLines) {
      out.push(b);
      chars += size.chars;
      lines += size.lines;
      continue;
    }
    const kept = trimBlock(b, { chars: limit - chars, lines: maxLines - lines });
    if (kept) out.push(kept);
    // 末尾に残った区切り線は落とす。この後ろには切り跡の「…」しか来ないので、
    // 区切る先の無い線だけが残る（trimBlock が hr を落とすのと同じ理由）。
    // 予算に収まる経路は trimBlock を通らないので、ここで見る
    while (out.length && out[out.length - 1].type === 'hr') out.pop();
    return { blocks: out, cut: true };
  }
  return { blocks: out, cut: false };
}
