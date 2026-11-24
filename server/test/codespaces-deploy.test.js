// GitHub Codespaces + Neon Free + Cloudflare Pages Deployment Config Verification Tests
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

test('Codespaces 1: .devcontainer/devcontainer.json uses Node 24, lockfile npm ci for root & server, LibreOffice, and forwards only port 8080', () => {
  const raw = readFileSync(path.join(REPO_ROOT, '.devcontainer/devcontainer.json'), 'utf8');
  const cfg = JSON.parse(raw);
  assert.match(cfg.image, /javascript-node:.*24/);
  assert.match(cfg.postCreateCommand, /libreoffice-writer/);
  assert.match(cfg.postCreateCommand, /fonts-dejavu/);
  assert.match(cfg.postCreateCommand, /fonts-noto-core/);
  assert.match(cfg.postCreateCommand, /npm ci && npm ci --prefix server/);
  assert.deepEqual(cfg.forwardPorts, [8080]);
  assert.equal(cfg.forwardPorts.includes(5432), false, 'PostgreSQL port 5432 must never be forwarded publicly');
  assert.equal(cfg.containerEnv.HOST, '0.0.0.0');
  assert.equal(cfg.containerEnv.PORT, '8080');
  assert.equal(cfg.containerEnv.OBJECT_STORAGE_PROVIDER, 'postgres');
  assert.equal(cfg.containerEnv.MIDTRANS_IS_PRODUCTION, 'false');
  assert.equal(cfg.containerEnv.STRICT_FREE_AI_ONLY, 'true');
  assert.equal(cfg.containerEnv.COOKIE_SECURE, 'true');
  assert.equal(cfg.containerEnv.COOKIE_SAME_SITE, 'lax');
});

test('Codespaces 2: scripts/start-codespaces-backend.sh enforces safe defaults, checks Migration v8, binds 0.0.0.0:8080, and never prints secrets', () => {
  const script = readFileSync(path.join(REPO_ROOT, 'scripts/start-codespaces-backend.sh'), 'utf8');
  assert.match(script, /HOST="\$\{HOST:-0\.0\.0\.0\}"/);
  assert.match(script, /PORT="\$\{PORT:-8080\}"/);
  assert.match(script, /OBJECT_STORAGE_PROVIDER="\$\{OBJECT_STORAGE_PROVIDER:-postgres\}"/);
  assert.match(script, /MIDTRANS_IS_PRODUCTION="false"/);
  assert.match(script, /STRICT_FREE_AI_ONLY="true"/);
  assert.match(script, /schema_version < 8/);
  assert.match(script, /exec node server\/src\/index\.js/);
  assert.doesNotMatch(script, /echo.*\$DATABASE_URL/i, 'Startup script must never print DATABASE_URL');
  assert.doesNotMatch(script, /echo.*\$JWT_ACCESS_SECRET/i, 'Startup script must never print JWT_ACCESS_SECRET');
});
