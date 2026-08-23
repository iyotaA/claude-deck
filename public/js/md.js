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
 * リンク 0.2% / 引用 0.3% / チェックボックス 0% / 打ち消し 0% は出さない。
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
 *   { depth, ordered, num, spans }
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
      items.push({
        depth: Math.min(stack.length - 1, MAX_DEPTH),
        ordered: !!ol,
        num: ol ? Number(ol[2]) : null,
        text: m[3].trim(),
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

/**
 * 記法が1つも無い（＝素の文字と同じ）か。
 *
 * 段落が1つで、その中が地の文だけなら、Markdown として描いても素で描いても同じ。
 * 呼ぶ側が「切る単位を文字数のままにするか、ブロックにするか」を決めるのに使う。
 *
 * @param {Array<object>} blocks parseMarkdown の結果
 */
export function isPlain(blocks) {
  if (blocks.length === 0) return true;
  if (blocks.length > 1) return false;
  const b = blocks[0];
  return b.type === 'p' && b.spans.every((s) => s.type === 'text');
}
