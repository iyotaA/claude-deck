/**
 * 詳細ビューの時系列を組む処理のテスト。
 *
 * 目的は「自分が何を判断したか」がログから決定論的に出ること。
 * 特に AskUserQuestion の回答抽出は、実測した文字列の形に依存しているので固定しておく。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDigest } from '../src/parse/digest.mjs';
import { T0, at, say, call, result, prompt } from './helpers.mjs';

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
    { i: 0, kind: 'compact', at: T0, trigger: null, preTokens: null, postTokens: null, droppedTokens: null },
  );
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

test('長い本文は切って、省略した印を付ける', () => {
  const long = 'あ'.repeat(1300);
  const d = buildDigest({ entries: [say(long)] });
  const [item] = only(d, 'say');
  assert.equal(item.full, true);
  assert.ok(item.text.endsWith('…（以下省略）'));
  assert.equal(item.text.length, 1200 + '…（以下省略）'.length);
});

test('項目が多すぎるときは説明文から落とし、判断の記録は残す', () => {
  const entries = [prompt('やって')];
  for (let i = 0; i < 410; i += 1) entries.push(say(`発言 ${i}`, { ms: i + 1 }));

  const d = buildDigest({ entries });
  assert.equal(d.items.length, 400);
  assert.equal(d.stats.droppedItems, 11);
  // 先頭の指示は必ず残る。何をやっていたか思い出すための場所なので
  assert.equal(d.items[0].kind, 'prompt');
  assert.equal(only(d, 'prompt').length, 1);
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
});
