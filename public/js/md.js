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
 * 出す記法は実測で決めた8つだけ（~/.claude/projects の大きい順 40 ログ・2026-08-23）。
 * assistant の発言 3,278 件のうち 47.8% が何らかの記法を含み、内訳は
 * インラインコード 41.9% / 太字 23.2% / フェンス 9.5% / 箇条書き 8.2% /
 * 見出し 7.7% / 表 7.1% / 水平線 2.7% / 番号付き 2.1%。
 * リンク 0.2% / 引用 0.3% / 打ち消し 0% は出さない。
 *
 * チェックリスト（`- [ ]` / `- [x]` / `- [~]`）は後から足した。
 * assistant の発言には1件も無いが（0 件 / 2,534 件）、プランの本文と
 * ユーザーの指示文には来る（実測 2026-08-24。指示文 40 ログで 129 行・15 件、
 * プラン 40 ログで 5 行・1 件）。承認待ちのプランは切らずに全部描く場所なので、
 * そこに素の `- [ ]` が並ぶと、どこまで終わったのかが読めない。
 *
 * 出さない記法は素の文字として残る。つまり作らなくても「いまと同じ見え方」で、
 * 作らないことによる害が無い。リンクをここに足さないのは、
 * javascript: を弾く検証を 0.2% のために抱えることになるため。
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
 *   { type: 'table', align, head, rows }  表
 *   { type: 'hr' }                        水平線
 *
 * 項目（list.items の1件）の形。
 *   { depth, ordered, num, task, spans }
 *   task は null（ふつうの項目）か 'todo' / 'doing' / 'done'
 *
 * 装飾（spans の1件）の形。
 *   { type: 'text',   v }
 *   { type: 'code',   v }
 *   { type: 'strong', v }
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
 * 1つの塊の文字を、装飾の区切りへ割る。
 *
 * バッククォートを先に見る。コードの中の ** は装飾しない
 * （** を含むコードを画面に出したときに太字へ化けないため。Markdown の決まりでもある）。
 *
 * 閉じていない記号はただの文字として残す。切られた入力が普通に来るので、
 * 開いたまま終わったものを装飾に化かすと、そこから先が全部太字になる。
 *
 * 斜体（* 1つ）は出さない。箇条書きの記号と衝突するうえ、*.js のような
 * ふつうの文字列が斜体に化ける。実測でも太字ばかりで斜体はほとんど無い。
 *
 * 太字の中の装飾は見ない（**`code`** はバッククォートごと太字になる）。
 * 入れ子まで追うと状態が増えるが、実測でその形はほとんど出ない。
 *
 * @param {string|null} text
 * @returns {Array<object>} spans
 */
export function inlineSpans(text) {
  const t = String(text ?? '');
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ type: 'text', v: buf });
    buf = '';
  };

  let i = 0;
  while (i < t.length) {
    if (t[i] === '`') {
      // ``code`` のように2本以上で囲む形もある。開いた本数と同じ並びで閉じる
      let n = 1;
      while (t[i + n] === '`') n += 1;
      const close = t.indexOf('`'.repeat(n), i + n);
      if (close > i + n) {
        flush();
        out.push({ type: 'code', v: t.slice(i + n, close) });
        i = close + n;
        continue;
      }
      buf += t.slice(i, i + n);
      i += n;
      continue;
    }
    if (t[i] === '*' && t[i + 1] === '*') {
      const close = t.indexOf('**', i + 2);
      if (close > i + 2) {
        flush();
        out.push({ type: 'strong', v: t.slice(i + 2, close) });
        i = close + 2;
        continue;
      }
      buf += '**';
      i += 2;
      continue;
    }
    buf += t[i];
    i += 1;
  }
  flush();
  return out;
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
        spans: inlineSpans(it.text),
      })),
    },
    next: i - 1,
  };
}

/**
 * Markdown を1本読んで、ブロックの並びを返す。
 *
 * @param {string|null} text 本文。null / 空なら空配列
 * @returns {Array<object>} ブロックの並び
 */
export function parseMarkdown(text) {
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
        const headCells = splitRow(line).map(inlineSpans);
        const rows = [];
        i += 2;
        for (; i < lines.length; i += 1) {
          if (!lines[i].trim() || !lines[i].includes('|')) break;
          rows.push(splitRow(lines[i]).map(inlineSpans));
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
 * （末尾の空白を落とすのに使う）。
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
      out.push({ type: s.type, v: s.v });
      left -= s.v.length;
      continue;
    }
    const v = s.v.slice(0, left);
    if (v) out.push({ type: s.type, v });
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
    let lines = 1;
    for (const row of b.rows) {
      const t = row.map(spansText).join('\t');
      if (chars + t.length > room.chars || lines + 1 > room.lines) break;
      rows.push(row);
      chars += t.length;
      lines += 1;
    }
    return { type: 'table', align: b.align, head: b.head, rows };
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
