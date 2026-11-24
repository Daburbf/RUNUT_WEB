import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { runMigrations, getSchemaVersion } from './migrations.js';

const { Pool } = pg;

export const USER_COLUMNS = new Set([
  'name', 'email', 'password_hash', 'email_verified', 'google_id', 'auth_provider',
  'reset_token_hash', 'reset_token_expires_at',
  'otp_code_hash', 'otp_purpose', 'otp_expires_at', 'otp_attempts', 'otp_sent_at',
  'token_version',
]);

export const DOCUMENT_COLUMNS = new Set([
  'title', 'original_text', 'revised_text', 'word_count', 'token_cost', 'file_name',
  'status', 'expires_at', 'last_analyzed_at',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => UUID_RE.test(String(v || ''));

const setClause = (patch, allowed, firstIndex = 2) => {
  const keys = Object.keys(patch || {}).filter((k) => allowed.has(k));
  return {
    keys,
    set: keys.map((k, i) => `${k} = $${i + firstIndex}`).join(', '),
    values: keys.map((k) => patch[k]),
  };
};

export function resolveSslOption(connectionString, env = process.env) {
  const explicit = String(env.DATABASE_SSL || '').trim().toLowerCase();
  if (explicit === 'false' || explicit === '0' || explicit === 'disable') return false;

  const rejectUnauthorized = String(env.DATABASE_SSL_REJECT_UNAUTHORIZED || 'false').trim().toLowerCase() === 'true';
  if (explicit === 'true' || explicit === '1' || explicit === 'require') {
    return { rejectUnauthorized };
  }

  try {
    const parsed = new URL(connectionString);
    const sslMode = (parsed.searchParams.get('sslmode') || '').toLowerCase();
    if (sslMode === 'disable') return false;
    if (sslMode === 'require' || sslMode === 'verify-ca' || sslMode === 'verify-full') {
      return { rejectUnauthorized: sslMode !== 'require' || rejectUnauthorized };
    }
    const isLocalHost = parsed.hostname === 'localhost'
      || parsed.hostname === '127.0.0.1'
      || parsed.hostname === '::1';
    if (!isLocalHost && env.NODE_ENV === 'production') {
      return { rejectUnauthorized };
    }
  } catch {
    // Biarkan pg memvalidasi connectionString
  }
  return false;
}

export async function createPostgresRepositories(connectionString) {
  const poolMax = Math.max(2, Math.min(Number(process.env.PG_POOL_MAX || 10), 50));
  const idleTimeoutMillis = Math.max(5000, Number(process.env.PG_IDLE_TIMEOUT_MS || 30000));
  const connectionTimeoutMillis = Math.max(2000, Number(process.env.PG_CONNECTION_TIMEOUT_MS || 10000));
  const statementTimeoutMs = Math.max(5000, Number(process.env.PG_STATEMENT_TIMEOUT_MS || 15000));

  const pool = new Pool({
    connectionString,
    max: poolMax,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    query_timeout: statementTimeoutMs,
    statement_timeout: statementTimeoutMs,
    allowExitOnIdle: process.env.NODE_ENV === 'test',
    ssl: resolveSslOption(connectionString),
  });

  pool.on('error', (err) => {
    console.error(JSON.stringify({ event: 'pg_pool_error', reason: err.message }));
  });

  let schemaVersion = 0;
  try {
    const mig = await runMigrations(pool);
    schemaVersion = mig.latestVersion;
    if (mig.newlyApplied.length) {
      console.log(JSON.stringify({ event: 'pg_migrations_applied', versions: mig.newlyApplied }));
    }
  } catch (err) {
    await pool.end().catch(() => {});
    throw err;
  }

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
      const bal = Math.max(0, Math.trunc(Number(token_balance) || 0));
      const { rows } = await pool.query(
        `insert into users (
           id, name, email, password_hash, token_balance, email_verified,
           google_id, auth_provider, otp_code_hash, otp_purpose, otp_expires_at,
           otp_attempts, otp_sent_at, token_version
         )
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning *`,
        [
          randomUUID(), name, email, password_hash, bal, Boolean(email_verified),
          google_id, auth_provider, otp_code_hash, otp_purpose, otp_expires_at,
          Number(otp_attempts) || 0, otp_sent_at, Math.max(0, Math.trunc(Number(token_version) || 0)),
        ],
      );
      return rows[0];
    },
    async findById(id) {
      if (!isUuid(id)) return null;
      const { rows } = await pool.query('select * from users where id = $1', [id]);
      return rows[0] || null;
    },
    async findByEmail(email) {
      const { rows } = await pool.query(
        'select * from users where lower(email) = lower($1) limit 1',
        [String(email || '').trim()],
      );
      return rows[0] || null;
    },
    async findByGoogleId(googleId) {
      if (!googleId) return null;
      const { rows } = await pool.query(
        'select * from users where google_id = $1 limit 1',
        [String(googleId)],
      );
      return rows[0] || null;
    },
    async findByResetTokenHash(hash) {
      if (!hash) return null;
      const { rows } = await pool.query(
        'select * from users where reset_token_hash = $1 limit 1',
        [hash],
      );
      return rows[0] || null;
    },
    async update(id, patch) {
      if (!isUuid(id)) return null;
      const { keys, set, values } = setClause(patch, USER_COLUMNS);
      if (!keys.length) return null;
      const { rows } = await pool.query(
        `update users set ${set}, updated_at = now() where id = $1 returning *`,
        [id, ...values],
      );
      return rows[0] || null;
    },
  };

  const tokenTransactions = {
    async findByIdempotencyKey(user_id, idempotency_key) {
      if (!isUuid(user_id) || !idempotency_key) return null;
      const key = String(idempotency_key).trim();
      if (!key) return null;
      const { rows } = await pool.query(
        'select * from token_transactions where user_id = $1 and idempotency_key = $2 limit 1',
        [user_id, key],
      );
      return rows[0] || null;
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
      if (!isUuid(user_id)) return { ok: false, error: 'USER_NOT_FOUND' };
      const delta = Math.trunc(Number(amount));
      if (!Number.isFinite(delta) || delta <= 0) {
        throw new Error('Jumlah penambahan token harus bilangan bulat positif.');
      }
      const idemKey = idempotency_key ? String(idempotency_key).trim() : null;
      const client = await pool.connect();
      try {
        await client.query('begin');
        if (idemKey) {
          const { rows: existing } = await client.query(
            'select * from token_transactions where user_id = $1 and idempotency_key = $2 limit 1',
            [user_id, idemKey],
          );
          if (existing[0]) {
            const { rows: uRows } = await client.query('select * from users where id = $1', [user_id]);
            await client.query('commit');
            return { ok: true, duplicate: true, transaction: existing[0], user: uRows[0] || null };
          }
        }
        const { rows: updated } = await client.query(
          `update users set token_balance = token_balance + $2, updated_at = now()
           where id = $1 returning *`,
          [user_id, delta],
        );
        if (!updated[0]) {
          await client.query('rollback');
          return { ok: false, error: 'USER_NOT_FOUND' };
        }
        const user = updated[0];
        const { rows: txRows } = await client.query(
          `insert into token_transactions
             (id, user_id, type, amount, balance_after, description, reference_type, reference_id, idempotency_key, meta)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
           returning *`,
          [
            randomUUID(), user_id, type, delta, user.token_balance,
            String(description || 'Penambahan token'),
            reference_type || null, reference_id || null, idemKey, JSON.stringify(meta || {}),
          ],
        );
        await client.query('commit');
        return { ok: true, duplicate: false, transaction: txRows[0], user };
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
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
      if (!isUuid(user_id)) return { ok: false, balance: 0, error: 'USER_NOT_FOUND' };
      const cost = Math.trunc(Number(amount));
      if (!Number.isFinite(cost) || cost <= 0) {
        throw new Error('Jumlah pemotongan token harus bilangan bulat positif.');
      }
      const idemKey = idempotency_key ? String(idempotency_key).trim() : null;
      const client = await pool.connect();
      try {
        await client.query('begin');
        if (idemKey) {
          const { rows: existing } = await client.query(
            'select * from token_transactions where user_id = $1 and idempotency_key = $2 limit 1',
            [user_id, idemKey],
          );
          if (existing[0]) {
            const { rows: uRows } = await client.query('select * from users where id = $1', [user_id]);
            await client.query('commit');
            return {
              ok: true,
              duplicate: true,
              transaction: existing[0],
              user: uRows[0] || null,
              balance: uRows[0]?.token_balance ?? 0,
            };
          }
        }
        // Operasi atomik: hanya berhasil bila token_balance >= cost.
        const { rows: updated } = await client.query(
          `update users
              set token_balance = token_balance - $2, updated_at = now()
            where id = $1 and token_balance >= $2
            returning *`,
          [user_id, cost],
        );
        if (!updated[0]) {
          const { rows: current } = await client.query('select token_balance from users where id = $1', [user_id]);
          await client.query('rollback');
          if (!current[0]) return { ok: false, balance: 0, error: 'USER_NOT_FOUND' };
          return {
            ok: false,
            duplicate: false,
            balance: current[0].token_balance,
            required: cost,
            error: 'INSUFFICIENT_TOKENS',
          };
        }
        const user = updated[0];
        const { rows: txRows } = await client.query(
          `insert into token_transactions
             (id, user_id, type, amount, balance_after, description, reference_type, reference_id, idempotency_key, meta)
           values ($1, $2, 'usage', $3, $4, $5, $6, $7, $8, $9::jsonb)
           returning *`,
          [
            randomUUID(), user_id, -cost, user.token_balance,
            String(description || 'Penggunaan token untuk analisis'),
            reference_type || 'analysis', reference_id || null, idemKey, JSON.stringify(meta || {}),
          ],
        );
        await client.query('commit');
        return {
          ok: true,
          duplicate: false,
          transaction: txRows[0],
          user,
          balance: user.token_balance,
        };
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
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
      if (!isUuid(id)) return null;
      const { rows } = await pool.query(
        `update token_transactions
            set reference_id = coalesce($2, reference_id),
                description = coalesce($3, description),
                meta = case when $4::jsonb is null then meta else meta || $4::jsonb end
          where id = $1
          returning *`,
        [
          id,
          reference_id === undefined ? null : reference_id,
          description === undefined ? null : description,
          meta === undefined ? null : JSON.stringify(meta),
        ],
      );
      return rows[0] || null;
    },

    async listByUser(user_id, { limit = 50, type = '' } = {}) {
      if (!isUuid(user_id)) return [];
      const filterType = String(type || '').trim();
      const { rows } = await pool.query(
        `select * from token_transactions
          where user_id = $1 and ($2 = '' or type = $2)
          order by created_at desc
          limit $3`,
        [user_id, filterType, Math.max(1, Math.min(Number(limit) || 50, 200))],
      );
      return rows;
    },

    async summaryByUser(user_id) {
      if (!isUuid(user_id)) {
        return { balance: 0, available_balance: 0, reserved_tokens: 0, total_purchased: 0, total_used: 0, gross_used: 0, total_refunded: 0 };
      }
      const { rows: uRows } = await pool.query('select token_balance from users where id = $1', [user_id]);
      const { rows: sRows } = await pool.query(
        `select
           coalesce(sum(case when type = 'purchase' and amount > 0 then amount else 0 end), 0)::int as total_purchased,
           coalesce(sum(case when type = 'usage' and amount < 0 then abs(amount) else 0 end), 0)::int as gross_used,
           coalesce(sum(case when type = 'refund' and amount > 0 then amount else 0 end), 0)::int as total_refunded
         from token_transactions
         where user_id = $1`,
        [user_id],
      );
      const { rows: rRows } = await pool.query(
        `select coalesce(sum(reserved_tokens), 0)::int as reserved_tokens
           from download_transactions
          where user_id = $1
            and state in ('pending', 'reserved', 'file_prepared', 'save_confirmed')
            and expires_at > now()`,
        [user_id],
      );
      const s = sRows[0] || { total_purchased: 0, gross_used: 0, total_refunded: 0 };
      const balance = Math.max(0, Number(uRows[0]?.token_balance) || 0);
      const reserved = Math.max(0, Number(rRows[0]?.reserved_tokens) || 0);
      return {
        balance,
        reserved_tokens: reserved,
        available_balance: Math.max(0, balance - reserved),
        total_purchased: s.total_purchased,
        total_used: Math.max(0, s.gross_used - s.total_refunded),
        gross_used: s.gross_used,
        total_refunded: s.total_refunded,
      };
    },
  };

  const refreshTokens = {
    async create({ user_id, token_hash, expires_at, user_agent }) {
      const { rows } = await pool.query(
        `insert into refresh_tokens (id, user_id, token_hash, expires_at, user_agent)
         values ($1, $2, $3, $4, $5) returning *`,
        [randomUUID(), user_id, token_hash, new Date(expires_at), user_agent || null],
      );
      return rows[0];
    },
    async findByHash(token_hash) {
      const { rows } = await pool.query(
        'select * from refresh_tokens where token_hash = $1 limit 1',
        [token_hash],
      );
      return rows[0] || null;
    },
    async revokeByHash(token_hash) {
      const { rowCount } = await pool.query(
        'update refresh_tokens set revoked_at = now() where token_hash = $1 and revoked_at is null',
        [token_hash],
      );
      return rowCount > 0;
    },
    async revokeById(id) {
      if (!isUuid(id)) return;
      await pool.query('update refresh_tokens set revoked_at = now() where id = $1', [id]);
    },
    async revokeAllForUser(user_id) {
      if (!isUuid(user_id)) return;
      await pool.query(
        'update refresh_tokens set revoked_at = now() where user_id = $1 and revoked_at is null',
        [user_id],
      );
    },
    async deleteExpired(at = new Date().toISOString()) {
      const { rowCount } = await pool.query(
        `delete from refresh_tokens
          where expires_at < $1
             or (revoked_at is not null and revoked_at < $1::timestamptz - interval '7 days')`,
        [new Date(at)],
      );
      return rowCount || 0;
    },
  };

  const documents = {
    async create(row) {
      const { rows } = await pool.query(
        `insert into documents
           (id, user_id, title, original_text, word_count, token_cost, file_name, revised_text, status, expires_at, last_analyzed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9,
           coalesce($10::timestamptz, now() + interval '30 days'),
           coalesce($11::timestamptz, now()))
         returning *`,
        [
          randomUUID(), row.user_id, row.title, row.original_text, row.word_count || 0,
          Math.max(0, Math.trunc(Number(row.token_cost) || 0)),
          row.file_name || null, row.revised_text || null, row.status || 'analyzed',
          row.expires_at || null, row.last_analyzed_at || null,
        ],
      );
      return rows[0];
    },
    async findById(id) {
      if (!isUuid(id)) return null;
      const { rows } = await pool.query('select * from documents where id = $1', [id]);
      return rows[0] || null;
    },
    async listByUser(user_id, { q = '', status = '', limit = 100 } = {}) {
      if (!isUuid(user_id)) return [];
      const needle = String(q || '').trim();
      const statusFilter = String(status || '').trim();
      const { rows } = await pool.query(
        `select * from documents
          where user_id = $1
            and ($2 = '' or title ilike '%' || $2 || '%')
            and ($3 = '' or lower(status) = lower($3))
          order by updated_at desc
          limit $4`,
        [user_id, needle, statusFilter, Math.max(1, Math.min(Number(limit) || 100, 500))],
      );
      return rows;
    },
    async update(id, patch) {
      if (!isUuid(id)) return null;
      const { keys, set, values } = setClause(patch, DOCUMENT_COLUMNS);
      if (!keys.length) return null;
      const { rows } = await pool.query(
        `update documents set ${set}, updated_at = now() where id = $1 returning *`,
        [id, ...values],
      );
      return rows[0] || null;
    },
    async deleteMany(user_id, ids) {
      if (!isUuid(user_id)) return [];
      const clean = (Array.isArray(ids) ? ids : []).filter(isUuid);
      if (!clean.length) return [];
      const { rows } = await pool.query(
        'delete from documents where user_id = $1 and id = any($2::uuid[]) returning id',
        [user_id, clean],
      );
      return rows.map((r) => r.id);
    },
    async deleteExpired(at = new Date().toISOString()) {
      const { rows } = await pool.query(
        'delete from documents where expires_at is not null and expires_at < $1 returning id',
        [new Date(at)],
      );
      return rows.map((r) => r.id);
    },
  };

  const analyses = {
    async create(row) {
      const { rows } = await pool.query(
        `insert into analysis_results
           (id, document_id, stats, token_cost, idempotency_key, ai_provider, ai_model, ai_latency_ms, ai_status)
         values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9)
         returning *`,
        [
          randomUUID(), row.document_id, JSON.stringify(row.stats || {}),
          Math.max(0, Math.trunc(Number(row.token_cost) || 0)), row.idempotency_key || null,
          row.ai_provider || null, row.ai_model || null,
          Number.isFinite(row.ai_latency_ms) ? row.ai_latency_ms : null, row.ai_status || null,
        ],
      );
      return rows[0];
    },
    async findLatestByDocument(document_id) {
      if (!isUuid(document_id)) return null;
      const { rows } = await pool.query(
        'select * from analysis_results where document_id = $1 order by created_at desc, id desc limit 1',
        [document_id],
      );
      return rows[0] || null;
    },
  };

  const issues = {
    async createMany(rows) {
      const list = Array.isArray(rows) ? rows : [];
      if (!list.length) return [];
      const values = [];
      const placeholders = [];
      let p = 1;
      for (const r of list) {
        const startPos = Math.max(0, Math.trunc(Number(r.start_pos) || 0));
        const endPos = Math.max(startPos, Math.trunc(Number(r.end_pos) || startPos));
        placeholders.push(
          `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::jsonb, $${p++}::jsonb, $${p++})`,
        );
        values.push(
          randomUUID(),
          r.analysis_id,
          r.category,
          startPos,
          endPos,
          r.snippet || null,
          r.explanation || null,
          r.suggestion || null,
          Boolean(r.needs_manual_review),
          JSON.stringify(r.review_reasons || []),
          r.evidence ? JSON.stringify(r.evidence) : null,
          r.decision || 'active',
        );
      }
      const { rows: inserted } = await pool.query(
        `insert into issues
           (id, analysis_id, category, start_pos, end_pos, snippet, explanation, suggestion,
            needs_manual_review, review_reasons, evidence, decision)
         values ${placeholders.join(', ')}
         returning *`,
        values,
      );
      return inserted;
    },
    async listByAnalysis(analysis_id) {
      if (!isUuid(analysis_id)) return [];
      const { rows } = await pool.query(
        'select * from issues where analysis_id = $1 order by start_pos asc, created_at asc',
        [analysis_id],
      );
      return rows;
    },
    async countPendingByDocument(document_id) {
      if (!isUuid(document_id)) return 0;
      const { rows } = await pool.query(
        `select count(*)::int as total
           from issues i
          where i.analysis_id = (
            select a.id
              from analysis_results a
             where a.document_id = $1
             order by a.created_at desc, a.id desc
             limit 1
          )
            and i.decision = 'active'`,
        [document_id],
      );
      return rows[0]?.total || 0;
    },
    async updateDecision(id, { decision, suggestion }) {
      if (!isUuid(id)) return null;
      const { rows } = await pool.query(
        `update issues set decision = $2,
           suggestion = case when $3::text is null then suggestion else $3 end,
           updated_at = now()
         where id = $1 returning *`,
        [id, decision, suggestion === undefined || suggestion === null ? null : String(suggestion)],
      );
      return rows[0] || null;
    },
    async resetDecisions(analysis_id) {
      if (!isUuid(analysis_id)) return;
      await pool.query(
        "update issues set decision = 'active', updated_at = now() where analysis_id = $1",
        [analysis_id],
      );
    },
  };

  const payments = {
    async create(row) {
      const { rows } = await pool.query(
        `insert into payments
           (id, user_id, order_id, package_id, package_label, token_amount, method, method_label,
            channel, amount, status, provider, provider_ref, instructions, expires_at, replaces_order_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16)
         returning *`,
        [
          randomUUID(), row.user_id, row.order_id, row.package_id || null, row.package_label || null,
          Math.max(0, Math.trunc(Number(row.token_amount) || 0)),
          row.method, row.method_label || null, row.channel || null, row.amount,
          row.status || 'pending', row.provider || null, row.provider_ref || null,
          JSON.stringify(row.instructions || {}),
          row.expires_at ? new Date(row.expires_at) : null,
          row.replaces_order_id || null,
        ],
      );
      return rows[0];
    },
    async findById(id) {
      if (!isUuid(id)) return null;
      const { rows } = await pool.query('select * from payments where id = $1', [id]);
      return rows[0] || null;
    },
    async findByOrderId(order_id) {
      const { rows } = await pool.query('select * from payments where order_id = $1 limit 1', [order_id]);
      return rows[0] || null;
    },
    async listByUser(user_id, { limit = 30 } = {}) {
      if (!isUuid(user_id)) return [];
      const { rows } = await pool.query(
        'select * from payments where user_id = $1 order by created_at desc limit $2',
        [user_id, Math.max(1, Math.min(Number(limit) || 30, 100))],
      );
      return rows;
    },
    async update(id, patch) {
      if (!isUuid(id)) return null;
      const allowed = new Set([
        'status', 'provider_ref', 'instructions', 'paid_at', 'expires_at',
        'last_webhook_at', 'replaced_by_order_id', 'replaces_order_id', 'reconciliation_flag',
      ]);
      const keys = Object.keys(patch || {}).filter((k) => allowed.has(k));
      if (!keys.length) return null;
      const values = keys.map((k) => (k === 'instructions' ? JSON.stringify(patch[k]) : patch[k]));
      const set = keys.map((k, i) => (k === 'instructions' ? `instructions = $${i + 2}::jsonb` : `${k} = $${i + 2}`)).join(', ');
      const { rows } = await pool.query(
        `update payments set ${set}, updated_at = now() where id = $1 returning *`,
        [id, ...values],
      );
      return rows[0] || null;
    },
    async markPaidIfPending(id, patch) {
      if (!isUuid(id)) return null;
      const { rows } = await pool.query(
        `update payments set status = 'paid', paid_at = now(), provider_ref = coalesce($2, provider_ref),
           updated_at = now()
         where id = $1 and status <> 'paid' returning *`,
        [id, patch?.provider_ref || null],
      );
      return rows[0] || null;
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
      if (!isUuid(user_id) || !isUuid(document_id)) return { ok: false, error: 'INVALID_ID' };
      const cost = Math.max(0, Math.trunc(Number(reserved_tokens) || 0));
      const idemKey = idempotency_key ? String(idempotency_key).trim().slice(0, 128) : null;
      const ttl = Math.max(30, Math.min(Number(ttl_seconds) || 300, 3600));
      const client = await pool.connect();
      try {
        await client.query('begin');
        // Row-level lock pada user agar reservasi paralel selalu atomik
        const { rows: uRows } = await client.query('select * from users where id = $1 for update', [user_id]);
        if (!uRows[0]) {
          await client.query('rollback');
          return { ok: false, error: 'USER_NOT_FOUND' };
        }
        const user = uRows[0];

        // Lepaskan reservasi kedaluwarsa milik user ini
        await client.query(
          `update download_transactions
              set state = 'expired', updated_at = now()
            where user_id = $1
              and state in ('pending', 'reserved', 'file_prepared')
              and expires_at <= now()`,
          [user_id],
        );

        if (idemKey) {
          const { rows: existing } = await client.query(
            'select * from download_transactions where user_id = $1 and idempotency_key = $2 limit 1',
            [user_id, idemKey],
          );
          if (existing[0]) {
            const { rows: rRows } = await client.query(
              `select coalesce(sum(reserved_tokens), 0)::int as reserved
                 from download_transactions
                where user_id = $1 and state in ('pending', 'reserved', 'file_prepared', 'save_confirmed') and expires_at > now()`,
              [user_id],
            );
            const reserved = rRows[0]?.reserved || 0;
            await client.query('commit');
            return {
              ok: true,
              duplicate: true,
              transaction: existing[0],
              balance: user.token_balance,
              reserved_tokens: reserved,
              available_balance: Math.max(0, user.token_balance - reserved),
            };
          }
        }

        const { rows: rRows } = await client.query(
          `select coalesce(sum(reserved_tokens), 0)::int as reserved
             from download_transactions
            where user_id = $1 and state in ('pending', 'reserved', 'file_prepared', 'save_confirmed') and expires_at > now()`,
          [user_id],
        );
        const currentReserved = rRows[0]?.reserved || 0;
        const available = Math.max(0, user.token_balance - currentReserved);
        if (available < cost) {
          await client.query('rollback');
          return {
            ok: false,
            error: 'INSUFFICIENT_TOKENS',
            balance: user.token_balance,
            reserved_tokens: currentReserved,
            available_balance: available,
            required: cost,
          };
        }

        const expiresAt = new Date(Date.now() + ttl * 1000);
        const { rows: txRows } = await client.query(
          `insert into download_transactions
             (id, user_id, document_id, export_format, reserved_tokens, committed_tokens, state, idempotency_key, refund_status, expires_at)
           values ($1, $2, $3, $4, $5, 0, 'reserved', $6, 'none', $7)
           returning *`,
          [randomUUID(), user_id, document_id, export_format, cost, idemKey, expiresAt],
        );
        await client.query('commit');
        const nextReserved = currentReserved + cost;
        return {
          ok: true,
          duplicate: false,
          transaction: txRows[0],
          balance: user.token_balance,
          reserved_tokens: nextReserved,
          available_balance: Math.max(0, user.token_balance - nextReserved),
        };
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async findById(id) {
      if (!isUuid(id)) return null;
      const { rows } = await pool.query('select * from download_transactions where id = $1', [id]);
      return rows[0] || null;
    },

    async markPrepared(id, user_id) {
      if (!isUuid(id) || !isUuid(user_id)) return null;
      const { rows } = await pool.query(
        `update download_transactions
            set state = 'file_prepared', updated_at = now()
          where id = $1 and user_id = $2 and state in ('reserved', 'file_prepared') and expires_at > now()
          returning *`,
        [id, user_id],
      );
      return rows[0] || null;
    },

    async markFailed(id, user_id, reason) {
      if (!isUuid(id) || !isUuid(user_id)) return null;
      const { rows } = await pool.query(
        `update download_transactions
            set state = 'failed', failure_reason = $3, updated_at = now()
          where id = $1 and user_id = $2 and state in ('pending', 'reserved', 'file_prepared')
          returning *`,
        [id, user_id, String(reason || 'File generation failed').slice(0, 500)],
      );
      return rows[0] || null;
    },

    async cancel(id, user_id, reason = 'user_cancelled') {
      if (!isUuid(id) || !isUuid(user_id)) return { ok: false, error: 'NOT_FOUND' };
      const client = await pool.connect();
      try {
        await client.query('begin');
        const { rows } = await client.query(
          'select * from download_transactions where id = $1 and user_id = $2 for update',
          [id, user_id],
        );
        const tx = rows[0];
        if (!tx) {
          await client.query('rollback');
          return { ok: false, error: 'NOT_FOUND' };
        }
        if (tx.state === 'committed') {
          await client.query('rollback');
          return { ok: false, error: 'ALREADY_COMMITTED', transaction: tx };
        }
        if (tx.state === 'cancelled' || tx.state === 'expired' || tx.state === 'failed') {
          await client.query('commit');
          return { ok: true, duplicate: true, transaction: tx };
        }
        const { rows: updated } = await client.query(
          `update download_transactions
              set state = 'cancelled', cancellation_reason = $3, updated_at = now()
            where id = $1 and user_id = $2
            returning *`,
          [id, user_id, String(reason || 'user_cancelled').slice(0, 300)],
        );
        await client.query('commit');
        return { ok: true, duplicate: false, transaction: updated[0] };
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async commit({ id, user_id, description = 'Unduh dokumen', meta = {} }) {
      if (!isUuid(id) || !isUuid(user_id)) return { ok: false, error: 'NOT_FOUND' };
      const client = await pool.connect();
      try {
        await client.query('begin');
        const { rows: uRows } = await client.query('select * from users where id = $1 for update', [user_id]);
        if (!uRows[0]) {
          await client.query('rollback');
          return { ok: false, error: 'USER_NOT_FOUND' };
        }
        const { rows: txRows } = await client.query(
          'select * from download_transactions where id = $1 and user_id = $2 for update',
          [id, user_id],
        );
        const tx = txRows[0];
        if (!tx) {
          await client.query('rollback');
          return { ok: false, error: 'NOT_FOUND' };
        }
        if (tx.state === 'committed') {
          await client.query('commit');
          return { ok: true, duplicate: true, transaction: tx, balance: uRows[0].token_balance };
        }
        if (!['reserved', 'file_prepared', 'save_confirmed'].includes(tx.state)) {
          await client.query('rollback');
          return { ok: false, error: 'RESERVATION_NOT_COMMITTABLE', state: tx.state, transaction: tx };
        }
        if (new Date(tx.expires_at).getTime() <= Date.now()) {
          await client.query("update download_transactions set state = 'expired', updated_at = now() where id = $1", [id]);
          await client.query('commit');
          return { ok: false, error: 'RESERVATION_EXPIRED', state: 'expired' };
        }

        const cost = Math.max(0, Math.trunc(Number(tx.reserved_tokens) || 0));
        const { rows: updatedUser } = await client.query(
          `update users set token_balance = token_balance - $2, updated_at = now()
            where id = $1 and token_balance >= $2
            returning *`,
          [user_id, cost],
        );
        if (!updatedUser[0]) {
          await client.query("update download_transactions set state = 'failed', failure_reason = 'INSUFFICIENT_TOKENS', updated_at = now() where id = $1", [id]);
          await client.query('commit');
          return { ok: false, error: 'INSUFFICIENT_TOKENS', balance: uRows[0].token_balance };
        }

        let ledgerTx = null;
        if (cost > 0) {
          const { rows: lRows } = await client.query(
            `insert into token_transactions
               (id, user_id, type, amount, balance_after, description, reference_type, reference_id, idempotency_key, meta)
             values ($1, $2, 'usage', $3, $4, $5, 'download', $6, $7, $8::jsonb)
             returning *`,
            [
              randomUUID(), user_id, -cost, updatedUser[0].token_balance,
              String(description || 'Unduh dokumen'), tx.document_id, `download_commit:${tx.id}`,
              JSON.stringify({ ...meta, download_transaction_id: tx.id, format: tx.export_format }),
            ],
          );
          ledgerTx = lRows[0];
        }

        const { rows: committedRows } = await client.query(
          `update download_transactions
              set state = 'committed',
                  committed_tokens = $2,
                  token_transaction_id = $3,
                  confirmed_at = now(),
                  updated_at = now()
            where id = $1
            returning *`,
          [id, cost, ledgerTx?.id || null],
        );
        await client.query('commit');
        return {
          ok: true,
          duplicate: false,
          transaction: committedRows[0],
          token_transaction: ledgerTx,
          balance: updatedUser[0].token_balance,
        };
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async listByUser(user_id, { limit = 50 } = {}) {
      if (!isUuid(user_id)) return [];
      const { rows } = await pool.query(
        'select * from download_transactions where user_id = $1 order by created_at desc limit $2',
        [user_id, Math.max(1, Math.min(Number(limit) || 50, 200))],
      );
      return rows;
    },

    async releaseExpired(at = new Date().toISOString()) {
      const { rowCount } = await pool.query(
        `update download_transactions
            set state = 'expired', updated_at = now()
          where state in ('pending', 'reserved', 'file_prepared')
            and expires_at <= $1`,
        [new Date(at)],
      );
      return rowCount || 0;
    },
  };

  const documentFiles = {
    async save({ document_id, user_id, ext, original_name, size_bytes, sha256, content = null, storage_provider = 'postgres', storage_key = null }) {
      if (!isUuid(document_id) || !isUuid(user_id)) return null;
      const isExternal = storage_provider === 'r2' || storage_provider === 'oci';
      if (!isExternal && (!Buffer.isBuffer(content) || content.length === 0)) return null;
      const finalSize = Number(size_bytes || (Buffer.isBuffer(content) ? content.length : 0));
      if (finalSize <= 0 || finalSize > 10 * 1024 * 1024) {
        throw new Error('Ukuran berkas melebihi batas penyimpanan persisten (10 MB).');
      }
      await pool.query(
        `insert into document_files (document_id, user_id, ext, original_name, size_bytes, sha256, content, storage_provider, storage_key)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (document_id) do nothing`,
        [document_id, user_id, ext, String(original_name || `document.${ext}`).slice(0, 255), finalSize, sha256, isExternal ? null : content, storage_provider, storage_key],
      );
      return { document_id, user_id, ext, original_name, size_bytes: finalSize, sha256, storage_provider, storage_key };
    },
    async findByDocumentId(document_id, { user_id = null } = {}) {
      if (!isUuid(document_id)) return null;
      const query = user_id && isUuid(user_id)
        ? 'select document_id, user_id, ext, original_name, size_bytes, sha256, content, storage_provider, storage_key, created_at from document_files where document_id = $1 and user_id = $2'
        : 'select document_id, user_id, ext, original_name, size_bytes, sha256, content, storage_provider, storage_key, created_at from document_files where document_id = $1';
      const params = user_id && isUuid(user_id) ? [document_id, user_id] : [document_id];
      const { rows } = await pool.query(query, params);
      if (!rows[0]) return null;
      return {
        ...rows[0],
        storage_provider: rows[0].storage_provider || 'postgres',
        storage_key: rows[0].storage_key || null,
        buffer: rows[0].content != null
          ? (Buffer.isBuffer(rows[0].content) ? Buffer.from(rows[0].content) : Buffer.from(rows[0].content))
          : null,
      };
    },
    async deleteByDocumentId(document_id) {
      if (!isUuid(document_id)) return false;
      const { rowCount } = await pool.query('delete from document_files where document_id = $1', [document_id]);
      return (rowCount || 0) > 0;
    },
  };

  const r2Usage = {
    async reserve({
      month,
      operation,
      op_class,
      bytes = 0,
      idempotency_key = null,
      ttl_seconds = 180,
      limits = {},
    }) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(
          `insert into r2_monthly_usage (month) values ($1) on conflict (month) do nothing`,
          [month],
        );
        const { rows: usageRows } = await client.query(
          'select * from r2_monthly_usage where month = $1 for update',
          [month],
        );
        const usage = usageRows[0];

        if (idempotency_key) {
          const { rows: dupRows } = await client.query(
            'select * from r2_quota_reservations where idempotency_key = $1',
            [idempotency_key],
          );
          if (dupRows[0]) {
            await client.query('commit');
            return { ok: true, duplicate: true, reservation: dupRows[0], usage };
          }
        }

        // Expire abandoned reservations automatically inside the lock
        await client.query(
          `update r2_quota_reservations
              set state = 'expired', updated_at = now()
            where month = $1 and state = 'reserved' and expires_at <= now()`,
          [month],
        );

        const { rows: activeRows } = await client.query(
          `select coalesce(sum(reserved_bytes), 0)::bigint as reserved_bytes,
                  count(*) filter (where op_class = 'class_a')::bigint as reserved_a,
                  count(*) filter (where op_class = 'class_b')::bigint as reserved_b
             from r2_quota_reservations
            where month = $1 and state = 'reserved'`,
          [month],
        );
        const activeBytes = Number(activeRows[0]?.reserved_bytes || 0);
        const activeA = Number(activeRows[0]?.reserved_a || 0);
        const activeB = Number(activeRows[0]?.reserved_b || 0);

        if (usage.quota_halted && op_class !== 'free') {
          await client.query('rollback');
          return { ok: false, code: 'R2_QUOTA_HALTED_BY_RECONCILIATION', usage };
        }

        const addBytes = Math.max(0, Math.trunc(Number(bytes) || 0));
        const maxBytes = Number(limits.maxManagedBytes || 8 * 1024 * 1024 * 1024);
        const maxA = Number(limits.maxClassAOps || 800_000);
        const maxB = Number(limits.maxClassBOps || 8_000_000);

        if (addBytes > 0 && Number(usage.managed_bytes) + activeBytes + addBytes > maxBytes) {
          await client.query('rollback');
          return { ok: false, code: 'R2_STORAGE_QUOTA_LIMIT', usage };
        }
        if (op_class === 'class_a' && Number(usage.class_a_ops) + activeA + 1 > maxA) {
          await client.query('rollback');
          return { ok: false, code: 'R2_CLASS_A_QUOTA_LIMIT', usage };
        }
        if (op_class === 'class_b' && Number(usage.class_b_ops) + activeB + 1 > maxB) {
          await client.query('rollback');
          return { ok: false, code: 'R2_CLASS_B_QUOTA_LIMIT', usage };
        }

        const expiresAt = new Date(Date.now() + Math.max(10, Number(ttl_seconds) || 180) * 1000);
        const { rows: resvRows } = await client.query(
          `insert into r2_quota_reservations (id, idempotency_key, month, operation, op_class, reserved_bytes, state, expires_at)
           values ($1, $2, $3, $4, $5, $6, 'reserved', $7)
           returning *`,
          [randomUUID(), idempotency_key, month, operation, op_class, addBytes, expiresAt],
        );
        await client.query('commit');
        return { ok: true, duplicate: false, reservation: resvRows[0], usage };
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async commit(id, { actual_bytes = null } = {}) {
      if (!isUuid(id)) return null;
      const client = await pool.connect();
      try {
        await client.query('begin');
        const { rows } = await client.query('select * from r2_quota_reservations where id = $1 for update', [id]);
        const r = rows[0];
        if (!r || r.state !== 'reserved') {
          await client.query('commit');
          return r || null;
        }
        const addBytes = actual_bytes != null ? Math.max(0, Math.trunc(Number(actual_bytes) || 0)) : Number(r.reserved_bytes || 0);
        const addObj = addBytes > 0 ? 1 : 0;
        const addA = r.op_class === 'class_a' ? 1 : 0;
        const addB = r.op_class === 'class_b' ? 1 : 0;

        await client.query(
          `update r2_monthly_usage
              set managed_bytes = managed_bytes + $2,
                  object_count = object_count + $3,
                  class_a_ops = class_a_ops + $4,
                  class_b_ops = class_b_ops + $5,
                  updated_at = now()
            where month = $1`,
          [r.month, addBytes, addObj, addA, addB],
        );
        const { rows: updated } = await client.query(
          `update r2_quota_reservations set state = 'committed', updated_at = now() where id = $1 returning *`,
          [id],
        );
        await client.query('commit');
        return updated[0];
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async release(id, { billable_request_sent = false } = {}) {
      if (!isUuid(id)) return null;
      const client = await pool.connect();
      try {
        await client.query('begin');
        const { rows } = await client.query('select * from r2_quota_reservations where id = $1 for update', [id]);
        const r = rows[0];
        if (!r || r.state !== 'reserved') {
          await client.query('commit');
          return r || null;
        }
        if (billable_request_sent) {
          const addA = r.op_class === 'class_a' ? 1 : 0;
          const addB = r.op_class === 'class_b' ? 1 : 0;
          await client.query(
            `update r2_monthly_usage
                set class_a_ops = class_a_ops + $2,
                    class_b_ops = class_b_ops + $3,
                    updated_at = now()
              where month = $1`,
            [r.month, addA, addB],
          );
        }
        const { rows: updated } = await client.query(
          `update r2_quota_reservations set state = 'released', updated_at = now() where id = $1 returning *`,
          [id],
        );
        await client.query('commit');
        return updated[0];
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async recordDelete({ month, bytes = 0 }) {
      const dropBytes = Math.max(0, Math.trunc(Number(bytes) || 0));
      await pool.query(
        `insert into r2_monthly_usage (month) values ($1) on conflict (month) do nothing`,
        [month],
      );
      await pool.query(
        `update r2_monthly_usage
            set managed_bytes = greatest(0, managed_bytes - $2),
                object_count = greatest(0, object_count - 1),
                updated_at = now()
          where month = $1`,
        [month, dropBytes],
      );
    },

    async reconcile({ month, provider_storage_bytes = null, provider_class_a_ops = null, provider_class_b_ops = null, status = 'ok', halt = false }) {
      await pool.query(`insert into r2_monthly_usage (month) values ($1) on conflict (month) do nothing`, [month]);
      const { rows } = await pool.query(
        `update r2_monthly_usage
            set managed_bytes = greatest(managed_bytes, coalesce($2, managed_bytes)),
                class_a_ops = greatest(class_a_ops, coalesce($3, class_a_ops)),
                class_b_ops = greatest(class_b_ops, coalesce($4, class_b_ops)),
                reconciled_storage_bytes = $2,
                reconciled_class_a_ops = $3,
                reconciled_class_b_ops = $4,
                reconciliation_status = $5,
                last_reconciled_at = now(),
                quota_halted = $6,
                updated_at = now()
          where month = $1
          returning *`,
        [month, provider_storage_bytes, provider_class_a_ops, provider_class_b_ops, status, Boolean(halt)],
      );
      return rows[0];
    },

    async getSnapshot(month) {
      await pool.query(`insert into r2_monthly_usage (month) values ($1) on conflict (month) do nothing`, [month]);
      await pool.query(
        `update r2_quota_reservations set state = 'expired', updated_at = now()
          where month = $1 and state = 'reserved' and expires_at <= now()`,
        [month],
      );
      const { rows: uRows } = await pool.query('select * from r2_monthly_usage where month = $1', [month]);
      const { rows: aRows } = await pool.query(
        `select coalesce(sum(reserved_bytes), 0)::bigint as reserved_bytes,
                count(*) filter (where op_class = 'class_a')::bigint as reserved_a,
                count(*) filter (where op_class = 'class_b')::bigint as reserved_b
           from r2_quota_reservations
          where month = $1 and state = 'reserved'`,
        [month],
      );
      const u = uRows[0];
      return {
        month: u.month,
        managed_bytes: Number(u.managed_bytes || 0),
        reserved_bytes: Number(aRows[0]?.reserved_bytes || 0),
        object_count: Number(u.object_count || 0),
        class_a_ops: Number(u.class_a_ops || 0),
        reserved_class_a_ops: Number(aRows[0]?.reserved_a || 0),
        class_b_ops: Number(u.class_b_ops || 0),
        reserved_class_b_ops: Number(aRows[0]?.reserved_b || 0),
        reconciled_storage_bytes: u.reconciled_storage_bytes != null ? Number(u.reconciled_storage_bytes) : null,
        reconciled_class_a_ops: u.reconciled_class_a_ops != null ? Number(u.reconciled_class_a_ops) : null,
        reconciled_class_b_ops: u.reconciled_class_b_ops != null ? Number(u.reconciled_class_b_ops) : null,
        reconciliation_status: u.reconciliation_status,
        last_reconciled_at: u.last_reconciled_at,
        quota_halted: Boolean(u.quota_halted),
      };
    },
  };

  const objectStorageUsage = {
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
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(
          `insert into object_storage_monthly_usage (provider, month) values ($1, $2) on conflict (provider, month) do nothing`,
          [provider, month],
        );
        const { rows: uRows } = await client.query(
          'select * from object_storage_monthly_usage where provider = $1 and month = $2 for update',
          [provider, month],
        );
        const usage = uRows[0];

        if (idempotency_key) {
          const { rows: dupRows } = await client.query(
            'select * from object_storage_quota_reservations where idempotency_key = $1',
            [idempotency_key],
          );
          if (dupRows[0]) {
            await client.query('commit');
            return { ok: true, duplicate: true, reservation: dupRows[0], usage };
          }
        }

        await client.query(
          `update object_storage_quota_reservations
              set state = 'expired', updated_at = now()
            where provider = $1 and month = $2 and state = 'reserved' and expires_at <= now()`,
          [provider, month],
        );

        const { rows: aRows } = await client.query(
          `select coalesce(sum(reserved_bytes), 0)::bigint as reserved_bytes,
                  coalesce(sum(reserved_requests), 0)::bigint as reserved_requests,
                  coalesce(sum(reserved_outbound_bytes), 0)::bigint as reserved_outbound_bytes
             from object_storage_quota_reservations
            where provider = $1 and month = $2 and state = 'reserved'`,
          [provider, month],
        );
        const activeBytes = Number(aRows[0]?.reserved_bytes || 0);
        const activeReqs = Number(aRows[0]?.reserved_requests || 0);
        const activeOut = Number(aRows[0]?.reserved_outbound_bytes || 0);

        const addBytes = Math.max(0, Math.trunc(Number(bytes) || 0));
        const addReqs = Math.max(0, Math.trunc(Number(requests) || 0));
        const addOut = Math.max(0, Math.trunc(Number(outbound_bytes) || 0));

        const maxBytes = Number(limits.maxManagedBytes || 16 * 1024 * 1024 * 1024);
        const maxReqs = Number(limits.maxApiRequests || 40_000);
        const maxOut = Number(limits.maxOutboundBytes || 8 * 1024 * 1024 * 1024 * 1024);

        if (addBytes > 0 && Number(usage.managed_bytes) + activeBytes + addBytes > maxBytes) {
          await client.query('rollback');
          return { ok: false, code: 'OBJECT_STORAGE_CAPACITY_LIMIT', usage };
        }
        if (addReqs > 0 && Number(usage.api_requests) + activeReqs + addReqs > maxReqs) {
          await client.query('rollback');
          return { ok: false, code: 'OBJECT_STORAGE_REQUEST_LIMIT', usage };
        }
        if (addOut > 0 && Number(usage.outbound_bytes) + activeOut + addOut > maxOut) {
          await client.query('rollback');
          return { ok: false, code: 'OBJECT_STORAGE_OUTBOUND_LIMIT', usage };
        }

        const expiresAt = new Date(Date.now() + Math.max(1, Number(ttl_seconds) || 180) * 1000);
        const { rows: resvRows } = await client.query(
          `insert into object_storage_quota_reservations
             (id, idempotency_key, provider, month, operation, reserved_bytes, reserved_requests, reserved_outbound_bytes, state, expires_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, 'reserved', $9)
           returning *`,
          [randomUUID(), idempotency_key, provider, month, operation, addBytes, addReqs, addOut, expiresAt],
        );
        await client.query('commit');
        return { ok: true, duplicate: false, reservation: resvRows[0], usage };
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async commit(id, { actual_bytes = null, actual_outbound_bytes = null, object_delta = null } = {}) {
      if (!isUuid(id)) return null;
      const client = await pool.connect();
      try {
        await client.query('begin');
        const { rows } = await client.query('select * from object_storage_quota_reservations where id = $1 for update', [id]);
        const r = rows[0];
        if (!r || r.state !== 'reserved') {
          await client.query('commit');
          return r || null;
        }
        const addBytes = actual_bytes != null ? Math.trunc(Number(actual_bytes) || 0) : Number(r.reserved_bytes || 0);
        const addOut = actual_outbound_bytes != null ? Math.max(0, Math.trunc(Number(actual_outbound_bytes) || 0)) : Number(r.reserved_outbound_bytes || 0);
        const objDelta = object_delta != null ? Math.trunc(Number(object_delta) || 0) : (addBytes > 0 ? 1 : 0);
        const addReqs = Number(r.reserved_requests || 0);

        await client.query(
          `update object_storage_monthly_usage
              set managed_bytes = greatest(0, managed_bytes + $3),
                  object_count = greatest(0, object_count + $4),
                  api_requests = api_requests + $5,
                  outbound_bytes = outbound_bytes + $6,
                  updated_at = now()
            where provider = $1 and month = $2`,
          [r.provider, r.month, addBytes, objDelta, addReqs, addOut],
        );
        const { rows: updated } = await client.query(
          `update object_storage_quota_reservations set state = 'committed', updated_at = now() where id = $1 returning *`,
          [id],
        );
        await client.query('commit');
        return updated[0];
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async release(id, { billable_request_sent = false } = {}) {
      if (!isUuid(id)) return null;
      const client = await pool.connect();
      try {
        await client.query('begin');
        const { rows } = await client.query('select * from object_storage_quota_reservations where id = $1 for update', [id]);
        const r = rows[0];
        if (!r || r.state !== 'reserved') {
          await client.query('commit');
          return r || null;
        }
        if (billable_request_sent) {
          await client.query(
            `update object_storage_monthly_usage
                set api_requests = api_requests + $3,
                    updated_at = now()
              where provider = $1 and month = $2`,
            [r.provider, r.month, Number(r.reserved_requests || 1)],
          );
        }
        const { rows: updated } = await client.query(
          `update object_storage_quota_reservations set state = 'released', updated_at = now() where id = $1 returning *`,
          [id],
        );
        await client.query('commit');
        return updated[0];
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async recordDelete({ provider = 'oci', month, bytes = 0 }) {
      const dropBytes = Math.max(0, Math.trunc(Number(bytes) || 0));
      await pool.query(
        `insert into object_storage_monthly_usage (provider, month) values ($1, $2) on conflict (provider, month) do nothing`,
        [provider, month],
      );
      await pool.query(
        `update object_storage_monthly_usage
            set managed_bytes = greatest(0, managed_bytes - $3),
                object_count = greatest(0, object_count - 1),
                updated_at = now()
          where provider = $1 and month = $2`,
        [provider, month, dropBytes],
      );
    },

    async getSnapshot({ provider = 'oci', month }) {
      await pool.query(
        `insert into object_storage_monthly_usage (provider, month) values ($1, $2) on conflict (provider, month) do nothing`,
        [provider, month],
      );
      await pool.query(
        `update object_storage_quota_reservations set state = 'expired', updated_at = now()
          where provider = $1 and month = $2 and state = 'reserved' and expires_at <= now()`,
        [provider, month],
      );
      const { rows: uRows } = await pool.query(
        'select * from object_storage_monthly_usage where provider = $1 and month = $2',
        [provider, month],
      );
      const { rows: aRows } = await pool.query(
        `select coalesce(sum(reserved_bytes), 0)::bigint as reserved_bytes,
                coalesce(sum(reserved_requests), 0)::bigint as reserved_requests,
                coalesce(sum(reserved_outbound_bytes), 0)::bigint as reserved_outbound_bytes
           from object_storage_quota_reservations
          where provider = $1 and month = $2 and state = 'reserved'`,
        [provider, month],
      );
      const u = uRows[0];
      return {
        provider: u.provider,
        month: u.month,
        managed_bytes: Number(u.managed_bytes || 0),
        reserved_bytes: Number(aRows[0]?.reserved_bytes || 0),
        object_count: Number(u.object_count || 0),
        api_requests: Number(u.api_requests || 0),
        reserved_requests: Number(aRows[0]?.reserved_requests || 0),
        outbound_bytes: Number(u.outbound_bytes || 0),
        reserved_outbound_bytes: Number(aRows[0]?.reserved_outbound_bytes || 0),
      };
    },
  };

  async function healthCheck() {
    const started = Date.now();
    try {
      await pool.query('select 1');
      const version = await getSchemaVersion(pool);
      return {
        ok: true,
        driver: 'postgresql',
        schema_version: version,
        latency_ms: Date.now() - started,
        pool: {
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
        },
      };
    } catch (err) {
      return {
        ok: false,
        driver: 'postgresql',
        schema_version: schemaVersion,
        latency_ms: Date.now() - started,
        error: err.message,
      };
    }
  }

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
    driver: 'postgresql',
    schemaVersion,
    healthCheck,
    close: () => pool.end(),
  };
}
