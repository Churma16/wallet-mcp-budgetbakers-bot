import type { IncomingUserMessageEvent } from '../../gateway/types.js';
import type { MessagingGatewayService } from '../../gateway/index.js';
import type { WalletCacheService } from '../../wallet/index.js';
import type { PendingTransactionService } from '../pending.js';
import type { FinancialAiProvider } from '../../brain/types.js';
import { INTERNAL_TRANSACTION_TYPES } from '../../wallet/constants.js';
import { enrichHistoryRecords } from '../../wallet/records/recordNormalizer.js';
import { applyReconciliationRules } from '../reconciliation/rules/jagoGopayRules.js';
import { compareMutationsWithWalletRecords } from '../reconciliation/comparisonEngine.js';
import {
  formatReconciliationCards,
  buildSingleMissingItemBubble,
  type FormattedTicketReference,
} from '../reconciliation/reconciliationCardFormatter.js';
import { reconciliationSessionStore } from '../reconciliation/reconciliationSessionStore.js';
import { applicationLogger } from '../../lib/logger.js';
import type { WalletRecordItem } from '../../wallet/types.js';

export interface ReconciliationHandlerDependencies {
  readonly gateway: MessagingGatewayService;
  readonly walletClient: {
    fetchRecords(options?: {
      startDate?: string;
      endDate?: string;
      limit?: number;
    }): Promise<{ records: WalletRecordItem[] }>;
  };
  readonly walletCache: WalletCacheService;
  readonly pendingTransactionManager: PendingTransactionService;
  readonly brainProvider: FinancialAiProvider;
}

/**
 * Extracts target account name hint following /reconciliation command.
 * Supports optional @botname suffix (e.g. /reconciliation@wallet_mcp_churma_bot mandiri).
 */
export function extractReconciliationAccountHint(textPayload: string): string {
  const trimmed = textPayload.trim();
  const match = trimmed.match(/^\/reconciliation(?:@\w+)?(?:\s+(.*))?$/i);
  return match && match[1] ? match[1].trim() : '';
}

/**
 * Checks whether an incoming message text qualifies as a reconciliation command.
 * Supports optional @botname suffix.
 */
export function isReconciliationCommand(textPayload?: string): boolean {
  if (!textPayload) return false;
  return /^\/reconciliation(?:@\w+)?(?:\s|$)/i.test(textPayload.trim());
}

/**
 * Resolves category for a suggested category name using guard clauses.
 */
export function resolveMatchingCategory(
  suggestedName: string | undefined,
  categories: readonly { id: string; name: string }[]
): { id?: string; name?: string } {
  if (!suggestedName) {
    return {};
  }
  const query = suggestedName.toLowerCase();
  const matched = categories.find(c => c.name.toLowerCase().includes(query));
  if (!matched) {
    return {};
  }
  return { id: matched.id, name: matched.name };
}

export class ReconciliationHandler {
  constructor(private readonly deps: ReconciliationHandlerDependencies) {}

  public async handleReconciliationRequest(event: IncomingUserMessageEvent): Promise<boolean> {
    const rawCaption = event.textPayload || '';
    if (!isReconciliationCommand(rawCaption)) {
      return false;
    }

    applicationLogger.info(
      `[Reconciliation] Incoming reconciliation request from ${event.senderIdentifier} in ${event.channel}`
    );

    const cachedAccounts = this.deps.walletCache.getAccounts();
    const cachedCategories = this.deps.walletCache.getCategories();

    // 1. Resolve Target Account from user caption
    const accountHint = extractReconciliationAccountHint(rawCaption);
    if (!accountHint) {
      const accountNames = cachedAccounts.map(a => a.name).join(', ');
      await this.deps.gateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        `⚠️ <b>Sertakan nama wallet/akun</b>\nContoh: <code>/reconciliation jago</code> atau <code>/reconciliation blu</code>\n\nAkun yang tersedia: <i>${accountNames || 'Belum ada akun terdaftar'}</i>`
      );
      return true;
    }

    const cleanHint = accountHint.toLowerCase();
    // Prioritize: 1. Exact match, 2. Starts with, 3. Substring includes, 4. Reverse includes
    const targetAccount =
      cachedAccounts.find(a => a.name.toLowerCase() === cleanHint) ||
      cachedAccounts.find(a => a.name.toLowerCase().startsWith(cleanHint)) ||
      cachedAccounts.find(a => a.name.toLowerCase().includes(cleanHint)) ||
      cachedAccounts.find(a => cleanHint.includes(a.name.toLowerCase()));

    if (!targetAccount) {
      const accountNames = cachedAccounts.map(a => a.name).join(', ');
      await this.deps.gateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        `⚠️ Akun "<b>${accountHint}</b>" tidak ditemukan di Wallet.\n\nAkun yang tersedia: <i>${accountNames || 'Tidak ada'}</i>`
      );
      return true;
    }

    // 2. Validate Image Buffers
    const imageBuffers: Buffer[] =
      event.imageBuffers && event.imageBuffers.length > 0
        ? event.imageBuffers
        : event.imageBuffer
        ? [event.imageBuffer]
        : [];

    if (imageBuffers.length === 0) {
      await this.deps.gateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        `⚠️ Mohon lampirkan foto/screenshot riwayat mutasi rekening atau dompet bersama perintah <code>/reconciliation ${accountHint}</code>.`
      );
      return true;
    }

    await this.deps.gateway.sendTypingPresence(event.channel, event.chatIdentifier);

    // 3. Extract Mutations via Brain AI Vision
    if (typeof this.deps.brainProvider.processStatementImages !== 'function') {
      await this.deps.gateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        '⚠️ Provider AI aktif saat ini belum mendukung ekstraksi mutasi rekening.'
      );
      return true;
    }

    applicationLogger.info(
      `[Reconciliation] Extracting mutations from ${imageBuffers.length} images for account "${targetAccount.name}"...`
    );

    const rawMutations = await this.deps.brainProvider.processStatementImages(
      imageBuffers,
      event.imageMimeType || 'image/jpeg',
      rawCaption
    );

    if (rawMutations.length === 0) {
      await this.deps.gateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        '⚠️ Tidak dapat membaca baris transaksi mutasi pada screenshot yang dilampirkan. Pastikan foto jelas, terang, dan teks transaksi terbaca.'
      );
      return true;
    }

    // 4. Apply Built-in Custom Rules (e.g. Jago x GoPay)
    const enrichedMutations = applyReconciliationRules(targetAccount.name, rawMutations);

    // 5. Query Wallet MCP Records for the expanded date window (minDate - 2 days s/d maxDate + 2 days)
    const sortedDates = [...enrichedMutations.map(m => m.date)].sort((a, b) => a.localeCompare(b));
    const minMutationDate = sortedDates[0];
    const maxMutationDate = sortedDates[sortedDates.length - 1];

    const startDateObj = new Date(minMutationDate + 'T00:00:00Z');
    startDateObj.setUTCDate(startDateObj.getUTCDate() - 2);
    const expandedStartDate = startDateObj.toISOString().slice(0, 10);

    const endDateObj = new Date(maxMutationDate + 'T00:00:00Z');
    endDateObj.setUTCDate(endDateObj.getUTCDate() + 2);
    const expandedEndDate = endDateObj.toISOString().slice(0, 10);

    let rawRecords: WalletRecordItem[] = [];
    try {
      const pageResult = await this.deps.walletClient.fetchRecords({
        startDate: expandedStartDate,
        endDate: expandedEndDate,
        limit: 50,
      });
      rawRecords = pageResult.records;
    } catch (fetchError: unknown) {
      applicationLogger.error(
        `[Reconciliation] Failed querying Wallet records: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`
      );
    }

    const enrichedWalletRecords = enrichHistoryRecords(
      rawRecords,
      cachedAccounts,
      cachedCategories
    );

    // 6. Execute Strict Distance-Priority Comparison Engine
    const comparisonResult = compareMutationsWithWalletRecords(
      enrichedMutations,
      targetAccount.id,
      targetAccount.name,
      enrichedWalletRecords
    );

    // 7. Enqueue Missing Transactions to PendingTransactionService
    const ticketReferences: FormattedTicketReference[] = [];

    for (const missingItem of comparisonResult.missing) {
      const resolvedCategory = resolveMatchingCategory(
        missingItem.suggestedCategoryName,
        cachedCategories
      );

      const isExpense = missingItem.mutation.direction === 'DEBIT';
      const signedAmount = isExpense
        ? -Math.abs(missingItem.mutation.amount)
        : Math.abs(missingItem.mutation.amount);

      const pendingItem = this.deps.pendingTransactionManager.addPendingTransaction({
        sourceType: 'RECONCILIATION',
        bankDisplayName: targetAccount.name,
        accountNameHint: targetAccount.name,
        matchedAccountId: targetAccount.id,
        counterParty: missingItem.mutation.counterParty,
        amount: signedAmount,
        currency: targetAccount.currency || 'IDR',
        transactionType: isExpense
          ? INTERNAL_TRANSACTION_TYPES.EXPENSE
          : INTERNAL_TRANSACTION_TYPES.INCOME,
        matchedCategoryId: resolvedCategory.id,
        matchedCategoryName: resolvedCategory.name,
        note: missingItem.note,
        recordDate: new Date(missingItem.mutation.date + 'T12:00:00Z').toISOString(),
        evidenceSources: ['RECONCILIATION_STATEMENT'],
      });

      ticketReferences.push({
        mutationId: missingItem.mutation.id,
        ticketId: pendingItem.ticketId,
      });
    }

    // 8. Create session and format separate cards
    const sessionId = reconciliationSessionStore.createSession(
      event.chatIdentifier,
      targetAccount.name,
      comparisonResult,
      ticketReferences
    );

    const cards = formatReconciliationCards(sessionId, comparisonResult, { ticketReferences });

    // Send Bubble 1: Overview Card
    await this.deps.gateway.sendMessage(event.channel, event.chatIdentifier, cards.overview);

    // Send Bubble 2: Matched (if any)
    if (cards.matched) {
      await this.deps.gateway.sendMessage(event.channel, event.chatIdentifier, cards.matched.text, {
        replyMarkup: cards.matched.replyMarkup,
      });
    }

    // Send Bubble 3: Wrong Account (if any)
    if (cards.wrongAccount) {
      await this.deps.gateway.sendMessage(event.channel, event.chatIdentifier, cards.wrongAccount.text, {
        replyMarkup: cards.wrongAccount.replyMarkup,
      });
    }

    // Send Missing Transactions: 1 dedicated bubble per transaction for direct swipe-reply interaction
    if (comparisonResult.missing.length > 0) {
      for (const missingItem of comparisonResult.missing) {
        const ticketRef = ticketReferences.find(t => t.mutationId === missingItem.mutation.id);
        const ticketId = ticketRef ? ticketRef.ticketId : 1;
        const itemBubbleText = buildSingleMissingItemBubble(missingItem, ticketId);

        const receipt = await this.deps.gateway.sendMessage(
          event.channel,
          event.chatIdentifier,
          itemBubbleText
        );

        if (
          receipt &&
          receipt.messageId &&
          typeof this.deps.pendingTransactionManager.updateNotificationMessageIds === 'function'
        ) {
          this.deps.pendingTransactionManager.updateNotificationMessageIds(ticketId, {
            [event.channel]: receipt.messageId,
          });
        }
      }

      if (comparisonResult.missing.length > 1) {
        await this.deps.gateway.sendMessage(
          event.channel,
          event.chatIdentifier,
          `💡 _Terdapat ${comparisonResult.missing.length} transaksi terlewat. Balas *Ya semua* untuk catat sekaligus, atau swipe reply per bubble di atas._`
        );
      }
    }

    return true;
  }
}
