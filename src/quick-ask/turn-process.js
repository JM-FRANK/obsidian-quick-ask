// Display-only steps. Canonical protocol items and model replay never read these.
const PROCESS_VERSION = 1;

function restoreProcess(records = []) {
  const steps = new Map();
  for (const record of records) {
    if (record.kind !== 'turn/process' || record.payload?.version !== PROCESS_VERSION || !Array.isArray(record.payload.steps)) continue;
    for (const step of record.payload.steps) {
      if (!Number.isSafeInteger(step?.order) || step.order < 0 || typeof step.id !== 'string') continue;
      if (['reasoning', 'text'].includes(step.kind) && typeof step.text === 'string')
        steps.set(step.id, { id: step.id, order: step.order, kind: step.kind, text: step.text });
      else if (step.kind === 'tool' && typeof step.groupId === 'string' && typeof step.callId === 'string')
        steps.set(step.id, { id: step.id, order: step.order, kind: 'tool', groupId: step.groupId, callId: step.callId });
    }
  }
  return [...steps.values()].sort((a, b) => a.order - b.order);
}

function createTurnProcess(initial = []) {
  const steps = initial.map(step => ({ ...step }));
  const tools = new Set(steps.filter(step => step.kind === 'tool').map(step => `${step.groupId}\n${step.callId}`));
  let saved = steps.length, active = null;
  const add = step => {
    const order = (steps.at(-1)?.order ?? -1) + 1;
    const value = { ...step, order, id: `step-${order}` };
    steps.push(value); return value;
  };
  return {
    steps,
    append(kind, delta) {
      if (!delta) return false;
      const boundary = active?.kind !== kind;
      if (boundary) active = add({ kind, text: '' });
      active.text += delta;
      return boundary;
    },
    tool(groupId, callId) {
      const key = `${groupId}\n${callId}`;
      if (tools.has(key)) return false;
      tools.add(key); active = null; add({ kind: 'tool', groupId, callId }); return true;
    },
    // Close an attempt even when the next attempt also begins with reasoning.
    boundary() { active = null; },
    drain(final = false) {
      const end = final || !active ? steps.length : steps.length - 1;
      const result = steps.slice(saved, end).map(step => ({ ...step }));
      saved = end; return result;
    },
  };
}

function processParts(steps = [], answerText = undefined) {
  // A provider may disclose hosted-search metadata only after its answer.
  // Keep that observed tool row without duplicating the final prose inside it.
  const index = answerText === '' ? -1 : answerText === undefined
    ? (steps.at(-1)?.kind === 'text' ? steps.length - 1 : -1)
    : steps.findLastIndex(step => step.kind === 'text' && step.text === answerText);
  return { steps: index < 0 ? steps : steps.filter((_, position) => position !== index),
    answer: index < 0 ? '' : steps[index].text };
}

function reasoningSummary(text, running = false) {
  const value = String(text ?? '');
  const paragraphs = value.split(/\r?\n[\t ]*\r?\n/);
  const completed = paragraphs.filter(paragraph => /\n/.test(paragraph));
  const line = running ? (completed.at(-1) ?? (paragraphs.length > 1 ? paragraphs.at(-2) : '')).split(/\r?\n/)[0]
    : value.trimStart().split(/\r?\n/)[0];
  return line.replace(/\*\*|^#{1,6}\s+/g, '').trim();
}

module.exports = { PROCESS_VERSION, restoreProcess, createTurnProcess, processParts, reasoningSummary };
