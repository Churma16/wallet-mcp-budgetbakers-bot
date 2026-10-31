import {
  PendingAccountSelectionCandidate,
  PendingAccountSelectionDraft,
  PendingCategorySelectionCandidate,
  PendingCategorySelectionDraft,
} from '../core/pending.js';
import { WalletCategoryItem } from '../wallet/index.js';
import {
  FinancialAiProvider,
  AccountClarificationQuestionContext,
} from './types.js';
import {
  composeClarificationMessage,
  formatAccountSelectionPrompt,
  formatDraftAmount,
  resolveCategoryName,
} from './accountClarificationFormatter.js';
import { formatCategorySelectionPrompt } from './categoryClarificationFormatter.js';
import { getDictionary } from '../i18n/index.js';
import { applicationLogger, formatConciseErrorMessage } from '../lib/logger.js';

export async function generateAccountClarificationQuestion(
  draft: PendingAccountSelectionDraft,
  categories: WalletCategoryItem[] = [],
  invalidSelection?: string,
  financialAiProvider?: FinancialAiProvider
): Promise<string> {
  const fallbackPrompt = formatAccountSelectionPrompt(draft, categories, invalidSelection);

  if (
    !financialAiProvider ||
    typeof financialAiProvider.generateAccountClarificationQuestion !== 'function'
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
      await financialAiProvider.generateAccountClarificationQuestion(questionContext);

    if (generatedResult?.question && generatedResult.question.trim().length > 0) {
      return composeClarificationMessage(
        generatedResult.question.trim(),
        draft,
        categories,
        invalidSelection
      );
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

export async function generateCategoryClarificationQuestion(
  draft: PendingCategorySelectionDraft,
  categories: WalletCategoryItem[] = [],
  invalidSelection?: string
): Promise<string> {
  return formatCategorySelectionPrompt(draft, categories, invalidSelection);
}

export async function interpretAccountClarificationReply(
  userReply: string,
  claimedDraft: PendingAccountSelectionDraft,
  categories: WalletCategoryItem[] = [],
  financialAiProvider?: FinancialAiProvider
): Promise<PendingAccountSelectionCandidate | undefined> {
  const candidateAccounts = claimedDraft.candidateAccounts;
  const normalizedReply = userReply.trim();

  if (/^\d+$/.test(normalizedReply)) {
    const selectedIndex = Number.parseInt(normalizedReply, 10) - 1;
    if (selectedIndex >= 0 && selectedIndex < candidateAccounts.length) {
      return candidateAccounts[selectedIndex];
    }
  }

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

  if (
    financialAiProvider &&
    typeof financialAiProvider.interpretAccountClarificationReply === 'function'
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
      const proposal = await financialAiProvider.interpretAccountClarificationReply(
        normalizedReply,
        candidateAccounts,
        interpretationContext
      );

      if (
        proposal &&
        typeof proposal.selectedCandidateIndex === 'number' &&
        Number.isInteger(proposal.selectedCandidateIndex)
      ) {
        const candidateIndex = proposal.selectedCandidateIndex - 1;
        if (candidateIndex >= 0 && candidateIndex < candidateAccounts.length) {
          const selectedCandidate = candidateAccounts[candidateIndex];
          applicationLogger.info(
            `[Account Clarification] LLM resolved reply "${normalizedReply.slice(0, 40)}" to candidate ${selectedCandidate.name} (#${claimedDraft.ticketId}).`
          );
          return selectedCandidate;
        }

        applicationLogger.warn(
          `[Account Clarification] LLM proposed out-of-bounds candidate index ${proposal.selectedCandidateIndex} for draft #${claimedDraft.ticketId}; rejected (fail closed).`
        );
        return undefined;
      }
      return undefined;
    } catch (error) {
      applicationLogger.warn(
        `[Account Clarification] LLM reply interpretation failed for draft #${claimedDraft.ticketId}: ${formatConciseErrorMessage(error)}`
      );
      return undefined;
    }
  }

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

export async function interpretCategoryClarificationReply(
  userReply: string,
  claimedDraft: PendingCategorySelectionDraft,
  availableCategories: WalletCategoryItem[] = []
): Promise<PendingCategorySelectionCandidate | undefined> {
  const candidateCategories = claimedDraft.candidateCategories;
  const normalizedReply = userReply.trim();

  const numericMatch = normalizedReply.match(/^\s*#?(\d+)\.?\s*$/);
  if (numericMatch) {
    const selectedIndex = Number.parseInt(numericMatch[1], 10) - 1;
    if (selectedIndex >= 0 && selectedIndex < candidateCategories.length) {
      return candidateCategories[selectedIndex];
    }
    return undefined;
  }

  const lowercasedReply = normalizedReply.toLowerCase();
  const exactCandidateMatch = candidateCategories.find(
    candidate => candidate.name.toLowerCase() === lowercasedReply
  );
  if (exactCandidateMatch) {
    return exactCandidateMatch;
  }

  if (lowercasedReply.length >= 3) {
    const substringCandidateMatches = candidateCategories.filter(
      candidate =>
        candidate.name.toLowerCase().includes(lowercasedReply) ||
        lowercasedReply.includes(candidate.name.toLowerCase())
    );
    if (substringCandidateMatches.length === 1) {
      return substringCandidateMatches[0];
    }
  }

  const exactAvailableMatch = availableCategories.find(
    category =>
      category.isAssignable !== false &&
      category.name.toLowerCase() === lowercasedReply
  );
  if (exactAvailableMatch) {
    return { id: exactAvailableMatch.id, name: exactAvailableMatch.name };
  }

  if (lowercasedReply.length >= 3) {
    const substringAvailableMatches = availableCategories.filter(
      category =>
        category.isAssignable !== false &&
        (category.name.toLowerCase().includes(lowercasedReply) ||
          lowercasedReply.includes(category.name.toLowerCase()))
    );
    if (substringAvailableMatches.length === 1) {
      return {
        id: substringAvailableMatches[0].id,
        name: substringAvailableMatches[0].name,
      };
    }
  }

  return undefined;
}
