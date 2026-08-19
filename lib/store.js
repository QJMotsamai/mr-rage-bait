import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EMPTY = { users: [], sessions: [], events: [], usage: [] };

export function createStore(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let data = EMPTY;
  if (fs.existsSync(filePath)) {
    try {
      data = { ...EMPTY, ...JSON.parse(fs.readFileSync(filePath, 'utf8')) };
    } catch {
      data = EMPTY;
    }
  }
  let writing = Promise.resolve();

  function persist() {
    writing = writing.then(() => {
      const tmp = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, filePath);
    }).catch((error) => {
      console.error('Failed to persist store', error);
    });
    return writing;
  }

  function id(prefix) {
    return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
  }

  return {
    id,
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
