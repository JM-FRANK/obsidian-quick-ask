// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTurnProcess, restoreProcess, processParts, reasoningSummary } = require('../src/quick-ask/turn-process');
const { conversationFromRecords } = require('../src/quick-ask/conversation-messages');
const rec = (kind, payload) => ({ kind, payload });
const started = turnId => rec('turn/started', { turnId, processVersion: 1 });
const input = text => rec('item/input', { item: { role: 'user', content: text } });
const saved = (turnId, steps) => rec('turn/process', { turnId, version: 1, steps });

test('many deltas persist once at boundaries and retain actual reasoning/tool/reasoning order', () => {
  const process = createTurnProcess(), records = [];
  for (let i = 0; i < 2000; i++) process.append('reasoning', '思考🧠');
  assert.deepEqual(process.drain(), []);
  process.tool('t:batch', 'a');
  records.push(saved('t', process.drain()));
  process.tool('t:batch', 'a'); // queued -> running -> complete is one occurrence.
  process.append('reasoning', 'After reading');
  process.append('text', 'Answer');
  records.push(saved('t', process.drain()));
  records.push(saved('t', process.drain(true)));
  assert.deepEqual(restoreProcess(records), process.steps);
  assert.deepEqual(process.steps.map(step => step.kind), ['reasoning', 'tool', 'reasoning', 'text']);
  assert.equal(process.steps[0].text, '思考🧠'.repeat(2000));
  assert.equal(processParts(process.steps).answer, 'Answer');
});

test('attempt boundaries keep adjacent reasoning blocks distinct and intermediate prose in the process', () => {
  const process = createTurnProcess();
  process.append('reasoning', 'first'); process.boundary();
  process.append('reasoning', 'second'); process.append('text', 'I will read it.');
  process.tool('t:b', 'a'); process.append('text', 'Final');
  const parts = processParts(process.steps);
  assert.deepEqual(parts.steps.map(step => step.kind), ['reasoning', 'reasoning', 'text', 'tool']);
  assert.equal(parts.steps[2].text, 'I will read it.');
  assert.equal(parts.answer, 'Final');
});

test('a saved step cannot alias later live mutations and restored processes continue with unique IDs', () => {
  const process = createTurnProcess(); process.append('reasoning', 'before');
  const snapshot = process.drain(true);
  process.append('reasoning', ' later');
  assert.equal(snapshot[0].text, 'before');
  const restored = createTurnProcess(snapshot);
  restored.append('reasoning', 'new attempt');
  assert.notEqual(restored.steps[0].id, restored.steps[1].id);
});

test('running summaries advance at completed first lines, settled summaries use the first line', () => {
  assert.equal(reasoningSummary('**First**', true), '');
  assert.equal(reasoningSummary('**First**\n\nSecond still typing', true), 'First');
  assert.equal(reasoningSummary('First\n\n**Second**\nbody', true), 'Second');
  assert.equal(reasoningSummary('**First**\n\nSecond', false), 'First');
  assert.equal(reasoningSummary('# Heading\nbody', false), 'Heading');
});

test('mixed old/new turns stay readable without changing any records or duplicating canonical reasoning', () => {
  const p = createTurnProcess(); p.append('reasoning', 'Before'); p.tool('new:b', 'a'); p.append('reasoning', 'After'); p.append('text', 'New answer');
  const records = [rec('turn/started', { turnId: 'old' }), input('Old question'),
    rec('turn/finished', { turnId: 'old', text: 'Old answer', reasoning: 'Old thought', state: 'complete' }),
    started('new'), input('New question'), saved('new', p.drain(true)),
    rec('turn/tool-started', { turnId: 'new', batchId: 'b', callId: 'a', name: 'get-full-file', arguments: { path: 'a.md' } }),
    rec('turn/tool-finished', { turnId: 'new', batchId: 'b', callId: 'a', name: 'get-full-file', status: 'complete', summary: { characters: 12 } }),
    rec('turn/finished', { turnId: 'new', state: 'complete', text: 'New answer', reasoning: 'BeforeAfter' })];
  const original = JSON.stringify(records), messages = conversationFromRecords(records);
  assert.deepEqual(messages.map(entry => entry.kind ?? entry.role), ['user', 'assistant', 'user', 'process', 'assistant']);
  assert.equal(messages[1].reasoning, 'Old thought');
  assert.deepEqual(messages[3].steps.map(step => step.kind), ['reasoning', 'tool', 'reasoning']);
  assert.equal(messages[3].steps[1].call.status, 'complete');
  assert.equal(messages[4].reasoning, undefined);
  assert.equal(JSON.stringify(records), original);
});

test('missing optional metadata falls back to full readable reasoning and existing tools, keeping answer outside', () => {
  const records = [started('t'), input('Q'),
    saved('t', [{ kind: 'text', id: 'step-0', order: 0, text: 'Answer' }]),
    rec('turn/tool-started', { turnId: 't', batchId: 'b', callId: 'a', name: 'get-image', arguments: { path: 'a.png' } }),
    rec('turn/finished', { turnId: 't', state: 'complete', text: 'Answer', reasoning: 'Readable fallback' })];
  const messages = conversationFromRecords(records), process = messages.find(entry => entry.kind === 'process');
  assert.equal(process.steps.filter(step => step.kind === 'text').length, 0);
  assert.equal(process.steps[0].text, 'Readable fallback');
  assert.equal(process.steps[1].call.status, 'interrupted');
  assert.equal(messages.at(-1).text, 'Answer');
});

test('restart before turn completion retains finished steps and marks pending tool calls interrupted', () => {
  const p = createTurnProcess(); p.append('reasoning', 'Before crash'); p.tool('t:b', 'a');
  const messages = conversationFromRecords([started('t'), input('Q'), saved('t', p.drain()),
    rec('turn/tool-started', { turnId: 't', batchId: 'b', callId: 'a', name: 'get-full-file', arguments: { path: 'a.md' } })]);
  const process = messages.find(entry => entry.kind === 'process');
  assert.equal(process.status, 'interrupted');
  assert.equal(process.steps[0].text, 'Before crash');
  assert.equal(process.steps[1].call.status, 'interrupted');
});

test('tool IDs are scoped to the turn and a tool-only completed turn has no empty answer', () => {
  const records = [];
  for (const id of ['a', 'b']) {
    const p = createTurnProcess(); p.tool(`${id}:batch`, 'same-id');
    records.push(started(id), input(id), saved(id, p.drain(true)),
      rec('turn/tool-finished', { turnId: id, batchId: 'batch', callId: 'same-id', name: 'get-full-file', status: id === 'a' ? 'complete' : 'failed' }),
      rec('turn/finished', { turnId: id, state: 'complete' }));
  }
  const messages = conversationFromRecords(records);
  assert.deepEqual(messages.map(entry => entry.kind ?? entry.role), ['user', 'process', 'user', 'process']);
  assert.deepEqual(messages.filter(entry => entry.kind === 'process').map(entry => entry.steps[0].call.status), ['complete', 'failed']);
});

test('hosted-search metadata returned after the answer does not duplicate the final prose in the process', () => {
  const p = createTurnProcess(); p.append('reasoning', 'Search'); p.append('text', 'Answer'); p.tool('t:server', 'server-search');
  const records = [started('t'), input('Q'), saved('t', p.drain(true)),
    rec('turn/tool-finished', { turnId: 't', batchId: 'server', callId: 'server-search', name: 'web_search', server: true, status: 'complete' }),
    rec('turn/finished', { turnId: 't', state: 'complete', text: 'Answer', reasoning: 'Search' })];
  const messages = conversationFromRecords(records);
  assert.deepEqual(messages.find(entry => entry.kind === 'process').steps.map(step => step.kind), ['reasoning', 'tool']);
  assert.equal(messages.at(-1).text, 'Answer');
});

test('an explicit empty final answer retains intermediate prose and does not turn it into an answer', () => {
  const p = createTurnProcess(); p.append('text', 'Preparing a tool call');
  const parts = processParts(p.steps, '');
  assert.equal(parts.steps[0].text, 'Preparing a tool call');
  assert.equal(parts.answer, '');
});

test('manual compaction after a completed new turn stays after its answer and before the next question', () => {
  const p = createTurnProcess(); p.append('reasoning', 'Thought'); p.append('text', 'Answer');
  const messages = conversationFromRecords([started('t'), input('Q'), saved('t', p.drain(true)),
    rec('turn/finished', { turnId: 't', state: 'complete', text: 'Answer', reasoning: 'Thought' }),
    rec('compaction/checkpoint', { trigger: 'manual', range: { from: 0, to: 1 } }),
    started('next'), input('Next')]);
  assert.deepEqual(messages.map(entry => entry.kind ?? entry.role), ['user', 'process', 'assistant', 'compaction', 'user']);
});

test('compaction during a tool turn keeps the already visible process ahead of the divider', () => {
  const p = createTurnProcess(); p.append('reasoning', 'Before'); p.tool('t:b', 'a');
  const first = p.drain(); p.append('text', 'Answer');
  const messages = conversationFromRecords([started('t'), input('Q'), saved('t', first),
    rec('turn/tool-finished', { turnId: 't', batchId: 'b', callId: 'a', name: 'get-full-file', status: 'complete' }),
    rec('compaction/checkpoint', { range: { from: 0, to: 1 } }), saved('t', p.drain(true)),
    rec('turn/finished', { turnId: 't', state: 'complete', text: 'Answer', reasoning: 'Before' })]);
  assert.deepEqual(messages.map(entry => entry.kind ?? entry.role), ['user', 'process', 'compaction', 'assistant']);
});
