import { FINANCIAL_ACTION_TYPES } from '../constants.js';
import { FastPathAction } from '../types.js';
import {
  parseTransactionHistoryIntent,
  parseTransactionSummaryIntent,
} from './fastPathHistory.js';

export * from './fastPathTokens.js';
export * from './fastPathHistory.js';
export * from './fastPathPending.js';

/**
 * Normalizes input text by stripping leading bot command slashes or exclamations
 * as well as leading UI symbols and emojis from button labels.
 */
export function normalizeFastPathInput(rawText: string): string {
  if (!rawText || typeof rawText !== 'string') {
    return '';
  }
  return rawText
    .trim()
    .replace(/^[\/!]/, '')
    .replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Symbol}]\s*/u, '')
    .trim();
}

/**
 * Maps exact Telegram button labels and direct keywords to financial actions in O(1) time.
 */
const EXACT_BUTTON_ACTION_MAP: Readonly<Record<string, FastPathAction>> = {
  '\u{1F4B0} cek saldo': FINANCIAL_ACTION_TYPES.CHECK_BALANCE,
  '\u{1F4B0} check balance': FINANCIAL_ACTION_TYPES.CHECK_BALANCE,
  'cek saldo': FINANCIAL_ACTION_TYPES.CHECK_BALANCE,
  'check balance': FINANCIAL_ACTION_TYPES.CHECK_BALANCE,
  'saldo': FINANCIAL_ACTION_TYPES.CHECK_BALANCE,
  'balance': FINANCIAL_ACTION_TYPES.CHECK_BALANCE,

  '\u{1F4CA} cek budget': FINANCIAL_ACTION_TYPES.CHECK_BUDGET,
  '\u{1F4CA} check budget': FINANCIAL_ACTION_TYPES.CHECK_BUDGET,
  'cek budget': FINANCIAL_ACTION_TYPES.CHECK_BUDGET,
  'check budget': FINANCIAL_ACTION_TYPES.CHECK_BUDGET,
  'budget': FINANCIAL_ACTION_TYPES.CHECK_BUDGET,

  '\u{1F4DC} riwayat': { type: FINANCIAL_ACTION_TYPES.TRANSACTION_HISTORY, options: { sort: 'newest' } },
  '\u{1F4DC} history': { type: FINANCIAL_ACTION_TYPES.TRANSACTION_HISTORY, options: { sort: 'newest' } },
  'riwayat': { type: FINANCIAL_ACTION_TYPES.TRANSACTION_HISTORY, options: { sort: 'newest' } },
  'history': { type: FINANCIAL_ACTION_TYPES.TRANSACTION_HISTORY, options: { sort: 'newest' } },

  '\u{2753} panduan': FINANCIAL_ACTION_TYPES.HELP_MENU,
  '\u{2753} guide': FINANCIAL_ACTION_TYPES.HELP_MENU,
  'panduan': FINANCIAL_ACTION_TYPES.HELP_MENU,
  'guide': FINANCIAL_ACTION_TYPES.HELP_MENU,
  'menu': FINANCIAL_ACTION_TYPES.HELP_MENU,
  'help': FINANCIAL_ACTION_TYPES.HELP_MENU,
  'start': FINANCIAL_ACTION_TYPES.HELP_MENU,

  'antrean': FINANCIAL_ACTION_TYPES.CHECK_QUEUE,
  'antrian': FINANCIAL_ACTION_TYPES.CHECK_QUEUE,
  'queue': FINANCIAL_ACTION_TYPES.CHECK_QUEUE,
  'pending': FINANCIAL_ACTION_TYPES.CHECK_QUEUE,
};

/**
 * Detects rule-based fast-path intent to bypass LLM latency and costs
 * for simple balance, budget, history, summary, queue, and help queries.
 */
export function detectFastPathAction(userMessageText: string): FastPathAction {
  if (!userMessageText || typeof userMessageText !== 'string') {
    return null;
  }

  const rawTrimmed = userMessageText.trim();
  if (!rawTrimmed) {
    return null;
  }

  // 1. O(1) Short-circuit for Slash Commands (e.g. /saldo, /budget, /riwayat, /rekap, /menu, /start)
  if (rawTrimmed.startsWith('/')) {
    const slashBody = rawTrimmed.slice(1).trim();
    const [commandKeyword, ...trailingArgs] = slashBody.split(/\s+/);
    const normalizedCommand = commandKeyword?.toLowerCase();

    switch (normalizedCommand) {
      case 'saldo':
      case 'balance':
        return FINANCIAL_ACTION_TYPES.CHECK_BALANCE;

      case 'budget':
      case 'anggaran':
        return FINANCIAL_ACTION_TYPES.CHECK_BUDGET;

      case 'riwayat':
      case 'history': {
        const potentialLimit = trailingArgs[0] ? Number.parseInt(trailingArgs[0], 10) : undefined;
        const validLimit = potentialLimit && !Number.isNaN(potentialLimit) && potentialLimit > 0 ? potentialLimit : undefined;
        return {
          type: FINANCIAL_ACTION_TYPES.TRANSACTION_HISTORY,
          options: { sort: 'newest', ...(validLimit ? { limit: validLimit } : {}) },
        };
      }

      case 'rekap':
      case 'summary':
        return parseTransactionSummaryIntent(rawTrimmed) || {
          type: FINANCIAL_ACTION_TYPES.TRANSACTION_SUMMARY,
          options: {},
        };

      case 'menu':
      case 'start':
      case 'help':
      case 'panduan':
      case 'guide':
        return FINANCIAL_ACTION_TYPES.HELP_MENU;

      case 'queue':
      case 'antrean':
      case 'antrian':
      case 'pending':
        return FINANCIAL_ACTION_TYPES.CHECK_QUEUE;

      default:
        break;
    }
  }

  // 2. O(1) Short-circuit for Exact Button Labels and Standard Single-Word Commands
  const lowerTrimmed = rawTrimmed.toLowerCase();
  const exactButtonMatch = EXACT_BUTTON_ACTION_MAP[lowerTrimmed];
  if (exactButtonMatch) {
    return exactButtonMatch;
  }

  // 3. Fallback to Natural Language Pattern Matching
  const normalizedInput = normalizeFastPathInput(userMessageText);

  // 3a. Transaction Summary Intent Check
  const summaryIntent =
    parseTransactionSummaryIntent(userMessageText) ||
    (normalizedInput !== userMessageText ? parseTransactionSummaryIntent(normalizedInput) : null);
  if (summaryIntent) {
    return summaryIntent;
  }

  // 3b. Transaction History Intent Check
  const historyIntent =
    parseTransactionHistoryIntent(userMessageText) ||
    (normalizedInput !== userMessageText ? parseTransactionHistoryIntent(normalizedInput) : null);
  if (historyIntent) {
    return historyIntent;
  }

  const hasNumericOrPricePattern =
    /\d|\d+\s*(?:k|rb|jt|ribu|juta)\b|(?:rp|idr)\.?\s*\d+|\d+\s*(?:rp|idr)\b|(?:^|\s)(?:rb|k|jt|ribu|juta|rp|idr)(?:$|\s)/i.test(
      lowerTrimmed
    );
  if (hasNumericOrPricePattern) {
    return null;
  }

  const normalizedLowerText = normalizedInput.toLowerCase();

  const balancePattern =
    /^(?:cek|lihat|info|total|check|view|show|my)?\s*(?:saldo|balance|balances|rekening|total\s+saldo|account\s+balance|account\s+balances)(?:\s+(?:saya|rekening|accounts))?$/i;
  if (balancePattern.test(lowerTrimmed) || balancePattern.test(normalizedLowerText)) {
    return FINANCIAL_ACTION_TYPES.CHECK_BALANCE;
  }

  const budgetPattern =
    /^(?:cek|lihat|info|status|check|view|show|my)?\s*(?:budget|budgets|anggaran|sisa\s+budget|status\s+budget|status\s+anggaran|budget\s+status)(?:\s+(?:saya|aktif|active))?$/i;
  if (budgetPattern.test(lowerTrimmed) || budgetPattern.test(normalizedLowerText)) {
    return FINANCIAL_ACTION_TYPES.CHECK_BUDGET;
  }

  const helpPattern = /^(?:halo|hello|hi|hai|menu|help|bantuan|ping|p|panduan|guide|mulai|start|commands)$/i;
  if (helpPattern.test(lowerTrimmed) || helpPattern.test(normalizedLowerText)) {
    return FINANCIAL_ACTION_TYPES.HELP_MENU;
  }

  const queuePattern =
    /^(?:cek|check|lihat|view|status)?\s*(?:antrean|antrian|queue|pending)(?:\s+transaksi)?$|^(?:cek|check|lihat|view)?\s*status(?:\s+(?:transaksi|antrean|antrian|queue))?$/i;
  if (queuePattern.test(lowerTrimmed) || queuePattern.test(normalizedLowerText)) {
    return FINANCIAL_ACTION_TYPES.CHECK_QUEUE;
  }

  return null;
}
