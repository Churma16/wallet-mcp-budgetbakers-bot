import { ExtractedEmailTransactionData } from '../brain/types.js';
import { GateEvaluationResult } from '../email/index.js';
import { PendingTransactionService, buildRecordsForPendingItem } from './pending.js';
import { MessagingGatewayService } from '../gateway/index.js';
import { TransactionCorrelationService, TransactionEvidence, TransactionEvidenceSource } from '../email/index.js';
import { isGenericMerchant, isGenericCategory } from '../email/transactionFusion.js';
import {
  WalletCacheService,
  WalletMcpClientService,
  WalletRecordItem,
  PatchRecordInputPayload,
} from '../wallet/index.js';
import {
  formatPendingEmailTransactionNotification,
  formatEnrichedPendingEmailTransactionNotification,
  formatCorrelatedWalletRecordNotification,
  formatRetroactivelyEnrichedWalletRecordNotification,
  formatPendingConfirmationSuccess,
} from '../wallet/formatters/humanResponseFormatter.js';
import {
  TransactionMessageStore,
  EnrichmentPoolService,
  isEligibleForEnrichmentPool,
} from '../wallet/records/index.js';
import { RuntimeSettingsManager } from '../config/runtimeSettingsManager.js';
import { applicationLogger } from '../lib/logger.js';

export interface InboundTransactionCandidateContext {
  parsedData: ExtractedEmailTransactionData;
  gateResult: GateEvaluationResult;
  sourceType: 'EMAIL' | 'PUSH_NOTIFICATION';
  evidenceSourceType: TransactionEvidenceSource;
  sourceId: string;
  sourceDate: Date;
  sourceDisplayName: string;
  fallbackNote: string;
  onRecordProcessed?: (reference: string) => void;
  isReplay?: boolean;
}

export interface InboundTransactionCoordinatorDependencies {
  walletCacheService: WalletCacheService;
  pendingTransactionManager: PendingTransactionService;
  messagingGateway: MessagingGatewayService;
  defaultCurrency: string;
  correlationService: TransactionCorrelationService;
  walletMcpClient?: WalletMcpClientService;
  transactionMessageStore?: TransactionMessageStore;
  runtimeSettingsManager?: RuntimeSettingsManager;
  enrichmentPoolService?: EnrichmentPoolService;
}

/**
 * Correlates and stages inbound transaction candidates (from Email IMAP or Push Webhook)
 * against active pending queues and upstream Wallet records.
 */
export async function coordinateInboundTransactionCandidate(
  context: InboundTransactionCandidateContext,
  deps: InboundTransactionCoordinatorDependencies
): Promise<void> {
  const {
    parsedData,
    gateResult,
    sourceType,
    evidenceSourceType,
    sourceId,
    sourceDate,
    sourceDisplayName,
    fallbackNote,
    onRecordProcessed,
  } = context;

  const {
    walletCacheService,
    pendingTransactionManager,
    messagingGateway,
    defaultCurrency,
    correlationService,
    walletMcpClient,
  } = deps;

  const cachedAccounts = walletCacheService.getAccounts();

  // 1. Resolve accounts
  let resolvedAccountId = parsedData.matchedAccountId;
  let resolvedAccountName = parsedData.accountNameHint;
  if (!resolvedAccountId) {
    const defaultAccount = cachedAccounts[0];
    resolvedAccountId = defaultAccount?.id || '';
    resolvedAccountName = defaultAccount?.name || 'Cash';
  }

  let resolvedDestinationAccountId = parsedData.matchedDestinationAccountId;
  let resolvedDestinationAccountName = parsedData.destinationAccountNameHint;
  if (
    parsedData.transactionType === 'TRANSFER' &&
    !resolvedDestinationAccountId &&
    parsedData.destinationAccountNameHint
  ) {
    const matchedDestinationAccount = cachedAccounts.find(account =>
      account.name.toLowerCase().includes(parsedData.destinationAccountNameHint!.toLowerCase())
    );
    if (matchedDestinationAccount) {
      resolvedDestinationAccountId = matchedDestinationAccount.id;
      resolvedDestinationAccountName = matchedDestinationAccount.name;
    }
  }

  const matchedAccountItem = cachedAccounts.find(account => account.id === resolvedAccountId);
  const resolvedCurrency = matchedAccountItem?.currency || defaultCurrency;

  const extractedRefs = Array.from(
    new Set([
      ...(parsedData.referenceNumber ? [parsedData.referenceNumber] : []),
      ...(gateResult.referenceNumber ? [gateResult.referenceNumber] : []),
    ])
  ).filter(Boolean);

  const incomingEvidence: TransactionEvidence = {
    sourceType: evidenceSourceType,
    sourceId,
    amount: parsedData.amount,
    currency: resolvedCurrency,
    occurredAt: parsedData.recordDate || sourceDate.toISOString(),
    merchant: parsedData.counterParty || gateResult.matchedBankRule?.displayName,
    accountHint: resolvedAccountName,
    accountId: resolvedAccountId,
    destinationAccountHint: resolvedDestinationAccountName,
    destinationAccountId: resolvedDestinationAccountId,
    referenceNumbers: extractedRefs,
    note: parsedData.note || fallbackNote,
    categoryId: parsedData.matchedCategoryId,
    categoryName: parsedData.matchedCategoryName,
    labels: evidenceSourceType === 'EMAIL_PAYMENT' ? ['e-receipt'] : undefined,
    transactionType: parsedData.transactionType,
    isBankSyncedAccount: Boolean(matchedAccountItem?.isBankSynced),
  };

  // 2. Query recent Wallet records if MCP client is provided
  let recentRecords: WalletRecordItem[] = [];
  if (walletMcpClient) {
    try {
      const page = await walletMcpClient.fetchRecords({
        limit: context.isReplay ? 50 : 15,
        sort: 'newest',
      });
      recentRecords = page?.records || [];
    } catch (fetchRecordsError) {
      applicationLogger.warn(
        `Failed to fetch recent Wallet records for correlation: ${
          fetchRecordsError instanceof Error ? fetchRecordsError.message : String(fetchRecordsError)
        }`
      );
    }
  }

  // Combine with active enrichment pool candidates for immediate in-memory correlation
  const poolCandidates = deps.enrichmentPoolService ? deps.enrichmentPoolService.getAllCandidates() : [];
  const combinedRecords: WalletRecordItem[] = [...recentRecords];
  const existingRecordIds = new Set(recentRecords.map(r => r.id));

  for (const candidate of poolCandidates) {
    if (!existingRecordIds.has(candidate.recordId)) {
      existingRecordIds.add(candidate.recordId);
      combinedRecords.push({
        id: candidate.recordId,
        accountId: candidate.accountId,
        accountName: candidate.accountName,
        amount: candidate.amount,
        currency: candidate.currency || defaultCurrency,
        recordDate: candidate.recordDate,
        recordType: candidate.amount < 0 ? 'expense' : 'income',
        counterParty: candidate.counterParty,
        note: candidate.note,
        category: candidate.categoryId
          ? { id: candidate.categoryId, name: candidate.categoryName || '' }
          : undefined,
        labels: candidate.labels?.map(lbl => ({ id: lbl, name: lbl })),
      });
    }
  }

  const correlationResult = correlationService.correlateEvidence(
    incomingEvidence,
    pendingTransactionManager.getAllPendingTransactions(),
    combinedRecords
  );

  // Case 1: Correlates with existing native Wallet record (bank sync or manual write)
  if (correlationResult.suggestedAction === 'ATTACH_WALLET_RECORD') {
    const matchedRecord = (correlationResult.matchTarget as { type: 'WALLET_RECORD'; record: any }).record;
    applicationLogger.info(
      `[Correlation Matched Wallet Record] ${sourceType} matches existing Wallet record (${matchedRecord.id}).`
    );

    if (onRecordProcessed) {
      for (const ref of extractedRefs) {
        onRecordProcessed(ref);
      }
    }

    const poolCandidate = deps.enrichmentPoolService?.getCandidate(matchedRecord.id);
    const isEligible = isEligibleForEnrichmentPool({
      counterParty: matchedRecord.counterParty,
      categoryName: matchedRecord.category?.name || poolCandidate?.categoryName,
      categoryId: matchedRecord.category?.id || poolCandidate?.categoryId,
      note: matchedRecord.note || poolCandidate?.note,
    });

    // Check if incoming evidence provides richer details
    const categories = walletCacheService.getCategories();
    let incomingCategoryId = incomingEvidence.categoryId;
    let incomingCategoryName = incomingEvidence.categoryName;
    if (!incomingCategoryId && incomingCategoryName) {
      const matchedCat = categories.find(
        c => c.name.toLowerCase() === incomingCategoryName!.toLowerCase()
      );
      if (matchedCat) {
        incomingCategoryId = matchedCat.id;
        incomingCategoryName = matchedCat.name;
      }
    }

    const currentCategoryName = matchedRecord.category?.name || poolCandidate?.categoryName;
    const hasGenericCategory = !currentCategoryName || isGenericCategory(currentCategoryName);
    const incomingHasSpecificCategory = Boolean(incomingCategoryName && !isGenericCategory(incomingCategoryName));
    const shouldPatchCategory = hasGenericCategory && incomingHasSpecificCategory && Boolean(incomingCategoryId);

    const currentMerchant = matchedRecord.counterParty || poolCandidate?.counterParty;
    const hasGenericMerchant = !currentMerchant || isGenericMerchant(currentMerchant);
    const incomingHasSpecificMerchant = Boolean(incomingEvidence.merchant && !isGenericMerchant(incomingEvidence.merchant));
    const shouldPatchMerchant = hasGenericMerchant && incomingHasSpecificMerchant;

    const currentNote = matchedRecord.note || poolCandidate?.note || '';
    const noteLower = currentNote.trim().toLowerCase();
    const isBoilerplateNote =
      !noteLower ||
      noteLower === 'pembayaran qris' ||
      noteLower.startsWith('pembayaran kartu debit') ||
      noteLower === 'transaksi' ||
      noteLower === (currentMerchant || '').trim().toLowerCase();
    const incomingNote = incomingEvidence.note && incomingEvidence.note !== fallbackNote ? incomingEvidence.note : undefined;
    const shouldPatchNote = isBoilerplateNote && Boolean(incomingNote && incomingNote !== currentNote);

    const incomingLabels = incomingEvidence.labels || [];
    const existingLabels = (matchedRecord.labels || poolCandidate?.labels || []).map((l: any) =>
      typeof l === 'string' ? l : l.name || l.id
    );
    const newLabels = incomingLabels.filter((l: string) => !existingLabels.includes(l));
    const shouldPatchLabels = newLabels.length > 0;

    const hasCoreEnrichment = shouldPatchMerchant || shouldPatchCategory || shouldPatchNote;
    const canEnrich = Boolean(
      walletMcpClient &&
      (poolCandidate || isEligible) &&
      hasCoreEnrichment
    );

    if (canEnrich && walletMcpClient) {
      try {
        const patchPayload: PatchRecordInputPayload = {
          id: matchedRecord.id,
        };
        if (shouldPatchMerchant) {
          patchPayload.counterParty = incomingEvidence.merchant;
        }
        if (shouldPatchCategory && incomingCategoryId) {
          patchPayload.categoryId = incomingCategoryId;
        }
        if (shouldPatchNote && incomingNote) {
          patchPayload.note = incomingNote;
        }
        if (shouldPatchLabels) {
          patchPayload.labels = Array.from(new Set([...existingLabels, ...incomingLabels]));
        }

        applicationLogger.mcp(
          `[Retroactive Enrichment] Patching Wallet MCP record ${matchedRecord.id} with incoming receipt evidence...`
        );
        await walletMcpClient.patchRecords([patchPayload]);
        applicationLogger.success(
          `[Retroactive Enrichment] Successfully patched Wallet MCP record ${matchedRecord.id}.`
        );

        // Prune from enrichment pool
        deps.enrichmentPoolService?.removeCandidate(matchedRecord.id);

        // Auto-dismiss matching dangling pending tickets
        const allPending = pendingTransactionManager.getAllPendingTransactions();
        const evidenceAmountAbs = Math.abs(incomingEvidence.amount);
        for (const pending of allPending) {
          if (Math.abs(pending.amount) === evidenceAmountAbs) {
            const timeDiff = Math.abs(new Date(pending.recordDate).getTime() - new Date(incomingEvidence.occurredAt).getTime());
            const isTimeMatch = Number.isNaN(timeDiff) || timeDiff <= 48 * 60 * 60 * 1000;
            const isMerchantMatch =
              !pending.counterParty ||
              !incomingEvidence.merchant ||
              isGenericMerchant(pending.counterParty) ||
              pending.counterParty.toLowerCase() === incomingEvidence.merchant.toLowerCase() ||
              incomingEvidence.merchant.toLowerCase().includes(pending.counterParty.toLowerCase()) ||
              incomingEvidence.merchant.toLowerCase().includes('grab');

            if (isTimeMatch && isMerchantMatch) {
              applicationLogger.info(
                `[Retroactive Enrichment] Auto-dismissing superseded pending ticket #${pending.ticketId}.`
              );
              pendingTransactionManager.rejectPendingTransaction(pending.ticketId);
            }
          }
        }

        // Update TransactionMessageStore mappings if present
        if (deps.transactionMessageStore) {
          deps.transactionMessageStore.updateMessageMappingsByRecordId(matchedRecord.id, {
            ...(patchPayload.counterParty ? { counterParty: patchPayload.counterParty } : {}),
            ...(patchPayload.categoryId ? { categoryId: patchPayload.categoryId, categoryName: incomingCategoryName } : {}),
            ...(patchPayload.note ? { note: patchPayload.note } : {}),
            ...(patchPayload.labels ? { labels: patchPayload.labels } : {}),
          });
        }

        // Send enriched notification
        const enrichedNotif = formatRetroactivelyEnrichedWalletRecordNotification({
          recordId: matchedRecord.id,
          merchant: patchPayload.counterParty || matchedRecord.counterParty || incomingEvidence.merchant || 'Transaksi',
          amount: incomingEvidence.amount,
          currency: incomingEvidence.currency,
          categoryName: incomingCategoryName || currentCategoryName,
          accountName: matchedRecord.accountName || poolCandidate?.accountName || resolvedAccountName,
          note: patchPayload.note || matchedRecord.note || poolCandidate?.note,
          recordDate: matchedRecord.recordDate || incomingEvidence.occurredAt,
          labels: patchPayload.labels || poolCandidate?.labels,
        });

        let wasEdited = false;
        const originalMessageIds = poolCandidate?.notificationMessageIds;
        if (
          originalMessageIds &&
          Object.keys(originalMessageIds).length > 0 &&
          typeof messagingGateway.editBroadcastNotification === 'function'
        ) {
          wasEdited = await messagingGateway.editBroadcastNotification(
            originalMessageIds,
            enrichedNotif
          );
        }

        if (!wasEdited) {
          await messagingGateway.broadcastNotification(enrichedNotif);
        }
        return;
      } catch (enrichError) {
        applicationLogger.error(
          `[Retroactive Enrichment Error] Failed to patch record ${matchedRecord.id}: ${
            enrichError instanceof Error ? enrichError.message : String(enrichError)
          }. Purging stale candidate and falling back to correlation notice.`
        );
        deps.enrichmentPoolService?.removeCandidate(matchedRecord.id);
        if (deps.transactionMessageStore) {
          deps.transactionMessageStore.deleteMessageMappingsByRecordId?.(matchedRecord.id);
        }
      }
    }

    if (context.isReplay) {
      applicationLogger.info(
        `[InboundRescan Replay] Suppressing duplicate correlation broadcast for record ${matchedRecord.id}.`
      );
      return;
    }

    const notif = formatCorrelatedWalletRecordNotification(
      matchedRecord.id,
      incomingEvidence.merchant || matchedRecord.counterParty || 'Transaksi',
      incomingEvidence.amount,
      incomingEvidence.currency,
      undefined,
      matchedRecord.accountName || poolCandidate?.accountName || resolvedAccountName,
      incomingCategoryName || currentCategoryName,
      matchedRecord.recordDate || incomingEvidence.occurredAt,
      incomingEvidence.note || matchedRecord.note || poolCandidate?.note
    );
    await messagingGateway.broadcastNotification(notif);
    return;
  }

  // Case 1.5: Correlates with an existing unlinked record as a paired transfer counterpart
  if (correlationResult.suggestedAction === 'PAIR_TRANSFER_EXISTING') {
    const matchedRecord = (correlationResult.matchTarget as { type: 'WALLET_RECORD'; record: any }).record;
    applicationLogger.info(
      `[Correlation Paired Transfer] ${sourceType} correlates with existing unlinked Wallet record (${matchedRecord.id}). Proposing transfer binding via pairingMode: 'existing'.`
    );
  }

  // Case 2: Correlates with an existing pending candidate (field fusion)
  if (correlationResult.suggestedAction === 'MERGE_PENDING') {
    const existingPending = (
      correlationResult.matchTarget as { type: 'PENDING_TRANSACTION'; pendingItem: any }
    ).pendingItem;

    applicationLogger.info(
      `[Correlation Fused Pending] Correlated ${sourceType} with pending ticket #${existingPending.ticketId}. Merging evidence.`
    );

    // Guard: Check if ticket is still active pending (not already confirmed, cancelled, or resolving)
    const currentPending = pendingTransactionManager.getPendingTransaction(existingPending.ticketId);
    const isProcessing =
      typeof pendingTransactionManager.isTicketProcessing === 'function' &&
      pendingTransactionManager.isTicketProcessing(existingPending.ticketId);

    if (!currentPending || isProcessing) {
      applicationLogger.info(
        `[Correlation Fused Pending] Ticket #${existingPending.ticketId} is no longer active pending (processing or resolved). Skipping edit.`
      );
      if (onRecordProcessed) {
        for (const ref of extractedRefs) {
          onRecordProcessed(ref);
        }
      }
      return;
    }

    const enrichedItem = pendingTransactionManager.enrichPendingTransaction(
      existingPending.ticketId,
      correlationResult.fusedPendingItem || {}
    );

    if (onRecordProcessed) {
      for (const ref of extractedRefs) {
        onRecordProcessed(ref);
      }
    }

    if (enrichedItem) {
      const activeSettings = (deps.runtimeSettingsManager || RuntimeSettingsManager.getInstance()).getSettings();
      const isAutoRecordEnriched = Boolean(activeSettings.autoRecordEnriched);

      const hasValidAccount = Boolean(
        enrichedItem.matchedAccountId &&
        (cachedAccounts.length === 0 || cachedAccounts.some(acc => acc.id === enrichedItem.matchedAccountId))
      );

      const categories = walletCacheService.getCategories();
      const resolvedCategory = enrichedItem.matchedCategoryId
        ? categories.find(c => c.id === enrichedItem.matchedCategoryId)
        : (enrichedItem.matchedCategoryName
            ? categories.find(c => c.name.toLowerCase() === enrichedItem.matchedCategoryName?.trim().toLowerCase())
            : undefined);

      const hasValidCategory = Boolean(
        (resolvedCategory &&
          resolvedCategory.isAssignable !== false &&
          resolvedCategory.group?.id !== 'system_categories' &&
          enrichedItem.matchedCategoryName !== 'Unknown' &&
          !isGenericCategory(enrichedItem.matchedCategoryName)) ||
        (!resolvedCategory &&
          categories.length === 0 &&
          enrichedItem.matchedCategoryName &&
          enrichedItem.matchedCategoryName !== 'Unknown' &&
          !isGenericCategory(enrichedItem.matchedCategoryName))
      );

      const isTransferEligible =
        enrichedItem.transactionType !== 'TRANSFER' ||
        Boolean(enrichedItem.transfer?.pairingMode === 'existing' || enrichedItem.matchedDestinationAccountId);

      const isEligibleForAutoRecord =
        isAutoRecordEnriched &&
        Boolean(walletMcpClient) &&
        hasValidAccount &&
        hasValidCategory &&
        enrichedItem.amount !== 0 &&
        isTransferEligible;

      if (isEligibleForAutoRecord && walletMcpClient) {
        try {
          applicationLogger.mcp(
            `[Auto-Record Enriched] Ticket #${enrichedItem.ticketId} qualifies for immediate dispatch. Recording to Wallet MCP...`
          );

          if (resolvedCategory && !enrichedItem.matchedCategoryId) {
            enrichedItem.matchedCategoryId = resolvedCategory.id;
          }

          const recordsToCreate = buildRecordsForPendingItem(enrichedItem, walletCacheService);
          const createResult = await walletMcpClient.createRecords(recordsToCreate);
          const createdId = createResult?.results?.[0]?.id;

          if (deps.enrichmentPoolService && createdId) {
            if (
              isEligibleForEnrichmentPool({
                counterParty: enrichedItem.counterParty,
                categoryName: enrichedItem.matchedCategoryName,
                categoryId: enrichedItem.matchedCategoryId,
                note: enrichedItem.note,
              })
            ) {
              deps.enrichmentPoolService.addCandidate({
                recordId: createdId,
                accountId: enrichedItem.matchedAccountId,
                accountName: enrichedItem.bankDisplayName || enrichedItem.accountNameHint,
                amount: enrichedItem.amount,
                currency: enrichedItem.currency,
                recordDate: enrichedItem.recordDate,
                counterParty: enrichedItem.counterParty,
                note: enrichedItem.note,
                categoryId: enrichedItem.matchedCategoryId,
                categoryName: enrichedItem.matchedCategoryName,
                labels: enrichedItem.labels,
                notificationMessageIds: enrichedItem.notificationMessageIds,
                channel: enrichedItem.notificationMessageIds
                  ? Object.keys(enrichedItem.notificationMessageIds)[0]
                  : undefined,
              });
            }
          }

          pendingTransactionManager.resolvePendingTransaction(enrichedItem.ticketId);
          applicationLogger.success(
            `[Auto-Record Enriched] Ticket #${enrichedItem.ticketId} successfully recorded to Wallet MCP (recordId=${createdId || 'n/a'}).`
          );

          if (onRecordProcessed) {
            const allRefs = [
              ...(enrichedItem.referenceNumbers || []),
              ...(enrichedItem.referenceNumber ? [enrichedItem.referenceNumber] : []),
            ];
            for (const ref of allRefs) {
              onRecordProcessed(ref);
            }
          }

          const successNotification = formatPendingConfirmationSuccess(enrichedItem);
          let wasEdited = false;
          if (
            enrichedItem.notificationMessageIds &&
            Object.keys(enrichedItem.notificationMessageIds).length > 0 &&
            typeof messagingGateway.editBroadcastNotification === 'function'
          ) {
            wasEdited = await messagingGateway.editBroadcastNotification(
              enrichedItem.notificationMessageIds,
              successNotification
            );
          }

          let finalReceipts: Record<string, any> = {};
          if (wasEdited && enrichedItem.notificationMessageIds) {
            for (const [channel, messageId] of Object.entries(enrichedItem.notificationMessageIds)) {
              finalReceipts[channel] = { messageId };
            }
          } else {
            finalReceipts = (await messagingGateway.broadcastNotification(successNotification)) || {};
          }

          if (deps.transactionMessageStore && createdId) {
            for (const [channel, receipt] of Object.entries(finalReceipts)) {
              const messageId =
                typeof receipt === 'object' && receipt !== null && 'messageId' in receipt
                  ? String(receipt.messageId)
                  : typeof receipt === 'string'
                    ? receipt
                    : undefined;

              if (messageId) {
                deps.transactionMessageStore.recordMessageMapping(messageId, {
                  recordId: createdId,
                  accountId: enrichedItem.matchedAccountId,
                  accountName: enrichedItem.bankDisplayName || enrichedItem.accountNameHint,
                  currency: enrichedItem.currency,
                  recordDate: enrichedItem.recordDate,
                  note: enrichedItem.note,
                  categoryId: enrichedItem.matchedCategoryId,
                  categoryName: enrichedItem.matchedCategoryName,
                  labels: enrichedItem.labels,
                  amount: enrichedItem.amount,
                  counterParty: enrichedItem.counterParty,
                  channel,
                  isTransfer: enrichedItem.transactionType === 'TRANSFER',
                });
              }
            }
          }

          return;
        } catch (autoRecordError) {
          applicationLogger.error(
            `[Auto-Record Error] Ticket #${enrichedItem.ticketId} auto-record failed: ${
              autoRecordError instanceof Error ? autoRecordError.message : String(autoRecordError)
            }. Retaining in pending queue.`
          );
        }
      }

      const totalPendingCount = pendingTransactionManager.getAllPendingTransactions().length;
      const notificationText = formatEnrichedPendingEmailTransactionNotification(
        enrichedItem,
        totalPendingCount,
        sourceDisplayName
      );

      let wasEdited = false;
      if (
        enrichedItem.notificationMessageIds &&
        Object.keys(enrichedItem.notificationMessageIds).length > 0 &&
        typeof messagingGateway.editBroadcastNotification === 'function'
      ) {
        wasEdited = await messagingGateway.editBroadcastNotification(
          enrichedItem.notificationMessageIds,
          notificationText
        );
      }

      if (!wasEdited) {
        await messagingGateway.broadcastNotification(notificationText);
        applicationLogger.success(
          `Dispatched enriched transaction notification (#${enrichedItem.ticketId}) to active messaging channels.`
        );
      } else {
        applicationLogger.success(
          `Successfully updated in-place notification bubble for enriched transaction (#${enrichedItem.ticketId}).`
        );
      }
    }
    return;
  }

  // Case 3: Independent candidate (LOW confidence or CLARIFY)
  let initialNote = parsedData.note || fallbackNote;
  const isClarification =
    correlationResult.suggestedAction === 'CLARIFY' &&
    Boolean(correlationResult.clarificationPrompt);
  const clarifyTargetTicketId =
    correlationResult.matchTarget.type === 'PENDING_TRANSACTION'
      ? correlationResult.matchTarget.pendingItem.ticketId
      : undefined;

  if (isClarification) {
    initialNote = clarifyTargetTicketId
      ? `[Klarifikasi: #${clarifyTargetTicketId}] ${initialNote}`
      : `[Klarifikasi] ${initialNote}`;
  }

  const matchedTransferRecord =
    correlationResult.suggestedAction === 'PAIR_TRANSFER_EXISTING' &&
    correlationResult.matchTarget.type === 'WALLET_RECORD'
      ? correlationResult.matchTarget.record
      : undefined;

  const resolvedTransferDestinationAccountName = matchedTransferRecord
    ? matchedTransferRecord.accountName ||
      cachedAccounts.find(account => account.id === matchedTransferRecord.accountId)?.name ||
      resolvedDestinationAccountName
    : resolvedDestinationAccountName;

  const pendingItem = pendingTransactionManager.addPendingTransaction({
    sourceType,
    bankDisplayName: gateResult.matchedBankRule?.displayName || sourceDisplayName,
    accountNameHint: resolvedAccountName,
    matchedAccountId: resolvedAccountId,
    destinationAccountNameHint: resolvedTransferDestinationAccountName,
    counterParty: parsedData.counterParty || '',
    amount: parsedData.amount,
    currency: resolvedCurrency,
    transactionType: matchedTransferRecord ? 'TRANSFER' : parsedData.transactionType,
    matchedDestinationAccountId: matchedTransferRecord
      ? matchedTransferRecord.accountId
      : resolvedDestinationAccountId,
    transfer: correlationResult.proposedTransfer || (matchedTransferRecord
      ? { pairingMode: 'existing', recordId: matchedTransferRecord.id, accountId: matchedTransferRecord.accountId }
      : undefined),
    matchedCategoryId: parsedData.matchedCategoryId,
    matchedCategoryName: parsedData.matchedCategoryName,
    note: initialNote,
    recordDate: parsedData.recordDate || sourceDate.toISOString(),
    referenceNumber: extractedRefs[0],
    referenceNumbers: extractedRefs,
    evidenceSources: [incomingEvidence.sourceType],
    emailSubject: sourceType === 'EMAIL' ? fallbackNote : undefined,
    isBankSyncedAccount: incomingEvidence.isBankSyncedAccount,
    clarificationPrompt: isClarification ? correlationResult.clarificationPrompt : undefined,
  });

  const totalPendingCount = pendingTransactionManager.getAllPendingTransactions().length;
  let notificationText = formatPendingEmailTransactionNotification(pendingItem, totalPendingCount);

  if (isClarification && correlationResult.clarificationPrompt) {
    notificationText = `⚠️ *Perlu Klarifikasi*\n${correlationResult.clarificationPrompt}\n\n${notificationText}`;
  }

  const receipts = await messagingGateway.broadcastNotification(notificationText);
  if (
    receipts &&
    typeof receipts === 'object' &&
    Object.keys(receipts).length > 0 &&
    typeof pendingTransactionManager.updateNotificationMessageIds === 'function'
  ) {
    pendingTransactionManager.updateNotificationMessageIds(pendingItem.ticketId, receipts);
  }

  applicationLogger.success(
    `Dispatched pending transaction notification (#${pendingItem.ticketId}) to active messaging channels.`
  );
}
