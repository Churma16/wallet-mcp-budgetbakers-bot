import { formatEditSuccessReceipt, type EditReceiptLocaleConfig } from '../editReceiptFormatter.js';
import {
  ResponseDictionary,
  RecordMessageParams,
  RecordEditSuccessParams,
  MultipleRecordsItemParams,
  PendingEmailNotificationParams,
  PendingConfirmationPromptParams,
  PendingConfirmationSuccessParams,
  PendingBulkItemParams,
  PendingCancellationParams,
  type TransactionSortOrder,
  type UnresolvedFilterIssue,
} from '../types.js';

export function formatPendingConfirmationPromptId(params: PendingConfirmationPromptParams): string {
  const lines: string[] = ['Catat transaksi ini?'];
  if (params.totalPendingCount > 1) {
    lines.push(`• Balas *Ya ${params.ticketId}* (atau *Ya semua*)`);
    lines.push(`• Balas *Ya ${params.ticketId}: n:<catatan> c:<kategori> t:<tag> m:<merchant> acc:<akun>*`);
    lines.push(`• Balas *Batal ${params.ticketId}*`);
    const otherCount = params.totalPendingCount - 1;
    lines.push('');
    lines.push(`_Ada ${otherCount} transaksi lain yang juga menunggu konfirmasi._`);
  } else {
    lines.push(`• Balas *Ya* atau *Catat* (atau *Ya ${params.ticketId}*)`);
    lines.push(`• Balas *Ya: n:<catatan> c:<kategori> t:<tag> m:<merchant> acc:<akun>*`);
    lines.push(`• Balas *Batal* atau *Abaikan* (atau *Batal ${params.ticketId}*)`);
  }
  return lines.join('\n');
}


const indonesianEditReceiptConfig: EditReceiptLocaleConfig = {
  header: '✅ Transaksi berhasil diperbarui:',
  accountMoved: (from, to) => `🏦 Akun dipindahkan dari: ${from} ➔ ${to}`,
  clearedFieldsHeader: '🧹 Bidang dibersihkan:',
  fieldNames: {
    note: 'Catatan',
    labelIds: 'Tag / Label',
    counterParty: 'Merchant / Payee',
    categoryId: 'Kategori',
    transfer: 'Status Transfer',
    place: 'Lokasi',
  },
};

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
    transferSuccess: 'Transfer berhasil dicatat!',
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

    editSuccess(params: RecordEditSuccessParams): string {
      return formatEditSuccessReceipt(params, indonesianEditReceiptConfig);
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
    convertToBadge(currencyCode: string): string {
      return `Konversi: ${currencyCode.toUpperCase()}`;
    },
  },

  emailPending: {
    formatConfirmationPrompt: formatPendingConfirmationPromptId,
    formatNotification(params: PendingEmailNotificationParams): string {
      const isTransfer = params.typeLabel.includes('Transfer');
      const headline = isTransfer ? '🔄 *Transfer Baru*' : '📩 *Pembayaran Baru*';
      const merchantOrTitle = isTransfer
        ? `${params.accountNameHint || 'Akun'} ➔ ${params.destinationAccountNameHint || 'Tujuan'}`
        : (params.counterParty || params.matchedCategoryName || params.bankDisplayName);

      const lines = [
        headline,
        `*${params.formattedAmount}* • ${merchantOrTitle} (#${params.ticketId})`,
      ];

      if (params.accountNameHint && !isTransfer) {
        lines.push(`Akun: ${params.accountNameHint}`);
      }
      if (params.matchedCategoryName && !isTransfer) {
        lines.push(`Kategori: ${params.matchedCategoryName}`);
      }
      if (params.isBankSyncedAccount) {
        lines.push('💡 _Rekening ini terhubung dengan bank sync Wallet._');
      }

      lines.push('');
      lines.push(
        formatPendingConfirmationPromptId({
          ticketId: params.ticketId,
          totalPendingCount: params.totalPendingCount,
        })
      );

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
      if (params.labels && params.labels.length > 0) {
        metaParts.push(`🔖 ${params.labels.map(label => `#${label}`).join(' ')}`);
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

    itemProcessing(ticketId: number): string {
      return `⏳ *Transaksi #${ticketId} sedang diproses...*\nMohon tunggu sebentar, transaksi sedang dicatat ke Wallet.`;
    },

    itemAlreadyResolved(ticketId: number): string {
      return `ℹ️ *Transaksi #${ticketId} sudah berhasil dicatat sebelumnya.*`;
    },

    itemNotFound(ticketId?: number): string {
      return ticketId
        ? `ℹ️ *Tiket #${ticketId} tidak ditemukan atau sudah selesai diproses.*`
        : 'ℹ️ *Tidak ada transaksi yang menunggu konfirmasi saat ini.*';
    },

    noPendingItems: 'ℹ️ *Tidak ada transaksi yang menunggu konfirmasi saat ini.*',

    itemProcessingCannotCancel(ticketId: number): string {
      return `⏳ *Transaksi #${ticketId} sedang diproses dan tidak dapat dibatalkan.*`;
    },

    cancellationNotFound(ticketId?: number): string {
      return ticketId
        ? `ℹ️ *Tiket #${ticketId} tidak ditemukan atau sudah dibatalkan/selesai.*`
        : 'ℹ️ *Tidak ada transaksi yang menunggu konfirmasi saat ini.*';
    },
  },

  help: {
    welcomeGuidance: [
      'Ketik pengeluaran kamu langsung, misalnya:',
      '"Makan siang 30k Cash" atau "Bensin 50rb Gopay"',
      '',
      'Atau kirim foto struk — langsung kerekam.',
    ].join('\n'),
  },

  telegramMenu: {
    buttonBalance: '\u{1F4B0} Cek Saldo',
    buttonBudget: '\u{1F4CA} Cek Budget',
    buttonHistory: '\u{1F4DC} Riwayat',
    buttonGuide: '\u{2753} Panduan',

    commandBalanceDescription: 'Cek saldo seluruh rekening',
    commandBudgetDescription: 'Cek limit dan sisa anggaran',
    commandHistoryDescription: 'Cek transaksi terakhir',
    commandSummaryDescription: 'Cek ringkasan pengeluaran bulan ini',
    commandMenuDescription: 'Buka menu utama dan panduan',

    topicRecord: '\u{1F4DD} Catat Transaksi',
    topicTransfer: '\u{1F504} Cara Transfer',
    topicEditDelete: '\u{270F}\u{FE0F} Edit & Hapus',
    topicReceipt: '\u{1F4F8} Foto Struk',
    topicSummaryFilter: '\u{1F50D} Rekap & Filter',
    topicFastCommands: '\u{26A1} Perintah Cepat',
    buttonBack: '\u{1F519} Kembali ke Menu Panduan',

    guideHomeTitle: '<b>\u{1F4D6} Panduan Penggunaan Wallet Bot</b>',
    guideHomeSubtitle: 'Pilih topik di bawah untuk melihat contoh format dan cara penggunaannya:',
    guideRecordContent: [
      '<b>\u{1F4DD} Catat Pengeluaran &amp; Pemasukan</b>',
      '',
      'Ketik nominal, keperluan, dan rekening dengan bahasa sehari-hari.',
      '',
      '<b>Contoh:</b>',
      '\u{2022} <i>Makan siang 35k BCA</i>',
      '\u{2022} <i>Beli bensin 50rb Cash</i>',
      '\u{2022} <i>Gaji bulanan 10jt ke Mandiri</i>',
      '\u{2022} <i>Jual barang bekas 150.000 Gopay</i>',
      '',
      '\u{1F4A1} <i>Tips: Bot otomatis mengenali singkatan nominal (k, rb, jt) dan mencocokkan kategori secara cerdas.</i>',
    ].join('\n'),
    guideTransferContent: [
      '<b>\u{1F504} Catat Transfer Antar Rekening</b>',
      '',
      'Pindahkan saldo antar bank atau e-wallet tanpa mengubah total kekayaan bersih Anda.',
      '',
      '<b>Contoh:</b>',
      '\u{2022} <i>Transfer 500k dari BCA ke Mandiri</i>',
      '\u{2022} <i>Topup Gopay 100k pakai BCA</i>',
      '\u{2022} <i>Tf 200rb BCA ke Shopeepay</i>',
      '\u{2022} <i>Tarik tunai 300k Mandiri ke Cash</i>',
    ].join('\n'),
    guideEditDeleteContent: [
      '<b>\u{270F}\u{FE0F} Edit &amp; Hapus Transaksi (Via Reply)</b>',
      '',
      'Salah catat nominal atau kategori? Cukup <b>swipe / reply</b> pesan konfirmasi/struk dari bot!',
      '',
      '<b>1. Cara Edit Transaksi:</b>',
      'Reply struk bot dengan format:',
      '\u{2022} <code>a: 35k</code> (ubah nominal)',
      '\u{2022} <code>c: Makanan</code> (ubah kategori)',
      '\u{2022} <code>rek: BCA</code> (ubah rekening)',
      '\u{2022} <code>n: Traktir teman t: #kopi</code> (tambah catatan &amp; tag)',
      '\u{2022} <code>a: 45k c: Hiburan rek: BCA</code> (ubah beberapa sekaligus)',
      '',
      '<b>2. Cara Hapus / Batalkan:</b>',
      '\u{2022} Reply struk bot lalu ketik <code>hapus</code> atau <code>delete</code>.',
      '  Bot akan langsung menghapus transaksi tersebut dari Wallet.',
    ].join('\n'),
    guideReceiptContent: [
      '<b>\u{1F4F8} Kirim Foto Struk Belanja (Vision)</b>',
      '',
      'Malas mengetik? Cukup foto struk belanjaanmu dan kirim langsung ke chat ini!',
      '',
      '<b>Cara kerja:</b>',
      '1. Ambil foto struk belanja (Indomaret, Alfamart, SPBU, resto, dsb.).',
      '2. Kirim fotonya ke chat bot ini (bisa tambahkan caption rekening, misal: <i>pakai BCA</i>).',
      '3. AI Vision akan membaca total belanja, nama toko, dan mencatatnya otomatis.',
    ].join('\n'),
    guideSummaryFilterContent: [
      '<b>\u{1F50D} Rekap &amp; Filter Riwayat</b>',
      '',
      'Kueri cepat langsung dari BudgetBakers tanpa memakan token AI:',
      '',
      '<b>Contoh Perintah:</b>',
      '\u{2022} <i>Rekap bulan ini</i>',
      '\u{2022} <i>Rekap pengeluaran minggu lalu</i>',
      '\u{2022} <i>10 transaksi terakhir</i>',
      '\u{2022} <i>Riwayat BCA</i>',
      '\u{2022} <i>Cek antrean pending</i>',
    ].join('\n'),
    guideFastCommandsContent: [
      '<b>\u{26A1} Perintah Cepat</b>',
      '',
      'Tombol keyboard bawah siap digunakan kapan saja:',
      '\u{2022} <b>Cek Saldo</b> \u{2014} Ringkasan total uang &amp; rekening',
      '\u{2022} <b>Cek Budget</b> \u{2014} Sisa limit anggaran bulan ini',
      '\u{2022} <b>Riwayat</b> \u{2014} 5 transaksi terakhir',
      '\u{2022} <b>Panduan</b> \u{2014} Menampilkan menu panduan ini',
    ].join('\n'),
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
    recordEditAccountNotFound(accountHint: string): string {
      return `⚠️ Akun "${accountHint}" tidak ditemukan.`;
    },
    recordEditAccountAmbiguous(accountHint: string, candidates: string[]): string {
      return `⚠️ Akun "${accountHint}" ambigu: cocok dengan ${candidates.join(', ')}.`;
    },
    recordEditSourceBankSynced(accountName: string): string {
      return `⚠️ Transaksi pada akun bank-sync (${accountName}) tidak dapat dipindahkan ke akun lain.`;
    },
    recordEditTargetBankSynced(accountName: string): string {
      return `⚠️ Tidak dapat memindahkan transaksi ke akun bank-sync (${accountName}).`;
    },
    recordEditCurrencyMismatch(
      sourceAccount: string,
      sourceCurrency: string,
      targetAccount: string,
      targetCurrency: string
    ): string {
      return `⚠️ Tidak dapat memindahkan transaksi: Mata uang ${sourceAccount} (${sourceCurrency}) berbeda dengan ${targetAccount} (${targetCurrency}). BudgetBakers hanya mengizinkan pemindahan antar-akun dengan mata uang yang sama.`;
    },
    recordEditZeroAmount: '⚠️ Nominal transaksi tidak boleh bernilai 0.',
    recordEditCategoryNotFound(categoryHint: string): string {
      return `⚠️ Kategori "${categoryHint}" tidak ditemukan atau tidak dapat digunakan.`;
    },
    recordEditNotFound: '⚠️ Transaksi tidak ditemukan atau pesan yang dibalas sudah kedaluwarsa.',
    recordEditFailed(reason: string): string {
      return `❌ Gagal memperbarui transaksi: ${reason}`;
    },
  },
};
