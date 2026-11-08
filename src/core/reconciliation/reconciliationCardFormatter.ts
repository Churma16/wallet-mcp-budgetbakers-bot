import type { ReconciliationComparisonResult } from './types.js';

export interface FormattedTicketReference {
  readonly ticketId: number;
  readonly mutationId: string;
}

export interface ReconciliationCardFormatterOptions {
  readonly ticketReferences?: readonly FormattedTicketReference[];
}

function formatAmountIDR(amount: number): string {
  return `Rp${Math.round(amount).toLocaleString('id-ID')}`;
}

function formatDateShort(isoDate: string): string {
  const parts = isoDate.slice(0, 10).split('-');
  if (parts.length === 3) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
    const monthIndex = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);
    return `${day} ${months[monthIndex] || parts[1]}`;
  }
  return isoDate;
}

/**
 * Builds a clean, mobile-optimized card representation of reconciliation results for Telegram.
 */
export function formatReconciliationCard(
  result: ReconciliationComparisonResult,
  options?: ReconciliationCardFormatterOptions
): string {
  const ticketMap = new Map<string, number>();
  if (options?.ticketReferences) {
    for (const ref of options.ticketReferences) {
      ticketMap.set(ref.mutationId, ref.ticketId);
    }
  }

  const lines: string[] = [];

  // Header Card
  lines.push(`📋 <b>Hasil Rekonsiliasi: ${result.targetAccountName}</b>`);
  lines.push(
    `<i>Periode: ${formatDateShort(result.dateRange.startDate)} – ${formatDateShort(result.dateRange.endDate)} (${result.totalMutations} transaksi)</i>\n`
  );

  // 1. Matched section
  if (result.matched.length > 0) {
    lines.push(`🟢 <b>Sudah Sesuai (${result.matched.length})</b>`);
    const previewMatched = result.matched.slice(0, 4);
    for (const pair of previewMatched) {
      const formattedAmount = formatAmountIDR(pair.mutation.amount);
      const dateStr = formatDateShort(pair.mutation.date);
      lines.push(`• ${formattedAmount} • ${pair.mutation.counterParty} <i>(${dateStr})</i>`);
    }
    if (result.matched.length > 4) {
      lines.push(`  <i>...dan ${result.matched.length - 4} transaksi lainnya cocok</i>`);
    }
    lines.push('');
  }

  // 2. Wrong Account section
  if (result.wrongAccount.length > 0) {
    lines.push(`🟡 <b>Salah Wallet / Akun (${result.wrongAccount.length})</b>`);
    for (const item of result.wrongAccount) {
      const formattedAmount = formatAmountIDR(item.mutation.amount);
      const dateStr = formatDateShort(item.mutation.date);
      lines.push(
        `• <b>${formattedAmount}</b> • ${item.mutation.counterParty} <i>(${dateStr})</i>\n  ↳ Tercatat di: <b>${item.actualAccountName}</b> (seharusnya ${result.targetAccountName})`
      );
    }
    lines.push('');
  }

  // 3. Missing section
  if (result.missing.length > 0) {
    lines.push(`🔴 <b>Terlewat / Belum Tercatat (${result.missing.length})</b>`);
    const ticketIds: number[] = [];

    for (const item of result.missing) {
      const ticketId = ticketMap.get(item.mutation.id);
      const ticketPrefix = ticketId ? `[Tiket #${ticketId}] ` : '';
      if (ticketId) ticketIds.push(ticketId);

      const formattedAmount = formatAmountIDR(item.mutation.amount);
      const dateStr = formatDateShort(item.mutation.date);
      lines.push(`• <b>${ticketPrefix}${formattedAmount}</b> • ${item.mutation.counterParty} <i>(${dateStr})</i>`);
    }

    lines.push('');
    if (ticketIds.length > 0) {
      const ticketRangeStr = ticketIds.length === 1 ? `${ticketIds[0]}` : ticketIds.join(',');
      lines.push(`💡 <i>Balas <b>Ya ${ticketRangeStr}</b> untuk konfirmasi catat ke Wallet, atau <b>Batal ${ticketIds[0]}</b>.</i>`);
    }
  } else if (result.wrongAccount.length === 0 && result.matched.length > 0) {
    lines.push('🎉 <b>Semua transaksi mutasi tercatat lengkap di Wallet!</b>');
  }

  return lines.join('\n').trim();
}
