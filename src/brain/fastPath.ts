import { FINANCIAL_ACTION_TYPES } from './constants.js';
import { FastPathAction } from './types.js';
import {
  parseTransactionHistoryIntent,
  parseTransactionSummaryIntent,
} from './fastPathHistory.js';

export * from './fastPathTokens.js';
export * from './fastPathHistory.js';
export * from './fastPathPending.js';

/**
 * Detects rule-based fast-path intent to bypass LLM latency and costs
 * for simple balance, budget, history, summary, queue, and help queries.
 */
export function detectFastPathAction(userMessageText: string): FastPathAction {
  if (!userMessageText || typeof userMessageText !== 'string') {
    return null;
  }

  const transactionSummaryIntent = parseTransactionSummaryIntent(userMessageText);
  if (transactionSummaryIntent) {
    return transactionSummaryIntent;
  }

  const transactionHistoryIntent = parseTransactionHistoryIntent(userMessageText);
  if (transactionHistoryIntent) {
    return transactionHistoryIntent;
  }

  const trimmedLowerText = userMessageText.toLowerCase().trim();

  const hasNumericOrPricePattern =
    /\d|\d+\s*(?:k|rb|jt|ribu|juta)\b|(?:rp|idr)\.?\s*\d+|\d+\s*(?:rp|idr)\b|(?:^|\s)(?:rb|k|jt|ribu|juta|rp|idr)(?:$|\s)/i.test(
      trimmedLowerText
    );
  if (hasNumericOrPricePattern) {
    return null;
  }

  const balancePattern = /^(?:cek|lihat|info|total|check|view|show|my)?\s*(?:saldo|balance|balances|rekening|total\s+saldo|account\s+balance|account\s+balances)(?:\s+(?:saya|rekening|accounts))?$/i;
  if (balancePattern.test(trimmedLowerText)) {
    return FINANCIAL_ACTION_TYPES.CHECK_BALANCE;
  }

  const budgetPattern = /^(?:cek|lihat|info|status|check|view|show|my)?\s*(?:budget|budgets|anggaran|sisa\s+budget|status\s+budget|status\s+anggaran|budget\s+status)(?:\s+(?:saya|aktif|active))?$/i;
  if (budgetPattern.test(trimmedLowerText)) {
    return FINANCIAL_ACTION_TYPES.CHECK_BUDGET;
  }

  const helpPattern = /^(?:halo|hello|hi|hai|menu|help|bantuan|ping|p|panduan|guide|mulai|start|commands)$/i;
  if (helpPattern.test(trimmedLowerText)) {
    return FINANCIAL_ACTION_TYPES.HELP_MENU;
  }

  const queuePattern =
    /^(?:cek|check|lihat|view|status)?\s*(?:antrean|antrian|queue|pending)(?:\s+transaksi)?$|^(?:cek|check|lihat|view)?\s*status(?:\s+(?:transaksi|antrean|antrian|queue))?$/i;
  if (queuePattern.test(trimmedLowerText)) {
    return FINANCIAL_ACTION_TYPES.CHECK_QUEUE;
  }

  return null;
}
