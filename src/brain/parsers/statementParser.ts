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
 * Parses and sanitizes raw LLM output from statement vision extraction into strongly-typed BankMutationItem[].
 * Also performs automatic deduplication for overlapping rows across multi-screenshot albums.
 */
export function parseStatementExtractionResponse(rawText: string): BankMutationItem[] {
  let cleanText = rawText.trim();

  // Strip markdown code fences if present
  if (cleanText.startsWith('```')) {
    cleanText = cleanText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }

  let parsed: RawStatementExtractionResponse;
  try {
    parsed = JSON.parse(cleanText) as RawStatementExtractionResponse;
  } catch {
    // Attempt fallback json block search
    const match = cleanText.match(/\{[\s\S]*\}/);
    if (!match) {
      return [];
    }
    try {
      parsed = JSON.parse(match[0]) as RawStatementExtractionResponse;
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

    // Parse numeric amount
    let numAmount = 0;
    if (typeof raw.amount === 'number' && Number.isFinite(raw.amount)) {
      numAmount = Math.abs(raw.amount);
    } else if (typeof raw.amount === 'string') {
      const parsedFinancial = parseFinancialAmount(raw.amount, 'IDR');
      if (parsedFinancial && Number.isFinite(parsedFinancial.amount)) {
        numAmount = Math.abs(parsedFinancial.amount);
      } else {
        const cleanedAmount = raw.amount.replace(/[^0-9.-]/g, '');
        const parsedFloat = parseFloat(cleanedAmount);
        if (Number.isFinite(parsedFloat)) {
          numAmount = Math.abs(parsedFloat);
        }
      }
    }

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
