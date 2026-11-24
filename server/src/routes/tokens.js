import { tokenTransactions, downloadTransactions } from '../repositories/index.js';
import { asyncHandler } from '../middleware/errors.js';
import { TOKEN_PACKAGES, getTokenPricingInfo } from '../services/tokens.js';

export const getTokenBalance = asyncHandler(async (req, res) => {
  const summary = await tokenTransactions.summaryByUser(req.user.id);
  res.json({
    balance: summary.balance,
    reserved_tokens: summary.reserved_tokens ?? 0,
    available_balance: summary.available_balance ?? summary.balance,
    total_purchased: summary.total_purchased,
    total_used: summary.total_used,
    total_refunded: summary.total_refunded,
    packages: TOKEN_PACKAGES,
    pricing: getTokenPricingInfo(),
  });
});

export const listTokenTransactions = asyncHandler(async (req, res) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
  const type = String(req.query.type || '').trim();
  const [summary, transactions, downloads] = await Promise.all([
    tokenTransactions.summaryByUser(req.user.id),
    tokenTransactions.listByUser(req.user.id, { limit, type }),
    downloadTransactions.listByUser(req.user.id, { limit: Math.min(limit, 50) }),
  ]);
  res.json({
    balance: summary.balance,
    reserved_tokens: summary.reserved_tokens ?? 0,
    available_balance: summary.available_balance ?? summary.balance,
    summary: {
      total_purchased: summary.total_purchased,
      total_used: summary.total_used,
      total_refunded: summary.total_refunded,
      reserved_tokens: summary.reserved_tokens ?? 0,
      available_balance: summary.available_balance ?? summary.balance,
    },
    transactions,
    download_transactions: downloads,
  });
});

export const listDownloadTransactions = asyncHandler(async (req, res) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
  const [summary, downloads] = await Promise.all([
    tokenTransactions.summaryByUser(req.user.id),
    downloadTransactions.listByUser(req.user.id, { limit }),
  ]);
  res.json({
    balance: summary.balance,
    reserved_tokens: summary.reserved_tokens ?? 0,
    available_balance: summary.available_balance ?? summary.balance,
    download_transactions: downloads,
  });
});

export const listTokenPackages = asyncHandler(async (_req, res) => {
  res.json({
    packages: TOKEN_PACKAGES,
    pricing: getTokenPricingInfo(),
  });
});
