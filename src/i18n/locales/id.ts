import {
  ResponseDictionary,
  RecordMessageParams,
  MultipleRecordsItemParams,
  PendingEmailNotificationParams,
  PendingConfirmationSuccessParams,
  PendingBulkItemParams,
  PendingCancellationParams,
} from '../types.js';

export const indonesianDictionary: ResponseDictionary = {
  languageCode: 'id',
  localeIdentifier: 'id-ID',
  timeZoneLabel: 'WIB',

  labels: {
    expense: 'Pengeluaran',
    income: 'Pemasukan',
    transfer: 'Transfer / Top-Up',
    defaultAccount: 'Akun',
    defaultCategory: 'Umum',
    total: 'Total',
    remaining: 'sisa',
    from: 'Dari',
    to: 'Tujuan',
  },

  records: {
    singleSuccess(params: RecordMessageParams): string {
      return [
        `✅ *${params.transactionTitle}* berhasil dicatat!`,
        '',
        `${params.transactionTypeIcon} ${params.formattedAmount}  •  ${params.accountName}`,
        `🏷️ ${params.categoryName}  •  ${params.recordTimestampDisplay}`,
      ].join('\n');
    },

    multipleSuccessHeader(totalRecordsCount: number, currentTimestamp: string): string {
      return `✅ *${totalRecordsCount} transaksi* berhasil dicatat! (${currentTimestamp})`;
    },

    multipleRecordItem(params: MultipleRecordsItemParams): string {
      return [
        `${params.itemIndex + 1}. ${params.transactionTypeIcon} ${params.transactionDescription} — *${params.formattedAmount}* dari ${params.accountName}`,
        `   🏷️ ${params.categoryName}  •  ${params.recordTimestampDisplay}`,
      ].join('\n');
    },
  },

  balance: {
    header(currentTimestamp: string): string {
      return `📊 *Saldo Rekening* (${currentTimestamp})`;
    },
    emptyState: 'Belum ada data rekening yang terhubung.',
    grandTotal(formattedTotal: string): string {
      return `*Total: ${formattedTotal}*`;
    },
    notAvailable: 'N/A',
  },

  budget: {
    header(currentTimestamp: string): string {
      return `📈 *Status Anggaran* (${currentTimestamp})`;
    },
    emptyState: 'Belum ada anggaran aktif yang ditemukan.',
    budgetItem(name: string, spent: string, limit: string, remaining: string): string {
      return `• *${name}*: ${spent} / ${limit} _(sisa ${remaining})_`;
    },
    budgetOverspentItem(name: string, spent: string, limit: string, overspent: string): string {
      return `• *${name}*: ${spent} / ${limit} ⚠️ _(lebih ${overspent})_`;
    },
  },

  emailPending: {
    formatNotification(params: PendingEmailNotificationParams): string {
      const lines = [
        `📩 *Transaksi Email Baru Terdeteksi (#${params.ticketId})*`,
        `🏦 *Sumber:* ${params.bankDisplayName}`,
        `${params.typeIcon} *Nominal:* ${params.formattedAmount} (${params.typeLabel})`,
      ];

      if (params.typeLabel.includes('Transfer') && params.destinationAccountNameHint) {
        lines.push(`🎯 *Tujuan:* ${params.destinationAccountNameHint}`);
      } else if (params.counterParty) {
        lines.push(`🏪 *Merchant/Pihak:* ${params.counterParty}`);
      }

      if (params.matchedCategoryName) {
        lines.push(`📂 *Kategori:* ${params.matchedCategoryName}`);
      }

      if (params.accountNameHint) {
        lines.push(`💳 *Akun Wallet:* ${params.accountNameHint}`);
      }

      lines.push(`🕒 *Waktu:* ${params.formattedTime}`);

      if (params.referenceNumber) {
        lines.push(`🔢 *Ref ID:* \`${params.referenceNumber}\``);
      }

      lines.push('');
      if (params.totalPendingCount > 1) {
        lines.push(`_Terdapat ${params.totalPendingCount} transaksi yang menunggu konfirmasi._`);
        lines.push(`• Balas *Ya ${params.ticketId}* untuk mencatat tiket ini`);
        lines.push(`• Balas *Ya semua* untuk mencatat semua tiket`);
        lines.push(`• Balas *Batal ${params.ticketId}* untuk membatalkan`);
      } else {
        lines.push('• Balas *Ya* atau *Catat* untuk menyimpan ke Wallet');
        lines.push('• Balas *Batal* untuk mengabaikan');
      }

      return lines.join('\n');
    },
  },

  confirmation: {
    singleSuccess(params: PendingConfirmationSuccessParams): string {
      if (params.isTransfer) {
        return [
          `✅ *Transfer Dicatat ke Wallet!* (#${params.ticketId})`,
          `🔄 ${params.formattedAmount}`,
          `💳 Dari: ${params.accountNameHint}${params.destinationAccountNameHint ? ` ➔ ${params.destinationAccountNameHint}` : ''}`,
          `_(${params.formattedTime})_`,
        ].join('\n');
      }

      const lines = [
        `✅ *Transaksi Dicatat ke Wallet!* (#${params.ticketId})`,
        `${params.icon || '💸'} ${params.merchantOrNote || 'Transaksi'} — ${params.formattedAmount}`,
      ];

      const metaParts: string[] = [];
      if (params.accountNameHint) {
        metaParts.push(`💳 ${params.accountNameHint}`);
      }
      if (params.matchedCategoryName) {
        metaParts.push(`📂 ${params.matchedCategoryName}`);
      }
      if (metaParts.length > 0) {
        lines.push(metaParts.join(' • '));
      }

      lines.push(`_(${params.formattedTime})_`);
      return lines.join('\n');
    },

    bulkSuccess(items: PendingBulkItemParams[], currentTimestamp: string): string {
      const lines = [
        `✅ *${items.length} Transaksi Berhasil Dicatat ke Wallet!*`,
        '',
      ];

      for (const item of items) {
        lines.push(`• [#${item.ticketId}] ${item.title}: ${item.formattedAmount} (${item.accountNameHint || 'Akun'})`);
      }

      lines.push('');
      lines.push(`_(${currentTimestamp})_`);
      return lines.join('\n');
    },

    cancellation(params: PendingCancellationParams): string {
      if (params.isBulk) {
        return `❌ *${params.count} Transaksi Dibatalkan*\nSemua transaksi pending telah dihapus dan tidak dicatat ke Wallet.`;
      }
      return `❌ *Transaksi #${params.ticketId} Dibatalkan*\nTransaksi "${params.title}" (${params.formattedAmount}) tidak dicatat ke Wallet.`;
    },
  },

  help: {
    welcomeGuidance: '👋 Halo! Kirimkan pengeluaran Anda (misal: "Makan siang 25rb pakai Cash") atau foto struk belanja untuk dicatat ke Wallet.',
    quickCommandsTitle: '*Perintah Cepat (0 Token AI):*',
    commandBalance: '• *Saldo* / *Cek Saldo*: Cek saldo semua rekening',
    commandBudget: '• *Budget* / *Cek Budget*: Cek status limit anggaran',
    commandMenu: '• *Menu* / *Bantuan*: Menampilkan petunjuk ini',
  },

  errors: {
    aiBusy(timestampString: string): string {
      return [
        '⚠️ Layanan AI lagi ramai, coba lagi ya dalam beberapa detik!',
        `_(${timestampString})_`,
      ].join('\n');
    },
    schemaValidation(timestampString: string): string {
      return [
        '⚠️ Transaksi belum tersimpan nih, format datanya kurang pas.',
        'Coba kirim ulang dengan lebih jelas ya, contoh: _"Makan siang 35rb pakai Gopay"_',
        `_(${timestampString})_`,
      ].join('\n');
    },
    networkConnection(timestampString: string): string {
      return [
        '⚠️ Koneksi ke server lagi gangguan sebentar, coba lagi ya!',
        `_(${timestampString})_`,
      ].join('\n');
    },
    generic(timestampString: string): string {
      return [
        '⚠️ Ada kendala saat memproses pesanmu.',
        'Detail sudah dicatat di log sistem untuk diperiksa.',
        `_(${timestampString})_`,
      ].join('\n');
    },
    validationRejected(errorMessage: string): string {
      return `⚠️ Transaksi tidak dapat disimpan karena data tidak valid:\n${errorMessage}`;
    },
    accountResolutionUnresolved(recordNumber: number, accountHint: string): string {
      const displayHint = accountHint || '(kosong)';
      return `Transaksi #${recordNumber}: Akun "${displayHint}" tidak dapat ditemukan secara pasti.`;
    },
    accountResolutionAmbiguous(recordNumber: number, accountHint: string, candidateNames: string[]): string {
      const displayHint = accountHint || '(kosong)';
      return candidateNames.length > 0
        ? `Transaksi #${recordNumber}: Akun "${displayHint}" ambigu. Kandidat: ${candidateNames.join(', ')}.`
        : `Transaksi #${recordNumber}: Akun "${displayHint}" ambigu dan tidak dapat dipilih secara aman.`;
    },
    accountResolutionFallback: 'Akun transaksi tidak dapat ditentukan secara aman.',
  },
};
