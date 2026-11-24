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
    download_transactions: [],
    r2_monthly_usage: [],
    r2_quota_reservations: [],
    object_storage_monthly_usage: [],
    object_storage_quota_reservations: [],
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
    async create({
      name,
      email,
      password_hash = null,
      token_balance = 0,
      email_verified = true,
      google_id = null,
      auth_provider = 'local',
      otp_code_hash = null,
      otp_purpose = null,
      otp_expires_at = null,
      otp_attempts = 0,
      otp_sent_at = null,
      token_version = 0,
    }) {
      return insert('users', {
        name,
        email,
        password_hash,
        token_balance: Math.max(0, Math.trunc(Number(token_balance) || 0)),
        email_verified: Boolean(email_verified),
        google_id,
        auth_provider,
        reset_token_hash: null,
        reset_token_expires_at: null,
        otp_code_hash,
        otp_purpose,
        otp_expires_at,
        otp_attempts: Number(otp_attempts) || 0,
        otp_sent_at,
        token_version: Number(token_version) || 0,
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
    async findByGoogleId(googleId) {
      if (!googleId) return null;
      const row = tables.users.find((u) => u.google_id && u.google_id === String(googleId));
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
      const nowMs = Date.now();
      const reserved = tables.download_transactions
        .filter((d) => d.user_id === user_id
          && ['pending', 'reserved', 'file_prepared', 'save_confirmed'].includes(d.state)
          && new Date(d.expires_at).getTime() > nowMs)
        .reduce((acc, d) => acc + Math.max(0, Number(d.reserved_tokens) || 0), 0);
      const balance = user ? Math.max(0, Number(user.token_balance) || 0) : 0;
      return {
        balance,
        reserved_tokens: reserved,
        available_balance: Math.max(0, balance - reserved),
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
    async deleteExpired(at = new Date().toISOString()) {
      const cutoff = new Date(at).getTime();
      const revokedCutoff = cutoff - 7 * 24 * 3600 * 1000;
      const before = tables.refresh_tokens.length;
      tables.refresh_tokens = tables.refresh_tokens.filter((t) => {
        const exp = new Date(t.expires_at).getTime();
        if (Number.isFinite(exp) && exp < cutoff) return false;
        if (t.revoked_at) {
          const rev = new Date(t.revoked_at).getTime();
          if (Number.isFinite(rev) && rev < revokedCutoff) return false;
        }
        return true;
      });
      const removed = before - tables.refresh_tokens.length;
      if (removed > 0) saveToDisk();
      return removed;
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
      return expired.map((d) => d.id);
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
      const list = tables.analyses.filter((a) => a.document_id === document_id);
      const latest = list[list.length - 1];
      if (!latest) return 0;
      return tables.issues.filter((i) => i.analysis_id === latest.id && i.decision === 'active').length;
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
        last_webhook_at: null,
        replaced_by_order_id: null,
        replaces_order_id: row.replaces_order_id || null,
        reconciliation_flag: null,
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
    async deleteById(id, userId) {
      const idx = tables.payments.findIndex((p) => p.id === id && p.user_id === userId);
      if (idx < 0) return false;
      tables.payments.splice(idx, 1);
      saveToDisk();
      return true;
    },
  };

  const downloadTransactions = {
    async reserve({
      user_id,
      document_id,
      export_format,
      reserved_tokens,
      idempotency_key = null,
      ttl_seconds = 300,
    }) {
      const cost = Math.max(0, Math.trunc(Number(reserved_tokens) || 0));
      const idemKey = idempotency_key ? String(idempotency_key).trim().slice(0, 128) : null;
      const ttl = Math.max(30, Math.min(Number(ttl_seconds) || 300, 3600));
      return withUserLock(user_id, async () => {
        const user = tables.users.find((u) => u.id === user_id);
        if (!user) return { ok: false, error: 'USER_NOT_FOUND' };
        if (typeof user.token_balance !== 'number') user.token_balance = 0;

        const nowMs = Date.now();
        let expiredAny = false;
        for (const d of tables.download_transactions) {
          if (d.user_id === user_id && ['pending', 'reserved', 'file_prepared'].includes(d.state) && new Date(d.expires_at).getTime() <= nowMs) {
            d.state = 'expired';
            d.updated_at = now();
            expiredAny = true;
          }
        }
        if (expiredAny) saveToDisk();

        const activeReserved = () => tables.download_transactions
          .filter((d) => d.user_id === user_id && ['pending', 'reserved', 'file_prepared', 'save_confirmed'].includes(d.state) && new Date(d.expires_at).getTime() > Date.now())
          .reduce((acc, d) => acc + Math.max(0, Number(d.reserved_tokens) || 0), 0);

        if (idemKey) {
          const existing = tables.download_transactions.find((d) => d.user_id === user_id && d.idempotency_key === idemKey);
          if (existing) {
            const reserved = activeReserved();
            return {
              ok: true,
              duplicate: true,
              transaction: clone(existing),
              balance: user.token_balance,
              reserved_tokens: reserved,
              available_balance: Math.max(0, user.token_balance - reserved),
            };
          }
        }

        const currentReserved = activeReserved();
        const available = Math.max(0, user.token_balance - currentReserved);
        if (available < cost) {
          return {
            ok: false,
            error: 'INSUFFICIENT_TOKENS',
            balance: user.token_balance,
            reserved_tokens: currentReserved,
            available_balance: available,
            required: cost,
          };
        }

        const tx = insert('download_transactions', {
          user_id,
          document_id,
          export_format,
          reserved_tokens: cost,
          committed_tokens: 0,
          state: 'reserved',
          idempotency_key: idemKey,
          failure_reason: null,
          cancellation_reason: null,
          refund_status: 'none',
          token_transaction_id: null,
          expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
          confirmed_at: null,
          updated_at: now(),
        });
        const nextReserved = currentReserved + cost;
        return {
          ok: true,
          duplicate: false,
          transaction: tx,
          balance: user.token_balance,
          reserved_tokens: nextReserved,
          available_balance: Math.max(0, user.token_balance - nextReserved),
        };
      });
    },

    async findById(id) {
      return clone(tables.download_transactions.find((d) => d.id === id) || null);
    },

    async markPrepared(id, user_id) {
      const row = tables.download_transactions.find(
        (d) => d.id === id && d.user_id === user_id && ['reserved', 'file_prepared'].includes(d.state) && new Date(d.expires_at).getTime() > Date.now(),
      );
      if (!row) return null;
      row.state = 'file_prepared';
      row.updated_at = now();
      saveToDisk();
      return clone(row);
    },

    async markFailed(id, user_id, reason) {
      const row = tables.download_transactions.find(
        (d) => d.id === id && d.user_id === user_id && ['pending', 'reserved', 'file_prepared'].includes(d.state),
      );
      if (!row) return null;
      row.state = 'failed';
      row.failure_reason = String(reason || 'File generation failed').slice(0, 500);
      row.updated_at = now();
      saveToDisk();
      return clone(row);
    },

    async cancel(id, user_id, reason = 'user_cancelled') {
      return withUserLock(user_id, async () => {
        const row = tables.download_transactions.find((d) => d.id === id && d.user_id === user_id);
        if (!row) return { ok: false, error: 'NOT_FOUND' };
        if (row.state === 'committed') return { ok: false, error: 'ALREADY_COMMITTED', transaction: clone(row) };
        if (['cancelled', 'expired', 'failed'].includes(row.state)) {
          return { ok: true, duplicate: true, transaction: clone(row) };
        }
        row.state = 'cancelled';
        row.cancellation_reason = String(reason || 'user_cancelled').slice(0, 300);
        row.updated_at = now();
        saveToDisk();
        return { ok: true, duplicate: false, transaction: clone(row) };
      });
    },

    async commit({ id, user_id, description = 'Unduh dokumen', meta = {} }) {
      return withUserLock(user_id, async () => {
        const user = tables.users.find((u) => u.id === user_id);
        if (!user) return { ok: false, error: 'USER_NOT_FOUND' };
        const row = tables.download_transactions.find((d) => d.id === id && d.user_id === user_id);
        if (!row) return { ok: false, error: 'NOT_FOUND' };
        if (row.state === 'committed') {
          return { ok: true, duplicate: true, transaction: clone(row), balance: user.token_balance };
        }
        if (!['reserved', 'file_prepared', 'save_confirmed'].includes(row.state)) {
          return { ok: false, error: 'RESERVATION_NOT_COMMITTABLE', state: row.state, transaction: clone(row) };
        }
        if (new Date(row.expires_at).getTime() <= Date.now()) {
          row.state = 'expired';
          row.updated_at = now();
          saveToDisk();
          return { ok: false, error: 'RESERVATION_EXPIRED', state: 'expired' };
        }
        const cost = Math.max(0, Math.trunc(Number(row.reserved_tokens) || 0));
        if (user.token_balance < cost) {
          row.state = 'failed';
          row.failure_reason = 'INSUFFICIENT_TOKENS';
          row.updated_at = now();
          saveToDisk();
          return { ok: false, error: 'INSUFFICIENT_TOKENS', balance: user.token_balance };
        }

        let ledgerTx = null;
        if (cost > 0) {
          user.token_balance -= cost;
          user.updated_at = now();
          ledgerTx = insert('token_transactions', {
            user_id,
            type: 'usage',
            amount: -cost,
            balance_after: user.token_balance,
            description: String(description || 'Unduh dokumen'),
            reference_type: 'download',
            reference_id: row.document_id,
            idempotency_key: `download_commit:${row.id}`,
            meta: { ...meta, download_transaction_id: row.id, format: row.export_format },
          });
        }

        row.state = 'committed';
        row.committed_tokens = cost;
        row.token_transaction_id = ledgerTx?.id || null;
        row.confirmed_at = now();
        row.updated_at = now();
        saveToDisk();
        return {
          ok: true,
          duplicate: false,
          transaction: clone(row),
          token_transaction: ledgerTx,
          balance: user.token_balance,
        };
      });
    },

    async listByUser(user_id, { limit = 50 } = {}) {
      return tables.download_transactions
        .filter((d) => d.user_id === user_id)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .slice(0, Math.max(1, Math.min(Number(limit) || 50, 200)))
        .map(clone);
    },

    async releaseExpired(at = new Date().toISOString()) {
      const cutoff = new Date(at).getTime();
      let count = 0;
      for (const d of tables.download_transactions) {
        if (['pending', 'reserved', 'file_prepared'].includes(d.state) && new Date(d.expires_at).getTime() <= cutoff) {
          d.state = 'expired';
          d.updated_at = now();
          count += 1;
        }
      }
      if (count > 0) saveToDisk();
      return count;
    },
  };

  const fileBlobs = new Map();
  const documentFiles = {
    async save({ document_id, user_id, ext, original_name, size_bytes, sha256, content = null, storage_provider = 'postgres', storage_key = null }) {
      const isExternal = storage_provider === 'r2' || storage_provider === 'oci';
      if (!document_id || (!isExternal && (!Buffer.isBuffer(content) || content.length === 0))) return null;
      if (!fileBlobs.has(document_id)) {
        fileBlobs.set(document_id, {
          document_id,
          user_id: user_id || null,
          ext,
          original_name: String(original_name || `document.${ext}`).slice(0, 255),
          size_bytes: size_bytes || (Buffer.isBuffer(content) ? content.length : 0),
          sha256,
          storage_provider,
          storage_key,
          buffer: isExternal ? null : Buffer.from(content),
          created_at: now(),
        });
      }
      return { document_id, user_id, ext, original_name, size_bytes, sha256, storage_provider, storage_key };
    },
    async findByDocumentId(document_id, { user_id = null } = {}) {
      const entry = fileBlobs.get(document_id);
      if (!entry) return null;
      if (user_id && entry.user_id && entry.user_id !== user_id) return null;
      return { ...entry, buffer: entry.buffer ? Buffer.from(entry.buffer) : null };
    },
    async deleteByDocumentId(document_id) {
      return fileBlobs.delete(document_id);
    },
    async getStorageMetrics() {
      let managedBytes = 0;
      let objectCount = 0;
      for (const entry of fileBlobs.values()) {
        if ((entry.storage_provider || 'postgres') === 'postgres') {
          managedBytes += Number(entry.size_bytes || 0);
          objectCount += 1;
        }
      }
      return { managed_bytes: managedBytes, object_count: objectCount, total_db_bytes: managedBytes };
    },
  };

  const r2Usage = {
    _ensureMonth(month) {
      let row = tables.r2_monthly_usage.find((r) => r.month === month);
      if (!row) {
        row = {
          month,
          managed_bytes: 0,
          object_count: 0,
          class_a_ops: 0,
          class_b_ops: 0,
          reconciled_storage_bytes: null,
          reconciled_class_a_ops: null,
          reconciled_class_b_ops: null,
          reconciliation_status: 'unreconciled',
          last_reconciled_at: null,
          quota_halted: false,
          updated_at: now(),
        };
        tables.r2_monthly_usage.push(row);
      }
      return row;
    },
    _expireOld(month) {
      const nowMs = Date.now();
      let changed = false;
      for (const r of tables.r2_quota_reservations) {
        if (r.month === month && r.state === 'reserved' && new Date(r.expires_at).getTime() <= nowMs) {
          r.state = 'expired';
          r.updated_at = now();
          changed = true;
        }
      }
      if (changed) saveToDisk();
    },
    async reserve({ month, operation, op_class, bytes = 0, idempotency_key = null, ttl_seconds = 180, limits = {} }) {
      // Reload from disk if shared persistPath is used across two independent instances
      if (persistPath) loadFromDisk();
      const usage = this._ensureMonth(month);
      if (idempotency_key) {
        const dup = tables.r2_quota_reservations.find((r) => r.idempotency_key === idempotency_key);
        if (dup) return { ok: true, duplicate: true, reservation: clone(dup), usage: clone(usage) };
      }
      this._expireOld(month);
      if (usage.quota_halted && op_class !== 'free') {
        return { ok: false, code: 'R2_QUOTA_HALTED_BY_RECONCILIATION', usage: clone(usage) };
      }
      const active = tables.r2_quota_reservations.filter((r) => r.month === month && r.state === 'reserved');
      const activeBytes = active.reduce((s, r) => s + Number(r.reserved_bytes || 0), 0);
      const activeA = active.filter((r) => r.op_class === 'class_a').length;
      const activeB = active.filter((r) => r.op_class === 'class_b').length;

      const addBytes = Math.max(0, Math.trunc(Number(bytes) || 0));
      const maxBytes = Number(limits.maxManagedBytes || 8 * 1024 * 1024 * 1024);
      const maxA = Number(limits.maxClassAOps || 800_000);
      const maxB = Number(limits.maxClassBOps || 8_000_000);

      if (addBytes > 0 && Number(usage.managed_bytes) + activeBytes + addBytes > maxBytes) {
        return { ok: false, code: 'R2_STORAGE_QUOTA_LIMIT', usage: clone(usage) };
      }
      if (op_class === 'class_a' && Number(usage.class_a_ops) + activeA + 1 > maxA) {
        return { ok: false, code: 'R2_CLASS_A_QUOTA_LIMIT', usage: clone(usage) };
      }
      if (op_class === 'class_b' && Number(usage.class_b_ops) + activeB + 1 > maxB) {
        return { ok: false, code: 'R2_CLASS_B_QUOTA_LIMIT', usage: clone(usage) };
      }

      const resv = insert('r2_quota_reservations', {
        idempotency_key,
        month,
        operation,
        op_class,
        reserved_bytes: addBytes,
        state: 'reserved',
        expires_at: new Date(Date.now() + Math.max(1, Number(ttl_seconds) || 180) * 1000).toISOString(),
        updated_at: now(),
      });
      return { ok: true, duplicate: false, reservation: resv, usage: clone(usage) };
    },
    async commit(id, { actual_bytes = null } = {}) {
      if (persistPath) loadFromDisk();
      const r = tables.r2_quota_reservations.find((x) => x.id === id);
      if (!r || r.state !== 'reserved') return clone(r || null);
      const usage = this._ensureMonth(r.month);
      const addBytes = actual_bytes != null ? Math.max(0, Math.trunc(Number(actual_bytes) || 0)) : Number(r.reserved_bytes || 0);
      usage.managed_bytes += addBytes;
      if (addBytes > 0) usage.object_count += 1;
      if (r.op_class === 'class_a') usage.class_a_ops += 1;
      if (r.op_class === 'class_b') usage.class_b_ops += 1;
      usage.updated_at = now();
      r.state = 'committed';
      r.updated_at = now();
      saveToDisk();
      return clone(r);
    },
    async release(id, { billable_request_sent = false } = {}) {
      if (persistPath) loadFromDisk();
      const r = tables.r2_quota_reservations.find((x) => x.id === id);
      if (!r || r.state !== 'reserved') return clone(r || null);
      if (billable_request_sent) {
        const usage = this._ensureMonth(r.month);
        if (r.op_class === 'class_a') usage.class_a_ops += 1;
        if (r.op_class === 'class_b') usage.class_b_ops += 1;
        usage.updated_at = now();
      }
      r.state = 'released';
      r.updated_at = now();
      saveToDisk();
      return clone(r);
    },
    async recordDelete({ month, bytes = 0 }) {
      if (persistPath) loadFromDisk();
      const usage = this._ensureMonth(month);
      usage.managed_bytes = Math.max(0, usage.managed_bytes - Math.max(0, Math.trunc(Number(bytes) || 0)));
      usage.object_count = Math.max(0, usage.object_count - 1);
      usage.updated_at = now();
      saveToDisk();
    },
    async reconcile({ month, provider_storage_bytes = null, provider_class_a_ops = null, provider_class_b_ops = null, status = 'ok', halt = false }) {
      if (persistPath) loadFromDisk();
      const usage = this._ensureMonth(month);
      if (provider_storage_bytes != null) usage.managed_bytes = Math.max(usage.managed_bytes, Number(provider_storage_bytes));
      if (provider_class_a_ops != null) usage.class_a_ops = Math.max(usage.class_a_ops, Number(provider_class_a_ops));
      if (provider_class_b_ops != null) usage.class_b_ops = Math.max(usage.class_b_ops, Number(provider_class_b_ops));
      usage.reconciled_storage_bytes = provider_storage_bytes;
      usage.reconciled_class_a_ops = provider_class_a_ops;
      usage.reconciled_class_b_ops = provider_class_b_ops;
      usage.reconciliation_status = status;
      usage.last_reconciled_at = now();
      usage.quota_halted = Boolean(halt);
      usage.updated_at = now();
      saveToDisk();
      return clone(usage);
    },
    async getSnapshot(month) {
      if (persistPath) loadFromDisk();
      const u = this._ensureMonth(month);
      this._expireOld(month);
      const active = tables.r2_quota_reservations.filter((r) => r.month === month && r.state === 'reserved');
      return {
        month: u.month,
        managed_bytes: Number(u.managed_bytes || 0),
        reserved_bytes: active.reduce((s, r) => s + Number(r.reserved_bytes || 0), 0),
        object_count: Number(u.object_count || 0),
        class_a_ops: Number(u.class_a_ops || 0),
        reserved_class_a_ops: active.filter((r) => r.op_class === 'class_a').length,
        class_b_ops: Number(u.class_b_ops || 0),
        reserved_class_b_ops: active.filter((r) => r.op_class === 'class_b').length,
        reconciled_storage_bytes: u.reconciled_storage_bytes,
        reconciled_class_a_ops: u.reconciled_class_a_ops,
        reconciled_class_b_ops: u.reconciled_class_b_ops,
        reconciliation_status: u.reconciliation_status,
        last_reconciled_at: u.last_reconciled_at,
        quota_halted: Boolean(u.quota_halted),
      };
    },
  };

  const objectStorageUsage = {
    _ensure(provider, month) {
      let row = tables.object_storage_monthly_usage.find((r) => r.provider === provider && r.month === month);
      if (!row) {
        row = {
          provider,
          month,
          managed_bytes: 0,
          object_count: 0,
          api_requests: 0,
          outbound_bytes: 0,
          updated_at: now(),
        };
        tables.object_storage_monthly_usage.push(row);
      }
      return row;
    },
    _expireOld(provider, month) {
      const nowMs = Date.now();
      let changed = false;
      for (const r of tables.object_storage_quota_reservations) {
        if (r.provider === provider && r.month === month && r.state === 'reserved' && new Date(r.expires_at).getTime() <= nowMs) {
          r.state = 'expired';
          r.updated_at = now();
          changed = true;
        }
      }
      if (changed) saveToDisk();
    },
    async reserve({
      provider = 'oci',
      month,
      operation,
      bytes = 0,
      requests = 1,
      outbound_bytes = 0,
      idempotency_key = null,
      ttl_seconds = 180,
      limits = {},
    }) {
      if (persistPath) loadFromDisk();
      const usage = this._ensure(provider, month);
      if (idempotency_key) {
        const dup = tables.object_storage_quota_reservations.find((r) => r.idempotency_key === idempotency_key);
        if (dup) return { ok: true, duplicate: true, reservation: clone(dup), usage: clone(usage) };
      }
      this._expireOld(provider, month);

      const active = tables.object_storage_quota_reservations.filter((r) => r.provider === provider && r.month === month && r.state === 'reserved');
      const activeBytes = active.reduce((s, r) => s + Number(r.reserved_bytes || 0), 0);
      const activeReqs = active.reduce((s, r) => s + Number(r.reserved_requests || 0), 0);
      const activeOut = active.reduce((s, r) => s + Number(r.reserved_outbound_bytes || 0), 0);

      const addBytes = Math.max(0, Math.trunc(Number(bytes) || 0));
      const addReqs = Math.max(0, Math.trunc(Number(requests) || 0));
      const addOut = Math.max(0, Math.trunc(Number(outbound_bytes) || 0));

      const maxBytes = Number(limits.maxManagedBytes || 16 * 1024 * 1024 * 1024);
      const maxReqs = Number(limits.maxApiRequests || 40_000);
      const maxOut = Number(limits.maxOutboundBytes || 8 * 1024 * 1024 * 1024 * 1024);

      if (addBytes > 0 && Number(usage.managed_bytes) + activeBytes + addBytes > maxBytes) {
        return { ok: false, code: 'OBJECT_STORAGE_CAPACITY_LIMIT', usage: clone(usage) };
      }
      if (addReqs > 0 && Number(usage.api_requests) + activeReqs + addReqs > maxReqs) {
        return { ok: false, code: 'OBJECT_STORAGE_REQUEST_LIMIT', usage: clone(usage) };
      }
      if (addOut > 0 && Number(usage.outbound_bytes) + activeOut + addOut > maxOut) {
        return { ok: false, code: 'OBJECT_STORAGE_OUTBOUND_LIMIT', usage: clone(usage) };
      }

      const resv = insert('object_storage_quota_reservations', {
        idempotency_key,
        provider,
        month,
        operation,
        reserved_bytes: addBytes,
        reserved_requests: addReqs,
        reserved_outbound_bytes: addOut,
        state: 'reserved',
        expires_at: new Date(Date.now() + Math.max(1, Number(ttl_seconds) || 180) * 1000).toISOString(),
        updated_at: now(),
      });
      return { ok: true, duplicate: false, reservation: resv, usage: clone(usage) };
    },
    async commit(id, { actual_bytes = null, actual_outbound_bytes = null, object_delta = null } = {}) {
      if (persistPath) loadFromDisk();
      const r = tables.object_storage_quota_reservations.find((x) => x.id === id);
      if (!r || r.state !== 'reserved') return clone(r || null);
      const usage = this._ensure(r.provider, r.month);
      const addBytes = actual_bytes != null ? Math.trunc(Number(actual_bytes) || 0) : Number(r.reserved_bytes || 0);
      const addOut = actual_outbound_bytes != null ? Math.max(0, Math.trunc(Number(actual_outbound_bytes) || 0)) : Number(r.reserved_outbound_bytes || 0);
      const objDelta = object_delta != null ? Math.trunc(Number(object_delta) || 0) : (addBytes > 0 ? 1 : 0);

      usage.managed_bytes = Math.max(0, usage.managed_bytes + addBytes);
      usage.object_count = Math.max(0, usage.object_count + objDelta);
      usage.api_requests += Number(r.reserved_requests || 0);
      usage.outbound_bytes += addOut;
      usage.updated_at = now();
      r.state = 'committed';
      r.updated_at = now();
      saveToDisk();
      return clone(r);
    },
    async release(id, { billable_request_sent = false } = {}) {
      if (persistPath) loadFromDisk();
      const r = tables.object_storage_quota_reservations.find((x) => x.id === id);
      if (!r || r.state !== 'reserved') return clone(r || null);
      if (billable_request_sent) {
        const usage = this._ensure(r.provider, r.month);
        usage.api_requests += Number(r.reserved_requests || 1);
        usage.updated_at = now();
      }
      r.state = 'released';
      r.updated_at = now();
      saveToDisk();
      return clone(r);
    },
    async recordDelete({ provider = 'oci', month, bytes = 0 }) {
      if (persistPath) loadFromDisk();
      const usage = this._ensure(provider, month);
      usage.managed_bytes = Math.max(0, usage.managed_bytes - Math.max(0, Math.trunc(Number(bytes) || 0)));
      usage.object_count = Math.max(0, usage.object_count - 1);
      usage.updated_at = now();
      saveToDisk();
    },
    async getSnapshot({ provider = 'oci', month }) {
      if (persistPath) loadFromDisk();
      const u = this._ensure(provider, month);
      this._expireOld(provider, month);
      const active = tables.object_storage_quota_reservations.filter((r) => r.provider === provider && r.month === month && r.state === 'reserved');
      return {
        provider: u.provider,
        month: u.month,
        managed_bytes: Number(u.managed_bytes || 0),
        reserved_bytes: active.reduce((s, r) => s + Number(r.reserved_bytes || 0), 0),
        object_count: Number(u.object_count || 0),
        api_requests: Number(u.api_requests || 0),
        reserved_requests: active.reduce((s, r) => s + Number(r.reserved_requests || 0), 0),
        outbound_bytes: Number(u.outbound_bytes || 0),
        reserved_outbound_bytes: active.reduce((s, r) => s + Number(r.reserved_outbound_bytes || 0), 0),
      };
    },
  };

  const driver = persistPath ? 'file' : 'memori';

  return {
    users,
    tokenTransactions,
    refreshTokens,
    documents,
    analyses,
    issues,
    payments,
    downloadTransactions,
    documentFiles,
    r2Usage,
    objectStorageUsage,
    driver,
    persistPath,
    async healthCheck() {
      return { ok: true, driver, schema_version: null, latency_ms: 0 };
    },
    async close() {},
  };
}
