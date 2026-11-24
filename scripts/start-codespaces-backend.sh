#!/usr/bin/env bash
# RUNUT GitHub Codespaces Production Startup Script
# - Uses GitHub Codespaces Secrets (preferred) or optional untracked server/.env fallback
# - Never prints secret values
# - Verifies Node.js 24, LibreOffice, and Neon PostgreSQL Migration v8 before listening on 0.0.0.0:8080
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Load optional untracked server/.env ONLY for variables not already set by Codespaces Secrets
if [ -f "server/.env" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    key="${line%%=*}"
    val="${line#*=}"
    if [ -n "$key" ] && [ -z "${!key:-}" ]; then
      export "$key=$val"
    fi
  done < "server/.env"
fi

# Enforce safe zero-cost production defaults
export NODE_ENV="${NODE_ENV:-production}"
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-8080}"
export DATABASE_SSL="${DATABASE_SSL:-true}"
export PG_CONNECTION_TIMEOUT_MS="${PG_CONNECTION_TIMEOUT_MS:-10000}"
export OBJECT_STORAGE_PROVIDER="${OBJECT_STORAGE_PROVIDER:-postgres}"
export STRICT_STORAGE_QUOTA_MODE="${STRICT_STORAGE_QUOTA_MODE:-true}"
export MIDTRANS_IS_PRODUCTION="false"
export STRICT_FREE_AI_ONLY="true"
export COOKIE_SECURE="${COOKIE_SECURE:-true}"
export COOKIE_SAME_SITE="${COOKIE_SAME_SITE:-lax}"
export DOCX_PDF_CONVERSION_ENABLED="${DOCX_PDF_CONVERSION_ENABLED:-true}"

echo "=== RUNUT Runtime Check ==="
echo "node:    $(node --version)"
echo "npm:     $(npm --version)"
if command -v soffice >/dev/null 2>&1; then
  echo "soffice: $(command -v soffice) ($(soffice --version | head -n 1))"
else
  echo "soffice: NOT FOUND (DOC/DOCX->PDF conversion will be unavailable)"
fi

echo "=== Required Config Presence Check (values hidden) ==="
missing=0
for var in DATABASE_URL JWT_ACCESS_SECRET; do
  if [ -n "${!var:-}" ]; then
    echo "  [OK] $var is set"
  else
    echo "  [MISSING] $var is NOT set (configure in GitHub Settings -> Secrets and variables -> Codespaces)"
    missing=1
  fi
done

if [ -z "${FRONTEND_URL:-}" ]; then
  echo "  [WARN] FRONTEND_URL is not set yet (set to https://<your-project>.pages.dev after Cloudflare Pages deploy)"
fi

if [ "$missing" -ne 0 ]; then
  echo "ERROR: Required secrets missing. Stopping before server startup."
  exit 1
fi

echo "=== Verifying Neon PostgreSQL Connectivity & Migration v8 ==="
node -e "
  import('./server/src/repositories/index.js').then(async (m) => {
    await m.initStorage(process.env.DATABASE_URL);
    const h = await m.healthCheck();
    await m.closeStorage();
    console.log(JSON.stringify({ db_ok: h.ok, driver: h.driver, schema_version: h.schema_version }));
    if (!h.ok || h.driver !== 'postgresql' || h.schema_version < 8) {
      console.error('Database migration v8 check failed');
      process.exit(1);
    }
  }).catch((err) => {
    console.error('Database connectivity failed:', err.message);
    process.exit(1);
  });
"

echo "=== Starting RUNUT Express API on ${HOST}:${PORT} ==="
echo "Reminder: In Codespaces PORTS panel, set port ${PORT} Visibility to Public for Cloudflare Pages Functions."
exec node server/src/index.js
