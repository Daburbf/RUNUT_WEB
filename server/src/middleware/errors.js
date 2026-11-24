import { randomUUID } from 'node:crypto';

export function attachRequestId(req, res, next) {
  const incoming = String(req.headers['x-request-id'] || '').trim().replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64);
  req.requestId = incoming || randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export class HttpError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.status = status;
    this.details = details;
    this.code = details.code;
    this.retryable = details.retryable;
    this.isHttp = true;
  }
}

// Penanganan error terpusat: bentuk respons konsisten dengan request_id,
// tanpa bocor stack trace, path internal, atau kredensial ke klien.
export function errorHandler(err, req, res, _next) {
  const requestId = req?.requestId || undefined;

  if (err && err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: 'Ukuran file melebihi batas maksimum unggahan (5 MB).',
        code: 'FILE_TOO_LARGE',
        request_id: requestId,
      });
    }
    return res.status(400).json({
      error: 'Unggahan file tidak valid atau melebihi batas jumlah file.',
      code: err.code || 'UPLOAD_ERROR',
      request_id: requestId,
    });
  }

  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: 'Format JSON permintaan tidak valid.',
      code: 'INVALID_JSON',
      request_id: requestId,
    });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Ukuran payload permintaan melebihi batas maksimum.',
      code: 'PAYLOAD_TOO_LARGE',
      request_id: requestId,
    });
  }

  const known = Boolean(err?.isHttp) && Number.isInteger(err.status);
  const status = known ? err.status : 500;
  if (!known || status >= 500) {
    console.error(JSON.stringify({
      event: 'api_error',
      request_id: requestId,
      status,
      code: err?.code || 'INTERNAL_ERROR',
      path: req?.originalUrl || req?.url,
      reason: err?.message || 'Unknown error',
    }));
  }
  res.status(status).json({
    error: known ? (err.message || 'Permintaan tidak valid.') : 'Terjadi kesalahan pada server.',
    code: known ? (err.code || undefined) : 'INTERNAL_ERROR',
    request_id: requestId,
    details: known ? (err.details || undefined) : undefined,
  });
}

export function notFound(req, res) {
  res.status(404).json({
    error: 'Endpoint tidak ditemukan.',
    code: 'NOT_FOUND',
    request_id: req?.requestId || undefined,
  });
}
