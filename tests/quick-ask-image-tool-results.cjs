// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createImageToolResults } = require('../src/quick-ask/image-tool-results');
const { protocolFor } = require('../src/quick-ask/protocol');
const output = (protocol, id) => protocol === 'responses'
  ? { type: 'function_call_output', call_id: id, output: `Image read: ${id}.png.` }
  : { role: 'tool', tool_call_id: id, content: `Image read: ${id}.png.` };
const image = (path, size = 10) => ({ path, size, url: `data:image/png;base64,${path}` });

for (const id of ['responses', 'chat-completions']) {
  const protocol = protocolFor({ protocol: id });
  test(`${id}: projection preserves canonical text and groups images after the complete CC tool batch`, async () => {
    const registry = createImageToolResults(), a = output(id, 'a'), b = output(id, 'b');
    registry.remember(a, ['a.png']); registry.remember(b, ['b.png']);
    const items = [a, b, protocol.assistantMessage('Done')];
    const original = JSON.stringify(items), reads = [];
    const result = await registry.materialize(items, { protocol, allowlist: new Set(['a.png', 'b.png']),
      source: { readForSend: async ([path]) => { reads.push(path); return [image(path)]; } } });
    assert.equal(result.hasImages, true); assert.deepEqual(reads, ['a.png', 'b.png']);
    assert.equal(JSON.stringify(items), original);
    if (id === 'responses') {
      assert.deepEqual(result.items[0].output.map(part => part.type), ['input_text', 'input_image']);
      assert.equal(result.items.length, 3);
    } else {
      assert.deepEqual(result.items.map(item => item.role), ['tool', 'tool', 'user', 'assistant']);
      assert.equal(result.items[2].content.filter(part => part.type === 'image_url').length, 2);
    }
  });

  test(`${id}: missing or unauthorized historical sources become text errors and can recover later`, async () => {
    const registry = createImageToolResults(), a = output(id, 'a');
    registry.remember(a, ['a.png']);
    let reads = 0, missing = true;
    const source = { readForSend: async ([path]) => { reads++; if (missing) throw new Error('/private/file'); return [image(path)]; } };
    const denied = await registry.materialize([a], { protocol, source, allowlist: new Set() });
    assert.equal(reads, 0); assert.match(JSON.stringify(denied.items), /not authorized/);
    const failed = await registry.materialize([a], { protocol, source, allowlist: new Set(['a.png']) });
    assert.equal(failed.hasImages, false); assert.match(JSON.stringify(failed.items), /IMAGE_MISSING/);
    assert.equal(JSON.stringify(failed.items).includes('/private'), false);
    missing = false;
    assert.equal((await registry.materialize([a], { protocol, source, allowlist: new Set(['a.png']) })).hasImages, true);
  });

  test(`${id}: total bytes include pending uploads and repeated image occurrences`, async () => {
    const registry = createImageToolResults(), a = output(id, 'a'), b = output(id, 'b');
    registry.remember(a, ['a.png']); registry.remember(b, ['a.png']);
    let reads = 0;
    const MiB = 1024 * 1024;
    const options = { protocol, allowlist: new Set(['a.png']), source: { readForSend: async ([path]) => { reads++; return [image(path, 20 * MiB)]; } },
      pendingImages: Array.from({ length: 9 }, (_, n) => image(`pending${n}.png`, 20 * MiB)) };
    const result = await registry.materialize([a, b], options);
    assert.equal(reads, 1, 'deduplicate source IO only within this request');
    assert.equal(result.hasImages, false); assert.match(JSON.stringify(result.items), /IMAGE_TOTAL/);
    assert.equal(JSON.stringify(result.items).includes('data:image'), false);
    const many = await registry.materialize(Array(21).fill(a), { ...options, pendingImages: [] });
    assert.match(JSON.stringify(many.items), /IMAGE_COUNT/); assert.equal(reads, 1);
  });

  test(`${id}: cancellation drops all materialized bytes and copied summary items retain references`, async () => {
    const registry = createImageToolResults(), a = output(id, 'a'), copied = { ...a };
    registry.remember(a, ['a.png']); registry.copy(a, copied);
    const controller = new AbortController();
    const options = { protocol, allowlist: new Set(['a.png']), source: { readForSend: async ([path]) => { controller.abort(); return [image(path)]; } } };
    const cancelled = await registry.materialize([copied], { ...options, signal: controller.signal });
    assert.equal(cancelled.hasImages, false); assert.equal(JSON.stringify(cancelled.items).includes('data:image'), false);
    assert.match(JSON.stringify(cancelled.items), /cancelled/);
    const ready = await registry.materialize([copied], { ...options, source: { readForSend: async ([path]) => [image(path)] } });
    assert.equal(ready.hasImages, true);
    const plain = await registry.materialize([protocol.userMessage('No tool results')], { protocol, allowlist: new Set() });
    assert.equal(plain.hasImages, false);
  });
}
