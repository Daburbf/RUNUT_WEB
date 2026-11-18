import { tokenTransactions } from '../repositories/index.js';
import { asyncHandler } from '../middleware/errors.js';
import { TOKEN_PACKAGES, getTokenPricingInfo } from '../services/tokens.js';

export const getTokenBalance = asyncHandler(async (req, res) => {
  const summary = await tokenTransactions.summaryByUser(req.user.id);
  res.json({
    balance: summary.balance,
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
  const [summary, transactions] = await Promise.all([
    tokenTransactions.summaryByUser(req.user.id),
    tokenTransactions.listByUser(req.user.id, { limit, type }),
  ]);
  res.json({
    balance: summary.balance,
    summary: {
      total_purchased: summary.total_purchased,
      total_used: summary.total_used,
      total_refunded: summary.total_refunded,
    },
    transactions,
  });
});

export const listTokenPackages = asyncHandler(async (_req, res) => {
  res.json({
    packages: TOKEN_PACKAGES,
    pricing: getTokenPricingInfo(),
  });
});
