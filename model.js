import { randomUUID } from 'node:crypto';

export const STYLES = ['text', 'checkbox', 'bullet', 'numbered'];
export const COLORS = ['default', 'accent', 'success', 'warn', 'error'];
export const PUBLIC_ACTIONS = ['list', 'create', 'update', 'archive', 'restore', 'delete', 'reorder', 'pause', 'cancelItem', 'createCard', 'renameCard', 'deleteCard'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const defaultCard = () => ({ id: 'default', title: 'Stickies', createdAt: 0, updatedAt: 0 });
function cardTitle(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) fail('INVALID_TITLE', 'Card title must contain 1–200 characters after trimming.');
  return value.trim();
}
function normalizeCards(state) {
  if (state.cards === undefined) state.cards = [defaultCard()];
  if (!Array.isArray(state.cards) || state.cards.length > 50 || new Set(state.cards.map(c => c?.id)).size !== state.cards.length) fail('INVALID_STORAGE', 'Invalid stored card catalog.');
  for (const card of state.cards) {
    if (!card || typeof card !== 'object' || (card.id !== 'default' && (typeof card.id !== 'string' || !UUID_RE.test(card.id))) || !Number.isFinite(card.createdAt) || card.createdAt < 0 || !Number.isFinite(card.updatedAt) || card.updatedAt < 0) fail('INVALID_STORAGE', 'Invalid stored card.');
    card.title = cardTitle(card.title);
  }
  for (const note of state.notes) {
    if (note.cardId === undefined) note.cardId = 'default';
    if (!state.cards.some(c => c.id === note.cardId)) fail('INVALID_CARD', 'Note references a missing card.');
  }
  return state;
}
export function fail(code, message) { throw Object.assign(new Error(message), { code }); }
export function initialState() { return { version: 1, revision: 0, cards: [defaultCard()], notes: [], queue: { status: 'idle', items: [], error: null } }; }
export const clone = value => structuredClone(value);
function validateMarks(marks, text) {
  if (!Array.isArray(marks) || marks.length > 256) fail('INVALID_MARKS', 'Marks must be an array of at most 256 ranges.');
  return marks.map(mark => {
    if (!mark || typeof mark !== 'object' || Array.isArray(mark) || Object.keys(mark).some(key => !['start', 'end', 'fontSize', 'color', 'bold'].includes(key))) fail('INVALID_MARKS', 'A mark may contain only start, end, fontSize, color, and bold.');
    if (!Number.isInteger(mark.start) || !Number.isInteger(mark.end) || mark.start < 0 || mark.start >= mark.end || mark.end > text.length) fail('INVALID_MARKS', 'Mark bounds must satisfy 0 <= start < end <= text.length in UTF-16 code units.');
    if (Object.hasOwn(mark, 'fontSize') && (!Number.isInteger(mark.fontSize) || mark.fontSize < 10 || mark.fontSize > 32)) fail('INVALID_MARKS', 'Mark fontSize must be an integer from 10 to 32.');
    if (Object.hasOwn(mark, 'color') && !COLORS.includes(mark.color)) fail('INVALID_MARKS', 'Unknown mark semantic color.');
    if (Object.hasOwn(mark, 'bold') && typeof mark.bold !== 'boolean') fail('INVALID_MARKS', 'Mark bold must be boolean.');
    return { ...mark };
  });
}
function fields(input, base = {}) {
  const out = { ...base };
  for (const key of Object.keys(input)) {
    const value = input[key];
    if (key === 'text') { if (typeof value !== 'string' || value.length > 16000) fail('INVALID_TEXT', 'Text must be a string of at most 16000 characters.'); }
    else if (key === 'style') { if (!STYLES.includes(value)) fail('INVALID_STYLE', 'Unknown note style.'); }
    else if (key === 'color') { if (!COLORS.includes(value)) fail('INVALID_COLOR', 'Unknown semantic color.'); }
    else if (key === 'fontSize') { if (!Number.isInteger(value) || value < 10 || value > 32) fail('INVALID_SIZE', 'Font size must be an integer from 10 to 32.'); }
    else if (key === 'checked') { if (typeof value !== 'boolean') fail('INVALID_CHECKED', 'Checked must be boolean.'); }
    else if (key === 'marks') { /* Validate after text, independent of property order. */ }
    else fail('INVALID_FIELD', `Unknown note field: ${key}`);
    out[key] = value;
  }
  if (Object.hasOwn(input, 'marks')) out.marks = validateMarks(input.marks, out.text);
  else if (Object.hasOwn(input, 'text') && input.text !== base.text) out.marks = [];
  else out.marks = base.marks === undefined ? [] : clone(base.marks);
  return out;
}
export function operate(state, request, { user = false, now = Date.now(), uuid = randomUUID } = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail('INVALID_REQUEST', 'Expected an operation object.');
  const { action } = request;
  if (action === 'list') return normalizeCards(clone(state));
  const userActions = ['queue', 'liveCreate', 'liveReorder'];
  if (!PUBLIC_ACTIONS.includes(action) && !userActions.includes(action)) fail('INVALID_ACTION', 'Unknown operation.');
  if (userActions.includes(action) && !user) fail('USER_ONLY', 'Only a user session command can authorize or change live queue work.');
  if (action === 'liveCreate') {
    if (!request.note || typeof request.note !== 'object' || Array.isArray(request.note) || Object.hasOwn(request.note, 'action')) fail('INVALID_REQUEST', 'Expected a note creation object.');
    const existed = request.note.id && state.notes.some(n => n.id === request.note.id);
    const next = operate(state, { ...request.note, action: 'create' }, { user, now, uuid });
    if (existed) return next;
    const n = next.notes.at(-1), q = next.queue;
    if (['armed', 'running'].includes(q.status) && q.liveCardId === n.cardId && n.text.trim()) {
      if (q.items.length >= 100) fail('LIMIT', 'The queue already has 100 items.');
      q.items.push({ id: uuid(), noteId: n.id, text: n.text, mode: q.liveMode, status: 'pending', result: '', error: null });
    }
    return next;
  }
  if (action === 'liveReorder') {
    if (typeof request.cardId !== 'string') fail('INVALID_CARD', 'A card ID is required for live reorder.');
    const next = operate(state, { action: 'reorder', cardId: request.cardId, ids: request.ids }, { user, now, uuid });
    const q = next.queue;
    if (['armed', 'running'].includes(q.status) && q.liveCardId === request.cardId) {
      const positions = new Map(request.ids.map((id, index) => [id, index]));
      const pending = q.items.filter(item => item.status === 'pending' && positions.has(item.noteId));
      pending.sort((a, b) => positions.get(a.noteId) - positions.get(b.noteId));
      let index = 0;
      q.items = q.items.map(item => item.status === 'pending' && positions.has(item.noteId) ? pending[index++] : item);
    }
    return next;
  }
  const next = normalizeCards(clone(state));
  const note = () => { const n = next.notes.find(n => n.id === request.id); if (!n) fail('NOT_FOUND', 'Note does not exist in this session.'); return n; };
  const requireCard = id => { const card = next.cards.find(c => c.id === id); if (!card) fail('INVALID_CARD', 'Card does not exist in this session.'); return card; };
  if (action === 'createCard') {
    if (typeof request.id !== 'string' || !UUID_RE.test(request.id)) fail('INVALID_ID', 'New card ID must be a UUID.');
    if (next.cards.some(c => c.id === request.id)) return next;
    if (next.cards.length >= 50) fail('LIMIT', 'This session already has 50 cards.');
    next.cards.push({ id: request.id, title: request.title === undefined ? 'Stickies' : cardTitle(request.title), createdAt: now, updatedAt: now });
  } else if (action === 'renameCard') {
    Object.assign(requireCard(request.id), { title: cardTitle(request.title), updatedAt: now });
  } else if (action === 'deleteCard') {
    if (typeof request.id !== 'string' || !request.id.trim()) fail('INVALID_ID', 'Card ID must be a non-empty string.');
    if (!next.cards.some(c => c.id === request.id)) return next;
    const ids = new Set(next.notes.filter(n => n.cardId === request.id).map(n => n.id));
    const affected = next.queue.items.filter(item => ids.has(item.noteId));
    if (affected.some(item => ['running', 'dispatching'].includes(item.status))) fail('CARD_IN_FLIGHT', 'This card has a dispatched queue item. Stop the session and wait for it to settle before deleting the card.');
    const pending = affected.filter(item => item.status === 'pending');
    if (pending.length) {
      for (const item of pending) { item.status = 'canceled'; item.error = 'Card deleted before dispatch.'; }
      next.queue.status = 'paused'; next.queue.error = 'A card with pending work was deleted. Review remaining work before authorizing again.';
    }
    if (next.queue.liveCardId === request.id) {
      next.queue.status = 'paused'; next.queue.error = 'The live queue card was deleted. Authorize a new queue to continue.';
      delete next.queue.liveCardId; delete next.queue.liveMode;
    }
    next.cards = next.cards.filter(c => c.id !== request.id);
    next.notes = next.notes.filter(n => !ids.has(n.id));
  } else if (action === 'create') {
    if (request.id !== undefined && (typeof request.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.id))) fail('INVALID_ID', 'Client note ID must be a UUID.');
    if (request.id && next.notes.some(n => n.id === request.id)) return next;
    if (next.notes.length >= 500) fail('LIMIT', 'This session already has 500 notes.');
    if (request.cardId === undefined && next.cards.length === 0) next.cards.push(defaultCard());
    const cardId = request.cardId === undefined ? next.cards[0].id : request.cardId;
    requireCard(cardId);
    const input = Object.fromEntries(Object.entries(request).filter(([k]) => k !== 'action' && k !== 'id' && k !== 'cardId'));
    next.notes.push({ id: request.id || uuid(), cardId, ...fields(input, { text: '', style: 'text', fontSize: 12, color: 'default', checked: false }), createdAt: now, updatedAt: now, archivedAt: null });
  } else if (action === 'update') {
    if (!request.patch || typeof request.patch !== 'object' || Array.isArray(request.patch)) fail('INVALID_PATCH', 'Expected note patch.');
    const current = note();
    Object.assign(current, fields(request.patch, current), { updatedAt: now });
  } else if (action === 'archive' || action === 'restore') {
    Object.assign(note(), { archivedAt: action === 'archive' ? now : null, updatedAt: now });
    if (action === 'archive' && next.queue.items.some(i => i.noteId === request.id && i.status === 'pending')) { next.queue.status = 'paused'; next.queue.error = 'A queued note was archived. Authorize a new queue to continue.'; }
  } else if (action === 'delete') {
    note(); next.notes = next.notes.filter(n => n.id !== request.id);
    // A destructive change cannot silently leave an authorized future task running.
    if (next.queue.items.some(i => i.noteId === request.id && i.status === 'pending')) { next.queue.status = 'paused'; next.queue.error = 'A queued note was deleted. Authorize a new queue to continue.'; }
  } else if (action === 'reorder') {
    const scoped = request.cardId !== undefined;
    if (scoped) requireCard(request.cardId);
    const selected = n => n.archivedAt === null && (!scoped || n.cardId === request.cardId);
    const active = next.notes.filter(selected);
    if (!Array.isArray(request.ids) || request.ids.length !== active.length || new Set(request.ids).size !== active.length || request.ids.some(id => !active.some(n => n.id === id))) fail('INVALID_ORDER', 'Provide every active note ID in the selected scope exactly once.');
    const ordered = request.ids.map(id => active.find(n => n.id === id));
    if (scoped) { let index = 0; next.notes = next.notes.map(n => selected(n) ? ordered[index++] : n); }
    else next.notes = [...ordered, ...next.notes.filter(n => n.archivedAt !== null)];
  } else if (action === 'cancelItem') {
    const item = next.queue.items.find(i => i.id === request.id);
    if (!item) fail('NOT_FOUND', 'Queue item does not exist in this session.');
    if (['running', 'dispatching'].includes(item.status)) fail('ITEM_IN_FLIGHT', 'This item has already been dispatched. Use the session stop control to interrupt it.');
    if (item.status !== 'pending') fail('ITEM_SETTLED', 'Only a pending item can be canceled.');
    item.status = 'canceled'; item.error = 'Canceled before dispatch.';
    if (!next.queue.items.some(i => ['pending', 'running', 'dispatching'].includes(i.status))) {
      next.queue.status = ['armed', 'running'].includes(next.queue.status) && next.queue.liveCardId !== undefined ? 'armed' : 'completed';
    }
  } else if (action === 'queue') {
    if (['armed', 'running'].includes(next.queue.status)) fail('BUSY_QUEUE', 'Pause the current queue before authorizing a replacement. Replacement discards remaining pending items.');
    if (next.queue.items.some(i => i.status === 'running' || i.status === 'dispatching')) fail('BUSY', 'The previous queue still has an in-flight item.');
    if (request.replacePending === false && next.queue.items.some(i => i.status === 'pending')) fail('BUSY_QUEUE', 'Pending items remain in this session. Cancel them explicitly before starting another queue.');
    const items = request.items ?? request.ids?.map(id => ({ id, mode: request.mode }));
    const live = request.liveCardId !== undefined || request.liveMode !== undefined;
    if (live) {
      if (typeof request.liveCardId !== 'string') fail('INVALID_CARD', 'Choose an existing live queue card.');
      requireCard(request.liveCardId);
      if (!['answer', 'execute'].includes(request.liveMode)) fail('INVALID_MODE', 'Choose answer or execute for live notes.');
    }
    if (!Array.isArray(items) || items.length < (live ? 0 : 1) || items.length > 100 || new Set(items.map(i => i?.id)).size !== items.length) fail('INVALID_QUEUE', 'Provide distinct notes (up to 100).');
    next.queue = { status: 'armed', error: null, authorizedAt: now, ...(live ? { liveCardId: request.liveCardId, liveMode: request.liveMode } : {}), items: items.map(item => {
      const n = next.notes.find(n => n.id === item.id && n.archivedAt === null);
      if (!n || !n.text.trim() || (live && n.cardId !== request.liveCardId)) fail('INVALID_NOTE', 'Queued notes must be active, non-empty, and in the selected live card.');
      if (!['answer', 'execute'].includes(item.mode)) fail('INVALID_MODE', 'Choose answer or execute for each item.');
      return { id: uuid(), noteId: n.id, text: n.text, mode: item.mode, status: 'pending', result: '', error: null };
    }) };
  } else if (action === 'pause') {
    next.queue.status = 'paused'; next.queue.error = 'Paused by request; an already running item is not canceled.';
  }
  next.revision++;
  return next;
}

export function validateStored(state) {
  if (!state || state.version !== 1 || !Number.isSafeInteger(state.revision) || !Array.isArray(state.notes) || !state.queue || !Array.isArray(state.queue.items)) fail('INVALID_STORAGE', 'Invalid Stickies session record.');
  if (!['idle', 'armed', 'running', 'paused', 'completed'].includes(state.queue.status) || state.notes.length > 500 || state.queue.items.length > 100 || new Set(state.notes.map(n => n.id)).size !== state.notes.length) fail('INVALID_STORAGE', 'Invalid stored queue or note count.');
  for (const item of state.queue.items) {
    if (typeof item.id !== 'string' || typeof item.noteId !== 'string' || typeof item.text !== 'string' || !['answer', 'execute'].includes(item.mode) || !['pending', 'dispatching', 'running', 'completed', 'failed', 'canceled', 'uncertain'].includes(item.status)) fail('INVALID_STORAGE', 'Invalid stored queue item.');
  }
  const normalized = clone(state);
  if ((normalized.queue.liveCardId !== undefined || normalized.queue.liveMode !== undefined) &&
      (typeof normalized.queue.liveCardId !== 'string' || !['answer', 'execute'].includes(normalized.queue.liveMode))) fail('INVALID_STORAGE', 'Invalid live queue authorization.');
  for (const n of normalized.notes) {
    if (typeof n.id !== 'string' || !Number.isFinite(n.createdAt) || !Number.isFinite(n.updatedAt) || !(n.archivedAt === null || Number.isFinite(n.archivedAt))) fail('INVALID_STORAGE', 'Invalid stored note.');
    fields({ text: n.text, style: n.style, color: n.color, fontSize: n.fontSize, checked: n.checked });
    n.marks = validateMarks(n.marks === undefined ? [] : n.marks, n.text);
  }
  normalizeCards(normalized);
  if (normalized.queue.liveCardId !== undefined && !normalized.cards.some(c => c.id === normalized.queue.liveCardId)) fail('INVALID_STORAGE', 'Live queue references a missing card.');
  return normalized;
}
