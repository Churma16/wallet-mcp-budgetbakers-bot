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
import type { PendingTransactionService } from '../pending.js';
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
    private readonly transactionMessageStore: TransactionMessageStore,
    private readonly pendingTransactionService?: PendingTransactionService
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
      // Check if replying to a pending ticket message (e.g., "Tiket #12")
      const pendingMatch = event.replyToMessageText?.match(/Tiket\s+#?(\d+)/i);
      if (pendingMatch && this.pendingTransactionService) {
        const ticketId = Number.parseInt(pendingMatch[1], 10);
        return this.handlePendingTicketEdit(event, ticketId, editCommand);
      }

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

    const patchPayload: PatchRecordInputPayload = {
      id: mapping.recordId,
      ...(resolvedCategoryId ? { categoryId: resolvedCategoryId } : {}),
      ...(resolvedLabelIds ? { labelIds: resolvedLabelIds } : {}),
      ...(editCommand.note !== undefined ? { note: editCommand.note } : {}),
      ...(editCommand.amount !== undefined ? { amount: editCommand.amount } : {}),
      ...(editCommand.counterParty !== undefined ? { counterParty: editCommand.counterParty } : {}),
    };

    try {
      const patchResult = await this.walletMcpClient.patchRecords([patchPayload]);
      const singleResult = patchResult.results?.[0];
      if (singleResult && singleResult.success === false) {
        throw new Error(singleResult.error || 'Gagal memperbarui rekor di Wallet MCP');
      }

      this.transactionMessageStore.updateMessageMapping(event.replyToMessageId, {
        ...(resolvedCategoryId ? { categoryId: resolvedCategoryId, categoryName: resolvedCategoryName } : {}),
        ...(resolvedLabelIds ? { labelIds: resolvedLabelIds, labels: resolvedLabelNames } : {}),
        ...(editCommand.note !== undefined ? { note: editCommand.note } : {}),
        ...(editCommand.amount !== undefined ? { amount: editCommand.amount } : {}),
        ...(editCommand.counterParty !== undefined ? { counterParty: editCommand.counterParty } : {}),
      });

      const responseLines = ['✅ *Transaksi berhasil diperbarui:*'];
      if (resolvedCategoryName) {
        responseLines.push(`• *Kategori:* ${resolvedCategoryName}`);
      }
      if (editCommand.note !== undefined) {
        responseLines.push(`• *Catatan:* ${editCommand.note}`);
      }
      if (resolvedLabelNames && resolvedLabelNames.length > 0) {
        responseLines.push(`• *Tag:* ${resolvedLabelNames.map(t => `#${t.replace(/^#/, '')}`).join(' ')}`);
      }
      if (editCommand.amount !== undefined) {
        const sign = editCommand.amount < 0 ? '-' : '';
        responseLines.push(`• *Nominal:* ${sign}Rp ${Math.abs(editCommand.amount).toLocaleString('id-ID')}`);
      }
      if (editCommand.counterParty !== undefined) {
        responseLines.push(`• *Penerima/Merchant:* ${editCommand.counterParty}`);
      }

      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        responseLines.join('\n')
      );
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

  private handlePendingTicketEdit(
    event: IncomingUserMessageEvent,
    ticketId: number,
    editCommand: ReturnType<typeof parseRecordEditCommand>
  ): boolean {
    if (!this.pendingTransactionService || !editCommand) return false;

    const pendingItem = this.pendingTransactionService.getPendingTransaction(ticketId);
    if (!pendingItem) {
      return false;
    }

    let resolvedCategoryName: string | undefined;
    if (editCommand.categoryName) {
      const match = this.findAssignableCategory(editCommand.categoryName);
      if (match) {
        pendingItem.matchedCategoryId = match.id;
        pendingItem.matchedCategoryName = match.name;
        resolvedCategoryName = match.name;
      }
    }

    if (editCommand.note !== undefined) {
      pendingItem.note = editCommand.note;
    }
    if (editCommand.amount !== undefined) {
      pendingItem.amount = editCommand.amount;
    }
    if (editCommand.counterParty !== undefined) {
      pendingItem.counterParty = editCommand.counterParty;
    }

    this.pendingTransactionService.enrichPendingTransaction(ticketId, {
      ...(pendingItem.matchedCategoryId ? { matchedCategoryId: pendingItem.matchedCategoryId, matchedCategoryName: pendingItem.matchedCategoryName } : {}),
      ...(editCommand.note !== undefined ? { note: editCommand.note } : {}),
      ...(editCommand.amount !== undefined ? { amount: editCommand.amount } : {}),
      ...(editCommand.counterParty !== undefined ? { counterParty: editCommand.counterParty } : {}),
    });

    const lines = [`✅ *Draft Tiket #${ticketId} berhasil diperbarui:*`];
    if (resolvedCategoryName) {
      lines.push(`• *Kategori:* ${resolvedCategoryName}`);
    }
    if (editCommand.note !== undefined) {
      lines.push(`• *Catatan:* ${editCommand.note}`);
    }
    if (editCommand.amount !== undefined) {
      const sign = editCommand.amount < 0 ? '-' : '';
      lines.push(`• *Nominal:* ${sign}Rp ${Math.abs(editCommand.amount).toLocaleString('id-ID')}`);
    }
    if (editCommand.counterParty !== undefined) {
      lines.push(`• *Penerima/Merchant:* ${editCommand.counterParty}`);
    }

    this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, lines.join('\n'));
    return true;
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
