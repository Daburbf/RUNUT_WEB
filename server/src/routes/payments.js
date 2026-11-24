import { payments, tokenTransactions } from '../repositories/index.js';
import { HttpError, asyncHandler } from '../middleware/errors.js';
import { buildPdf } from '../services/pdf.js';
import {
  createPayment, publicPayment, paymentInfo, refreshPayment,
  renewQrisPayment, handleNotification, fetchQrImage,
} from '../services/payments.js';

const STATUS_LABEL = {
  pending: 'Menunggu pembayaran',
  paid: 'Lunas',
  failed: 'Gagal',
  expired: 'Kedaluwarsa',
  cancelled: 'Dibatalkan',
  refunded: 'Dikembalikan',
};

async function ownedPayment(userId, orderId) {
  const row = await payments.findByOrderId(orderId);
  if (!row) throw new HttpError(404, 'Transaksi tidak ditemukan.', { code: 'ORDER_NOT_FOUND' });
  if (row.user_id !== userId) throw new HttpError(403, 'Transaksi ini bukan milik akun Anda.');
  return row;
}

const fmtIdr = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');
const fmtDate = (v) => (v ? new Date(v).toLocaleString('id-ID', { dateStyle: 'long', timeStyle: 'short' }) : '-');

// GET /api/payments - katalog paket token, metode, status gateway, dan riwayat transaksi.
export const listPayments = asyncHandler(async (req, res) => {
  const [rows, summary] = await Promise.all([
    payments.listByUser(req.user.id, { limit: 20 }),
    tokenTransactions.summaryByUser(req.user.id),
  ]);
  res.json({
    ...paymentInfo(),
    token_balance: summary.balance,
    orders: rows.map(publicPayment),
  });
});

// POST /api/payments - buat transaksi pembelian token.
// Nominal dan jumlah token ditentukan server berdasarkan package_id.
export const createPaymentHandler = asyncHandler(async (req, res) => {
  const row = await createPayment(req.user, {
    packageId: req.body?.package_id || req.body?.packageId,
    methodId: req.body?.method,
  });
  res.status(201).json({ payment: publicPayment(row) });
});

// GET /api/payments/:orderId - status terbaru (dipakai polling dan tombol "Periksa status").
export const getPayment = asyncHandler(async (req, res) => {
  const row = await ownedPayment(req.user.id, req.params.orderId);
  const fresh = await refreshPayment(row);
  const summary = await tokenTransactions.summaryByUser(req.user.id);
  res.json({
    payment: publicPayment(fresh),
    token_balance: summary.balance,
  });
});

export const paymentQr = asyncHandler(async (req, res) => {
  const row = await ownedPayment(req.user.id, req.params.orderId);
  const { buffer, contentType } = await fetchQrImage(row);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.send(buffer);
});

// GET /api/payments/:orderId/invoice - bukti pembayaran dalam bentuk PDF.
export const paymentInvoice = asyncHandler(async (req, res) => {
  const row = await ownedPayment(req.user.id, req.params.orderId);
  const body = [
    `Nomor pesanan   : ${row.order_id}`,
    `Tanggal         : ${fmtDate(row.created_at)}`,
    `Paket           : ${row.package_label || row.package_id || 'Paket Token'}`,
    `Jumlah Token    : ${Number(row.token_amount || 0)} token`,
    `Metode          : ${row.method_label || row.method}`,
    `Nominal         : ${fmtIdr(row.amount)}`,
    `Status          : ${STATUS_LABEL[row.status] || row.status}`,
    `Dibayar pada    : ${fmtDate(row.paid_at)}`,
    '',
    'Terima kasih telah menggunakan Runut. Invoice ini dibuat otomatis oleh sistem',
    'dan sah tanpa tanda tangan basah.',
  ].join('\n');
  const pdf = await buildPdf({
    title: 'Invoice Pembelian Token Runut',
    meta: row.status === 'paid' ? 'PEMBAYARAN LUNAS' : `STATUS: ${(STATUS_LABEL[row.status] || row.status).toUpperCase()}`,
    body,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="invoice-${row.order_id}.pdf"`);
  res.send(pdf);
});

// POST /api/payments/:orderId/renew - perbarui QRIS kedaluwarsa dengan kode dinamis 10 menit baru.
export const renewPayment = asyncHandler(async (req, res) => {
  const row = await ownedPayment(req.user.id, req.params.orderId);
  const result = await renewQrisPayment(req.user, row);
  const summary = await tokenTransactions.summaryByUser(req.user.id);
  res.status(result.renewed && !result.duplicate ? 201 : 200).json({
    ok: true,
    renewed: Boolean(result.renewed),
    duplicate: Boolean(result.duplicate),
    already_paid: Boolean(result.already_paid),
    still_active: Boolean(result.still_active),
    previous_order_id: result.previous_order_id,
    payment: publicPayment(result.payment),
    token_balance: summary.balance,
  });
});

// POST /api/payments/:orderId/cancel - batalkan transaksi yang masih menunggu pembayaran.
export const cancelPayment = asyncHandler(async (req, res) => {
  const row = await ownedPayment(req.user.id, req.params.orderId);
  if (row.status === 'paid') {
    throw new HttpError(409, 'Pembayaran sudah lunas dan tidak dapat dibatalkan.', { code: 'PAYMENT_ALREADY_PAID' });
  }
  if (row.status === 'cancelled' || row.status === 'expired') {
    return res.json({ ok: true, cancelled: row.status === 'cancelled', payment: publicPayment(row) });
  }
  const updated = (await payments.updateByOrderId(row.order_id, { status: 'cancelled' })) || { ...row, status: 'cancelled' };
  res.json({ ok: true, cancelled: true, payment: publicPayment(updated) });
});

// POST /api/payments/notify - webhook Midtrans.
export const paymentNotification = asyncHandler(async (req, res) => {
  const row = await handleNotification(req.body);
  res.json({ ok: true, order_id: row.order_id, status: row.status });
});
