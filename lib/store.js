import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EMPTY = { users: [], sessions: [], events: [], usage: [] };

/* ------------------------------------------------------------------
   Storage backends.

   Postgres  -> used when DATABASE_URL is set. Survives every restart,
                redeploy and cold start. This is the one you want.
   JSON file -> the old behaviour. Kept as a fallback so the app still
                boots with no database (and for local development).

   Both keep the whole dataset in memory and write the full document
   back on change, so every store method below stays synchronous and
   nothing else in the app had to change.
------------------------------------------------------------------- */

function readSeedFile(filePath) {
  if (!filePath) return { ...EMPTY };
  try {
    if (!fs.existsSync(filePath)) return { ...EMPTY };
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { ...EMPTY, ...parsed };
  } catch {
    return { ...EMPTY };
  }
}

function fileBackend(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return {
    label: 'json-file',
    durable: false,
    initial: readSeedFile(filePath),
    async write(json) {
      const tmp = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, json);
      fs.renameSync(tmp, filePath);
    },
    async close() {}
  };
}

function wantsSsl(url) {
  const lowered = String(url).toLowerCase();
  if (lowered.includes('sslmode=disable')) return false;
  if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(lowered)) return false;
  return true;
}

async function postgresBackend(databaseUrl, seedFile) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: wantsSsl(databaseUrl) ? { rejectUnauthorized: false } : false,
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 20_000
  });

  pool.on('error', (error) => console.error('[store] idle postgres client error:', error.message));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id         smallint PRIMARY KEY,
      doc        jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const existing = await pool.query('SELECT doc FROM app_state WHERE id = 1');
  let initial;
  if (existing.rowCount) {
    initial = { ...EMPTY, ...existing.rows[0].doc };
  } else {
    // First boot against an empty database: carry over anything that was
    // sitting in the old JSON file so nothing is silently dropped.
    initial = readSeedFile(seedFile);
    await pool.query(
      'INSERT INTO app_state (id, doc) VALUES (1, $1) ON CONFLICT (id) DO NOTHING',
      [JSON.stringify(initial)]
    );
  }

  return {
    label: 'postgres',
    durable: true,
    initial,
    async write(json) {
      await pool.query(
        `INSERT INTO app_state (id, doc, updated_at) VALUES (1, $1, now())
         ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`,
        [json]
      );
    },
    async close() {
      await pool.end();
    }
  };
}

/* ------------------------------------------------------------------ */

export async function createStore(options = {}) {
  const config = typeof options === 'string' ? { file: options } : options;
  const filePath = config.file;
  const databaseUrl = config.databaseUrl || '';

  let backend;
  if (databaseUrl) {
    try {
      backend = await postgresBackend(databaseUrl, filePath);
      console.log('[store] postgres connected — data survives restarts');
    } catch (error) {
      console.error('[store] POSTGRES FAILED:', error.message);
      console.error('[store] falling back to a temporary file. Data will be lost on restart.');
      backend = fileBackend(filePath);
    }
  } else {
    backend = fileBackend(filePath);
    console.warn('[store] no DATABASE_URL — using a temporary file. Accounts reset on every restart.');
  }

  let data = backend.initial;
  const writeDelay = backend.label === 'postgres' ? 350 : 0;

  let dirty = false;
  let timer = null;
  let chain = Promise.resolve();

  function flush() {
    if (!dirty) return chain;
    dirty = false;
    const json = JSON.stringify(data);
    chain = chain.catch(() => {}).then(() => backend.write(json)).catch((error) => {
      console.error('[store] failed to save:', error.message);
      dirty = true;                 // try again on the next change
    });
    return chain;
  }

  function persist() {
    dirty = true;
    if (timer) return chain;
    timer = setTimeout(() => { timer = null; flush(); }, writeDelay);
    if (typeof timer.unref === 'function') timer.unref();
    return chain;
  }

  function id(prefix) {
    return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
  }

  return {
    id,
    label: backend.label,
    durable: backend.durable,

    /** Write anything outstanding right now. Called on shutdown. */
    async flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      dirty = true;
      await flush();
      return chain;
    },
    async close() {
      await this.flush();
      await backend.close();
    },

    get users() { return data.users; },
    get sessions() { return data.sessions; },
    get events() { return data.events; },
    get usage() { return data.usage; },

    findUser(predicate) {
      return data.users.find(predicate) || null;
    },

    userById(userId) {
      return data.users.find((user) => user.id === userId) || null;
    },

    userByEmail(email) {
      const needle = String(email || '').trim().toLowerCase();
      return data.users.find((user) => user.email === needle) || null;
    },

    saveUser(user) {
      const index = data.users.findIndex((row) => row.id === user.id);
      if (index === -1) data.users.push(user);
      else data.users[index] = user;
      persist();
      return user;
    },

    saveSession(session) {
      data.sessions = data.sessions.filter((row) => row.expiresAt > Date.now());
      data.sessions.push(session);
      persist();
      return session;
    },

    sessionByHash(hash) {
      const session = data.sessions.find((row) => row.hash === hash && row.expiresAt > Date.now());
      return session || null;
    },

    deleteSessionsForUser(userId) {
      data.sessions = data.sessions.filter((row) => row.userId !== userId);
      persist();
    },

    deleteSessionByHash(hash) {
      data.sessions = data.sessions.filter((row) => row.hash !== hash);
      persist();
    },

    addEvent(event) {
      const row = { id: id('evt'), createdAt: new Date().toISOString(), ...event };
      data.events.push(row);
      if (data.events.length > 5000) data.events.splice(0, data.events.length - 5000);
      persist();
      return row;
    },

    usageKey(ownerKey, day = new Date().toISOString().slice(0, 10)) {
      return `${ownerKey}:${day}`;
    },

    getUsage(ownerKey) {
      const key = this.usageKey(ownerKey);
      const row = data.usage.find((item) => item.key === key);
      return row ? row.count : 0;
    },

    bumpUsage(ownerKey) {
      const key = this.usageKey(ownerKey);
      let row = data.usage.find((item) => item.key === key);
      if (!row) {
        row = { key, count: 0 };
        data.usage.push(row);
      }
      row.count += 1;
      if (data.usage.length > 8000) {
        const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
        data.usage = data.usage.filter((item) => item.key.slice(-10) >= cutoff);
      }
      persist();
      return row.count;
    },

    refundUsage(ownerKey) {
      const key = this.usageKey(ownerKey);
      const row = data.usage.find((item) => item.key === key);
      if (row && row.count > 0) {
        row.count -= 1;
        persist();
      }
    },

    people() {
      return data.users
        .map((user) => {
          const events = data.events.filter((event) => event.userId === user.id);
          const types = new Set(events.map((event) => event.type));
          let intent = 'browsing';
          if (user.plan === 'pro') intent = 'paying';
          else if (types.has('checkout_started')) intent = 'willing';
          else if (types.has('upgrade_viewed')) intent = 'interested';
          const lastCheckout = [...events].reverse().find((event) => event.type.startsWith('checkout') || event.type === 'upgrade_viewed');
          return {
            id: user.id,
            email: user.email,
            name: user.name,
            plan: user.plan,
            country: user.country || lastCheckout?.country || null,
            currency: user.currency || lastCheckout?.currency || null,
            amount: lastCheckout?.amount || null,
            provider: lastCheckout?.provider || null,
            intent,
            createdAt: user.createdAt,
            lastSeenAt: user.lastSeenAt,
            messageCountTotal: user.messageCountTotal || 0,
            events: events.slice(-8)
          };
        })
        .sort((a, b) => {
          const rank = { paying: 0, willing: 1, interested: 2, browsing: 3 };
          return (rank[a.intent] - rank[b.intent]) || String(b.lastSeenAt).localeCompare(String(a.lastSeenAt));
        });
    },

    snapshot() {
      return {
        users: data.users.length,
        paying: data.users.filter((user) => user.plan === 'pro').length,
        willing: this.people().filter((person) => person.intent === 'willing').length,
        interested: this.people().filter((person) => person.intent === 'interested').length,
        events: data.events.slice(-200).reverse()
      };
    }
  };
}
