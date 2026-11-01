import type { IncomingUserMessageEvent, MessagingGatewayService } from '../../gateway/index.js';
import type {
  WalletCacheService,
  WalletMcpClientService,
  WalletCategoryItem,
  PatchRecordInputPayload,
} from '../../wallet/index.js';
import {
  parseRecordEditCommand,
  resolveAndEnsureLabels,
  TransactionMessageStore,
} from '../../wallet/index.js';
import {
  formatCurrencyAmount,
  formatTransactionDate,
} from '../../wallet/formatters/humanResponseFormatter.js';
import { getDefaultCurrency } from '../../config/applicationConfig.js';
import { normalizeTransactionText } from '../../lib/textCasing.js';
import { applicationLogger } from '../../lib/logger.js';

/**
 * Handles conversational transaction edit commands triggered when a user
 * replies to a previously recorded transaction message in Telegram.
 */
export class ModifyRecordHandler {
  constructor(
    private readonly walletMcpClient: WalletMcpClientService,
    private readonly walletCacheService: WalletCacheService,
    private readonly messagingGateway: MessagingGatewayService,
    private readonly transactionMessageStore: TransactionMessageStore
  ) {}

  public async handleModifyRecordReply(
    event: IncomingUserMessageEvent,
    _processingStartTimestamp: number
  ): Promise<boolean> {
    if (!event.replyToMessageId || !event.textPayload) {
      return false;
    }

    const editCommand = parseRecordEditCommand(event.textPayload);
    if (!editCommand || !editCommand.hasModifications) {
      return false;
    }

    applicationLogger.fileDetail('chat', 'Detected Record Edit Command on Reply', {
      replyToMessageId: event.replyToMessageId,
      editCommand,
    });

    const mapping = this.transactionMessageStore.getMessageMapping(event.replyToMessageId);
    if (!mapping) {
      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        '⚠️ Transaksi tidak ditemukan atau pesan yang dibalas sudah kedaluwarsa.'
      );
      return true;
    }

    let resolvedCategoryId: string | undefined;
    let resolvedCategoryName: string | undefined;

    if (editCommand.categoryName) {
      const match = this.findAssignableCategory(editCommand.categoryName);
      if (!match) {
        await this.messagingGateway.sendMessage(
          event.channel,
          event.chatIdentifier,
          `⚠️ Kategori "${editCommand.categoryName}" tidak ditemukan atau tidak dapat digunakan.`
        );
        return true;
      }
      resolvedCategoryId = match.id;
      resolvedCategoryName = match.name;
    }

    let resolvedLabelIds: string[] | undefined;
    let resolvedLabelNames: string[] | undefined;

    if (editCommand.tags && editCommand.tags.length > 0) {
      const labelResolution = await resolveAndEnsureLabels(
        editCommand.tags,
        this.walletCacheService,
        this.walletMcpClient
      );
      resolvedLabelIds = labelResolution.resolvedLabelIds;
      resolvedLabelNames = labelResolution.resolvedLabelNames;
    }

    let resolvedAmount: number | undefined;
    if (editCommand.amount !== undefined) {
      if (editCommand.amount === 0) {
        await this.messagingGateway.sendMessage(
          event.channel,
          event.chatIdentifier,
          '⚠️ Nominal transaksi tidak boleh bernilai 0.'
        );
        return true;
      }
      // Preserve negative expense sign if original transaction was an expense and no explicit '+' was provided
      if (mapping.amount !== undefined && mapping.amount < 0 && !editCommand.hasExplicitPositiveSign) {
        resolvedAmount = -Math.abs(editCommand.amount);
      } else {
        resolvedAmount = editCommand.amount;
      }
    }

    // Auto-capitalize note and counterParty using Smart Title Casing
    const formattedNote = editCommand.note !== undefined
      ? (normalizeTransactionText(editCommand.note) || editCommand.note)
      : undefined;

    const formattedCounterParty = editCommand.counterParty !== undefined
      ? (normalizeTransactionText(editCommand.counterParty) || editCommand.counterParty)
      : undefined;

    const patchPayload: PatchRecordInputPayload = {
      id: mapping.recordId,
      ...(resolvedCategoryId ? { categoryId: resolvedCategoryId } : {}),
      ...(resolvedLabelIds ? { labelIds: resolvedLabelIds } : {}),
      ...(formattedNote !== undefined ? { note: formattedNote } : {}),
      ...(resolvedAmount !== undefined ? { amount: resolvedAmount } : {}),
      ...(formattedCounterParty !== undefined ? { counterParty: formattedCounterParty } : {}),
    };

    try {
      const patchResult = await this.walletMcpClient.patchRecords([patchPayload]);
      const singleResult = patchResult.results?.[0];
      if (!singleResult || singleResult.success === false) {
        throw new Error(singleResult?.error || 'Gagal memperbarui rekor di Wallet MCP');
      }

      this.transactionMessageStore.updateMessageMapping(event.replyToMessageId, {
        ...(resolvedCategoryId ? { categoryId: resolvedCategoryId, categoryName: resolvedCategoryName } : {}),
        ...(resolvedLabelIds ? { labelIds: resolvedLabelIds, labels: resolvedLabelNames } : {}),
        ...(formattedNote !== undefined ? { note: formattedNote } : {}),
        ...(resolvedAmount !== undefined ? { amount: resolvedAmount } : {}),
        ...(formattedCounterParty !== undefined ? { counterParty: formattedCounterParty } : {}),
      });

      // Build structured receipt response
      const finalAmount = resolvedAmount !== undefined ? resolvedAmount : (mapping.amount ?? 0);
      const isExpense = finalAmount < 0;
      const transactionTypeIcon = isExpense ? '💸' : '💰';

      const cachedAccounts = this.walletCacheService.getAccounts();
      const targetAccount = cachedAccounts.find(account => account.id === mapping.accountId);
      const resolvedCurrency = mapping.currency || targetAccount?.currency || getDefaultCurrency();
      const formattedAmount = formatCurrencyAmount(finalAmount, resolvedCurrency, 'id');
      const resolvedAccountName = targetAccount?.name || mapping.accountName || 'Wallet';

      const cachedCategories = this.walletCacheService.getCategories();
      const finalCategoryName =
        resolvedCategoryName ||
        mapping.categoryName ||
        cachedCategories.find(c => c.id === mapping.categoryId)?.name ||
        'Umum';

      const recordTimestampDisplay = formatTransactionDate(
        mapping.recordDate || mapping.createdAt,
        'id'
      );

      const finalNote = formattedNote !== undefined ? formattedNote : mapping.note;
      const finalCounterParty = formattedCounterParty !== undefined ? formattedCounterParty : mapping.counterParty;
      const displayTitle = finalNote || finalCounterParty || (isExpense ? 'Pengeluaran' : 'Pemasukan');

      const responseLines = [
        '✅ Transaksi berhasil diperbarui:',
        '',
        displayTitle,
        `${transactionTypeIcon} ${formattedAmount}  •  ${resolvedAccountName}`,
        `🏷️ ${finalCategoryName}  •  ${recordTimestampDisplay}`,
      ];

      const finalLabels = resolvedLabelNames !== undefined ? resolvedLabelNames : mapping.labels;
      if (finalLabels && finalLabels.length > 0) {
        responseLines.push(`🔖 ${finalLabels.map(t => `#${t.replace(/^#/, '')}`).join(' ')}`);
      }

      const sendReceipt = await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        responseLines.join('\n')
      );

      // Support chained edits by recording the new response message ID
      if (sendReceipt && 'messageId' in sendReceipt && sendReceipt.messageId) {
        this.transactionMessageStore.recordMessageMapping(sendReceipt.messageId, {
          ...mapping,
          ...(resolvedCategoryId ? { categoryId: resolvedCategoryId, categoryName: resolvedCategoryName } : {}),
          ...(resolvedLabelIds ? { labelIds: resolvedLabelIds, labels: resolvedLabelNames } : {}),
          ...(formattedNote !== undefined ? { note: formattedNote } : {}),
          ...(resolvedAmount !== undefined ? { amount: resolvedAmount } : {}),
          ...(formattedCounterParty !== undefined ? { counterParty: formattedCounterParty } : {}),
        });
      }

      return true;
    } catch (patchError) {
      applicationLogger.error(
        `Failed to patch record '${mapping.recordId}': ${
          patchError instanceof Error ? patchError.message : String(patchError)
        }`
      );
      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        `❌ Gagal memperbarui transaksi: ${
          patchError instanceof Error ? patchError.message : String(patchError)
        }`
      );
      return true;
    }
  }

  private findAssignableCategory(nameOrIdHint: string): WalletCategoryItem | undefined {
    const categories = this.walletCacheService.getCategories();
    const cleanHint = nameOrIdHint.trim().toLowerCase();

    // 1. Direct ID match
    const byId = categories.find(c => c.id === nameOrIdHint.trim());
    if (byId && byId.isAssignable !== false && byId.group?.id !== 'system_categories') {
      return byId;
    }

    // 2. Exact name match (case-insensitive)
    const exactName = categories.find(
      c =>
        c.name.trim().toLowerCase() === cleanHint &&
        c.isAssignable !== false &&
        c.group?.id !== 'system_categories'
    );
    if (exactName) return exactName;

    // 3. Partial substring name match
    const partialName = categories.find(
      c =>
        c.name.trim().toLowerCase().includes(cleanHint) &&
        c.isAssignable !== false &&
        c.group?.id !== 'system_categories'
    );
    if (partialName) return partialName;

    return undefined;
  }
}
