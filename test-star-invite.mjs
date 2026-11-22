import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from './host.js';

const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const DAY_1 = '2026-01-02T09:59:00Z'; // Jan 1, 23:59 on the Host.
const DAY_2 = '2026-01-02T10:01:00Z'; // Jan 2, 00:01, same UTC day.
const DAY_3 = '2026-01-03T10:01:00Z';
const HIDE = { ok: true, show: false };
const SHOW = { ok: true, show: true };

function clock(t, initial = DAY_1) {
  const old = process.env.TZ;
  process.env.TZ = 'Pacific/Honolulu';
  t.after(() => { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; });
  let now = initial;
  t.mock.method(Date, 'now', () => Date.parse(now));
  return value => { now = value; };
}

function profile() {
  const p = { notes: {}, invite: null, openUnits: new Set(), inviteWrites: 0, controls: {} };
  p.kv = { async open(descriptor) {
    const { name } = descriptor;
    assert.ok(!p.openUnits.has(name));
    const close = async () => { assert.ok(p.openUnits.delete(name)); };
    if (name === 'dsh_stickies') {
      p.openUnits.add(name);
      return {
        loadAll: async () => ({ tables: { sessions: structuredClone(p.notes) }, global: null }),
        async putRecord(table, id, state) {
          assert.equal(table, 'sessions'); await p.controls.noteWrite?.();
          p.notes[id] = structuredClone(state);
        }, close
      };
    }
    assert.deepEqual(descriptor, { name: 'dsh_stickies_star_invite', version: 1, tables: [], hasGlobal: true, layout: 'single' });
    await p.controls.inviteOpen?.();
    p.openUnits.add(name);
    return {
      async loadAll() { await p.controls.inviteRead?.(); return { tables: {}, global: structuredClone(p.invite) }; },
      async setGlobal(state) {
        p.inviteWrites++;
        await p.controls.inviteWrite?.(state);
        p.invite = structuredClone(state);
        await p.controls.afterInviteWrite?.(state);
      },
      async close() { await close(); await p.controls.inviteClose?.(); }
    };
  } };
  return p;
}

async function start(p, port = 62307) {
  const sessions = new Map(), tools = [], commands = [], cleanup = [];
  const ctx = {
    gui: { url: `http://127.0.0.1:${port}` },
    storage: { backend: { names: () => ['test'], get: () => ({ kv: p.kv }) } },
    agents: { get: id => sessions.get(id), list: () => [...sessions.values()], turnBoundaryOf: () => ({ openTurnStartSeq: null }) },
    tools: { register: d => tools.push(d), guard() {} }, commands: { register: d => commands.push(d) },
    typert: { register() {} }, effect: fn => cleanup.push(fn()), on() {}
  };
  class Remote { constructor(ctx, service) { ctx[service] = this; } }
  await apply(ctx, {}, { TypertRemoteService: Remote });
  const agent = id => {
    if (!sessions.has(id)) sessions.set(id, { id, session: { id }, inbox: { remove() {} } });
    return sessions.get(id);
  };
  const remote = (id, request) => ctx.stickies.request(agent(id), request);
  return {
    remote, claim: id => remote(id, { action: 'claimStarInvite' }),
    create: (id, note = {}) => remote(id, { action: 'create', text: 'note', ...note }),
    command: (id, request) => commands[0].handler({ agent: agent(id), rawInput: JSON.stringify(request) }),
    tool: (id, request) => tools[0].execute(request, { agent: agent(id) }),
    toolActions: tools[0].parameters.properties.action.enum,
    close: async () => { for (const close of cleanup) await close(); }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const assertSaved = async pending => assert.equal((await pending).ok, true);

test('invite counts two distinct Host-local dates from ordinary and live saves only', async t => {
  const setDate = clock(t), p = profile(), f = await start(p);
  t.after(f.close);
  assert.deepEqual(await f.claim('first'), HIDE);
  await assertSaved(f.create('first', { id: A, text: '' }));
  await assertSaved(f.create('second')); // Another save on the same date.
  assert.deepEqual(await f.claim('second'), HIDE);
  assert.deepEqual(p.invite, { dates: ['2026-01-01'], shown: false });
  assert.equal(p.inviteWrites, 1);

  setDate(DAY_2);
  await assertSaved(f.create('first', { id: A })); // Idempotent ordinary retry.
  assert.equal((await f.command('first', { action: 'liveCreate', note: { id: A, text: 'retry via live' } })).kind, 'success');
  await assertSaved(f.tool('second', { action: 'create', text: 'tool note' }));
  await assertSaved(f.remote('first', { action: 'update', id: A, patch: { text: 'edit' } }));
  assert.equal((await f.create('first', { cardId: 'missing' })).ok, false);
  assert.equal((await f.remote('second', { action: 'liveCreate', note: { text: 'no command' } })).error.code, 'USER_ONLY');
  assert.deepEqual(await f.claim('first'), HIDE);
  assert.deepEqual(p.invite, { dates: ['2026-01-01'], shown: false });

  assert.equal((await f.command('second', { action: 'liveCreate', note: { id: B, text: 'human' } })).kind, 'success');
  const claim = { action: 'claimStarInvite' };
  assert.ok(!f.toolActions.includes(claim.action));
  assert.equal((await f.tool('second', claim)).error.code, 'INVALID_ACTION');
  assert.equal((await f.command('second', claim)).kind, 'error');
  assert.deepEqual(await f.claim('first'), SHOW);
  assert.deepEqual(await f.claim('second'), HIDE);
  setDate(DAY_3);
  await assertSaved(f.create('first'));
  assert.deepEqual(await f.claim('first'), HIDE);
  assert.deepEqual(p.invite, { dates: ['2026-01-01', '2026-01-02'], shown: true });
  assert.equal(p.inviteWrites, 3);
});

test('opening with existing notes does not backfill invitation dates', async t => {
  const setDate = clock(t), p = profile(), previous = await start(p);
  await assertSaved(previous.tool('existing', { action: 'create', id: A, text: 'older' }));
  setDate(DAY_2);
  await assertSaved(previous.tool('existing', { action: 'create', id: B, text: 'newer' }));
  await previous.close();
  assert.equal(p.invite, null);

  const installed = await start(p);
  t.after(installed.close);
  const listed = await installed.remote('existing', { action: 'list' });
  assert.equal(listed.state.notes.length, 2);
  assert.deepEqual(await installed.claim('existing'), HIDE);
  assert.equal(p.inviteWrites, 0);
});

test('profile writes are serialized across sessions and claim commits before showing, including after reopen', async t => {
  const setDate = clock(t), p = profile(), first = await start(p);
  const entered = deferred(), release = deferred();
  p.controls.inviteWrite = async ({ dates }) => { if (dates.length === 1) { entered.resolve(); await release.promise; } };
  await assertSaved(first.create('first')); // Returns despite the blocked invitation write.
  await entered.promise;
  setDate(DAY_2);
  await assertSaved(first.create('second'));
  release.resolve();
  await first.close(); // Drain both dates without anyone claiming yet.
  assert.deepEqual(p.invite, { dates: ['2026-01-01', '2026-01-02'], shown: false });
  assert.equal(p.openUnits.size, 0);

  const reopened = await start(p, 62500), claimEntered = deferred(), claimRelease = deferred();
  p.controls.inviteWrite = async ({ shown }) => { if (shown) { claimEntered.resolve(); await claimRelease.promise; } };
  let replied = false;
  const claims = Promise.all([
    reopened.claim('first').then(result => { replied = true; return result; }),
    reopened.claim('second'), reopened.claim('third')
  ]);
  await claimEntered.promise;
  assert.equal(replied, false);
  assert.equal(p.invite.shown, false);
  await assertSaved(reopened.create('first')); // Notes do not wait on a blocked claim.
  claimRelease.resolve();
  assert.deepEqual(await claims, [SHOW, HIDE, HIDE]);
  assert.equal(p.invite.shown, true);
  assert.equal(p.inviteWrites, 3);
  await reopened.close();
  const restarted = await start(p, 62600);
  assert.deepEqual(await restarted.claim('different'), HIDE);
  await restarted.close();
});

test('a failed note write does not count; an ambiguous claim commit stays closed through retries and reopen', async t => {
  const setDate = clock(t), p = profile(), f = await start(p);
  await assertSaved(f.create('first'));
  setDate(DAY_2);
  p.controls.noteWrite = () => { throw new Error('notes write failed'); };
  assert.equal((await f.create('first')).ok, false);
  assert.deepEqual(await f.claim('second'), HIDE);
  assert.deepEqual(p.invite, { dates: ['2026-01-01'], shown: false });
  delete p.controls.noteWrite;
  await assertSaved(f.create('first'));
  p.controls.afterInviteWrite = ({ shown }) => { if (shown) throw new Error('write outcome unknown'); };
  assert.deepEqual(await f.claim('second'), HIDE);
  assert.deepEqual(await f.claim('first'), HIDE);
  await assertSaved(f.create('second'));
  assert.equal(p.invite.shown, true);
  assert.equal(p.inviteWrites, 3);
  await f.close();
  delete p.controls.afterInviteWrite;
  const reopened = await start(p);
  assert.deepEqual(await reopened.claim('first'), HIDE);
  assert.equal(p.inviteWrites, 3);
  await reopened.close();
});

for (const operation of ['inviteOpen', 'inviteRead', 'inviteWrite', 'inviteClose', 'malformed state']) {
  test(`${operation} failure stays isolated from normal note storage`, async t => {
    const setDate = clock(t), p = profile();
    if (operation === 'malformed state') p.invite = { dates: ['2026-01-01', '2026-02-30'], shown: false };
    else p.controls[operation] = () => { throw new Error('invite storage unavailable'); };
    const f = await start(p);
    await assertSaved(f.create('first'));
    setDate(DAY_2);
    await assertSaved(f.create('second'));
    if (operation !== 'inviteClose') assert.deepEqual(await f.claim('first'), HIDE);
    assert.equal(p.notes.first.notes.length, 1);
    assert.equal(p.notes.second.notes.length, 1);
    await f.close();
    assert.equal(p.openUnits.size, 0);
  });
}
