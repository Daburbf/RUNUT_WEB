import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { payments, tokenTransactions } from '../repositories/index.js';
import { HttpError } from '../middleware/errors.js';
import { TOKEN_PACKAGES, findTokenPackage } from './tokens.js';

export const PAYMENT_METHODS = [
  { id: 'qris', label: 'QRIS', group: 'qris', note: 'Semua aplikasi: OVO, DANA, LinkAja, mobile banking', icon: 'fa-qrcode' },
  { id: 'va_bca', label: 'BCA Virtual Account', group: 'va', bank: 'bca', icon: 'fa-building-columns' },
  { id: 'va_bni', label: 'BNI Virtual Account', group: 'va', bank: 'bni', icon: 'fa-building-columns' },
  { id: 'va_bri', label: 'BRI Virtual Account', group: 'va', bank: 'bri', icon: 'fa-building-columns' },
  { id: 'va_permata', label: 'Permata Virtual Account', group: 'va', bank: 'permata', icon: 'fa-building-columns' },
  { id: 'gopay', label: 'GoPay', group: 'ewallet', provider: 'gopay', icon: 'fa-wallet' },
  { id: 'shopeepay', label: 'ShopeePay', group: 'ewallet', provider: 'shopeepay', icon: 'fa-bag-shopping' },
  { id: 'card', label: 'Kartu Kredit / Debit', group: 'card', note: 'Visa, Mastercard, JCB', icon: 'fa-credit-card' },
  { id: 'alfamart', label: 'Alfamart', group: 'cstore', store: 'alfamart', icon: 'fa-store' },
  { id: 'indomaret', label: 'Indomaret', group: 'cstore', store: 'indomaret', icon: 'fa-store' },
];

const STATUS_MAP = {
  settlement: 'paid',
  capture: 'paid',
  pending: 'pending',
  deny: 'failed',
  failure: 'failed',
  cancel: 'cancelled',
  expire: 'expired',
  refund: 'refunded',
  partial_refund: 'paid',
  chargeback: 'failed',
};

export const paymentMode = () => (config.payments.serverKey ? 'midtrans' : 'unavailable');

export const paymentInfo = () => ({
  available: paymentMode() !== 'unavailable',
  mode: paymentMode(),
  provider: 'midtrans',
  packages: TOKEN_PACKAGES,
  methods: PAYMENT_METHODS.map(({ id, label, group, note, icon }) => ({
    id,
    label,
    group,
    note: note || '',
    icon,
  })),
});

const apiBase = () => config.payments.apiBase
  || (config.payments.isProduction ? 'https://api.midtrans.com' : 'https://api.sandbox.midtrans.com');

const basicAuth = () => `Basic ${Buffer.from(`${config.payments.serverKey}:`).toString('base64')}`;

async function gateway(path, { method = 'GET', body } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res;
  try {
    res = await fetch(apiBase() + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: basicAuth(),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new HttpError(502, `Payment gateway tidak bisa dihubungi: ${err.message}`, { code: 'PAYMENT_GATEWAY_UNREACHABLE' });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text().catch(() => '');
  let data = {};
  try { data = JSON.parse(text); } catch { /* bukan JSON: dilaporkan lewat status */ }
  if (!res.ok) {
    const reason = data.status_message || text.slice(0, 200) || `HTTP ${res.status}`;
    throw new HttpError(502, `Payment gateway menolak transaksi: ${reason}`, { code: 'PAYMENT_GATEWAY_ERROR' });
  }
  return data;
}

function instructionsFrom(data, method) {
  const actions = Array.isArray(data.actions) ? data.actions : [];
  const action = (name) => actions.find((a) => a.name === name)?.url || null;
  switch (method.group) {
    case 'qris':
      return { qr_url: action('generate-qr-code') };
    case 'va': {
      const va = Array.isArray(data.va_numbers) ? data.va_numbers[0] : null;
      return {
        bank: va?.bank || method.bank,
        va_number: va?.va_number || data.permata_va_number || null,
      };
    }
    case 'ewallet':
      return { deeplink: action('deeplink-redirect'), qr_url: action('generate-qr-code') };
    case 'cstore':
      return { store: method.store, payment_code: data.payment_code || null };
    case 'card':
      return { redirect_url: data.redirect_url || null };
    default:
      return {};
  }
}

async function chargeMidtrans(method, orderId, amount, pkg, user) {
  if (method.group === 'card') {
    const data = await gateway('/snap/v1/transactions', {
      method: 'POST',
      body: {
        transaction_details: { order_id: orderId, gross_amount: amount },
        item_details: [{
          id: pkg.id,
          price: pkg.price_idr,
          quantity: 1,
          name: `Runut Paket ${pkg.name} (${pkg.tokens} Token)`,
        }],
        credit_card: { secure: true },
        callbacks: { finish: `${config.frontendUrl}/#/token?order=${orderId}` },
      },
    });
    return { providerRef: data.token || null, instructions: { redirect_url: data.redirect_url || null } };
  }
  const details = {
    transaction_details: { order_id: orderId, gross_amount: amount },
    item_details: [{
      id: pkg.id,
      price: pkg.price_idr,
      quantity: 1,
      name: `Runut Paket ${pkg.name} (${pkg.tokens} Token)`,
    }],
    custom_field1: user.id,
    custom_field2: pkg.id,
  };
  let payload;
  if (method.group === 'qris') {
    payload = { ...details, payment_type: 'qris', qris: { acquirer: config.payments.qrisAcquirer } };
  } else if (method.group === 'va') {
    payload = { ...details, payment_type: 'bank_transfer', bank_transfer: { bank: method.bank } };
  } else if (method.group === 'ewallet') {
    const callback = `${config.frontendUrl}/#/token?order=${orderId}`;
    payload = method.provider === 'gopay'
      ? { ...details, payment_type: 'gopay', gopay: { enable_callback: true, callback_url: callback } }
      : { ...details, payment_type: 'shopeepay', shopeepay: { callback_url: callback } };
  } else if (method.group === 'cstore') {
    payload = { ...details, payment_type: 'cstore', cstore: { store: method.store, message: `Runut ${pkg.tokens} Token` } };
  } else {
    throw new HttpError(400, 'Metode pembayaran tidak dikenal.', { code: 'METHOD_INVALID' });
  }
  const data = await gateway('/v2/charge', { method: 'POST', body: payload });
  return { providerRef: data.transaction_id || null, instructions: instructionsFrom(data, method) };
}

export async function createPayment(user, { packageId, methodId } = {}) {
  const mode = paymentMode();
  const method = PAYMENT_METHODS.find((m) => m.id === String(methodId || ''));
  if (!method) {
    throw new HttpError(400, 'Pilih metode pembayaran yang tersedia.', { code: 'METHOD_INVALID' });
  }
  const pkg = findTokenPackage(packageId);
  if (!pkg) {
    throw new HttpError(400, 'Pilih paket token yang tersedia (Hemat, Populer, atau Lebih Hemat).', { code: 'PACKAGE_INVALID' });
  }
  if (mode !== 'midtrans') {
    throw new HttpError(503, 'Pembelian token belum tersedia: payment gateway belum dikonfigurasi di server.', { code: 'PAYMENTS_UNAVAILABLE' });
  }

  // Nominal dan jumlah token selalu ditentukan backend berdasarkan paket,
  // tidak pernah dari input frontend.
  const amount = Number(pkg.price_idr);
  const tokenAmount = Number(pkg.tokens);
  const orderId = `RUNUT-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;
  const charge = await chargeMidtrans(method, orderId, amount, pkg, user);

  return payments.create({
    user_id: user.id,
    order_id: orderId,
    package_id: pkg.id,
    package_label: pkg.name,
    token_amount: tokenAmount,
    method: method.id,
    method_label: method.label,
    channel: method.group,
    amount,
    status: 'pending',
    provider: mode,
    provider_ref: charge.providerRef,
    instructions: charge.instructions,
    expires_at: new Date(Date.now() + config.payments.expiryHours * 3600 * 1000).toISOString(),
  });
}

async function settle(row, providerRef) {
  // Hanya transisi pertama ke 'paid' yang menambahkan saldo token.
  // Ditambah idempotency_key pada ledger token untuk perlindungan berlapis.
  const claimed = await payments.markPaidIfPending(row.id, { provider_ref: providerRef || row.provider_ref });
  if (!claimed) return row;

  const tokenAmount = Math.max(0, Math.trunc(Number(claimed.token_amount) || 0));
  if (tokenAmount > 0) {
    await tokenTransactions.credit({
      user_id: claimed.user_id,
      amount: tokenAmount,
      type: 'purchase',
      description: `Pembelian Paket ${claimed.package_label || claimed.package_id || 'Token'} (${tokenAmount} token)`,
      reference_type: 'payment',
      reference_id: claimed.order_id,
      idempotency_key: `payment:${claimed.order_id}`,
      meta: {
        order_id: claimed.order_id,
        package_id: claimed.package_id,
        package_label: claimed.package_label,
        amount_idr: claimed.amount,
        method: claimed.method,
      },
    });
  }
  console.log(JSON.stringify({
    event: 'payment_paid',
    order_id: claimed.order_id,
    user: claimed.user_id,
    amount: claimed.amount,
    tokens: tokenAmount,
  }));
  return claimed;
}

async function applyStatus(row, payload) {
  const next = STATUS_MAP[payload?.transaction_status];
  if (!next) return row;
  if (next === 'paid' && payload.fraud_status && payload.fraud_status !== 'accept') return row;
  if (next === 'paid') return settle(row, payload.transaction_id);
  if (next === row.status) return row;
  return (await payments.update(row.id, { status: next })) || row;
}

export async function refreshPayment(row) {
  if (!row || row.status !== 'pending') return row;
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return (await payments.update(row.id, { status: 'expired' })) || row;
  }
  if (row.provider !== 'midtrans') return row;
  const data = await gateway(`/v2/${encodeURIComponent(row.order_id)}/status`);
  return applyStatus(row, data);
}

export function verifySignature(body) {
  const expected = createHash('sha512')
    .update(`${body.order_id}${body.status_code}${body.gross_amount}${config.payments.serverKey}`)
    .digest('hex');
  return expected === String(body.signature_key || '');
}

export async function handleNotification(body) {
  if (paymentMode() !== 'midtrans') {
    throw new HttpError(503, 'Notifikasi pembayaran tidak diproses: payment gateway belum dikonfigurasi.', { code: 'PAYMENTS_NOT_CONFIGURED' });
  }
  const orderId = body?.order_id;
  if (!orderId || !body.status_code || !body.gross_amount || !body.signature_key) {
    throw new HttpError(400, 'Notifikasi tidak lengkap.', { code: 'INVALID_NOTIFICATION' });
  }
  if (!verifySignature(body)) {
    throw new HttpError(403, 'Tanda tangan notifikasi tidak valid.', { code: 'INVALID_SIGNATURE' });
  }
  const row = await payments.findByOrderId(orderId);
  if (!row) throw new HttpError(404, 'Transaksi tidak ditemukan.', { code: 'ORDER_NOT_FOUND' });
  if (Number(body.gross_amount) !== Number(row.amount)) {
    throw new HttpError(409, 'Nominal notifikasi tidak sama dengan tagihan.', { code: 'AMOUNT_MISMATCH' });
  }
  return applyStatus(row, body);
}

export async function fetchQrImage(row) {
  const url = row?.instructions?.qr_url;
  if (row?.provider !== 'midtrans' || !url) {
    throw new HttpError(404, 'Kode QR hanya tersedia untuk QRIS asli.', { code: 'QR_UNAVAILABLE' });
  }
  const res = await fetch(url, { headers: { Authorization: basicAuth() } });
  if (!res.ok) throw new HttpError(502, 'Gagal mengambil gambar QR dari payment gateway.', { code: 'QR_FETCH_FAILED' });
  return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'image/png' };
}

export const publicPayment = (row) => (row ? {
  id: row.id,
  order_id: row.order_id,
  package_id: row.package_id || null,
  package_label: row.package_label || null,
  token_amount: Number(row.token_amount || 0),
  method: row.method,
  method_label: row.method_label,
  channel: row.channel,
  amount: row.amount,
  status: row.status,
  provider: row.provider,
  instructions: row.instructions || {},
  expires_at: row.expires_at,
  paid_at: row.paid_at,
  created_at: row.created_at,
} : null);
