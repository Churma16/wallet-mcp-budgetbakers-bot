import {
  PendingAccountSelectionCandidate,
  PendingAccountSelectionDraft,
} from '../pendingTransactionService.js';
import { WalletCategoryItem } from '../../types/walletTypes.js';
import {
  AccountClarificationQuestionContext,
  FinancialAiProvider,
} from './financialAiProvider.js';
import {
  formatAccountSelectionPrompt,
  formatDraftAmount,
  resolveCategoryName,
} from '../../utils/accountClarificationFormatter.js';
import { getDictionary } from '../../i18n/index.js';
import { applicationLogger, formatConciseErrorMessage } from '../../utils/logger.js';

export class AccountClarificationConversationService {
  constructor(private readonly financialAiProvider?: FinancialAiProvider) {}

  public async generateClarificationQuestion(
    draft: PendingAccountSelectionDraft,
    categories: WalletCategoryItem[],
    invalidSelection?: string
  ): Promise<string> {
    const fallbackPrompt = formatAccountSelectionPrompt(draft, categories, invalidSelection);

    if (
      !this.financialAiProvider ||
      typeof this.financialAiProvider.generateAccountClarificationQuestion !== 'function'
    ) {
      return fallbackPrompt;
    }

    const dictionary = getDictionary();
    const currentRecord = draft.records[draft.pendingRecordIndex];
    const categoryName = resolveCategoryName(currentRecord?.categoryId, categories);
    const description =
      currentRecord?.note ||
      currentRecord?.counterParty ||
      (dictionary.languageCode === 'id' ? 'Transaksi' : 'Transaction');

    const questionContext: AccountClarificationQuestionContext = {
      ticketId: draft.ticketId,
      records: draft.records,
      pendingRecordIndex: draft.pendingRecordIndex,
      accountHint: draft.accountHint,
      candidateAccounts: draft.candidateAccounts,
      formattedAmount: formatDraftAmount(draft),
      categoryName,
      description,
      invalidSelection,
      languageCode: dictionary.languageCode,
    };

    try {
      const generatedResult =
        await this.financialAiProvider.generateAccountClarificationQuestion(questionContext);

      if (generatedResult?.question && generatedResult.question.trim().length > 0) {
        return generatedResult.question.trim();
      }

      applicationLogger.warn(
        `[Account Clarification] LLM question generation returned empty string for draft #${draft.ticketId}; using deterministic template.`
      );
      return fallbackPrompt;
    } catch (error) {
      applicationLogger.warn(
        `[Account Clarification] LLM question generation failed for draft #${draft.ticketId}; using deterministic template: ${formatConciseErrorMessage(error)}`
      );
      return fallbackPrompt;
    }
  }

  public async interpretClarificationReply(
    userReply: string,
    claimedDraft: PendingAccountSelectionDraft,
    categories: WalletCategoryItem[] = []
  ): Promise<PendingAccountSelectionCandidate | undefined> {
    const candidateAccounts = claimedDraft.candidateAccounts;
    const normalizedReply = userReply.trim();

    // Step 1: Cheap deterministic fast-path (0 AI tokens consumed)
    if (/^\d+$/.test(normalizedReply)) {
      const selectedIndex = Number.parseInt(normalizedReply, 10) - 1;
      if (selectedIndex >= 0 && selectedIndex < candidateAccounts.length) {
        return candidateAccounts[selectedIndex];
      }
    }

    // Check 4+ digit bank account number matches
    const replyDigits = normalizedReply.replace(/\D/g, '');
    if (replyDigits.length >= 4) {
      const numberMatches = candidateAccounts.filter(candidate => {
        const candidateDigits = candidate.bankAccountNumber?.replace(/\D/g, '') || '';
        return (
          candidateDigits.length > 0 &&
          (candidateDigits === replyDigits ||
            candidateDigits.endsWith(replyDigits) ||
            replyDigits.endsWith(candidateDigits))
        );
      });
      if (numberMatches.length === 1) {
        return numberMatches[0];
      }
    }

    if (/^\d+$/.test(normalizedReply)) {
      // It was purely digits, but did not match an index or bank account number
      return undefined;
    }

    const lowercasedReply = normalizedReply.toLowerCase();
    const exactMatches = candidateAccounts.filter(
      candidate => candidate.name.toLowerCase() === lowercasedReply
    );
    if (exactMatches.length === 1) {
      return exactMatches[0];
    }
    if (exactMatches.length > 1) {
      return undefined;
    }

    // Step 2: Semantic free-form LLM interpretation
    if (
      this.financialAiProvider &&
      typeof this.financialAiProvider.interpretAccountClarificationReply === 'function'
    ) {
      const dictionary = getDictionary();
      const currentRecord = claimedDraft.records[claimedDraft.pendingRecordIndex];
      const categoryName = resolveCategoryName(currentRecord?.categoryId, categories);
      const description =
        currentRecord?.note ||
        currentRecord?.counterParty ||
        (dictionary.languageCode === 'id' ? 'Transaksi' : 'Transaction');

      const interpretationContext: Partial<AccountClarificationQuestionContext> = {
        ticketId: claimedDraft.ticketId,
        accountHint: claimedDraft.accountHint,
        formattedAmount: formatDraftAmount(claimedDraft),
        categoryName,
        description,
        languageCode: dictionary.languageCode,
      };

      try {
        const proposal = await this.financialAiProvider.interpretAccountClarificationReply(
          normalizedReply,
          candidateAccounts,
          interpretationContext
        );

        // Step 3: Strict candidate boundary check
        if (proposal) {
          let verifiedCandidate: PendingAccountSelectionCandidate | undefined;

          if (proposal.selectedAccountId) {
            verifiedCandidate = candidateAccounts.find(
              candidate => candidate.id === proposal.selectedAccountId
            );
          }

          if (!verifiedCandidate && typeof proposal.selectedCandidateIndex === 'number') {
            const candidateIndex = proposal.selectedCandidateIndex - 1;
            if (candidateIndex >= 0 && candidateIndex < candidateAccounts.length) {
              verifiedCandidate = candidateAccounts[candidateIndex];
            }
          }

          if (verifiedCandidate) {
            applicationLogger.info(
              `[Account Clarification] LLM resolved reply "${normalizedReply.slice(0, 40)}" to candidate ${verifiedCandidate.name} (#${claimedDraft.ticketId}).`
            );
            return verifiedCandidate;
          }

          if (proposal.selectedAccountId) {
            applicationLogger.warn(
              `[Account Clarification] LLM proposed non-candidate account ID "${proposal.selectedAccountId}" for draft #${claimedDraft.ticketId}; rejected (fail closed).`
            );
          } else if (typeof proposal.selectedCandidateIndex === 'number') {
            applicationLogger.warn(
              `[Account Clarification] LLM proposed out-of-bounds candidate index ${proposal.selectedCandidateIndex} for draft #${claimedDraft.ticketId}; rejected (fail closed).`
            );
          }
        }
        return undefined;
      } catch (error) {
        applicationLogger.warn(
          `[Account Clarification] LLM reply interpretation failed for draft #${claimedDraft.ticketId}: ${formatConciseErrorMessage(error)}`
        );
        return undefined;
      }
    }

    // Fallback: If no AI provider or method available, use deterministic partial matching
    if (lowercasedReply.length >= 2) {
      const partialMatches = candidateAccounts.filter(candidate => {
        const candidateName = candidate.name.toLowerCase();
        return (
          candidateName.includes(lowercasedReply) || lowercasedReply.includes(candidateName)
        );
      });
      if (partialMatches.length === 1) {
        return partialMatches[0];
      }
    }

    return undefined;
  }
}
