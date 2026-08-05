/**
 * 詳細ビューの時系列を組む処理のテスト。
 *
 * 目的は「自分が何を判断したか」がログから決定論的に出ること。
 * 特に AskUserQuestion の回答抽出は、実測した文字列の形に依存しているので固定しておく。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDigest } from '../src/parse/digest.mjs';
import { T0, at, say, call, multiCall, result, prompt } from './helpers.mjs';

/** 指定した kind の項目だけ取り出す。 */
const only = (digest, kind) => digest.items.filter((i) => i.kind === kind);

test('指示と発言が打った順に並ぶ', () => {
  const d = buildDigest({
    entries: [prompt('これやって'), say('やるね', { ms: 100 }), prompt('もう一つ', { ms: 200 })],
  });
  assert.deepEqual(d.items.map((i) => i.kind), ['prompt', 'say', 'prompt']);
  assert.deepEqual(d.items.map((i) => i.i), [0, 1, 2]);
  assert.equal(d.items[0].text, 'これやって');
  assert.equal(d.stats.prompts, 2);
  assert.equal(d.stats.says, 1);
  assert.equal(d.stats.turns, 1);
});

test('選んだ選択肢と、その選択肢の説明が残る', () => {
  const input = {
    questions: [{
      question: '範囲はどうする？',
      header: '範囲',
      multiSelect: false,
      options: [
        { label: 'A: 最小', description: '重複だけ直す' },
        { label: 'B: 階層化', description: 'src を役割で分ける' },
      ],
    }],
  };
  const d = buildDigest({
    entries: [
      call('AskUserQuestion', input, { id: 'q1' }),
      result('q1', {
        ms: 100,
        text: 'Your questions have been answered: "範囲はどうする？"="B: 階層化" selected preview:\n'
          + 'src を役割で分ける\n'
          + '. You can now continue with these answers in mind.',
      }),
    ],
  });

  const [answer] = only(d, 'answer');
  assert.equal(answer.unanswered, false);
  assert.equal(answer.answers.length, 1);

  const a = answer.answers[0];
  assert.equal(a.question, '範囲はどうする？');
  assert.equal(a.header, '範囲');
  assert.equal(a.multiSelect, false);
  assert.equal(a.chosen, 'B: 階層化');
  assert.equal(a.freeText, false);
  assert.deepEqual(a.chosenOptions, [{ label: 'B: 階層化', description: 'src を役割で分ける' }]);
  assert.deepEqual(a.otherOptions, [{ label: 'A: 最小', description: '重複だけ直す' }]);
  assert.equal(d.stats.answers, 1);
});

test('選択肢に無い答え（自由入力）はそのまま文字列で残す', () => {
  const d = buildDigest({
    entries: [
      call('AskUserQuestion', {
        questions: [{ question: 'どうする？', options: [{ label: 'はい', description: 'やる' }] }],
      }, { id: 'q1' }),
      result('q1', { ms: 100, text: 'Your questions have been answered: "どうする？"="自分で書いた案".' }),
    ],
  });
  const a = only(d, 'answer')[0].answers[0];
  assert.equal(a.chosen, '自分で書いた案');
  assert.equal(a.freeText, true);
  assert.deepEqual(a.chosenOptions, []);
  // 選ばれなかった案は全部が「その他」に回る
  assert.deepEqual(a.otherOptions.map((o) => o.label), ['はい']);
});

test('まだ答えていない質問は未回答の印が付く', () => {
  const d = buildDigest({
    entries: [call('AskUserQuestion', { questions: [{ question: 'どっち？', options: [] }] }, { id: 'q1' })],
  });
  const [answer] = only(d, 'answer');
  assert.equal(answer.unanswered, true);
  assert.equal(answer.answers[0].chosen, null);
});

test('選んだ答えは toolUseResult.answers から先に引く', () => {
  const question = '範囲は "どこ" まで？';
  const input = {
    questions: [{
      question,
      header: '範囲',
      options: [
        { label: 'A: 最小', description: '重複だけ直す' },
        { label: 'B: 階層化', description: 'src を役割で分ける' },
      ],
    }],
  };
  const d = buildDigest({
    entries: [
      call('AskUserQuestion', input, { id: 'q1' }),
      result('q1', {
        ms: 100,
        text: 'Your questions have been answered. You can now continue with these answers in mind.',
        structured: { answers: { [question]: 'B: 階層化' } },
      }),
    ],
  });
  const a = only(d, 'answer')[0].answers[0];
  // 質問文に " が入ると本文からは引けない。辞書を先に見る理由がこれ
  assert.equal(a.chosen, 'B: 階層化');
  assert.deepEqual(a.chosenOptions, [{ label: 'B: 階層化', description: 'src を役割で分ける' }]);
  assert.equal(a.freeText, false);
});

test('複数選択は文字列でも配列でも同じ形に寄せる', () => {
  const input = {
    questions: [{
      question: 'どれを入れる？',
      multiSelect: true,
      options: [
        { label: '検索', description: '絞り込みを足す' },
        { label: '足跡', description: 'ツールの記録を出す' },
        { label: '原文', description: '生データに戻れる' },
      ],
    }],
  };
  const chosenOf = (answers) => buildDigest({
    entries: [
      call('AskUserQuestion', input, { id: 'q1' }),
      result('q1', { ms: 100, text: '', structured: { answers } }),
    ],
  }).items[0].answers[0];

  // 実測した3本はすべて ", " 連結の文字列。配列は0件だった
  const fromText = chosenOf({ 'どれを入れる？': '検索, 原文' });
  assert.equal(fromText.chosen, '検索, 原文');
  assert.deepEqual(fromText.chosenOptions.map((o) => o.label), ['検索', '原文']);
  assert.equal(fromText.freeText, false);

  // 将来配列に変わっても同じ結果になること。文字列側は分割しない（ラベルに ", " が入ると壊れる）
  const fromArray = chosenOf({ 'どれを入れる？': ['検索', '原文'] });
  assert.equal(fromArray.chosen, '検索, 原文');
  assert.deepEqual(fromArray.chosenOptions.map((o) => o.label), ['検索', '原文']);
});

test('却下されたときは定型文を落として、自分が添えたコメントだけ残す', () => {
  const d = buildDigest({
    entries: [
      call('Write', { file_path: 'C:\\work\\a.mjs' }, { id: 'd1' }),
      result('d1', {
        ms: 100,
        denialKind: 'user-rejected',
        text: "The user doesn't want to proceed with this tool use. そこじゃなくて b.mjs のほう\n"
          + 'STOP what you are doing and wait for the user to tell you how to proceed.',
      }),
    ],
  });
  const [denial] = only(d, 'denial');
  assert.equal(denial.tool, 'Write');
  assert.equal(denial.detail, 'C:\\work\\a.mjs');
  assert.equal(denial.denialKind, 'user-rejected');
  assert.equal(denial.denialLabel, 'あなたが却下');
  assert.equal(denial.note, 'そこじゃなくて b.mjs のほう');
  assert.equal(d.stats.denials, 1);
  // 却下は失敗として数えない。数え方が変わると画面の件数がずれる
  assert.equal(d.stats.errors, 0);
});

test('却下に添えたコメントは改行を保って残す', () => {
  const d = buildDigest({
    entries: [
      call('Write', { file_path: 'C:\\work\\a.mjs' }, { id: 'd1' }),
      result('d1', {
        ms: 100,
        denialKind: 'user-rejected',
        text: "The user doesn't want to proceed with this tool use. 直してほしいのは2点。\n"
          + '1. 置き場所\n'
          + '2. 名前\n'
          + 'STOP what you are doing and wait for the user to tell you how to proceed.',
      }),
    ],
  });
  // 1行に潰すと箇条書きが溶けて、何を指示したのか読めなくなる
  assert.equal(only(d, 'denial')[0].note, '直してほしいのは2点。\n1. 置き場所\n2. 名前');
});

test('知らない却下の種類でも、そのまま出して落ちない', () => {
  const d = buildDigest({
    entries: [
      call('Bash', { command: 'ls' }, { id: 'd1' }),
      result('d1', { ms: 100, denialKind: 'まだ知らない種類', text: '' }),
    ],
  });
  const [denial] = only(d, 'denial');
  assert.equal(denial.denialLabel, 'まだ知らない種類');
  assert.equal(denial.note, null);
});

test('承認されたプランは保存先まで拾う', () => {
  const d = buildDigest({
    entries: [
      call('ExitPlanMode', { plan: '# 手順\n1. やる' }, { id: 'p1' }),
      result('p1', {
        ms: 100,
        text: 'User has approved your plan. Plan saved to: C:\\Users\\me\\.claude\\plans\\foo.md',
      }),
    ],
  });
  const [plan] = only(d, 'plan');
  assert.equal(plan.approved, true);
  assert.equal(plan.pending, false);
  assert.equal(plan.plan, '# 手順\n1. やる');
  assert.equal(plan.planFile, 'C:\\Users\\me\\.claude\\plans\\foo.md');
  assert.equal(plan.feedback, null);
  assert.equal(d.stats.plans, 1);
});

test('プランの保存先は結果の構造化データを先に見る', () => {
  const d = buildDigest({
    entries: [
      call('ExitPlanMode', { plan: '# 手順' }, { id: 'p1' }),
      result('p1', {
        ms: 100,
        text: 'User has approved your plan. Plan saved to: C:\\wrong\\path.md',
        structured: { filePath: 'C:\\Users\\me\\.claude\\plans\\right.md', planWasEdited: true },
      }),
    ],
  });
  const [plan] = only(d, 'plan');
  // filePath は承認された結果すべてに入っていた（実測46件）。本文の正規表現は古い版のための控え
  assert.equal(plan.planFile, 'C:\\Users\\me\\.claude\\plans\\right.md');
  assert.equal(plan.edited, true);
});

test('プランは切る前の長さを持つ', () => {
  const body = 'あ'.repeat(30_000);
  const d = buildDigest({ entries: [call('ExitPlanMode', { plan: body }, { id: 'p1' })] });
  const [plan] = only(d, 'plan');
  // ディスクの本文と突き合わせるとき、切られた本文で比べると必ず不一致になる
  assert.equal(plan.planChars, 30_000);
  assert.ok(plan.plan.length < 30_000);
  // 編集の有無は書かれていないので null。キーが無いことを「編集なし」と読み替えない
  assert.equal(plan.edited, null);
});

test('却下されたプランは、返された指示が本文として残る', () => {
  const d = buildDigest({
    entries: [
      call('ExitPlanMode', { plan: '# 手順' }, { id: 'p1' }),
      result('p1', { ms: 100, text: 'テストを先に置いてほしい' }),
    ],
  });
  const [plan] = only(d, 'plan');
  assert.equal(plan.approved, false);
  assert.equal(plan.feedback, 'テストを先に置いてほしい');
});

test('プランに返した指示も改行を保って残す', () => {
  const d = buildDigest({
    entries: [
      call('ExitPlanMode', { plan: '# 手順' }, { id: 'p1' }),
      result('p1', { ms: 100, text: '段ごとにコミットして\n動作確認してから次へ' }),
    ],
  });
  // 次に何をするかの指示そのもの。行の形に意味がある
  assert.equal(only(d, 'plan')[0].feedback, '段ごとにコミットして\n動作確認してから次へ');
});

test('提出したまま止まっているプランは保留の印が付く', () => {
  const d = buildDigest({ entries: [call('ExitPlanMode', { plan: '# 手順' }, { id: 'p1' })] });
  const [plan] = only(d, 'plan');
  assert.equal(plan.pending, true);
  assert.equal(plan.approved, false);
});

test('プラン本文が tool_use に無いときは結果側から拾う', () => {
  const d = buildDigest({
    entries: [
      call('ExitPlanMode', {}, { id: 'p1' }),
      result('p1', { ms: 100, text: 'User has approved your plan.', structured: { plan: '# あとから来た手順' } }),
    ],
  });
  assert.equal(only(d, 'plan')[0].plan, '# あとから来た手順');
});

test('文脈が圧縮された地点を拾う', () => {
  const d = buildDigest({
    entries: [
      prompt('長い作業'),
      {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'c1',
        timestamp: at(500),
        compactMetadata: {
          trigger: 'auto',
          preTokens: 180000,
          postTokens: 20000,
          cumulativeDroppedTokens: 160000,
        },
      },
    ],
  });
  assert.equal(d.compactions.length, 1);
  const [c] = d.compactions;
  assert.equal(c.kind, 'compact');
  assert.equal(c.trigger, 'auto');
  assert.equal(c.preTokens, 180000);
  assert.equal(c.postTokens, 20000);
  assert.equal(c.droppedTokens, 160000);
  assert.equal(c.at, T0 + 500);
  // 時系列にも同じものが並ぶ
  assert.equal(only(d, 'compact').length, 1);
});

test('compactMetadata が無くても落ちない', () => {
  const d = buildDigest({
    entries: [{ type: 'system', subtype: 'compact_boundary', uuid: 'c1', timestamp: at(0) }],
  });
  assert.deepEqual(
    only(d, 'compact')[0],
    {
      i: 0,
      kind: 'compact',
      at: T0,
      uuid: 'c1',
      trigger: null,
      preTokens: null,
      postTokens: null,
      droppedTokens: null,
    },
  );
});

test('Claude の中間報告は専用の種類で時系列に並ぶ', () => {
  const d = buildDigest({
    entries: [
      prompt('長い作業をお願い'),
      {
        type: 'system',
        subtype: 'away_summary',
        uuid: 'r1',
        timestamp: at(500),
        content: 'テストを通しました。\n次はコミットします。 (disable recaps in /config)',
      },
    ],
  });
  const [r] = only(d, 'recap');
  assert.equal(r.uuid, 'r1');
  assert.equal(r.at, T0 + 500);
  // 断り書きだけ落として、改行は残す（読み物として読ませる本文なので）
  assert.equal(r.text, 'テストを通しました。\n次はコミットします。');
  assert.equal(r.fullLength, r.text.length);
});

test('スキルと サブエージェントは専用の一覧にも溜まる', () => {
  const d = buildDigest({
    entries: [
      call('Skill', { skill: 'pr-review', args: '1234' }, { id: 's1' }),
      call('Agent', { subagent_type: 'general-purpose', description: 'CSS の構造を調査' }, { id: 'g1', ms: 100 }),
      call('Task', { description: '別名でも同じ扱い' }, { id: 'g2', ms: 200 }),
    ],
  });
  assert.deepEqual(d.skills.map((s) => [s.skill, s.args]), [['pr-review', '1234']]);
  assert.deepEqual(d.agents.map((a) => [a.agentType, a.description]), [
    ['general-purpose', 'CSS の構造を調査'],
    [null, '別名でも同じ扱い'],
  ]);
  assert.equal(d.stats.toolCalls, 3);
});

test('失敗した呼び出しは却下とは別に数える', () => {
  const d = buildDigest({
    entries: [
      call('Bash', { command: 'boom' }, { id: 'x1' }),
      result('x1', { ms: 100, isError: true, text: 'コマンドが見つかりません' }),
    ],
  });
  const [err] = only(d, 'error');
  assert.equal(err.tool, 'Bash');
  assert.equal(err.message, 'コマンドが見つかりません');
  assert.equal(d.stats.errors, 1);
  assert.equal(d.stats.denials, 0);
});

test('ツールの一行説明の作り方', () => {
  // 成功した呼び出しは時系列に出さないので、却下の項目を通して確かめる。
  // 却下はツール名より先に判定されるので、Skill や Agent でもここを通る
  const detailOf = (name, input) => {
    const d = buildDigest({
      entries: [
        call(name, input, { id: 'x1' }),
        result('x1', { ms: 100, denialKind: 'user-rejected', text: '' }),
      ],
    });
    return only(d, 'denial')[0].detail;
  };

  // description と command の両方があるときは description を優先する。
  // 一覧側（state.mjs）と表記を揃えるとき、人が読んで分かるほうへ寄せた
  assert.equal(detailOf('Bash', { command: 'npm test', description: 'テストを走らせる' }), 'テストを走らせる');
  assert.equal(detailOf('PowerShell', { command: 'Get-ChildItem' }), 'Get-ChildItem');
  assert.equal(detailOf('Read', { file_path: 'C:\\a.mjs' }), 'C:\\a.mjs');
  assert.equal(detailOf('Grep', { pattern: 'TODO', path: 'src' }), 'TODO in src');
  assert.equal(detailOf('Grep', { pattern: 'TODO' }), 'TODO');
  assert.equal(detailOf('Glob', { pattern: '**/*.mjs' }), '**/*.mjs');
  // 引数は括弧で囲む。スキル名との境目が分かるようにするため
  assert.equal(detailOf('Skill', { skill: 'pr-review', args: '1234' }), 'pr-review (1234)');
  assert.equal(detailOf('Skill', { skill: 'pr-review' }), 'pr-review');
  assert.equal(detailOf('WebFetch', { url: 'https://example.com' }), 'https://example.com');
  assert.equal(detailOf('まだ知らないツール', { description: '何かする' }), '何かする');
  assert.equal(detailOf('まだ知らないツール', {}), null);
  // 改行は空白に潰して一行にする
  assert.equal(detailOf('Bash', { command: 'a\n  b' }), 'a b');
});

test('触ったファイルは回数の多い順に集計する', () => {
  const d = buildDigest({
    entries: [
      call('Edit', { file_path: 'a.mjs' }, { id: 'e1' }),
      call('Write', { file_path: 'b.mjs' }, { id: 'w1', ms: 100 }),
      call('Edit', { file_path: 'a.mjs' }, { id: 'e2', ms: 200 }),
    ],
  });
  assert.deepEqual(d.files, [
    { path: 'a.mjs', count: 2, tools: ['Edit'] },
    { path: 'b.mjs', count: 1, tools: ['Write'] },
  ]);
});

test('スラッシュコマンドと中断は別枠で並ぶ', () => {
  const d = buildDigest({
    entries: [
      prompt('<command-name>/pr-review</command-name>\n<command-args>1234</command-args>'),
      prompt('[Request interrupted by user for tool use]', { ms: 100 }),
      prompt('<command-name>/clear</command-name>', { ms: 200 }),
    ],
  });
  assert.deepEqual(d.items.map((i) => i.kind), ['slash', 'interrupt', 'slash']);
  assert.equal(d.items[0].command, '/pr-review');
  assert.equal(d.items[0].args, '1234');
  assert.equal(d.items[2].args, null);
  assert.equal(d.stats.interrupts, 1);
  // どちらも自分が打った指示としては数えない
  assert.equal(d.stats.prompts, 0);
});

test('サブエージェントの行は時系列に混ぜない', () => {
  const d = buildDigest({
    entries: [
      prompt('調査して'),
      { ...say('サブの発言', { ms: 100 }), isSidechain: true },
      { ...call('Bash', { command: 'ls' }, { id: 'sub1', ms: 200 }), isSidechain: true },
      say('終わったよ', { ms: 300 }),
    ],
  });
  assert.deepEqual(d.items.map((i) => i.kind), ['prompt', 'say']);
  assert.equal(d.stats.toolCalls, 0);
  assert.equal(d.stats.turns, 1);
});

test('長い本文は切って、切る前の長さを持たせる', () => {
  const long = 'あ'.repeat(1300);
  const d = buildDigest({ entries: [say(long)] });
  const [item] = only(d, 'say');
  // 切ったあとの本文から長さを計ると「全文（1,200字）」と嘘をつく。切る前の数を持たせる
  assert.equal(item.fullLength, 1300);
  assert.ok(item.text.endsWith('…（以下省略）'));
  assert.equal(item.text.length, 1200 + '…（以下省略）'.length);
});

test('項目が多すぎるときは説明文から落とし、判断の記録は残す', () => {
  const entries = [prompt('やって')];
  for (let i = 0; i < 410; i += 1) entries.push(say(`発言 ${i}`, { ms: i + 1 }));

  const d = buildDigest({ entries });
  // 省略の印は上限の枠外。枠の中だと、印を作るために本体をもう1件落とす循環になる
  assert.equal(d.items.filter((i) => i.kind !== 'elided').length, 400);
  assert.equal(d.stats.droppedItems, 11);
  // 先頭の指示は必ず残る。何をやっていたか思い出すための場所なので
  assert.equal(d.items[0].kind, 'prompt');
  assert.equal(only(d, 'prompt').length, 1);
});

test('間引きで落ちた区間には省略の印が残る', () => {
  const entries = [prompt('やって')];
  for (let i = 0; i < 410; i += 1) entries.push(say(`発言 ${i}`, { ms: i + 1 }));

  const d = buildDigest({ entries });
  const [gap] = only(d, 'elided');
  // 連続して落ちた区間は1つにまとめる。1件ずつ印を出すと本体より数が増える
  assert.equal(gap.count, 11);
  assert.deepEqual(gap.byKind, { say: 11 });
  // 落ちたのは古い側。どのあたりが消えたか分かるように時刻の幅を持たせる
  assert.equal(gap.fromAt, T0 + 1);
  assert.equal(gap.toAt, T0 + 11);
  // 印は1つの行を指していないので、原文には戻れない
  assert.equal(gap.uuid, null);
  assert.equal(d.items[1].kind, 'elided');
});

test('上限を超えたら失敗の記録から先に落とす', () => {
  const entries = [prompt('やって')];
  for (let i = 0; i < 5; i += 1) {
    entries.push(call('Bash', { command: `boom ${i}` }, { id: `x${i}`, ms: i + 1 }));
    entries.push(result(`x${i}`, { ms: i + 1, isError: true, text: 'だめ' }));
  }
  for (let i = 0; i < 400; i += 1) entries.push(say(`発言 ${i}`, { ms: 100 + i }));

  const d = buildDigest({ entries });
  // 失敗は件数が stats.errors に残るので、Claude の説明より先に落としてよい
  assert.equal(only(d, 'error').length, 0);
  assert.equal(d.stats.errors, 5);
  assert.deepEqual(only(d, 'elided')[0].byKind, { error: 5, say: 1 });
});

test('ふつうのツールの呼び出しは、行ごとに1件の足跡にまとまる', () => {
  const d = buildDigest({
    entries: [
      multiCall([
        { name: 'Read', input: { file_path: 'a.mjs' }, id: 'x1' },
        { name: 'Read', input: { file_path: 'b.mjs' }, id: 'x2' },
      ], { uuid: 'a-1' }),
      result('x1', { ms: 300, text: 'あ'.repeat(500), uuid: 'r-1' }),
      result('x2', { ms: 900, text: 'い' }),
    ],
  });

  const [trace] = only(d, 'trace');
  // 並列で2本呼んだ行を2件にすると、水増しになって判断の記録が埋もれる
  assert.equal(trace.count, 2);
  assert.equal(trace.uuid, 'a-1');
  // 同じツールを並列で呼んだ行を「Read ×2」と読めるようにする
  assert.deepEqual(trace.tools, ['Read']);
  // 一番遅い結果まで。速いほうに合わせると、実際に待った時間が読めない
  assert.equal(trace.durationMs, 900);
  // 本文は積まない。長さだけ持って、中身は原文に戻って見る
  assert.equal(trace.calls[0].resultChars, 500);
  assert.equal(trace.calls[0].head.length, 160);
  assert.equal(trace.calls[0].resultUuid, 'r-1');
  assert.equal(trace.calls[0].pending, false);
});

test('自分の項目を持つ呼び出しは足跡に二重で数えない', () => {
  const d = buildDigest({
    entries: [
      call('Bash', { command: 'boom' }, { id: 'x1' }),
      result('x1', { ms: 10, isError: true, text: 'だめ' }),
      call('ExitPlanMode', { plan: 'これでいく' }, { id: 'x2', ms: 20 }),
      result('x2', { ms: 30, text: 'User has approved your plan' }),
      call('Skill', { skill: 'review' }, { id: 'x3', ms: 40 }),
      result('x3', { ms: 50 }),
    ],
  });
  // 失敗・プラン・スキルは自分の項目を持つ。足跡にも出ると同じ呼び出しが2件に見える
  assert.equal(only(d, 'trace').length, 0);
});

test('結果の来ていない呼び出しは足跡に保留として残る', () => {
  const d = buildDigest({ entries: [call('Bash', { command: 'npm test' }, { id: 'x1' })] });
  const [trace] = only(d, 'trace');
  // いま止まっているのがここだと分かる
  assert.equal(trace.calls[0].pending, true);
  // 測れなかったものを 0 と書かない
  assert.equal(trace.durationMs, null);
  assert.equal(trace.calls[0].resultChars, null);
  assert.equal(trace.calls[0].head, null);
});

test('足跡は独立した枠なので、あふれても説明は落とさない', () => {
  const entries = [prompt('やって')];
  for (let i = 0; i < 210; i += 1) {
    entries.push(call('Read', { file_path: `f${i}.mjs` }, { id: `x${i}`, ms: i + 1 }));
    entries.push(result(`x${i}`, { ms: i + 1 }));
  }
  for (let i = 0; i < 300; i += 1) entries.push(say(`発言 ${i}`, { ms: 500 + i }));

  const d = buildDigest({ entries });
  // 足跡は 200 件で止まる。本編（400）と枠を分けているので、説明は1件も落ちない
  assert.equal(only(d, 'trace').length, 200);
  assert.equal(only(d, 'say').length, 300);
  // 落ちた区間の内訳を持たせるのは、足跡を隠している人に無関係な省略通知を出さないため
  assert.deepEqual(only(d, 'elided')[0].byKind, { trace: 10 });
});

test('項目は元の行の uuid を持ち、結果の行も指せる', () => {
  const d = buildDigest({
    entries: [
      prompt('やって', { uuid: 'p-1' }),
      call('Bash', { command: 'boom' }, { id: 'x1', ms: 100, uuid: 'a-1', text: '走らせるね' }),
      result('x1', { ms: 200, isError: true, text: 'コマンドが見つかりません', uuid: 'r-1' }),
    ],
  });
  // 発言と失敗が同じ assistant 行から出るので、uuid は項目のあいだで一意にならない。
  // 原文ボタンは「その行を開く」の意味になる
  assert.deepEqual(d.items.map((i) => i.uuid), ['p-1', 'a-1', 'a-1']);
  assert.equal(only(d, 'error')[0].resultUuid, 'r-1');
});

test('回答までの間を測る', () => {
  const d = buildDigest({
    entries: [
      call('AskUserQuestion', { questions: [{ question: 'どっち？', options: [] }] }, { id: 'q1' }),
      result('q1', { ms: 90_000 }),
    ],
  });
  const [answer] = only(d, 'answer');
  assert.equal(answer.wait.kind, 'answer');
  assert.equal(answer.wait.ms, 90_000);
  assert.equal(answer.wait.away, false);
  assert.equal(d.stats.waits.answer.count, 1);
  assert.equal(d.stats.waits.answer.totalMs, 90_000);
});

test('答えの来ていない待ちは null。0 とは書かない', () => {
  const d = buildDigest({ entries: [call('AskUserQuestion', { questions: [] }, { id: 'q1' })] });
  // 進行中の待ちは state.mjs の idleMs が持っている。ここは終わった待ちだけを扱う
  assert.equal(only(d, 'answer')[0].wait, null);
  assert.equal(d.stats.waits.answer.count, 0);
});

test('4時間を超える待ちは合計に混ぜず別に数える', () => {
  const d = buildDigest({
    entries: [
      call('ExitPlanMode', { plan: '# 手順' }, { id: 'p1' }),
      result('p1', { ms: 5 * 60 * 60 * 1000, text: 'User has approved your plan.' }),
    ],
  });
  assert.equal(only(d, 'plan')[0].wait.away, true);
  // 席を外していた時間を合計に入れると「回答までの間」が意味を失う
  assert.equal(d.stats.waits.plan.count, 0);
  assert.equal(d.stats.waits.plan.away, 1);
});

test('返信待ちは turn_duration が挟まっても測れる', () => {
  const d = buildDigest({
    entries: [
      prompt('やって'),
      say('やったよ', { ms: 1000 }),
      // 毎ターンの直後に必ず入る行（実測405件）。これでリセットすると返信待ちが1件も測れない
      { type: 'system', subtype: 'turn_duration', uuid: 't1', timestamp: at(1100) },
      prompt('次いこう', { ms: 61_000 }),
    ],
  });
  const prompts = only(d, 'prompt');
  // 1件目は起点が無い。会話の頭なので待たせていない
  assert.equal(prompts[0].wait, null);
  assert.equal(prompts[1].wait.kind, 'reply');
  assert.equal(prompts[1].wait.ms, 60_000);
  assert.equal(d.stats.waits.reply.count, 1);
});

test('ツール結果が挟まると返信待ちにはしない', () => {
  const d = buildDigest({
    entries: [
      say('調べるね'),
      call('Bash', { command: 'ls' }, { id: 'b1', ms: 100 }),
      result('b1', { ms: 200 }),
      prompt('ありがと', { ms: 60_000 }),
    ],
  });
  // 結果が返っているなら Claude は動いていた。返信を待っていた時間ではない
  assert.equal(only(d, 'prompt')[0].wait, null);
});

test('区切りを跨いだ待ちは測らない', () => {
  const crossing = (mid) => buildDigest({
    entries: [
      call('AskUserQuestion', { questions: [{ question: 'どっち？', options: [] }] }, { id: 'q1' }),
      mid,
      result('q1', { ms: 60_000 }),
    ],
  }).items[0].wait;

  // 圧縮・中断・スラッシュコマンドのあとは別の作業。跨いだ時間を足すと嘘になる
  assert.equal(crossing({ type: 'system', subtype: 'compact_boundary', uuid: 'c1', timestamp: at(30_000) }), null);
  assert.equal(crossing(prompt('[Request interrupted by user]', { ms: 30_000 })), null);
  assert.equal(crossing(prompt('<command-name>/clear</command-name>', { ms: 30_000 })), null);
  // 跨いでいないものは測れる
  assert.equal(crossing(say('待たせてるあいだの発言', { ms: 30_000 })).ms, 60_000);
});

test('ふつうのツールの往復は別枠に集計する', () => {
  const d = buildDigest({
    entries: [
      call('Bash', { command: 'npm test' }, { id: 'b1' }),
      result('b1', { ms: 12_000 }),
    ],
  });
  // 許可待ちと実行時間が混ざるので、回答までの間とは足し合わせない
  assert.equal(d.stats.waits.tool.count, 1);
  assert.equal(d.stats.waits.tool.totalMs, 12_000);
  assert.equal(d.stats.waits.answer.count, 0);
});

test('経過時間は最初と最後の行から計算する', () => {
  const d = buildDigest({ entries: [prompt('はじめ'), say('おわり', { ms: 5000 })] });
  assert.equal(d.stats.firstAt, T0);
  assert.equal(d.stats.lastAt, T0 + 5000);
  assert.equal(d.stats.elapsedMs, 5000);
});

test('空のログでも形の揃った結果を返す', () => {
  const d = buildDigest({});
  assert.deepEqual(d.items, []);
  assert.deepEqual(d.files, []);
  assert.deepEqual(d.skills, []);
  assert.deepEqual(d.agents, []);
  assert.deepEqual(d.compactions, []);
  assert.equal(d.stats.elapsedMs, null);
  assert.equal(d.stats.droppedItems, 0);
  // 待ちの集計は種類の枠だけ先に作る。画面側が存在チェックをしなくて済む
  assert.deepEqual(d.stats.waits.answer, { count: 0, totalMs: 0, maxMs: 0, away: 0 });
  assert.deepEqual(Object.keys(d.stats.waits), ['answer', 'plan', 'denial', 'reply', 'tool']);
});

test('同期で終わったサブエージェントは結果から中身まで拾う', () => {
  const report = 'あ'.repeat(4200);
  const d = buildDigest({
    entries: [
      call('Agent', { subagent_type: 'Explore', description: '探偵A: parse 層を調査' }, { id: 'tu-1' }),
      result('tu-1', {
        ms: 90_000,
        structured: {
          agentId: 'a1b5fffa598f1c4ce',
          agentType: 'Explore',
          status: 'completed',
          resolvedModel: 'claude-sonnet-5',
          content: report,
          totalDurationMs: 88_400,
          totalTokens: 51_200,
          totalToolUseCount: 12,
        },
      }),
    ],
  });
  const [a] = d.agents;
  // agentId はサブエージェントの記録（ファイル名）と突き合わせる鍵
  assert.equal(a.agentId, 'a1b5fffa598f1c4ce');
  assert.equal(a.toolUseId, 'tu-1');
  assert.equal(a.status, 'completed');
  assert.equal(a.model, 'claude-sonnet-5');
  assert.equal(a.durationMs, 88_400);
  assert.equal(a.tokens, 51_200);
  assert.equal(a.toolUseCount, 12);
  // 本文そのものは積まない。長さだけ出して、中身は「開く」の応答へ回す
  assert.equal(a.reportChars, 4200);
  assert.equal(a.content, undefined);
});

test('非同期のサブエージェントは完了通知から終わりを決める', () => {
  const d = buildDigest({
    entries: [
      call('Agent', { subagent_type: 'general-purpose', description: '職人: 修正' }, { id: 'tu-2' }),
      result('tu-2', {
        ms: 500,
        structured: { agentId: 'aae06781144f65807', status: 'async_launched', resolvedModel: 'claude-opus-5' },
      }),
      prompt([
        '<task-notification>',
        '<task-id>aae06781144f65807</task-id>',
        '<status>killed</status>',
        '<result>途中で止めました</result>',
      ].join('\n'), { ms: 120_000 }),
    ],
  });
  const [a] = d.agents;
  // 呼び出しの結果には「起動した」までしか入らない。終わりは差し込みの行にだけ出る
  assert.equal(a.status, 'killed');
  assert.equal(a.doneAt, T0 + 120_000);
  // 完了通知は指示ではないので、あなたの指示として数えない
  assert.equal(d.stats.prompts, 0);
});

test('通知の来ていない非同期のエージェントを「走っている」と言わない', () => {
  const d = buildDigest({
    entries: [
      call('Agent', { description: '探偵B: 調査' }, { id: 'tu-3' }),
      result('tu-3', { ms: 500, structured: { agentId: 'b2', status: 'async_launched' } }),
    ],
  });
  // 終わったセッションを開いても走っているように見えてしまう。起動したことだけを言う
  assert.equal(d.agents[0].status, 'launched');
  assert.equal(d.agents[0].doneAt, null);
});

test('結果がまだ来ていないエージェントは保留として出す', () => {
  const d = buildDigest({ entries: [call('Agent', { description: '起動直後' }, { id: 'tu-4' })] });
  const [a] = d.agents;
  assert.equal(a.status, 'pending');
  assert.equal(a.agentId, null);
  // 取れなかったものを 0 と書かない
  assert.equal(a.durationMs, null);
  assert.equal(a.reportChars, null);
});

test('scope に sidechain を渡すとサブエージェントの行だけで組む', () => {
  const branch = (entry) => ({ ...entry, isSidechain: true, agentId: 'a1' });
  const entries = [
    prompt('親の指示'),
    branch(prompt('サブエージェントへの指示', { ms: 100 })),
    branch(say('調べました', { ms: 200 })),
  ];

  // 既定（main）はサブエージェントの行を落とす。今までの呼び出し元は1文字も変わらない
  const main = buildDigest({ entries });
  assert.deepEqual(main.items.map((i) => i.kind), ['prompt']);

  // サブエージェントのログは全行 isSidechain:true なので、main のままだと1件も残らない
  const sub = buildDigest({ entries, scope: 'sidechain' });
  assert.deepEqual(sub.items.map((i) => i.kind), ['prompt', 'say']);
  assert.equal(sub.items[0].text, 'サブエージェントへの指示');
  assert.equal(sub.stats.turns, 1);
});

test('sidechain では agentId でさらに絞れる', () => {
  const entries = [
    { ...say('こっちの枝', { ms: 100 }), isSidechain: true, agentId: 'a1' },
    { ...say('別の枝', { ms: 200 }), isSidechain: true, agentId: 'a2' },
  ];
  const d = buildDigest({ entries, scope: 'sidechain', agentId: 'a2' });
  // 1エージェント1ファイルなので通常は要らないが、混ざったログを渡されても正しく組めるようにしておく
  assert.deepEqual(d.items.map((i) => i.text), ['別の枝']);
});

test('未知の type が混ざっても黙って飛ばす', () => {
  const d = buildDigest({
    entries: [
      prompt('これやって'),
      // 実測した未知の type。attachment のほか mode / ai-title / queue-operation などがある
      { type: 'attachment', uuid: 'x1', timestamp: at(50), attachment: { type: 'plan_mode_exit' } },
      { type: 'ai-title', uuid: 'x2', timestamp: at(60), title: 'つけられた題' },
      { type: 'queue-operation', uuid: 'x3', timestamp: at(70) },
      say('やるね', { ms: 100 }),
    ],
  });
  // 公開仕様が無いので未知の形は必ず来る。落ちずに、知っている行だけ組む
  assert.deepEqual(d.items.map((i) => i.kind), ['prompt', 'say']);
});
