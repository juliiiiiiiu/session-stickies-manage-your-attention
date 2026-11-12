import { randomUUID } from 'node:crypto';
import { COLORS, STYLES, PUBLIC_ACTIONS, clone, fail, initialState, operate, validateStored } from './model.js';

export const inject = ['storage', 'agents', 'commands', 'tools', 'typert'];
const PACKAGE = 'session-stickies-manage-your-attention';
const jsonCodec = (name, parse = value => value) => ({ mode: 'strict', typeSymbol: `${PACKAGE}#${name}`, create: () => ({ parse }), jsonSchema: {} });
export const remoteDescriptor = {
  id: `${PACKAGE}#stickies/request`, service: 'stickies', namespace: 'stickies', method: 'request',
  invocation: { kind: 'direct' }, scope: { context: 'agent', wire: 'agentId' },
  parameters: [
    // Canonical lookup identity from dsh-commands/remote. Gateway compares this
    // symbol with the agent provider's wireTypeSymbol, not merely its JSON shape.
    { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: {
      mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', jsonSchema: { type: 'string' },
      create: () => ({ parse(value) { if (typeof value !== 'string') throw new Error('Session ID must be a string.'); return value; } })
    } },
    { name: 'request', wire: 'request', source: 'json', codec: jsonCodec('Request', value => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request object is required.'); return value; }) }
  ], cancellation: { parameter: 'signal' }, result: jsonCodec('Reply')
};

/** Agent lookup and scope delegate authenticated session access to the standard Gateway. */
export function registerRemote(ctx, host, TypertRemoteService) {
  class StickiesRemote extends TypertRemoteService {
    constructor(context) { super(context, 'stickies'); }
    request(agent, request, signal) { return host.request(agent, request, false, signal); }
  }
  new StickiesRemote(ctx);
  ctx.typert.register({ package: PACKAGE, face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: [remoteDescriptor] });
}
const errorValue = error => ({ code: error?.code || 'STICKIES_ERROR', message: String(error?.message || error) });
// Exact names verified with Host Tool.listTools. Unknown/new tools fail closed.
const ANSWER_READ_TOOLS = new Set(['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'skill', 'cordis_inspect_list', 'cordis_inspect_query']);

/** One serialized owner per session. No filesystem/profile writes and no composer access. */
export class StickiesHost {
  constructor(unit, agents, records = {}) {
    this.unit = unit; this.agents = agents; this.states = new Map(); this.chains = new Map(); this.faults = new Map(); this.answerTurns = new Map(); this.closed = false;
    for (const [id, value] of Object.entries(records)) {
      const state = validateStored(value);
      // Never replay uncertain execution or transfer an old authorization across reload.
      if (['armed', 'running'].includes(state.queue.status) || state.queue.items.some(i => ['running', 'dispatching'].includes(i.status))) {
        state.queue.status = 'paused'; state.queue.error = 'Host restarted; prior execution may have completed. Review and authorize a new queue.';
        for (const item of state.queue.items) if (['running', 'dispatching'].includes(item.status)) { item.status = 'uncertain'; item.error = state.queue.error; }
      }
      this.states.set(id, state);
    }
  }
  serial(id, fn) {
    const work = (this.chains.get(id) || Promise.resolve()).catch(() => {}).then(fn);
    this.chains.set(id, work);
    work.finally(() => { if (this.chains.get(id) === work) this.chains.delete(id); }).catch(() => {});
    return work;
  }
  state(id) { return this.states.get(id) || initialState(); }
  async save(id, state) {
    if (this.closed) fail('CLOSED', 'Stickies is unloading.');
    try { await this.unit.putRecord('sessions', id, state); this.states.set(id, state); }
    catch (error) { this.faults.set(id, errorValue(error)); throw error; }
  }
  async request(agent, request, user = false, signal) {
    if (!agent?.id) return { ok: false, error: { code: 'NO_SESSION', message: 'An exact session is required.' } };
    return this.serial(agent.id, async () => {
      try {
        signal?.throwIfAborted();
        if (this.closed) fail('CLOSED', 'Stickies is unloading.');
        if (this.faults.has(agent.id)) {
          if (request?.action === 'list') return { ok: true, state: clone(this.state(agent.id)), storageError: this.faults.get(agent.id) };
          // An explicit retry reloads the durable record. Never replay ambiguous dispatch.
          const data = await this.unit.loadAll();
          const value = data.tables.sessions?.[agent.id];
          const recovered = value ? validateStored(value) : initialState();
          recovered.queue.status = 'paused'; recovered.queue.error = 'Recovered after a storage error; review before authorizing new work.';
          for (const item of recovered.queue.items) if (['running', 'dispatching'].includes(item.status)) { item.status = 'uncertain'; item.error = recovered.queue.error; }
          recovered.revision++;
          await this.save(agent.id, recovered); this.faults.delete(agent.id);
        }
        const next = operate(this.state(agent.id), request, { user });
        if (request.action !== 'list') await this.save(agent.id, next);
        if (request.action === 'queue' || request.action === 'liveCreate') {
          if (signal?.aborted) {
            const paused = clone(this.state(agent.id)); paused.queue.status = 'paused'; paused.queue.error = 'Authorization request was canceled.'; paused.revision++;
            await this.save(agent.id, paused); fail('ABORTED', paused.queue.error);
          }
          await this.pump(agent, signal);
        }
        return { ok: true, state: clone(this.state(agent.id)) };
      } catch (error) { return { ok: false, error: errorValue(error) }; }
    });
  }
  async pump(agent, signal) {
    const id = agent.id;
    if (this.closed || this.faults.has(id) || this.agents.get(id) !== agent) return;
    const state = clone(this.state(id)), q = state.queue;
    if (!['armed', 'running'].includes(q.status) || q.items.some(i => ['running', 'dispatching'].includes(i.status))) return;
    // Wait for a committed turn boundary, not an idle interval or assistant stream end.
    if (this.agents.turnBoundaryOf(agent.session).openTurnStartSeq !== null) return;
    const item = q.items.find(i => i.status === 'pending');
    if (!item) {
      const status = q.liveCardId !== undefined ? 'armed' : 'completed';
      if (q.status !== status) { q.status = status; state.revision++; await this.save(id, state); }
      return;
    }
    item.messageId = randomUUID(); item.status = 'dispatching'; q.status = 'running'; state.revision++;
    // Persist dispatch intent BEFORE followup. A crash in either gap is uncertain, never auto-retried.
    await this.save(id, state);
    if (this.closed || this.agents.get(id) !== agent) return;
    const instruction = item.mode === 'answer'
      ? 'Answer this queued note in this session. Explain only; do not execute commands or change files for this item.'
      : 'Carry out this queued note in this session using the normal tool permissions and approval requirements. Report the outcome; do not bypass safeguards.';
    try {
      signal?.throwIfAborted();
      agent.followup({ id: item.messageId, role: 'user', source: { kind: 'stickies' }, content: [{ type: 'text', text: `[Stickies ${item.mode}; item ${item.id}]\n${instruction}\n\n${item.text}` }] });
      const sent = clone(this.state(id)); sent.queue.items.find(i => i.id === item.id).status = 'running'; sent.revision++;
      await this.save(id, sent);
    } catch (error) {
      const failed = clone(this.state(id)), entry = failed.queue.items.find(i => i.id === item.id);
      entry.status = 'uncertain'; entry.error = String(error.message || error); failed.queue.status = 'paused'; failed.queue.error = entry.error; failed.revision++;
      // Save may itself fail; faults remain visible and block further dispatch.
      await this.save(id, failed);
    }
  }
  attach(agent) {
    // A durable inbox can outlive the plugin process. Remove uncertain sends before
    // agent/created releases restored input; disarming our own record is not enough.
    for (const item of this.state(agent.id).queue.items) {
      if (item.messageId && ['uncertain', 'canceled', 'failed'].includes(item.status)) agent.inbox.remove(item.messageId);
    }
  }
  guard(exec) {
    const turn = this.answerTurns.get(exec.agent);
    if (turn === undefined) return;
    const boundary = this.agents.turnBoundaryOf(exec.agent.session);
    if (boundary.openTurnStartSeq === null || boundary.lastTurn !== turn) return;
    if (ANSWER_READ_TOOLS.has(exec.name)) return;
    if (exec.name === 'stickies_notes' && exec.arguments?.action === 'list') return;
    return 'This Stickies answer item is read-only. Writing, shell execution, delegation, and unverified tools are disabled for this turn.';
  }
  observe(agent, kind, payload) {
    if (!agent || this.closed) return Promise.resolve();
    // Admission protection is synchronous: never await storage before constraining tool dispatch.
    if (kind === 'claimed') {
      const item = this.state(agent.id).queue.items.find(i => i.messageId === payload.message.id && ['running', 'dispatching'].includes(i.status));
      if (item?.mode === 'answer') this.answerTurns.set(agent, payload.turn);
    }
    if (kind === 'disposed' || (kind === 'turn/end' && this.answerTurns.get(agent) === payload.turn)) this.answerTurns.delete(agent);
    return this.serial(agent.id, async () => {
      if (this.closed || this.faults.has(agent.id)) return;
      const state = clone(this.state(agent.id)), q = state.queue;
      if (!q.items.length) return;
      const item = q.items.find(i => ['running', 'dispatching'].includes(i.status));
      let changed = false, pump = false;
      if (kind === 'claimed' && item?.messageId === payload.message.id) { item.turn = payload.turn; changed = true; }
      if (kind === 'discarded' && item?.messageId === payload.message.id) {
        item.status = 'canceled'; item.error = 'Queued input was discarded.'; q.status = 'paused'; q.error = item.error; changed = true;
      }
      if (kind === 'assistant/message' && item?.turn === payload.turn) {
        const text = payload.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        if (text) {
          const result = item.result + (item.result ? '\n\n' : '') + text;
          item.result = result.slice(-32000); item.resultTruncated = Boolean(item.resultTruncated || result.length > 32000); changed = true;
        }
      }
      if (kind === 'turn/end') {
        if (Number.isInteger(q.lastTurnEnd) && payload.turn <= q.lastTurnEnd) return;
        q.lastTurnEnd = payload.turn; changed = true;
        if (payload.reason?.kind !== 'completed' && ['armed', 'running'].includes(q.status)) {
          q.status = 'paused'; q.error = `Turn ended: ${payload.reason?.kind || 'unknown'}. Review before authorizing again.`; changed = true;
          if (item?.turn === payload.turn) { item.status = 'failed'; item.error = q.error; }
          else if (item?.messageId) { agent.inbox.remove(item.messageId); item.status = 'canceled'; item.error = q.error; }
        } else if (item?.turn === payload.turn) {
          item.status = payload.reason?.kind === 'completed' ? 'completed' : 'failed';
          item.completedAt = Date.now(); changed = true; pump = q.status !== 'paused';
        } else if (!item) pump = ['armed', 'running'].includes(q.status);
      }
      if (kind === 'disposed' || kind === 'error') {
        if (['armed', 'running'].includes(q.status)) { q.status = 'paused'; q.error = kind === 'disposed' ? 'Session agent was disposed.' : String(payload.error?.message || payload.error || 'Agent error.'); changed = true; }
        if (item && kind === 'disposed') { item.status = 'uncertain'; item.error = q.error || 'Agent disposed before settlement.'; changed = true; }
        else if (item && item.turn === undefined) { agent.inbox.remove(item.messageId); item.status = 'canceled'; item.error = q.error; changed = true; }
      }
      if (item && ['completed', 'failed', 'canceled'].includes(item.status)) {
        const note = state.notes.find(n => n.id === item.noteId);
        if (note) {
          const stale = note.text !== item.text;
          note.lastResult = { mode: item.mode, text: item.result, status: item.status, error: item.error, completedAt: item.completedAt || Date.now(), stale, truncated: Boolean(item.resultTruncated) };
          if (item.status === 'completed' && !stale) { note.checked = true; note.archivedAt = item.completedAt; note.updatedAt = item.completedAt; }
        }
      }
      if (changed) { state.revision++; await this.save(agent.id, state); }
      if (pump) await this.pump(agent);
    }).catch(error => { this.faults.set(agent.id, errorValue(error)); });
  }
  async close() {
    this.closed = true;
    for (const agent of this.answerTurns.keys()) agent.cancel({ kind: 'hook', reason: 'Stickies unloaded during a read-only answer.' }, { keepInbox: true });
    this.answerTurns.clear();
    for (const [id, state] of this.states) {
      const agent = this.agents.get(id);
      for (const item of state.queue.items) if (item.messageId && ['running', 'dispatching'].includes(item.status)) agent?.inbox.remove(item.messageId);
    }
    await Promise.allSettled([...this.chains.values()]);
    await this.unit.close();
  }
}

const marksSchema = {
  type: 'array', maxItems: 256,
  description: 'UTF-16 half-open text ranges; 0 <= start < end <= text.length. Later overlapping marks override earlier properties. Changing text without marks clears ranges.',
  items: { type: 'object', properties: {
    start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 1 },
    fontSize: { type: 'integer', minimum: 10, maximum: 32 }, color: { type: 'string', enum: COLORS }, bold: { type: 'boolean' }
  }, required: ['start', 'end'], additionalProperties: false }
};
export const toolDefinition = host => ({
  name: 'stickies_notes',
  description: 'Read and organize this session’s notes and named cards. Create or rename cards, or permanently delete a card and all its notes; create, edit, check, archive, restore, permanently delete, or reorder notes; pause processing or cancel a pending queue item. Returns cards, notes, and queue status. Starting automatic work requires the user’s Stickies control.',
  parameters: { type: 'object', properties: {
    action: { type: 'string', enum: PUBLIC_ACTIONS },
    id: { type: 'string', description: 'Note ID for update/archive/restore/delete; queue item ID for cancelItem; card ID for renameCard/deleteCard or a new UUID for idempotent createCard.' },
    title: { type: 'string', description: 'Card title: trimmed, 1–200 characters. createCard defaults to Stickies.' },
    cardId: { type: 'string', description: 'Existing card for create or reorder. Create uses the first card, creating default if empty; omitted reorder spans all cards.' },
    text: { type: 'string', description: 'New note text; at most 16000 characters.' },
    style: { type: 'string', enum: STYLES }, color: { type: 'string', enum: COLORS },
    fontSize: { type: 'integer', description: '10–32; defaults to 12.' }, checked: { type: 'boolean' }, marks: marksSchema,
    patch: { type: 'object', properties: { text: { type: 'string' }, style: { type: 'string', enum: STYLES }, color: { type: 'string', enum: COLORS }, fontSize: { type: 'integer' }, checked: { type: 'boolean' }, marks: marksSchema }, additionalProperties: false },
    ids: { type: 'array', items: { type: 'string' }, description: 'For reorder, every active note ID in the selected card (or all cards if cardId is omitted), in the desired order.' }
  }, required: ['action'], additionalProperties: false },
  output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
  execute: (args, exec) => host.request(exec.agent, args, false, exec.signal)
});

export async function apply(ctx, config = {}, protocol) {
  const { TypertRemoteService } = protocol || await import('@deepseek-ai/dsh-typert-protocol');
  const names = ctx.storage.backend.names();
  const backendName = config.storageBackend || (names.length === 1 ? names[0] : null);
  if (!backendName) throw new Error('Stickies requires config.storageBackend when more than one storage backend is mounted.');
  const backend = ctx.storage.backend.get(backendName);
  if (!backend.kv) throw new Error(`Storage backend ${backendName} has no KV facility.`);
  const unit = await backend.kv.open({ name: 'dsh_stickies', version: 1, tables: ['sessions'], hasGlobal: false, layout: 'per-record' });
  let host;
  try { const data = await unit.loadAll(); host = new StickiesHost(unit, ctx.agents, data.tables.sessions || {}); }
  catch (error) { await unit.close(); throw error; }
  ctx.effect(() => () => host.close());
  registerRemote(ctx, host, TypertRemoteService);
  ctx.commands.register({ name: 'stickies', description: '授权当前会话便签队列 / Authorize this session’s note queue', input: { hint: '{"action":"queue","items":[{"id":"note UUID","mode":"answer"}]}' }, recordInput: false,
    handler: async ({ agent, rawInput, signal }) => {
      let result;
      try {
        const request = JSON.parse(rawInput);
        if (request.action === 'liveCapabilities') return { kind: 'success', text: JSON.stringify({ ok: true, liveQueue: 1 }) };
        if (!['queue', 'liveCreate', 'liveReorder'].includes(request.action)) fail('COMMAND_ACTION', 'This command accepts queue, liveCreate, or liveReorder only.');
        result = await host.request(agent, request, true, signal);
      }
      catch (error) { result = { ok: false, error: errorValue(error) }; }
      // Command lifecycle is durable; never copy the private notes snapshot into its result.
      const receipt = result.ok ? { ok: true, status: result.state.queue.status, revision: result.state.revision } : result;
      return { kind: result.ok ? 'success' : 'error', text: JSON.stringify(receipt) };
    }
  });
  ctx.tools.register(toolDefinition(host));
  ctx.tools.guard(exec => host.guard(exec));
  ctx.on('agent/created', ({ agent }) => { host.attach(agent); });
  for (const agent of ctx.agents.list()) host.attach(agent);
  ctx.on('agent/inbox/claimed', p => { void host.observe(p.agent, 'claimed', p); });
  ctx.on('agent/inbox/discarded', p => { void host.observe(p.agent, 'discarded', p); });
  ctx.on('agent/error', p => { void host.observe(p.agent, 'error', p); });
  ctx.on('agent/disposed', p => { void host.observe(p.agent, 'disposed', p); });
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end' && event.type !== 'assistant/message') return;
    const agent = ctx.agents.get(session.id);
    if (agent?.session === session) void host.observe(agent, event.type, event.data);
  });
}
