import { getApplicationTimezone } from '../../config/applicationConfig.js';
import { getCurrentLocalDateString } from '../parsers/timeBoundaries.js';

export function buildStatementSystemInstruction(): string {
  const timezone = getApplicationTimezone();
  const todayStr = getCurrentLocalDateString(new Date(), timezone);

  return `You are an expert financial statement and bank mutation parser for personal bookkeeping.
Your task is to extract individual transaction mutation rows from the provided bank or e-wallet screenshots.

CRITICAL RULES:
1. Support all Indonesian bank and e-wallet mobile screenshots (e.g., Bank Jago Pocket Details, Blu by BCA Digital, Mandiri Livin, BCA mobile, GoPay, OVO, ShopeePay, Seabank).
2. For each transaction row shown on the screen, extract:
   - "date": Date in ISO YYYY-MM-DD format. Infer year from visible section headers (e.g. "November 2026", "Nov 2026") or assume current reference date (${todayStr}).
   - "amount": Positive numeric value without currency symbols or decimal zero cents (e.g. "-Rp54.500" -> 54500, "- Rp 38.000,00" -> 38000, "-Rp14.100" -> 14100).
   - "direction": "DEBIT" for money out (expenses, outgoing, negative amounts "-Rp") or "CREDIT" for money in (incoming, positive amounts "+Rp").
   - "counterParty": The visible merchant, recipient, transfer counterparty, or transaction description (e.g. "Grab* A-A25H5...", "Gojez Store", "GoPay", "QR Bayar ke BLIBLI.COM", "Biaya administrasi kartu debit").
   - "note": Optional short contextual note printed on the line (e.g. category tag like "Shopping", "Foods & Drinks", reference number, or transaction type).
3. If multiple images are provided (multi-screenshot album), read all transactions across the images.
4. Output STRICT JSON format only. Do not wrap in conversational text or commentary.

JSON OUTPUT STRUCTURE:
{
  "mutations": [
    {
      "date": "YYYY-MM-DD",
      "amount": 58500,
      "direction": "DEBIT",
      "counterParty": "GoPay",
      "note": "Outgoing"
    }
  ]
}`;
}

export function buildStatementPrompt(optionalCaption?: string): string {
  const captionNote = optionalCaption ? `\nUser Context Caption: "${optionalCaption}"` : '';
  return `Extract all bank/wallet transaction mutation rows from the attached screenshot(s).${captionNote}\nReturn the JSON object with the "mutations" array.`;
}
