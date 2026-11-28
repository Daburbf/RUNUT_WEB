// Sistem migrasi SQL berversi dan idempotent untuk PostgreSQL.
// Menggunakan PostgreSQL advisory lock agar aman saat multi-instance / rolling deploy.

const MIGRATION_LOCK_ID = 728194651;

export const MIGRATIONS = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      create or replace function set_updated_at()
      returns trigger as $$
      begin
        new.updated_at = now();
        return new;
      end;
      $$ language plpgsql;

      create table if not exists users (
        id uuid primary key,
        name text not null,
        email text not null,
        password_hash text,
        token_balance integer not null default 0 check (token_balance >= 0),
        email_verified boolean not null default true,
        google_id text,
        auth_provider text not null default 'local' check (auth_provider in ('local', 'google')),
        reset_token_hash text,
        reset_token_expires_at timestamptz,
        otp_code_hash text,
        otp_purpose text check (otp_purpose is null or otp_purpose in ('verify_email', 'reset_password')),
        otp_expires_at timestamptz,
        otp_attempts integer not null default 0 check (otp_attempts >= 0),
        otp_sent_at timestamptz,
        token_version integer not null default 0 check (token_version >= 0),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create unique index if not exists users_email_key on users (lower(email));
      create unique index if not exists users_google_id_key on users (google_id) where google_id is not null;
      create index if not exists users_reset_token_hash_idx on users (reset_token_hash) where reset_token_hash is not null;

      create table if not exists token_transactions (
        id uuid primary key,
        user_id uuid not null references users(id) on delete cascade,
        type text not null check (type in ('purchase', 'usage', 'refund')),
        amount integer not null check (amount <> 0),
        balance_after integer not null check (balance_after >= 0),
        description text not null,
        reference_type text,
        reference_id text,
        idempotency_key text,
        meta jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      );
      create index if not exists token_transactions_user_idx on token_transactions (user_id, created_at desc);
      create unique index if not exists token_transactions_idempotency_idx
        on token_transactions (user_id, idempotency_key)
        where idempotency_key is not null;

      create table if not exists documents (
        id uuid primary key,
        user_id uuid not null references users(id) on delete cascade,
        title text not null,
        original_text text not null,
        revised_text text,
        word_count integer not null default 0 check (word_count >= 0),
        token_cost integer not null default 0 check (token_cost >= 0),
        file_name text,
        status text not null default 'analyzed' check (status in ('analyzed', 'revising', 'completed')),
        expires_at timestamptz,
        last_analyzed_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index if not exists documents_user_updated_idx on documents (user_id, updated_at desc);
      create index if not exists documents_expires_at_idx on documents (expires_at) where expires_at is not null;

      create table if not exists analysis_results (
        id uuid primary key,
        document_id uuid not null references documents(id) on delete cascade,
        stats jsonb not null default '{}'::jsonb,
        token_cost integer not null default 0 check (token_cost >= 0),
        idempotency_key text,
        ai_provider text,
        ai_model text,
        ai_latency_ms integer check (ai_latency_ms is null or ai_latency_ms >= 0),
        ai_status text,
        created_at timestamptz not null default now()
      );
      create index if not exists analysis_results_document_idx on analysis_results (document_id, created_at desc, id desc);

      create table if not exists issues (
        id uuid primary key,
        analysis_id uuid not null references analysis_results(id) on delete cascade,
        category text not null,
        start_pos integer not null default 0 check (start_pos >= 0),
        end_pos integer not null default 0 check (end_pos >= start_pos),
        snippet text,
        explanation text,
        suggestion text,
        needs_manual_review boolean not null default false,
        review_reasons jsonb not null default '[]'::jsonb,
        evidence jsonb,
        decision text not null default 'active' check (decision in ('active', 'applied', 'rejected')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index if not exists issues_analysis_idx on issues (analysis_id, start_pos, created_at);

      create table if not exists payments (
        id uuid primary key,
        user_id uuid not null references users(id) on delete cascade,
        order_id text not null,
        package_id text,
        package_label text,
        token_amount integer not null default 0 check (token_amount >= 0),
        method text not null,
        method_label text,
        channel text,
        amount integer not null check (amount > 0),
        status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'expired', 'cancelled', 'refunded')),
        provider text,
        provider_ref text,
        instructions jsonb not null default '{}'::jsonb,
        expires_at timestamptz,
        paid_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create unique index if not exists payments_order_id_key on payments (order_id);
      create index if not exists payments_user_idx on payments (user_id, created_at desc);
      create index if not exists payments_pending_expires_idx
        on payments (expires_at)
        where status = 'pending' and expires_at is not null;

      create table if not exists refresh_tokens (
        id uuid primary key,
        user_id uuid not null references users(id) on delete cascade,
        token_hash text not null,
        expires_at timestamptz not null,
        user_agent text,
        revoked_at timestamptz,
        created_at timestamptz not null default now()
      );
      create unique index if not exists refresh_tokens_token_hash_key on refresh_tokens (token_hash);
      create index if not exists refresh_tokens_user_active_idx on refresh_tokens (user_id) where revoked_at is null;
      create index if not exists refresh_tokens_expires_at_idx on refresh_tokens (expires_at);
    `,
  },
  {
    version: 2,
    name: 'cleanup_legacy_columns_and_harden_constraints',
    sql: `
      -- Pastikan kolom baru tersedia pada database lama sebelum menambah constraint.
      alter table users alter column password_hash drop not null;
      alter table users add column if not exists token_balance integer not null default 0;
      alter table users add column if not exists email_verified boolean not null default true;
      alter table users add column if not exists google_id text;
      alter table users add column if not exists auth_provider text not null default 'local';
      alter table users add column if not exists otp_code_hash text;
      alter table users add column if not exists otp_purpose text;
      alter table users add column if not exists otp_expires_at timestamptz;
      alter table users add column if not exists otp_attempts integer not null default 0;
      alter table users add column if not exists otp_sent_at timestamptz;
      alter table users add column if not exists token_version integer not null default 0;
      alter table documents add column if not exists token_cost integer not null default 0;
      alter table analysis_results add column if not exists token_cost integer not null default 0;
      alter table analysis_results add column if not exists idempotency_key text;
      alter table payments add column if not exists order_id text;
      alter table payments add column if not exists package_id text;
      alter table payments add column if not exists package_label text;
      alter table payments add column if not exists token_amount integer not null default 0;
      alter table payments add column if not exists method text;
      alter table payments add column if not exists method_label text;
      alter table payments add column if not exists channel text;
      alter table payments add column if not exists provider text;
      alter table payments add column if not exists instructions jsonb not null default '{}'::jsonb;
      alter table payments add column if not exists expires_at timestamptz;
      alter table payments add column if not exists paid_at timestamptz;

      -- Hapus kolom legacy dari sistem langganan lama yang sudah tidak dipakai.
      alter table users drop column if exists is_premium;
      alter table users drop column if exists premium_until;
      alter table payments drop column if exists premium_days;
      alter table analysis_results drop column if exists locked;

      -- Ganti index lama refresh_tokens yang non-unique dengan unique index.
      drop index if exists refresh_tokens_token_hash_idx;
      drop index if exists refresh_tokens_user_id_idx;
      create unique index if not exists refresh_tokens_token_hash_key on refresh_tokens (token_hash);
      create index if not exists refresh_tokens_user_active_idx on refresh_tokens (user_id) where revoked_at is null;
      create index if not exists refresh_tokens_expires_at_idx on refresh_tokens (expires_at);
      create index if not exists users_reset_token_hash_idx on users (reset_token_hash) where reset_token_hash is not null;
      create index if not exists documents_expires_at_idx on documents (expires_at) where expires_at is not null;
      create index if not exists payments_pending_expires_idx
        on payments (expires_at)
        where status = 'pending' and expires_at is not null;

      -- Tambahkan trigger otomatis updated_at untuk tabel mutable.
      drop trigger if exists trg_users_updated_at on users;
      create trigger trg_users_updated_at before update on users
        for each row execute function set_updated_at();

      drop trigger if exists trg_documents_updated_at on documents;
      create trigger trg_documents_updated_at before update on documents
        for each row execute function set_updated_at();

      drop trigger if exists trg_issues_updated_at on issues;
      create trigger trg_issues_updated_at before update on issues
        for each row execute function set_updated_at();

      drop trigger if exists trg_payments_updated_at on payments;
      create trigger trg_payments_updated_at before update on payments
        for each row execute function set_updated_at();

      -- Tambahkan CHECK constraints secara idempotent untuk database yang sudah terlanjur ada.
      do $$
      begin
        if not exists (select 1 from pg_constraint where conname = 'chk_users_token_balance_nonneg') then
          alter table users add constraint chk_users_token_balance_nonneg check (token_balance >= 0) not valid;
          alter table users validate constraint chk_users_token_balance_nonneg;
        end if;
        if not exists (select 1 from pg_constraint where conname = 'chk_users_auth_provider') then
          alter table users add constraint chk_users_auth_provider check (auth_provider in ('local', 'google')) not valid;
          alter table users validate constraint chk_users_auth_provider;
        end if;
        if not exists (select 1 from pg_constraint where conname = 'chk_token_tx_type') then
          alter table token_transactions add constraint chk_token_tx_type check (type in ('purchase', 'usage', 'refund')) not valid;
          alter table token_transactions validate constraint chk_token_tx_type;
        end if;
        if not exists (select 1 from pg_constraint where conname = 'chk_token_tx_balance_nonneg') then
          alter table token_transactions add constraint chk_token_tx_balance_nonneg check (balance_after >= 0) not valid;
          alter table token_transactions validate constraint chk_token_tx_balance_nonneg;
        end if;
        if not exists (select 1 from pg_constraint where conname = 'chk_documents_status') then
          alter table documents add constraint chk_documents_status check (status in ('analyzed', 'revising', 'completed')) not valid;
          alter table documents validate constraint chk_documents_status;
        end if;
        if not exists (select 1 from pg_constraint where conname = 'chk_issues_decision') then
          alter table issues add constraint chk_issues_decision check (decision in ('active', 'applied', 'rejected')) not valid;
          alter table issues validate constraint chk_issues_decision;
        end if;
        if not exists (select 1 from pg_constraint where conname = 'chk_issues_pos_range') then
          alter table issues add constraint chk_issues_pos_range check (start_pos >= 0 and end_pos >= start_pos) not valid;
          alter table issues validate constraint chk_issues_pos_range;
        end if;
        if not exists (select 1 from pg_constraint where conname = 'chk_payments_status') then
          alter table payments add constraint chk_payments_status check (status in ('pending', 'paid', 'failed', 'expired', 'cancelled', 'refunded')) not valid;
          alter table payments validate constraint chk_payments_status;
        end if;
        if not exists (select 1 from pg_constraint where conname = 'chk_payments_amount_pos') then
          alter table payments add constraint chk_payments_amount_pos check (amount > 0) not valid;
          alter table payments validate constraint chk_payments_amount_pos;
        end if;
      end $$;
    `,
  },
  {
    version: 3,
    name: 'download_transactions_two_phase_reservation',
    sql: `
      create table if not exists download_transactions (
        id uuid primary key,
        user_id uuid not null references users(id) on delete cascade,
        document_id uuid not null references documents(id) on delete cascade,
        export_format text not null check (export_format in ('txt', 'docx', 'pdf')),
        reserved_tokens integer not null check (reserved_tokens >= 0),
        committed_tokens integer not null default 0 check (committed_tokens >= 0),
        state text not null default 'pending' check (state in (
          'pending', 'reserved', 'file_prepared', 'save_confirmed',
          'committed', 'cancelled', 'expired', 'failed', 'refund_pending', 'refunded'
        )),
        idempotency_key text,
        failure_reason text,
        cancellation_reason text,
        refund_status text check (refund_status is null or refund_status in ('none', 'pending', 'refunded')),
        token_transaction_id uuid references token_transactions(id) on delete set null,
        expires_at timestamptz not null,
        confirmed_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index if not exists download_tx_user_idx on download_transactions (user_id, created_at desc);
      create unique index if not exists download_tx_idempotency_idx
        on download_transactions (user_id, idempotency_key)
        where idempotency_key is not null;
      create index if not exists download_tx_active_user_idx
        on download_transactions (user_id, expires_at)
        where state in ('pending', 'reserved', 'file_prepared', 'save_confirmed');
      create index if not exists download_tx_expires_idx
        on download_transactions (expires_at)
        where state in ('pending', 'reserved', 'file_prepared');

      drop trigger if exists trg_download_transactions_updated_at on download_transactions;
      create trigger trg_download_transactions_updated_at before update on download_transactions
        for each row execute function set_updated_at();
    `,
  },
  {
    version: 4,
    name: 'payments_qris_dynamic_expiration_and_reconciliation',
    sql: `
      alter table payments add column if not exists last_webhook_at timestamptz;
      alter table payments add column if not exists replaced_by_order_id text;
      alter table payments add column if not exists replaces_order_id text;
      alter table payments add column if not exists reconciliation_flag text;
    `,
  },
  {
    version: 5,
    name: 'document_files_persistent_storage',
    sql: `
      create table if not exists document_files (
        document_id uuid primary key references documents(id) on delete cascade,
        user_id uuid not null references users(id) on delete cascade,
        ext text not null check (ext in ('docx', 'pdf', 'doc', 'txt')),
        original_name text not null,
        size_bytes integer not null check (size_bytes > 0 and size_bytes <= 10485760),
        sha256 text not null,
        content bytea not null,
        created_at timestamptz not null default now()
      );
      create index if not exists document_files_user_idx on document_files (user_id, created_at desc);
    `,
  },
  {
    version: 6,
    name: 'document_files_cloudflare_r2_metadata',
    sql: `
      alter table document_files alter column content drop not null;
      alter table document_files add column if not exists storage_provider text not null default 'postgres' check (storage_provider in ('postgres', 'r2'));
      alter table document_files add column if not exists storage_key text;
    `,
  },
  {
    version: 7,
    name: 'r2_persistent_usage_quota_accounting',
    sql: `
      create table if not exists r2_monthly_usage (
        month text primary key,
        managed_bytes bigint not null default 0 check (managed_bytes >= 0),
        object_count integer not null default 0 check (object_count >= 0),
        class_a_ops bigint not null default 0 check (class_a_ops >= 0),
        class_b_ops bigint not null default 0 check (class_b_ops >= 0),
        reconciled_storage_bytes bigint,
        reconciled_class_a_ops bigint,
        reconciled_class_b_ops bigint,
        reconciliation_status text not null default 'unreconciled',
        last_reconciled_at timestamptz,
        quota_halted boolean not null default false,
        updated_at timestamptz not null default now()
      );

      create table if not exists r2_quota_reservations (
        id uuid primary key,
        idempotency_key text,
        month text not null references r2_monthly_usage(month) on delete cascade,
        operation text not null,
        op_class text not null check (op_class in ('class_a', 'class_b', 'free')),
        reserved_bytes bigint not null default 0 check (reserved_bytes >= 0),
        state text not null default 'reserved' check (state in ('reserved', 'committed', 'released', 'expired')),
        expires_at timestamptz not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create unique index if not exists r2_quota_reservations_idem_key
        on r2_quota_reservations (idempotency_key)
        where idempotency_key is not null;
      create index if not exists r2_quota_reservations_active_idx
        on r2_quota_reservations (month, state, expires_at)
        where state = 'reserved';

      drop trigger if exists trg_r2_monthly_usage_updated_at on r2_monthly_usage;
      create trigger trg_r2_monthly_usage_updated_at before update on r2_monthly_usage
        for each row execute function set_updated_at();

      drop trigger if exists trg_r2_quota_reservations_updated_at on r2_quota_reservations;
      create trigger trg_r2_quota_reservations_updated_at before update on r2_quota_reservations
        for each row execute function set_updated_at();
    `,
  },
  {
    version: 8,
    name: 'oci_object_storage_provider_and_persistent_quota',
    sql: `
      alter table document_files drop constraint if exists document_files_storage_provider_check;
      alter table document_files add constraint document_files_storage_provider_check
        check (storage_provider in ('postgres', 'r2', 'oci'));

      create table if not exists object_storage_monthly_usage (
        provider text not null check (provider in ('oci', 'r2')),
        month text not null,
        managed_bytes bigint not null default 0 check (managed_bytes >= 0),
        object_count integer not null default 0 check (object_count >= 0),
        api_requests bigint not null default 0 check (api_requests >= 0),
        outbound_bytes bigint not null default 0 check (outbound_bytes >= 0),
        updated_at timestamptz not null default now(),
        primary key (provider, month)
      );

      create table if not exists object_storage_quota_reservations (
        id uuid primary key,
        idempotency_key text,
        provider text not null,
        month text not null,
        operation text not null,
        reserved_bytes bigint not null default 0 check (reserved_bytes >= 0),
        reserved_requests integer not null default 1 check (reserved_requests >= 0),
        reserved_outbound_bytes bigint not null default 0 check (reserved_outbound_bytes >= 0),
        state text not null default 'reserved' check (state in ('reserved', 'committed', 'released', 'expired')),
        expires_at timestamptz not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        foreign key (provider, month) references object_storage_monthly_usage(provider, month) on delete cascade
      );
      create unique index if not exists obj_storage_resv_idem_key
        on object_storage_quota_reservations (idempotency_key)
        where idempotency_key is not null;
      create index if not exists obj_storage_resv_active_idx
        on object_storage_quota_reservations (provider, month, state, expires_at)
        where state = 'reserved';

      drop trigger if exists trg_obj_storage_usage_updated_at on object_storage_monthly_usage;
      create trigger trg_obj_storage_usage_updated_at before update on object_storage_monthly_usage
        for each row execute function set_updated_at();

      drop trigger if exists trg_obj_storage_resv_updated_at on object_storage_quota_reservations;
      create trigger trg_obj_storage_resv_updated_at before update on object_storage_quota_reservations
        for each row execute function set_updated_at();
    `,
  },
  {
    version: 9,
    name: 'ai_provider_quota_tracking',
    sql: `
      create table if not exists ai_provider_quotas (
        provider_id text not null,
        model_id text not null,
        remaining_requests integer,
        remaining_tokens integer,
        rate_limit_type text,
        reset_timestamp timestamptz,
        retry_after_seconds integer,
        last_successful_request timestamptz,
        last_failure timestamptz,
        last_error text,
        cooldown_until timestamptz,
        enabled boolean not null default true,
        updated_at timestamptz not null default now(),
        primary key (provider_id, model_id)
      );

      drop trigger if exists trg_ai_provider_quotas_updated_at on ai_provider_quotas;
      create trigger trg_ai_provider_quotas_updated_at before update on ai_provider_quotas
        for each row execute function set_updated_at();
    `,
  },
  {
    version: 10,
    name: 'token_transactions_bonus_type',
    sql: `
      alter table token_transactions drop constraint if exists token_transactions_type_check;
      alter table token_transactions drop constraint if exists chk_token_tx_type;
      alter table token_transactions add constraint chk_token_tx_type
        check (type in ('purchase', 'usage', 'refund', 'bonus'));
    `,
  },
  {
    version: 11,
    name: 'object_storage_monthly_usage_postgres_provider',
    sql: `
      alter table object_storage_monthly_usage drop constraint if exists object_storage_monthly_usage_provider_check;
      alter table object_storage_monthly_usage add constraint object_storage_monthly_usage_provider_check
        check (provider in ('oci', 'r2', 'postgres'));
    `,
  },
];

export async function runMigrations(pool) {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      create table if not exists schema_migrations (
        version integer primary key,
        name text not null,
        applied_at timestamptz not null default now()
      )
    `);
    const { rows } = await client.query('select version from schema_migrations order by version asc');
    const applied = new Set(rows.map((r) => Number(r.version)));

    const newlyApplied = [];
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      await client.query('begin');
      try {
        await client.query(migration.sql);
        await client.query(
          'insert into schema_migrations (version, name) values ($1, $2)',
          [migration.version, migration.name],
        );
        await client.query('commit');
        newlyApplied.push(migration.version);
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw new Error(`Migrasi v${migration.version} (${migration.name}) gagal: ${err.message}`);
      }
    }

    const latestVersion = MIGRATIONS.length ? MIGRATIONS[MIGRATIONS.length - 1].version : 0;
    return { latestVersion, newlyApplied };
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}

export async function getSchemaVersion(pool) {
  try {
    const { rows } = await pool.query('select coalesce(max(version), 0)::int as version from schema_migrations');
    return rows[0]?.version ?? 0;
  } catch {
    return 0;
  }
}
