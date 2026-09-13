import {
  ResponseDictionary,
  RecordMessageParams,
  MultipleRecordsItemParams,
  PendingEmailNotificationParams,
  PendingConfirmationSuccessParams,
  PendingBulkItemParams,
  PendingCancellationParams,
  type TransactionSortOrder,
  type UnresolvedFilterIssue,
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
      const labelLine = params.labels && params.labels.length > 0
        ? `\n🔖 ${params.labels.map(label => `#${label}`).join(' ')}`
        : '';
      return [
        `✅ *${params.transactionTitle}* berhasil dicatat!`,
        '',
        `${params.transactionTypeIcon} ${params.formattedAmount}  •  ${params.accountName}`,
        `🏷️ ${params.categoryName}  •  ${params.recordTimestampDisplay}${labelLine}`,
      ].join('\n');
    },

    multipleSuccessHeader(totalRecordsCount: number, currentTimestamp: string): string {
      return `✅ *${totalRecordsCount} transaksi* berhasil dicatat! (${currentTimestamp})`;
    },

    multipleRecordItem(params: MultipleRecordsItemParams): string {
      const labelSuffix = params.labels && params.labels.length > 0
        ? `  •  🔖 ${params.labels.map(label => `#${label}`).join(' ')}`
        : '';
      return [
        `${params.itemIndex + 1}. ${params.transactionTypeIcon} ${params.transactionDescription} — *${params.formattedAmount}* dari ${params.accountName}`,
        `   🏷️ ${params.categoryName}  •  ${params.recordTimestampDisplay}${labelSuffix}`,
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

  history: {
    header(
      page: number,
      totalPages?: number,
      displayedCount?: number,
      totalCount?: number,
      sortOrderLabel?: string,
      filterSummary?: string
    ): string {
      const pageInfo = typeof totalPages === 'number' ? `Hal. ${page}/${totalPages}` : `Hal. ${page}`;
      const countInfo = typeof displayedCount === 'number' && displayedCount > 0
        ? ` • ${displayedCount} item`
        : '';
      const sortSuffix = sortOrderLabel ? ` [${sortOrderLabel}]` : '';
      const filterSuffix = filterSummary ? ` [${filterSummary}]` : '';
      return `📋 *Riwayat Transaksi*\n${pageInfo}${countInfo}${sortSuffix}${filterSuffix}`;
    },
    emptyState: 'Belum ada transaksi yang tercatat.',
    emptyFilteredState(filterSummary: string): string {
      return `Belum ada transaksi yang cocok dengan filter [${filterSummary}].`;
    },
    unresolvedFilters(issues: UnresolvedFilterIssue[]): string {
      const issueLines = issues.map(issue => {
        if (issue.filterKey === 'account') {
          if (issue.reason === 'NOT_FOUND') {
            return `• Akun "${issue.rawValue}" tidak ditemukan dalam daftar akun Wallet Anda.`;
          }
          if (issue.reason === 'UNRESOLVED' || issue.reason === 'AMBIGUOUS') {
            if (issue.subType === 'bank_account' && issue.candidates && issue.candidates.length > 0) {
              return `• Nomor rekening "${issue.rawValue}" ambigu. Kandidat: ${issue.candidates.join(', ')}.`;
            }
            if (issue.candidates && issue.candidates.length > 0) {
              return `• Akun "${issue.rawValue}" ambigu. Kandidat: ${issue.candidates.join(', ')}.`;
            }
            return `• Akun "${issue.rawValue}" ambigu. Ditemukan beberapa akun dengan nama yang sama.`;
          }
        }
        if (issue.filterKey === 'category') {
          if (issue.reason === 'NOT_FOUND') {
            return `• Kategori "${issue.rawValue}" tidak ditemukan dalam daftar kategori Wallet Anda.`;
          }
          if (issue.reason === 'UNSUPPORTED') {
            return `• Grup kategori "${issue.rawValue}" tidak didukung oleh Wallet.`;
          }
          if (issue.reason === 'UNRESOLVED' || issue.reason === 'AMBIGUOUS') {
            if (issue.candidates && issue.candidates.length > 0) {
              return `• Kategori "${issue.rawValue}" ambigu. Kandidat: ${issue.candidates.join(', ')}.`;
            }
            return `• Kategori "${issue.rawValue}" ambigu. Ditemukan beberapa kategori dengan nama yang sama.`;
          }
        }
        if (issue.filterKey === 'recordType') {
          return `• Tipe transaksi "${issue.rawValue}" tidak valid. Gunakan "expense" (pengeluaran) atau "income" (pemasukan).`;
        }
        if (issue.filterKey === 'dateRange') {
          if (issue.reason === 'INVALID_RANGE') {
            return `• Rentang tanggal tidak valid: batas awal tidak boleh lebih besar dari batas akhir.`;
          }
          if (issue.reason === 'INVALID_FORMAT') {
            if (issue.subType === 'operator_prefix') {
              return `• Format filter tanggal "${issue.rawValue}" tidak valid. Gunakan prefix operator: eq., gt., gte., lt., atau lte.`;
            }
            return `• Tanggal "${issue.rawValue}" tidak valid atau bukan tanggal kalender yang valid.`;
          }
        }
        if (issue.filterKey === 'searchQuery') {
          if (issue.reason === 'UNSUPPORTED') {
            return `• Pencarian teks tidak didukung oleh sumber data upstream.`;
          }
          if (issue.reason === 'INVALID_FORMAT') {
            if (!issue.rawValue || issue.rawValue.trim().length === 0) {
              return `• Kata kunci pencarian tidak boleh kosong.`;
            }
            return `• Kata kunci pencarian "${issue.rawValue}" tidak valid atau melebihi batas 100 karakter.`;
          }
          if (issue.reason === 'UNRESOLVED') {
            return `• Verifikasi pencarian dijeda pada batas pemindaian aman. Ulangi pencarian yang sama untuk melanjutkan dari posisi cache, atau persempit dengan filter akun, kategori, atau tanggal.`;
          }
          return `• Kata kunci pencarian "${issue.rawValue}" tidak dapat diproses.`;
        }
        return `• ${issue.message}`;
      });
      return [
        '⚠️ *Filter Riwayat Tidak Ditemukan:*',
        ...issueLines,
        '_Pastikan nama akun atau kategori sudah sesuai dengan data Wallet Anda._',
      ].join('\n');
    },
    outOfBounds(totalCount: number): string {
      return `Halaman ini melebihi jumlah transaksi yang tersedia (Total: ${totalCount} transaksi).`;
    },
    navigationHint(
      nextPage: number,
      options?: { limit?: number; sort?: TransactionSortOrder; filterTokens?: string[] }
    ): string {
      const commandParts = ['riwayat'];
      if (options?.filterTokens && options.filterTokens.length > 0) {
        commandParts.push(...options.filterTokens);
      }
      if (options?.limit && options.limit !== 10) {
        commandParts.push(String(options.limit));
      }
      commandParts.push(`hal ${nextPage}`);
      if (options?.sort === 'oldest') {
        commandParts.push('terlama');
      }
      return `_Ketik *${commandParts.join(' ')}* untuk halaman selanjutnya._`;
    },
    sortNewest: 'Terbaru',
    sortOldest: 'Terlama',
    typeExpense: 'Pengeluaran',
    typeIncome: 'Pemasukan',
    searchBadge(keyword: string): string {
      return `Cari: "${keyword}"`;
    },
  },

  emailPending: {
    formatNotification(params: PendingEmailNotificationParams): string {
      const isTransfer = params.typeLabel.includes('Transfer');
      const headline = isTransfer ? '🔄 *Transfer Baru*' : '📩 *Pembayaran Baru*';
      const merchantOrTitle = isTransfer
        ? `${params.accountNameHint || 'Akun'} ➔ ${params.destinationAccountNameHint || 'Tujuan'}`
        : (params.counterParty || params.matchedCategoryName || params.bankDisplayName);

      const ticketSuffix = params.totalPendingCount > 1 ? ` (#${params.ticketId})` : '';
      const lines = [
        headline,
        `*${params.formattedAmount}* • ${merchantOrTitle}${ticketSuffix}`,
      ];

      if (params.accountNameHint && !isTransfer) {
        lines.push(`Akun: ${params.accountNameHint}`);
      }
      if (params.matchedCategoryName && !isTransfer) {
        lines.push(`Kategori: ${params.matchedCategoryName}`);
      }

      lines.push('');
      lines.push('Catat transaksi ini?');
      if (params.totalPendingCount > 1) {
        lines.push(`• Balas *Ya ${params.ticketId}* (atau *Ya semua*)`);
        lines.push(`• Balas *Batal ${params.ticketId}*`);
        const otherCount = params.totalPendingCount - 1;
        lines.push('');
        lines.push(`_Ada ${otherCount} transaksi lain yang juga menunggu konfirmasi._`);
      } else {
        lines.push('• Balas *Ya* atau *Catat*');
        lines.push('• Balas *Batal* atau *Abaikan*');
      }

      return lines.join('\n');
    },
  },

  status: {
    header: '📋 *Status Transaksi*',
    emptyAttention: 'Tidak ada transaksi yang memerlukan perhatian saat ini.',
    needsCheckHeader(count: number): string {
      return `⚠️ *${count} transaksi perlu diperiksa:*`;
    },
    waitingConfirmationHeader(count: number): string {
      return `⏳ *${count} transaksi menunggu konfirmasi:*`;
    },
    waitingAccountHeader(count: number): string {
      return `⏳ *${count} transaksi menunggu pilihan akun:*`;
    },
    noOtherTransactionsWaiting: 'Tidak ada transaksi lain yang menunggu konfirmasi.',
  },

  uncertain: {
    title: '⚠️ *Belum bisa memastikan transaksi sudah tercatat*',
    riskWarning: 'Jangan kirim ulang transaksi ini dulu agar tidak tercatat dua kali. Transaksi ini tidak akan dikirim ulang otomatis.',
    actionPromptSingle: 'Cek Wallet, lalu balas:\n• *Sudah ada*\n• *Belum ada*',
    actionPromptMultiple(tickets: number[]): string {
      const commandLines = tickets.map(
        ticketId => `• *Sudah ada #${ticketId}* atau *Belum ada #${ticketId}*`
      );
      return `Cek Wallet, lalu balas:\n${commandLines.join('\n')}`;
    },
  },

  reconciliation: {
    recordedWithTicket(ticketId: number): string {
      return `✅ Oke, transaksi #${ticketId} dianggap sudah tercatat di Wallet.\nTidak ada transaksi yang akan dikirim ulang.`;
    },
    recordedSingle: '✅ Oke, transaksi dianggap sudah tercatat di Wallet.\nTidak ada transaksi yang akan dikirim ulang.',
    absentWithTicket(ticketId: number): string {
      return `⚠️ Transaksi #${ticketId} belum tercatat di Wallet.\nStatus dikembalikan agar aman dicoba lagi.\nBalas *Ya #${ticketId}* untuk mencoba mencatat kembali, atau *Batal #${ticketId}* untuk membatalkan.`;
    },
    absentSingle: '⚠️ Transaksi belum tercatat di Wallet.\nStatus dikembalikan agar aman dicoba lagi.\nBalas *Ya* untuk mencoba mencatat kembali, atau *Batal* untuk membatalkan.',
    notFoundWithTicket(ticketId: number): string {
      return `⚠️ Transaksi #${ticketId} tidak ditemukan atau sudah selesai diperiksa.`;
    },
    notFoundNone: 'Tidak ada transaksi yang perlu diperiksa saat ini.',
    ambiguous(ticketIds: number[]): string {
      const ticketList = ticketIds.map(ticketId => `#${ticketId}`).join(', ');
      return `⚠️ Ada beberapa transaksi yang perlu diperiksa (${ticketList}). Balas dengan nomor tiket, contoh: *Sudah ada #${ticketIds[0]}* atau *Belum ada #${ticketIds[0]}*.`;
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
    commandHistory: '• *Riwayat* / *History*: Cek riwayat transaksi terakhir',
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
    receiptExtractionFailed(timestampString: string): string {
      return [
        '⚠️ Foto struk belum berhasil dibaca dengan jelas.',
        'Pastikan foto terang dan teks transaksi terbaca, atau kirim ulang dengan caption contoh: _"Makan siang 35rb pakai Gopay"_',
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
    mediaTooLarge(maxMegabytes: number): string {
      return `⚠️ Ukuran foto melebihi batas maksimal (${maxMegabytes} MB). Silakan kirim foto dengan ukuran lebih kecil ya!`;
    },
    mediaDownloadFailed(channelDisplayName: string): string {
      return `⚠️ Gagal mengunduh foto struk dari ${channelDisplayName}. Silakan coba kirim ulang ya!`;
    },
  },
};
