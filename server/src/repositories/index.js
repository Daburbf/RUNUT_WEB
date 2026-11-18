import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryRepositories } from './memory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DEV_FILE = path.resolve(__dirname, '../../.data/runut-storage.json');

const memory = createMemoryRepositories({
  persistPath: process.env.RUNUT_STORAGE_FILE || null,
});

const active = {
  users: memory.users,
  tokenTransactions: memory.tokenTransactions,
  refreshTokens: memory.refreshTokens,
  documents: memory.documents,
  analyses: memory.analyses,
  issues: memory.issues,
  payments: memory.payments,
};

const delegate = (name) => new Proxy({}, {
  get: (_target, prop) => active[name][prop]?.bind(active[name]),
});

export const users = delegate('users');
export const tokenTransactions = delegate('tokenTransactions');
export const refreshTokens = delegate('refreshTokens');
export const documents = delegate('documents');
export const analyses = delegate('analyses');
export const issues = delegate('issues');
export const payments = delegate('payments');

export const storage = {
  driver: memory.driver,
  detail: memory.persistPath
    ? `berkas lokal (${memory.persistPath})`
    : 'memori sementara (hilang saat server dimatikan)',
  note: 'Isi DATABASE_URL untuk memakai PostgreSQL.',
};

// Dipanggil saat startup atau pengujian.
// Di production, PostgreSQL wajib dipakai (tidak boleh jatuh diam-diam ke memori).
export async function initStorage(url = process.env.DATABASE_URL || '', options = {}) {
  const isProd = (options.env || process.env.NODE_ENV) === 'production';
  const persistPath = options.persistPath !== undefined
    ? options.persistPath
    : (process.env.RUNUT_STORAGE_FILE || (process.env.NODE_ENV !== 'test' ? DEFAULT_DEV_FILE : null));

  if (!url) {
    if (isProd) {
      throw new Error('DATABASE_URL wajib dikonfigurasi di production. Penyimpanan memori tidak diizinkan di production.');
    }
    const repo = createMemoryRepositories({ persistPath });
    for (const name of Object.keys(active)) active[name] = repo[name];
    storage.driver = repo.driver;
    delete storage.error;
    storage.detail = persistPath
      ? `berkas persisten lokal (${path.basename(persistPath)})`
      : 'memori sementara (hilang saat server dimatikan)';
    storage.note = 'Isi DATABASE_URL untuk memakai PostgreSQL.';
    return storage;
  }

  try {
    const { createPostgresRepositories } = await import('./postgres.js');
    const pg = await createPostgresRepositories(url);
    for (const name of Object.keys(active)) active[name] = pg[name];
    storage.driver = 'postgresql';
    delete storage.error;
    storage.detail = 'PostgreSQL (users, token_transactions, documents, analysis_results, issues, refresh_tokens, payments)';
    storage.note = 'Seluruh data website dan ledger token tersimpan di PostgreSQL.';
  } catch (err) {
    if (isProd) {
      throw new Error(`Koneksi PostgreSQL gagal di production: ${err.message}`);
    }
    const repo = createMemoryRepositories({ persistPath });
    for (const name of Object.keys(active)) active[name] = repo[name];
    storage.driver = repo.driver;
    storage.error = err.message;
    storage.detail = `memori sementara (hilang saat server dimatikan) - PostgreSQL tidak terpakai: ${err.message}`;
    storage.note = 'Perbaiki DATABASE_URL lalu jalankan ulang server untuk memakai PostgreSQL.';
    console.warn(`[storage] DATABASE_URL diisi tetapi PostgreSQL tidak terpakai (${err.message}) - memakai penyimpanan lokal.`);
  }
  return storage;
}

export default {
  users,
  tokenTransactions,
  refreshTokens,
  documents,
  analyses,
  issues,
  payments,
};
