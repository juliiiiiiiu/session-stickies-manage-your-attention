const UNIT_NAME = 'dsh_stickies_star_invite';
const DATE_LIMIT = 2;

function localDate(timestamp) {
  const date = new Date(timestamp);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, i) => String(part).padStart(i === 0 ? 4 : 2, '0')).join('-');
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** One owner per Host profile, shared by all session requests. */
export class StarInvite {
  #kv;
  #unit;
  #state;
  #chain = Promise.resolve();
  #failed = false;
  #closed = false;

  constructor(kv) { this.#kv = kv; }

  #serial(work) {
    if (this.#closed) return Promise.resolve(false);
    this.#chain = this.#chain.then(async () => {
      if (this.#failed) return false;
      try { return await work(); }
      catch {
        // A failed write may already have committed. Do not use the old state
        // to grant another claim; only a fresh open may inspect durable state.
        this.#failed = true;
        return false;
      }
    });
    return this.#chain;
  }

  async #load() {
    if (this.#state) return this.#state;
    this.#unit = await this.#kv.open({ name: UNIT_NAME, version: 1, tables: [], hasGlobal: true, layout: 'single' });
    const { global: stored } = await this.#unit.loadAll();
    if (stored === null) return this.#state = { dates: [], shown: false };
    const { dates, shown } = stored;
    if (!Array.isArray(dates) || dates.length > DATE_LIMIT || new Set(dates).size !== dates.length || !dates.every(validDate) ||
        typeof shown !== 'boolean' || (shown && dates.length !== DATE_LIMIT) || Object.keys(stored).length !== 2) {
      throw new Error('Invalid Stickies invitation state.');
    }
    return this.#state = { dates: [...dates], shown };
  }

  async #save(next) {
    await this.#unit.setGlobal(next);
    this.#state = next;
  }

  recordNoteSave() {
    // Sample at the successful note save, not later when the invite queue runs.
    const timestamp = Date.now();
    return this.#serial(async () => {
      const state = await this.#load();
      if (state.dates.length >= DATE_LIMIT) return false;
      const date = localDate(timestamp);
      if (!validDate(date) || state.dates.includes(date)) return false;
      await this.#save({ dates: [...state.dates, date], shown: false });
      return true;
    });
  }

  claim(signal) {
    return this.#serial(async () => {
      if (signal?.aborted) return false;
      const state = await this.#load();
      if (signal?.aborted || state.shown || state.dates.length < DATE_LIMIT) return false;
      await this.#save({ ...state, shown: true });
      return !signal?.aborted;
    });
  }

  async close() {
    this.#closed = true;
    await this.#chain;
    try { await this.#unit?.close(); } catch { /* Optional invite storage must not block note teardown. */ }
  }
}
