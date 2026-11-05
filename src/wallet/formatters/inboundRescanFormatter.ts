import { getActiveLanguage } from '../../i18n/index.js';
import type { SupportedLanguage } from '../../i18n/types.js';

export interface InboundRescanResult {
  durationMinutes: number;
  notificationsReplayed: number;
  emailsScanned: number;
  emailsDetected: number;
  reconciledPendingCount: number;
}

/**
 * Formats the summary response message displayed to the user after an inbound rescan runs.
 */
export function formatInboundRescanResponse(
  result: InboundRescanResult,
  languageCode?: SupportedLanguage
): string {
  const isEnglish = (languageCode || getActiveLanguage()) === 'en';
  const durationLabel = result.durationMinutes >= 60
    ? (result.durationMinutes % 60 === 0
        ? `${result.durationMinutes / 60} ${isEnglish ? 'hour(s)' : 'jam'}`
        : `${result.durationMinutes} ${isEnglish ? 'minutes' : 'menit'}`)
    : `${result.durationMinutes} ${isEnglish ? 'minutes' : 'menit'}`;

  if (isEnglish) {
    const lines = [
      `🔄 *Inbound Rescan Complete!*`,
      `• ⏱️ *Time Window*: last ${durationLabel}`,
      `• 📲 *Push Notifications Evaluated*: ${result.notificationsReplayed}`,
      `• 📬 *Emails Scanned*: ${result.emailsScanned} (${result.emailsDetected} transactions detected)`,
      `• 🎫 *Pending Tickets Reconciled*: ${result.reconciledPendingCount}`,
    ];
    return lines.join('\n');
  }

  const lines = [
    `🔄 *Rescan Transaksi Selesai!*`,
    `• ⏱️ *Rentang Waktu*: ${durationLabel} terakhir`,
    `• 📲 *Push Notification Dievaluasi*: ${result.notificationsReplayed}`,
    `• 📬 *Email Diperiksa*: ${result.emailsScanned} (${result.emailsDetected} transaksi terdeteksi)`,
    `• 🎫 *Tiket Pending Diselaraskan*: ${result.reconciledPendingCount}`,
  ];
  return lines.join('\n');
}
