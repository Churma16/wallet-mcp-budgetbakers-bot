import type { BankMutationItem, MutationDirection } from '../../core/reconciliation/types.js';
import { parseFinancialAmount } from './amountParser.js';

interface RawMutationItem {
  date?: string;
  amount?: number | string;
  direction?: string;
  counterParty?: string;
  note?: string;
}

interface RawStatementExtractionResponse {
  mutations?: RawMutationItem[];
}

/**
 * Parses and extracts a positive absolute numeric amount using guard clauses.
 */
export function extractPositiveAmount(rawAmount: unknown): number {
  if (typeof rawAmount === 'number') {
    return Number.isFinite(rawAmount) ? Math.abs(rawAmount) : 0;
  }

  if (typeof rawAmount !== 'string') {
    return 0;
  }

  const parsedFinancial = parseFinancialAmount(rawAmount, 'IDR');
  if (parsedFinancial && Number.isFinite(parsedFinancial.amount)) {
    return Math.abs(parsedFinancial.amount);
  }

  const cleanedAmount = rawAmount.replace(/[^0-9.-]/g, '');
  const parsedFloat = Number.parseFloat(cleanedAmount);
  return Number.isFinite(parsedFloat) ? Math.abs(parsedFloat) : 0;
}

/**
 * Parses and sanitizes raw LLM output from statement vision extraction into strongly-typed BankMutationItem[].
 * Also performs automatic deduplication for overlapping rows across multi-screenshot albums.
 */
export function parseStatementExtractionResponse(rawText: string): BankMutationItem[] {
  let cleanText = rawText.trim();

  // Strip markdown code fences if present
  if (cleanText.startsWith('```')) {
    const firstNewline = cleanText.indexOf('\n');
    if (firstNewline !== -1) {
      cleanText = cleanText.slice(firstNewline + 1);
    }
    if (cleanText.endsWith('```')) {
      cleanText = cleanText.slice(0, -3);
    }
    cleanText = cleanText.trim();
  }

  let parsed: RawStatementExtractionResponse;
  try {
    parsed = JSON.parse(cleanText) as RawStatementExtractionResponse;
  } catch {
    // Attempt fallback json block search without regex backtracking
    const firstBrace = cleanText.indexOf('{');
    const lastBrace = cleanText.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace <= firstBrace) {
      return [];
    }
    try {
      parsed = JSON.parse(cleanText.slice(firstBrace, lastBrace + 1)) as RawStatementExtractionResponse;
    } catch {
      return [];
    }
  }

  if (!parsed || !Array.isArray(parsed.mutations)) {
    return [];
  }

  const seenFingerprints = new Set<string>();
  const sanitizedList: BankMutationItem[] = [];

  for (let index = 0; index < parsed.mutations.length; index++) {
    const raw = parsed.mutations[index];
    if (!raw) continue;

    // Parse numeric amount using guard clauses
    const numAmount = extractPositiveAmount(raw.amount);
    if (numAmount <= 0) {
      continue;
    }

    // Direction
    const rawDir = String(raw.direction || '').toUpperCase();
    const direction: MutationDirection = rawDir === 'CREDIT' ? 'CREDIT' : 'DEBIT';

    // Date
    let date = String(raw.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      // If partial date or missing, fallback to today's UTC ISO date
      date = new Date().toISOString().slice(0, 10);
    }

    // Counterparty
    const counterParty = String(raw.counterParty || 'Transaksi').trim();
    const note = raw.note ? String(raw.note).trim() : undefined;

    // Cross-screenshot deduplication fingerprint
    const fingerprint = `${date}|${numAmount}|${direction}|${counterParty.toLowerCase()}`;
    if (seenFingerprints.has(fingerprint)) {
      continue;
    }
    seenFingerprints.add(fingerprint);

    sanitizedList.push({
      id: `mut_${Date.now()}_${index}`,
      date,
      amount: numAmount,
      direction,
      counterParty,
      note,
    });
  }

  return sanitizedList;
}
