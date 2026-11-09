import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, operate, validateStored } from './model.js';
import { StickiesHost, toolDefinition, apply, remoteDescriptor } from './host.js';

const CARD_ONE = '00000000-0000-4000-8000-000000000001';
const CARD_TWO = '00000000-0000-4000-8000-000000000002';
test('deleteCard atomically removes active and archived notes, preserving other cards and idempotent retries', async () => {
  const f = fixture(), a = f.agent('delete-card'), b = f.agent('other-session');
  const active = await add(f.host, a, 'active'), archived = await add(f.host, a, 'archived');
  await f.host.request(a, { action: 'archive', id: archived });
  await f.host.request(a, { action: 'createCard', id: CARD_ONE, title: 'Keep' });
  await f.host.request(a, { action: 'create', cardId: CARD_ONE, text: 'untouched', marks: [{ start: 0, end: 3, bold: true }] });
  const before = structuredClone(f.host.state(a.id)), other = await add(f.host, b, 'private');
  const result = await f.host.request(a, { action: 'deleteCard', id: 'default' });
  assert.equal(result.ok, true); assert.deepEqual(result.state.cards, before.cards.filter(c => c.id === CARD_ONE));
  assert.deepEqual(result.state.notes, before.notes.filter(n => n.cardId === CARD_ONE));
  assert.ok(!result.state.notes.some(n => [active, archived].includes(n.id)));
  assert.deepEqual(result.state.queue, before.queue);
  const retry = await f.host.request(a, { action: 'deleteCard', id: 'default' });
  assert.deepEqual(retry.state, result.state);
  assert.equal(f.host.state(b.id).notes[0].id, other);
  assert.deepEqual(fixture(f.saved).host.state(a.id), result.state);
});
test('deleting last card persists an empty board, unlike a legacy missing card catalog', async () => {
  const f = fixture(), a = f.agent('empty-card'); await add(f.host, a);
  const removed = await f.host.request(a, { action: 'deleteCard', id: 'default' });
  assert.deepEqual(removed.state.cards, []); assert.deepEqual(removed.state.notes, []);
  const restored = fixture(f.saved).host.state(a.id); assert.deepEqual(restored.cards, []);
  assert.deepEqual(operate(restored, { action: 'list' }).cards, []);
  const legacy = structuredClone(restored); delete legacy.cards;
  assert.equal(validateStored(legacy).cards[0].id, 'default');
  const explicit = await f.host.request(a, { action: 'create', cardId: 'default', text: 'must reject' });
  assert.equal(explicit.error.code, 'INVALID_CARD'); assert.deepEqual(f.host.state(a.id).cards, []);
  const lazy = await f.host.request(a, { action: 'create', text: 'legacy create' });
  assert.equal(lazy.state.cards[0].id, 'default'); assert.equal(lazy.state.notes[0].cardId, 'default');
});
test('legacy create falls back to first remaining card and deleteCard validates IDs', () => {
  let state = operate(initialState(), { action: 'createCard', id: CARD_ONE });
  state = operate(state, { action: 'deleteCard', id: 'default' });
  state = operate(state, { action: 'create', text: 'first existing' });
  assert.equal(state.notes[0].cardId, CARD_ONE); assert.equal(state.cards.length, 1);
  for (const id of ['', '  ', null, 1, undefined]) assert.throws(() => operate(state, { action: 'deleteCard', id }), e => e.code === 'INVALID_ID');
  assert.deepEqual(operate(state, { action: 'deleteCard', id: 'absent-id' }), state);
});
test('deleting queued card cancels only matching pending snapshots and pauses all later dispatch', async () => {
  const f = fixture(), a = f.agent('delete-pending'), first = await add(f.host, a, 'remove task');
  await f.host.request(a, { action: 'createCard', id: CARD_ONE });
  const second = (await f.host.request(a, { action: 'create', cardId: CARD_ONE, text: 'keep task' })).state.notes.at(-1).id;
  a.session.open = 1;
  await f.host.request(a, { action: 'queue', ids: [first, second], mode: 'execute' }, true);
  const snapshot = structuredClone(f.host.state(a.id).queue);
  const deleted = await f.host.request(a, { action: 'deleteCard', id: 'default' });
  assert.equal(deleted.state.queue.status, 'paused');
  assert.equal(deleted.state.queue.items[0].status, 'canceled'); assert.equal(deleted.state.queue.items[0].text, snapshot.items[0].text);
  assert.deepEqual(deleted.state.queue.items[1], snapshot.items[1]);
  a.session.open = null; await f.host.observe(a, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert.equal(a.sent.length, 0); assert.equal(fixture(f.saved).host.state(a.id).queue.items[0].status, 'canceled');
});
test('deleteCard refuses running and dispatching matching items without partial deletion', async () => {
  const f = fixture(), a = f.agent('delete-active'), id = await add(f.host, a);
  await f.host.request(a, { action: 'queue', ids: [id], mode: 'answer' }, true);
  const before = structuredClone(f.host.state(a.id));
  assert.equal((await f.host.request(a, { action: 'deleteCard', id: 'default' })).error.code, 'CARD_IN_FLIGHT');
  assert.deepEqual(f.host.state(a.id), before);
  before.queue.items[0].status = 'dispatching';
  assert.throws(() => operate(before, { action: 'deleteCard', id: 'default' }), e => e.code === 'CARD_IN_FLIGHT');
  assert.equal(before.notes.length, 1); assert.equal(before.cards.length, 1);
});
test('deleteCard failure does not expose partial memory state; tools share permanent deletion', async () => {
  const f = fixture(), a = f.agent('delete-failure'); await add(f.host, a);
  const before = structuredClone(f.host.state(a.id)), put = f.unit.putRecord;
  f.unit.putRecord = async () => { throw new Error('disk full'); };
  assert.equal((await f.host.request(a, { action: 'deleteCard', id: 'default' })).ok, false);
  assert.deepEqual(f.host.state(a.id), before);
  f.unit.putRecord = put;
  const tool = toolDefinition(f.host); assert.ok(tool.parameters.properties.action.enum.includes('deleteCard'));
  const result = await tool.execute({ action: 'deleteCard', id: 'default' }, { agent: a });
  assert.equal(result.ok, true); assert.deepEqual(result.state.cards, []); assert.deepEqual(result.state.notes, []);
  assert.ok(!tool.parameters.properties.action.enum.includes('queue'));
});

test('replacePending false rejects paused cross-card replacement without changing the queue', async () => {
  const f = fixture(), a = f.agent('replace-safe');
  const first = await add(f.host, a, 'card A task');
  await f.host.request(a, { action: 'createCard', id: CARD_ONE });
  const second = (await f.host.request(a, { action: 'create', cardId: CARD_ONE, text: 'card B task' })).state.notes.at(-1).id;
  a.session.open = 1;
  await f.host.request(a, { action: 'queue', ids: [first], mode: 'answer' }, true);
  await f.host.request(a, { action: 'pause' });
  const before = structuredClone(f.host.state(a.id));
  const rejected = await f.host.request(a, { action: 'queue', ids: [second], mode: 'execute', replacePending: false }, true);
  assert.equal(rejected.error.code, 'BUSY_QUEUE'); assert.deepEqual(f.host.state(a.id), before);
  // Legacy omission preserves the existing explicit replacement contract.
  const legacy = await f.host.request(a, { action: 'queue', ids: [second], mode: 'execute' }, true);
  assert.equal(legacy.ok, true); assert.equal(legacy.state.queue.items[0].noteId, second);
  await f.host.request(a, { action: 'pause' });
  await f.host.request(a, { action: 'cancelItem', id: legacy.state.queue.items[0].id });
  assert.equal((await f.host.request(a, { action: 'queue', ids: [first], mode: 'answer', replacePending: false }, true)).ok, true);
});
test('serialized pause and protected replacement cannot race past pending detection', async () => {
  const f = fixture(), a = f.agent('replace-race'), id = await add(f.host, a);
  a.session.open = 1;
  await f.host.request(a, { action: 'queue', ids: [id], mode: 'answer' }, true);
  const [paused, replacement] = await Promise.all([
    f.host.request(a, { action: 'pause' }),
    f.host.request(a, { action: 'queue', ids: [id], mode: 'execute', replacePending: false }, true)
  ]);
  assert.equal(paused.ok, true); assert.equal(replacement.error.code, 'BUSY_QUEUE');
  assert.equal(f.host.state(a.id).queue.items[0].mode, 'answer');
});

test('at 500 notes a lost-response UUID retry is idempotent while new creation stays limited', () => {
  const id = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  const state = operate(initialState(), { action: 'create', id: id(1), text: 'saved' }, { now: 10 });
  state.notes = Array.from({ length: 500 }, (_, index) => ({ ...structuredClone(state.notes[0]), id: id(index + 1) }));
  state.revision = 500;
  const before = structuredClone(state);
  const retry = operate(state, { action: 'create', id: id(500), text: 'must not overwrite' });
  assert.deepEqual(retry, before);
  assert.deepEqual(state, before);
  assert.throws(() => operate(state, { action: 'create', id: id(501), text: 'new' }), error => error.code === 'LIMIT');
  assert.throws(() => operate(state, { action: 'create', id: 'invalid', text: 'bad' }), error => error.code === 'INVALID_ID');
});

test('legacy records migrate cards deterministically without losing any note or queue data', () => {
  let legacy = operate(initialState(), { action: 'create', text: 'keep', marks: [{ start: 0, end: 4, bold: true }] }, { now: 10, uuid: () => 'old' });
  legacy = operate(legacy, { action: 'archive', id: 'old' }, { now: 20 });
  delete legacy.cards; delete legacy.notes[0].cardId;
  const before = structuredClone(legacy), migrated = validateStored(legacy);
  assert.deepEqual(migrated.cards, [{ id: 'default', title: 'Stickies', createdAt: 0, updatedAt: 0 }]);
  assert.deepEqual(migrated.notes[0], { ...before.notes[0], cardId: 'default' });
  assert.deepEqual(migrated.queue, before.queue); assert.deepEqual(legacy, before);
  assert.deepEqual(validateStored(migrated), migrated);
});
test('cards create idempotently, rename with trimmed title, persist, and isolate sessions', async () => {
  const f = fixture(), a = f.agent('cards'), b = f.agent('other');
  const created = await f.host.request(a, { action: 'createCard', id: CARD_ONE });
  assert.equal(created.state.cards[1].title, 'Stickies');
  const revision = created.state.revision;
  const duplicate = await f.host.request(a, { action: 'createCard', id: CARD_ONE, title: 'must not replace' });
  assert.equal(duplicate.state.cards.length, 2); assert.equal(duplicate.state.revision, revision);
  await f.host.request(a, { action: 'renameCard', id: CARD_ONE, title: '  Work ideas  ' });
  const note = await f.host.request(a, { action: 'create', cardId: CARD_ONE, text: 'note', marks: [{ start: 0, end: 4, color: 'accent' }] });
  assert.equal(note.state.notes[0].cardId, CARD_ONE);
  const reloaded = fixture(f.saved).host.state(a.id);
  assert.equal(reloaded.cards[1].title, 'Work ideas'); assert.equal(reloaded.notes[0].marks[0].color, 'accent');
  assert.equal((await f.host.request(b, { action: 'create', cardId: CARD_ONE, text: 'invalid' })).error.code, 'INVALID_CARD');
  assert.equal((await f.host.request(b, { action: 'list' })).state.cards.length, 1);
});
test('card titles, identifiers, references, and count are validated', () => {
  const create = title => operate(initialState(), { action: 'createCard', id: CARD_ONE, title });
  for (const title of ['', '   ', 1, null, 'x'.repeat(201)]) assert.throws(() => create(title), error => error.code === 'INVALID_TITLE');
  assert.equal(create('x'.repeat(200)).cards[1].title.length, 200);
  assert.throws(() => operate(initialState(), { action: 'createCard', id: 'default' }), error => error.code === 'INVALID_ID');
  assert.throws(() => operate(initialState(), { action: 'renameCard', id: CARD_ONE, title: 'missing' }), error => error.code === 'INVALID_CARD');
  let state = initialState();
  for (let i = 1; i < 50; i++) state = operate(state, { action: 'createCard', id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` });
  assert.equal(state.cards.length, 50);
  assert.equal(operate(state, { action: 'createCard', id: CARD_ONE }).cards.length, 50);
  assert.throws(() => operate(state, { action: 'createCard', id: '00000000-0000-4000-8000-000000000050' }), error => error.code === 'LIMIT');
  const invalid = operate(initialState(), { action: 'create', text: 'bad ref' }); invalid.notes[0].cardId = CARD_ONE;
  assert.throws(() => validateStored(invalid), error => error.code === 'INVALID_CARD');
});
test('card-scoped reorder changes only its active slots; global reorder remains compatible', () => {
  let state = operate(initialState(), { action: 'createCard', id: CARD_ONE });
  for (const [id, cardId] of [['a', 'default'], ['x', CARD_ONE], ['b', 'default'], ['y', CARD_ONE], ['z', CARD_ONE]]) state = operate(state, { action: 'create', text: id, cardId }, { uuid: () => id });
  state = operate(state, { action: 'archive', id: 'z' });
  state = operate(state, { action: 'reorder', cardId: CARD_ONE, ids: ['y', 'x'] });
  assert.deepEqual(state.notes.map(n => n.id), ['a', 'y', 'b', 'x', 'z']);
  for (const ids of [['x'], ['x', 'x'], ['x', 'a'], ['x', 'y', 'z']]) assert.throws(() => operate(state, { action: 'reorder', cardId: CARD_ONE, ids }), error => error.code === 'INVALID_ORDER');
  assert.throws(() => operate(state, { action: 'reorder', cardId: CARD_TWO, ids: [] }), error => error.code === 'INVALID_CARD');
  state = operate(state, { action: 'reorder', ids: ['b', 'a', 'x', 'y'] });
  assert.deepEqual(state.notes.map(n => n.id), ['b', 'a', 'x', 'y', 'z']);
  assert.throws(() => operate(state, { action: 'update', id: 'a', patch: { cardId: CARD_ONE } }), error => error.code === 'INVALID_FIELD');
});
test('cards do not change global queue snapshots, authorization, or completion routing', async () => {
  const f = fixture(), a = f.agent('card-queue'), tool = toolDefinition(f.host);
  assert.equal((await tool.execute({ action: 'createCard', id: CARD_ONE, title: 'Work' }, { agent: a })).ok, true);
  const first = await add(f.host, a, 'first');
  const second = (await f.host.request(a, { action: 'create', cardId: CARD_ONE, text: 'second' })).state.notes.at(-1).id;
  const request = { action: 'queue', items: [{ id: first, mode: 'answer' }, { id: second, mode: 'execute' }] };
  assert.equal((await tool.execute(request, { agent: a })).error.code, 'USER_ONLY');
  await f.host.request(a, request, true);
  const snapshot = structuredClone(f.host.state(a.id).queue);
  await f.host.request(a, { action: 'renameCard', id: CARD_ONE, title: 'Renamed' });
  await f.host.request(a, { action: 'createCard', id: CARD_TWO });
  assert.deepEqual(f.host.state(a.id).queue, snapshot);
  await finish(f.host, a, a.sent[0], 1); await finish(f.host, a, a.sent[1], 2);
  assert.equal(f.host.state(a.id).queue.status, 'completed');
  assert.deepEqual(f.host.state(a.id).notes.map(n => n.cardId), ['default', CARD_ONE]);
  assert.ok(f.host.state(a.id).notes.every(n => n.archivedAt !== null));
});

test('formatting ranges persist across archive, restore, and storage reload', async () => {
  const f = fixture(), a = f.agent('marks');
  const marks = [{ start: 0, end: 3, bold: true, color: 'accent', fontSize: 18 }, { start: 1, end: 2, bold: false, color: 'error' }];
  const created = await f.host.request(a, { action: 'create', text: 'abc', marks });
  assert.equal(created.ok, true); const id = created.state.notes[0].id;
  marks[0].bold = false; // No caller-owned alias retained by the model.
  assert.equal(f.host.state(a.id).notes[0].marks[0].bold, true);
  await f.host.request(a, { action: 'archive', id });
  await f.host.request(a, { action: 'restore', id });
  const restored = fixture(f.saved).host.state(a.id).notes[0];
  assert.deepEqual(restored.marks, created.state.notes[0].marks);
  assert.equal(restored.marks[1].bold, false); // Ordered, overlapping marks are retained.
});
test('text-only changes invalidate old offsets; combined updates validate against new text', () => {
  let state = operate(initialState(), { action: 'create', text: 'a', marks: [{ start: 0, end: 1, bold: true }] }, { uuid: () => 'n' });
  state = operate(state, { action: 'update', id: 'n', patch: { text: 'a' } });
  assert.equal(state.notes[0].marks.length, 1);
  state = operate(state, { action: 'update', id: 'n', patch: { color: 'success' } });
  assert.equal(state.notes[0].marks.length, 1);
  state = operate(state, { action: 'update', id: 'n', patch: { marks: [{ start: 1, end: 4, fontSize: 32 }], text: 'long' } });
  assert.equal(state.notes[0].marks[0].end, 4);
  assert.throws(() => operate(state, { action: 'update', id: 'n', patch: { marks: [{ start: 0, end: 4 }], text: 'no' } }), /bounds/);
  state = operate(state, { action: 'update', id: 'n', patch: { text: '' } });
  assert.deepEqual(state.notes[0].marks, []);
});
test('marks enforce UTF-16 bounds, range count, and strict formatting values', () => {
  const create = marks => operate(initialState(), { action: 'create', text: '😀x', marks });
  assert.equal(create([{ start: 0, end: 2, bold: true }]).notes[0].marks[0].end, 2);
  assert.equal(create([{ start: 2, end: 3 }]).notes[0].marks[0].start, 2);
  for (const mark of [
    { start: -1, end: 1 }, { start: 1, end: 1 }, { start: 2, end: 1 }, { start: 0, end: 4 },
    { start: 0.5, end: 2 }, { start: 0, end: 1.5 }, { end: 1 }, { start: 0, end: Infinity },
    { start: 0, end: 1, fontSize: 9 }, { start: 0, end: 1, fontSize: 33 }, { start: 0, end: 1, fontSize: 12.5 },
    { start: 0, end: 1, color: '#ffffff' }, { start: 0, end: 1, bold: 'true' }, { start: 0, end: 1, html: '<b>x</b>' }, null, []
  ]) assert.throws(() => create([mark]), error => error.code === 'INVALID_MARKS');
  assert.equal(create(Array.from({ length: 256 }, () => ({ start: 0, end: 1 }))).notes[0].marks.length, 256);
  assert.throws(() => create(Array.from({ length: 257 }, () => ({ start: 0, end: 1 }))));
  assert.throws(() => create(null));
});
test('legacy records default to empty marks without mutating caller data', () => {
  const legacy = operate(initialState(), { action: 'create', text: 'old' });
  delete legacy.notes[0].marks;
  const restored = validateStored(legacy);
  assert.deepEqual(restored.notes[0].marks, []); assert.equal(legacy.notes[0].marks, undefined);
  legacy.notes[0].marks = [{ start: 0, end: 99 }];
  assert.throws(() => validateStored(legacy), error => error.code === 'INVALID_MARKS');
});
test('agent tool uses the same validated marks operation without queue authorization', async () => {
  const f = fixture(), a = f.agent('marks-tool'), tool = toolDefinition(f.host);
  assert.equal(tool.parameters.properties.marks.maxItems, 256);
  assert.equal(tool.parameters.properties.patch.properties.marks.items.additionalProperties, false);
  const r = await tool.execute({ action: 'create', text: 'yes', marks: [{ start: 0, end: 3, bold: true }] }, { agent: a });
  assert.equal(r.state.notes[0].marks[0].bold, true);
  const invalid = await tool.execute({ action: 'update', id: r.state.notes[0].id, patch: { marks: [{ start: 0, end: 3, bold: 1 }] } }, { agent: a });
  assert.equal(invalid.error.code, 'INVALID_MARKS');
});

test('Remote agent lookup matches the installed canonical strict wire definition', () => {
  // Verified against installed dsh-commands/lib/typert.remote-client.js:74–89.
  // Gateway resolveParameter rejects either a wire or strict typeSymbol mismatch.
  const parameter = remoteDescriptor.parameters[0];
  const provider = { wire: 'agentId', wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId' };
  const matches = p => provider.wire === p.wire && (p.codec.mode !== 'strict' || provider.wireTypeSymbol === p.codec.typeSymbol);
  assert.equal(parameter.name, 'agent');
  assert.equal(parameter.source, 'lookup');
  assert.equal(parameter.lookup, 'agent');
  assert.equal(parameter.codec.mode, 'strict');
  assert.equal(matches(parameter), true);
  assert.equal(matches({ ...parameter, codec: { ...parameter.codec, typeSymbol: '@local/dsh-stickies#SessionId' } }), false);
  assert.deepEqual(parameter.codec.jsonSchema, { type: 'string' });
  assert.equal(parameter.codec.create().parse('session-example'), 'session-example');
  assert.throws(() => parameter.codec.create().parse(123));
});

function fixture(records = {}) {
  const writes = [], live = new Map(), saved = structuredClone(records);
  const unit = { async loadAll() { return { tables: { sessions: structuredClone(saved) } }; }, async putRecord(table, id, value) { writes.push([table, id]); saved[id] = structuredClone(value); }, async close() {} };
  const agents = { get: id => live.get(id), list: () => [...live.values()], turnBoundaryOf: session => ({ openTurnStartSeq: session.open, lastTurn: session.turn }) };
  const host = new StickiesHost(unit, agents, records);
  function agent(id) {
    const a = { id, session: { id, open: null }, sent: [], removed: [], inbox: { remove(id) { a.removed.push(id); return true; } }, followup(message) { a.sent.push(message); } };
    live.set(id, a); return a;
  }
  return { host, unit, agent, writes, saved, live };
}
async function add(host, agent, text = 'hello') { const r = await host.request(agent, { action: 'create', text }); assert.equal(r.ok, true); return r.state.notes.at(-1).id; }
async function finish(host, agent, message, turn, reason = 'completed') {
  agent.session.open = turn;
  await host.observe(agent, 'claimed', { message, turn });
  await host.observe(agent, 'assistant/message', { turn, message: { content: [{ type: 'text', text: 'Done.' }] } });
  agent.session.open = null;
  await host.observe(agent, 'turn/end', { turn, reason: { kind: reason } });
}

test('active queue replacement is refused; pending cancellation skips only that item', async () => {
  const f = fixture(), a = f.agent('a');
  const ids = [await add(f.host, a, 'one'), await add(f.host, a, 'two')];
  a.session.open = 10;
  await f.host.request(a, { action: 'queue', ids, mode: 'answer' }, true);
  assert.equal((await f.host.request(a, { action: 'queue', ids, mode: 'answer' }, true)).error.code, 'BUSY_QUEUE');
  const item = f.host.state('a').queue.items[0];
  assert.equal((await f.host.request(a, { action: 'cancelItem', id: item.id })).ok, true);
  a.session.open = null;
  await f.host.observe(a, 'turn/end', { turn: 10, reason: { kind: 'completed' } });
  assert.equal(a.sent.length, 1); assert.ok(a.sent[0].content[0].text.endsWith('two'));
  assert.equal((await f.host.request(a, { action: 'cancelItem', id: f.host.state('a').queue.items[1].id })).error.code, 'ITEM_IN_FLIGHT');
});
test('paused pending queue may be explicitly replaced, but not an in-flight item', async () => {
  const f = fixture(), a = f.agent('a'), id = await add(f.host, a);
  a.session.open = 1;
  await f.host.request(a, { action: 'queue', ids: [id], mode: 'answer' }, true);
  await f.host.request(a, { action: 'pause' });
  assert.equal((await f.host.request(a, { action: 'queue', ids: [id], mode: 'execute' }, true)).ok, true);
  a.session.open = null;
  await f.host.observe(a, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  await f.host.request(a, { action: 'pause' });
  assert.equal((await f.host.request(a, { action: 'queue', ids: [id], mode: 'answer' }, true)).error.code, 'BUSY');
});
test('answer guard is immediate, same-turn only, denies writes and delegation, allows verified reads', async () => {
  const f = fixture(), a = f.agent('a'), b = f.agent('b'), id = await add(f.host, a);
  await f.host.request(a, { action: 'queue', ids: [id], mode: 'answer' }, true);
  a.session.open = 7; a.session.turn = 7;
  const pending = f.host.observe(a, 'claimed', { message: a.sent[0], turn: 7 });
  for (const name of ['bash', 'write', 'edit', 'subagent', 'workflow', 'unknown', 'functions.read']) assert.match(f.host.guard({ agent: a, name }), /read-only/);
  for (const name of ['read', 'glob', 'grep', 'web_fetch', 'web_search']) assert.equal(f.host.guard({ agent: a, name }), undefined);
  assert.equal(f.host.guard({ agent: b, name: 'write' }), undefined);
  a.session.turn = 8; assert.equal(f.host.guard({ agent: a, name: 'write' }), undefined);
  await pending; a.session.turn = 7; a.session.open = null;
  await f.host.observe(a, 'turn/end', { turn: 7, reason: { kind: 'completed' } });
  assert.equal(f.host.answerTurns.size, 0);
});
test('client UUID creation is idempotent and blank drafts cannot be queued', async () => {
  const f = fixture(), a = f.agent('a'), id = '67c1332b-92e3-4a93-8f56-cc338221e812';
  for (let i = 0; i < 2; i++) assert.equal((await f.host.request(a, { action: 'create', id, text: '' })).ok, true);
  assert.equal(f.host.state('a').notes.length, 1);
  assert.equal((await f.host.request(a, { action: 'queue', ids: [id], mode: 'answer' }, true)).error.code, 'INVALID_NOTE');
  await f.host.request(a, { action: 'update', id, patch: { text: 'hello' } });
  assert.equal((await f.host.request(a, { action: 'queue', ids: [id, id], mode: 'answer' }, true)).error.code, 'INVALID_QUEUE');
});
test('completed unchanged notes archive, edited snapshots do not, and failures stay active', async () => {
  const f = fixture(), a = f.agent('a');
  const ids = [await add(f.host, a, 'one'), await add(f.host, a, 'two'), await add(f.host, a, 'three')];
  await f.host.request(a, { action: 'queue', ids, mode: 'execute' }, true);
  await finish(f.host, a, a.sent[0], 1);
  assert.equal(f.host.state('a').notes[0].checked, true); assert.equal(typeof f.host.state('a').notes[0].archivedAt, 'number');
  await f.host.request(a, { action: 'update', id: ids[1], patch: { text: 'new two' } });
  await finish(f.host, a, a.sent[1], 2);
  assert.equal(f.host.state('a').notes[1].archivedAt, null); assert.equal(f.host.state('a').notes[1].lastResult.stale, true);
  await finish(f.host, a, a.sent[2], 3, 'error'); assert.equal(f.host.state('a').notes[2].archivedAt, null);
});
test('explicit write retry recovers storage safely without automatic work replay', async () => {
  const f = fixture(), a = f.agent('a'), id = await add(f.host, a), put = f.unit.putRecord;
  f.unit.putRecord = async () => { throw new Error('disk full'); };
  assert.equal((await f.host.request(a, { action: 'update', id, patch: { text: 'new' } })).ok, false);
  f.unit.putRecord = put;
  const r = await f.host.request(a, { action: 'update', id, patch: { text: 'retry' } });
  assert.equal(r.ok, true); assert.equal(r.state.notes[0].text, 'retry'); assert.equal(r.state.queue.status, 'paused'); assert.equal(a.sent.length, 0);
});
test('notes defaults, styles, check, archive timestamp, restore and delete', () => {
  let s = operate(initialState(), { action: 'create', text: 'one' }, { now: 10, uuid: () => 'n' });
  assert.equal(s.notes[0].fontSize, 12); assert.equal(s.notes[0].color, 'default');
  for (const style of ['text', 'checkbox', 'bullet', 'numbered']) s = operate(s, { action: 'update', id: 'n', patch: { style, checked: true } });
  assert.equal(s.notes[0].checked, true);
  s = operate(s, { action: 'archive', id: 'n' }, { now: 20 }); assert.equal(s.notes[0].archivedAt, 20);
  s = operate(s, { action: 'restore', id: 'n' }); assert.equal(s.notes[0].archivedAt, null);
  s = operate(s, { action: 'delete', id: 'n' }); assert.equal(s.notes.length, 0);
});
test('validation and reorder reject partial or duplicate ID lists', () => {
  let i = 0, s = initialState();
  for (const text of ['a', 'b']) s = operate(s, { action: 'create', text }, { uuid: () => String(++i) });
  assert.throws(() => operate(s, { action: 'reorder', ids: ['1', '1'] }));
  assert.throws(() => operate(s, { action: 'update', id: '1', patch: { fontSize: 100 } }));
  assert.throws(() => operate(s, { action: 'update', id: '1', patch: { id: 'spoof' } }));
  assert.equal(operate(s, { action: 'reorder', ids: ['2', '1'] }).notes[0].id, '2');
});
test('sessions are isolated and concurrent operations serialize without lost writes', async () => {
  const { host, agent } = fixture(), a = agent('a'), b = agent('b');
  await Promise.all(Array.from({ length: 20 }, (_, i) => add(host, a, String(i))));
  assert.equal((await host.request(a, { action: 'list' })).state.notes.length, 20);
  assert.equal((await host.request(b, { action: 'list' })).state.notes.length, 0);
  assert.equal((await host.request(b, { action: 'delete', id: host.state('a').notes[0].id })).ok, false);
});
test('tool and user CRUD share operations; tools cannot authorize a queue even with spoofed fields', async () => {
  const { host, agent } = fixture(), a = agent('a'), tool = toolDefinition(host);
  assert.ok(!tool.parameters.properties.action.enum.includes('queue'));
  const created = await tool.execute({ action: 'create', text: 'tool note' }, { agent: a });
  const id = created.state.notes[0].id;
  const denied = await tool.execute({ action: 'queue', items: [{ id, mode: 'execute' }], user: true }, { agent: a });
  assert.equal(denied.error.code, 'USER_ONLY'); assert.equal(a.sent.length, 0);
  assert.equal((await host.request(a, { action: 'list' }, true)).state.notes[0].text, 'tool note');
});
test('mixed modes run only at normal same-session turn boundaries; snapshot and duplicate protection', async () => {
  const { host, agent } = fixture(), a = agent('a'), b = agent('b');
  const id1 = await add(host, a, 'Question'), id2 = await add(host, a, 'Task');
  a.session.open = 1;
  const armed = await host.request(a, { action: 'queue', items: [{ id: id1, mode: 'answer' }, { id: id2, mode: 'execute' }] }, true);
  assert.equal(armed.state.queue.status, 'armed'); assert.equal(a.sent.length, 0);
  await host.request(a, { action: 'update', id: id2, patch: { text: 'MUTATED' } });
  await host.observe(b, 'turn/end', { turn: 1, reason: { kind: 'completed' } }); assert.equal(a.sent.length, 0);
  a.session.open = null;
  await host.observe(a, 'turn/end', { turn: 1, reason: { kind: 'completed' } }); assert.equal(a.sent.length, 1);
  await finish(host, a, a.sent[0], 2); assert.equal(a.sent.length, 2);
  assert.ok(a.sent[1].content[0].text.includes('Task')); assert.ok(!a.sent[1].content[0].text.includes('MUTATED'));
  await host.observe(a, 'turn/end', { turn: 2, reason: { kind: 'completed' } }); assert.equal(a.sent.length, 2);
  await finish(host, a, a.sent[1], 3);
  assert.equal(host.state('a').queue.status, 'completed');
  assert.equal(host.state('a').queue.items[0].result, 'Done.');
  assert.equal(host.state('a').notes[0].lastResult.text, 'Done.');
});
for (const reason of ['aborted', 'error', 'blocked', 'max-tokens', 'interrupted', 'forked']) test(`${reason} pauses and never dispatches the next item`, async () => {
  const { host, agent } = fixture(), a = agent('a');
  const ids = [await add(host, a, '1'), await add(host, a, '2')];
  await host.request(a, { action: 'queue', ids, mode: 'execute' }, true);
  await finish(host, a, a.sent[0], 1, reason);
  assert.equal(a.sent.length, 1); assert.equal(host.state('a').queue.status, 'paused');
});
test('manual pause preserves current work but prevents subsequent work', async () => {
  const { host, agent } = fixture(), a = agent('a');
  const ids = [await add(host, a, '1'), await add(host, a, '2')];
  await host.request(a, { action: 'queue', ids, mode: 'answer' }, true);
  await host.request(a, { action: 'pause' }, true);
  await finish(host, a, a.sent[0], 1);
  assert.equal(a.sent.length, 1); assert.equal(host.state('a').queue.status, 'paused');
});
test('reload disarms persisted authorization and never replays uncertain items', async () => {
  const f = fixture(), a = f.agent('a'), id = await add(f.host, a);
  await f.host.request(a, { action: 'queue', ids: [id], mode: 'execute' }, true);
  const g = fixture(f.saved), b = g.agent('a');
  assert.equal(g.host.state('a').queue.status, 'paused');
  assert.equal(g.host.state('a').queue.items[0].status, 'uncertain');
  g.host.attach(b);
  assert.deepEqual(b.removed, [a.sent[0].id]);
  await g.host.observe(b, 'turn/end', { turn: 99, reason: { kind: 'completed' } }); assert.equal(b.sent.length, 0);
});
test('storage failures surface an error and never dispatch work', async () => {
  const f = fixture(), a = f.agent('a'), id = await add(f.host, a);
  f.unit.putRecord = async () => { throw new Error('disk full'); };
  const r = await f.host.request(a, { action: 'queue', ids: [id], mode: 'execute' }, true);
  assert.equal(r.ok, false); assert.match(r.error.message, /disk full/); assert.equal(a.sent.length, 0);
  assert.match((await f.host.request(a, { action: 'list' })).storageError.message, /disk full/);
});
test('discarded followup and dispatch errors pause visibly', async () => {
  const f = fixture(), a = f.agent('a'), id = await add(f.host, a);
  await f.host.request(a, { action: 'queue', ids: [id], mode: 'answer' }, true);
  await f.host.observe(a, 'discarded', { message: a.sent[0] });
  assert.equal(f.host.state('a').queue.status, 'paused');
  a.followup = () => { throw new Error('unavailable'); };
  await f.host.request(a, { action: 'queue', ids: [id], mode: 'answer' }, true);
  assert.equal(f.host.state('a').queue.items[0].status, 'uncertain');
});
test('installable apply registers only user command authorization and scoped-session tools', async () => {
  const f = fixture(), commands = [], tools = [], events = new Map(), cleanup = [];
  const ctx = { storage: { backend: { names: () => ['test'], get: () => ({ kv: { open: async descriptor => {
      // dsh-storage/lib/index.js UNIT_NAME_RE: unit AND table names are SQL-safe identifiers.
      assert.match(descriptor.name, /^[a-z][a-z0-9_]*$/);
      for (const table of descriptor.tables) assert.match(table, /^[a-z][a-z0-9_]*$/);
      assert.equal(descriptor.name, 'dsh_stickies');
      return { ...f.unit, loadAll: async () => ({ tables: { sessions: {} } }) };
    } } }) } }, agents: f.host.agents,
    effect(fn) { cleanup.push(fn()); }, typert: { register(d) { assert.equal(d.invocations[0].parameters[0].lookup, 'agent'); } }, commands: { register(d) { commands.push(d); } }, tools: { register(d) { tools.push(d); }, guard(fn) { ctx.guard = fn; } }, on(k, fn) { events.set(k, fn); } };
  class RemoteService { constructor(ctx, key) { ctx[key] = this; } }
  await apply(ctx, {}, { TypertRemoteService: RemoteService });
  const a = f.agent('a');
  const created = await ctx.stickies.request(a, { action: 'create', text: 'user note' });
  const id = created.state.notes[0].id;
  const result = await commands[0].handler({ agent: a, rawInput: JSON.stringify({ action: 'queue', items: [{ id, mode: 'answer' }] }) });
  assert.equal(result.kind, 'success'); assert.equal(JSON.parse(result.text).ok, true);
  assert.equal(result.text.includes('user note'), false); assert.equal(result.text.includes('notes'), false);
  const denied = await ctx.stickies.request(a, { action: 'queue', items: [{ id, mode: 'answer' }] }); assert.equal(denied.error.code, 'USER_ONLY');
  assert.equal(commands[0].recordInput, false); assert.equal(tools.length, 1); assert.ok(events.has('session/event'));
  const invalid = await commands[0].handler({ agent: a, rawInput: 'invalid' }); assert.equal(invalid.kind, 'error');
  await Promise.all(cleanup.map(fn => fn()));
});
