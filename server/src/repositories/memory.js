import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const now = () => new Date().toISOString();
const clone = (row) => (row ? JSON.parse(JSON.stringify(row)) : row);

export function createMemoryRepositories({ persistPath = null } = {}) {
  const tables = {
    users: [],
    documents: [],
    analyses: [],
    issues: [],
    refresh_tokens: [],
    payments: [],
    token_transactions: [],
  };

  const loadFromDisk = () => {
    if (!persistPath || !existsSync(persistPath)) return;
    try {
      const raw = JSON.parse(readFileSync(persistPath, 'utf8'));
      for (const key of Object.keys(tables)) {
        if (Array.isArray(raw[key])) tables[key] = raw[key];
      }
    } catch (err) {
      console.warn(`[storage] gagal membaca berkas penyimpanan ${persistPath}: ${err.message}`);
    }
  };

  const saveToDisk = () => {
    if (!persistPath) return;
    try {
      mkdirSync(path.dirname(persistPath), { recursive: true });
      writeFileSync(persistPath, JSON.stringify(tables, null, 2), 'utf8');
    } catch (err) {
      console.warn(`[storage] gagal menyimpan berkas penyimpanan ${persistPath}: ${err.message}`);
    }
  };

  loadFromDisk();

  const insert = (table, row) => {
    const record = { id: randomUUID(), created_at: now(), ...row };
    tables[table].push(record);
    saveToDisk();
    return clone(record);
  };

  // Kunci per pengguna di memori agar pemotongan token serentak (concurrent)
  // dieksekusi berurutan dan tidak pernah membuat saldo negatif.
  const userLocks = new Map();
  const withUserLock = async (userId, fn) => {
    const prev = userLocks.get(userId) || Promise.resolve();
    const next = prev.then(fn, fn);
    userLocks.set(userId, next.catch(() => {}));
    return next;
  };

  const users = {
    async create({ name, email, password_hash, token_balance = 0 }) {
      return insert('users', {
        name,
        email,
        password_hash,
        token_balance: Math.max(0, Math.trunc(Number(token_balance) || 0)),
        is_premium: false,
        premium_until: null,
        reset_token_hash: null,
        reset_token_expires_at: null,
        updated_at: now(),
      });
    },
    async findById(id) {
      const row = tables.users.find((u) => u.id === id);
      if (!row) return null;
      if (typeof row.token_balance !== 'number') row.token_balance = 0;
      return clone(row);
    },
    async findByEmail(email) {
      const needle = String(email || '').trim().toLowerCase();
      const row = tables.users.find((u) => u.email.toLowerCase() === needle);
      if (!row) return null;
      if (typeof row.token_balance !== 'number') row.token_balance = 0;
      return clone(row);
    },
    async findByResetTokenHash(hash) {
      return clone(tables.users.find((u) => u.reset_token_hash && u.reset_token_hash === hash) || null);
    },
    async update(id, patch) {
      const row = tables.users.find((u) => u.id === id);
      if (!row) return null;
      const safePatch = { ...patch };
      delete safePatch.id;
      delete safePatch.token_balance;
      Object.assign(row, safePatch, { updated_at: now() });
      saveToDisk();
      return clone(row);
    },
    async extendPremium(id, days) {
      const row = tables.users.find((u) => u.id === id);
      if (!row) return null;
      const base = row.premium_until && new Date(row.premium_until) > new Date() ? new Date(row.premium_until) : new Date();
      base.setDate(base.getDate() + Number(days));
      row.is_premium = true;
      row.premium_until = base.toISOString();
      row.updated_at = now();
      saveToDisk();
      return clone(row);
    },
  };

  const tokenTransactions = {
    async findByIdempotencyKey(user_id, idempotency_key) {
      if (!user_id || !idempotency_key) return null;
      const key = String(idempotency_key).trim();
      if (!key) return null;
      return clone(tables.token_transactions.find(
        (t) => t.user_id === user_id && t.idempotency_key === key,
      ) || null);
    },

    async credit({
      user_id,
      amount,
      type = 'purchase',
      description = 'Penambahan token',
      reference_type = null,
      reference_id = null,
      idempotency_key = null,
      meta = {},
    }) {
      const delta = Math.trunc(Number(amount));
      if (!Number.isFinite(delta) || delta <= 0) {
        throw new Error('Jumlah penambahan token harus bilangan bulat positif.');
      }
      const idemKey = idempotency_key ? String(idempotency_key).trim() : null;
      return withUserLock(user_id, async () => {
        const user = tables.users.find((u) => u.id === user_id);
        if (!user) return { ok: false, error: 'USER_NOT_FOUND' };
        if (typeof user.token_balance !== 'number') user.token_balance = 0;

        if (idemKey) {
          const existing = tables.token_transactions.find(
            (t) => t.user_id === user_id && t.idempotency_key === idemKey,
          );
          if (existing) {
            return { ok: true, duplicate: true, transaction: clone(existing), user: clone(user) };
          }
        }

        user.token_balance += delta;
        user.updated_at = now();

        const tx = insert('token_transactions', {
          user_id,
          type,
          amount: delta,
          balance_after: user.token_balance,
          description: String(description || 'Penambahan token'),
          reference_type: reference_type || null,
          reference_id: reference_id || null,
          idempotency_key: idemKey,
          meta: meta || {},
        });

        return { ok: true, duplicate: false, transaction: tx, user: clone(user) };
      });
    },

    async deduct({
      user_id,
      amount,
      description = 'Penggunaan token untuk analisis',
      reference_type = 'analysis',
      reference_id = null,
      idempotency_key = null,
      meta = {},
    }) {
      const cost = Math.trunc(Number(amount));
      if (!Number.isFinite(cost) || cost <= 0) {
        throw new Error('Jumlah pemotongan token harus bilangan bulat positif.');
      }
      const idemKey = idempotency_key ? String(idempotency_key).trim() : null;
      return withUserLock(user_id, async () => {
        const user = tables.users.find((u) => u.id === user_id);
        if (!user) return { ok: false, balance: 0, error: 'USER_NOT_FOUND' };
        if (typeof user.token_balance !== 'number') user.token_balance = 0;

        if (idemKey) {
          const existing = tables.token_transactions.find(
            (t) => t.user_id === user_id && t.idempotency_key === idemKey,
          );
          if (existing) {
            return {
              ok: true,
              duplicate: true,
              transaction: clone(existing),
              user: clone(user),
              balance: user.token_balance,
            };
          }
        }

        if (user.token_balance < cost) {
          return {
            ok: false,
            duplicate: false,
            balance: user.token_balance,
            required: cost,
            error: 'INSUFFICIENT_TOKENS',
          };
        }

        user.token_balance -= cost;
        user.updated_at = now();

        const tx = insert('token_transactions', {
          user_id,
          type: 'usage',
          amount: -cost,
          balance_after: user.token_balance,
          description: String(description || 'Penggunaan token untuk analisis'),
          reference_type: reference_type || 'analysis',
          reference_id: reference_id || null,
          idempotency_key: idemKey,
          meta: meta || {},
        });

        return {
          ok: true,
          duplicate: false,
          transaction: tx,
          user: clone(user),
          balance: user.token_balance,
        };
      });
    },

    async refund({
      user_id,
      amount,
      description = 'Pengembalian token karena analisis gagal',
      reference_type = 'analysis_refund',
      reference_id = null,
      idempotency_key = null,
      meta = {},
    }) {
      return this.credit({
        user_id,
        amount,
        type: 'refund',
        description,
        reference_type,
        reference_id,
        idempotency_key,
        meta,
      });
    },

    async updateReference(id, { reference_id, description, meta } = {}) {
      const row = tables.token_transactions.find((t) => t.id === id);
      if (!row) return null;
      if (reference_id !== undefined) row.reference_id = reference_id;
      if (description !== undefined) row.description = description;
      if (meta !== undefined) row.meta = { ...(row.meta || {}), ...meta };
      saveToDisk();
      return clone(row);
    },

    async listByUser(user_id, { limit = 50, type = '' } = {}) {
      const filterType = String(type || '').trim();
      return tables.token_transactions
        .filter((t) => t.user_id === user_id && (!filterType || t.type === filterType))
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .slice(0, Math.max(1, Math.min(Number(limit) || 50, 200)))
        .map(clone);
    },

    async summaryByUser(user_id) {
      const user = tables.users.find((u) => u.id === user_id);
      const txs = tables.token_transactions.filter((t) => t.user_id === user_id);
      let totalPurchased = 0;
      let grossUsed = 0;
      let totalRefunded = 0;
      for (const t of txs) {
        if (t.type === 'purchase' && t.amount > 0) totalPurchased += t.amount;
        else if (t.type === 'usage' && t.amount < 0) grossUsed += Math.abs(t.amount);
        else if (t.type === 'refund' && t.amount > 0) totalRefunded += t.amount;
      }
      return {
        balance: user ? Math.max(0, Number(user.token_balance) || 0) : 0,
        total_purchased: totalPurchased,
        total_used: Math.max(0, grossUsed - totalRefunded),
        gross_used: grossUsed,
        total_refunded: totalRefunded,
      };
    },
  };

  const refreshTokens = {
    async create({ user_id, token_hash, expires_at, user_agent }) {
      return insert('refresh_tokens', { user_id, token_hash, expires_at, user_agent: user_agent || null, revoked_at: null });
    },
    async findByHash(token_hash) {
      return clone(tables.refresh_tokens.find((t) => t.token_hash === token_hash) || null);
    },
    async revokeByHash(token_hash) {
      const row = tables.refresh_tokens.find((t) => t.token_hash === token_hash && !t.revoked_at);
      if (row) {
        row.revoked_at = now();
        saveToDisk();
      }
      return Boolean(row);
    },
    async revokeById(id) {
      const row = tables.refresh_tokens.find((t) => t.id === id);
      if (row) {
        row.revoked_at = now();
        saveToDisk();
      }
    },
    async revokeAllForUser(user_id) {
      let changed = false;
      for (const t of tables.refresh_tokens) {
        if (t.user_id === user_id && !t.revoked_at) {
          t.revoked_at = now();
          changed = true;
        }
      }
      if (changed) saveToDisk();
    },
  };

  const documents = {
    async create(row) {
      return insert('documents', {
        revised_text: null,
        status: 'analyzed',
        token_cost: Math.max(0, Math.trunc(Number(row.token_cost) || 0)),
        expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
        last_analyzed_at: now(),
        updated_at: now(),
        ...row,
      });
    },
    async findById(id) {
      return clone(tables.documents.find((d) => d.id === id) || null);
    },
    async listByUser(user_id, { q = '', status = '', limit = 100 } = {}) {
      const needle = q.trim().toLowerCase();
      const statusFilter = String(status || '').trim().toLowerCase();
      return tables.documents
        .filter((d) => d.user_id === user_id
          && (!needle || d.title.toLowerCase().includes(needle))
          && (!statusFilter || String(d.status || '').toLowerCase() === statusFilter))
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
        .slice(0, limit)
        .map(clone);
    },
    async update(id, patch) {
      const row = tables.documents.find((d) => d.id === id);
      if (!row) return null;
      Object.assign(row, patch, { updated_at: now() });
      saveToDisk();
      return clone(row);
    },
    async deleteMany(user_id, ids) {
      const owned = tables.documents.filter((d) => d.user_id === user_id && ids.includes(d.id));
      tables.documents = tables.documents.filter((d) => !owned.includes(d));
      for (const d of owned) {
        const analyses = tables.analyses.filter((a) => a.document_id === d.id);
        tables.issues = tables.issues.filter((i) => !analyses.some((a) => a.id === i.analysis_id));
        tables.analyses = tables.analyses.filter((a) => a.document_id !== d.id);
      }
      if (owned.length) saveToDisk();
      return owned.map((d) => d.id);
    },
    async deleteExpired(at = new Date().toISOString()) {
      const expired = tables.documents.filter((d) => d.expires_at && d.expires_at < at);
      for (const d of expired) {
        const owned = tables.analyses.filter((a) => a.document_id === d.id);
        tables.issues = tables.issues.filter((i) => !owned.some((a) => a.id === i.analysis_id));
        tables.analyses = tables.analyses.filter((a) => a.document_id !== d.id);
      }
      tables.documents = tables.documents.filter((d) => !expired.includes(d));
      if (expired.length) saveToDisk();
      return expired.length;
    },
  };

  const analyses = {
    async create(row) {
      return insert('analyses', {
        token_cost: Math.max(0, Math.trunc(Number(row.token_cost) || 0)),
        idempotency_key: row.idempotency_key || null,
        ...row,
      });
    },
    async findLatestByDocument(document_id) {
      const rows = tables.analyses.filter((a) => a.document_id === document_id);
      return clone(rows[rows.length - 1] || null);
    },
  };

  const issues = {
    async createMany(rows) {
      const created = rows.map((r) => ({ id: randomUUID(), created_at: now(), ...r }));
      tables.issues.push(...created);
      if (created.length) saveToDisk();
      return created.map(clone);
    },
    async listByAnalysis(analysis_id) {
      return tables.issues
        .filter((i) => i.analysis_id === analysis_id)
        .sort((a, b) => a.start_pos - b.start_pos)
        .map(clone);
    },
    async countPendingByDocument(document_id) {
      const ids = tables.analyses.filter((a) => a.document_id === document_id).map((a) => a.id);
      return tables.issues.filter((i) => ids.includes(i.analysis_id) && i.decision === 'active').length;
    },
    async updateDecision(id, { decision, suggestion }) {
      const row = tables.issues.find((i) => i.id === id);
      if (!row) return null;
      row.decision = decision;
      if (suggestion !== undefined) row.suggestion = suggestion;
      row.updated_at = now();
      saveToDisk();
      return clone(row);
    },
    async resetDecisions(analysis_id) {
      let changed = false;
      for (const i of tables.issues) {
        if (i.analysis_id === analysis_id) {
          i.decision = 'active';
          changed = true;
        }
      }
      if (changed) saveToDisk();
    },
  };

  const payments = {
    async create(row) {
      return insert('payments', {
        package_id: row.package_id || null,
        package_label: row.package_label || null,
        token_amount: Math.max(0, Math.trunc(Number(row.token_amount) || 0)),
        premium_days: row.premium_days || 0,
        updated_at: now(),
        ...row,
      });
    },
    async findById(id) {
      return clone(tables.payments.find((p) => p.id === id) || null);
    },
    async findByOrderId(order_id) {
      return clone(tables.payments.find((p) => p.order_id === order_id) || null);
    },
    async listByUser(user_id, { limit = 30 } = {}) {
      return tables.payments
        .filter((p) => p.user_id === user_id)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .slice(0, limit)
        .map(clone);
    },
    async update(id, patch) {
      const row = tables.payments.find((p) => p.id === id);
      if (!row) return null;
      Object.assign(row, patch, { updated_at: now() });
      saveToDisk();
      return clone(row);
    },
    async markPaidIfPending(id, patch) {
      const row = tables.payments.find((p) => p.id === id);
      if (!row || row.status === 'paid') return null;
      Object.assign(row, patch, { status: 'paid', paid_at: now(), updated_at: now() });
      saveToDisk();
      return clone(row);
    },
  };

  return {
    users,
    tokenTransactions,
    refreshTokens,
    documents,
    analyses,
    issues,
    payments,
    driver: persistPath ? 'file' : 'memori',
    persistPath,
  };
}
