import {
  PendingAccountSelectionCandidate,
  PendingAccountSelectionDraft,
  PendingCategorySelectionCandidate,
  PendingCategorySelectionDraft,
} from '../../core/pending.js';
import { WalletCategoryItem } from '../../wallet/index.js';
import { FinancialAiProvider } from '../types.js';
import { selectBestCategory } from '../category/categoryScorer.js';
import {
  generateAccountClarificationQuestion,
  generateCategoryClarificationQuestion,
  interpretAccountClarificationReply,
  interpretCategoryClarificationReply,
} from './clarificationInterpreter.js';

export { selectBestCategory };

/**
 * Unified conversational state machine and candidate interpretation service
 * for both account and category interactive clarification dialogues.
 *
 * Core Purpose & Responsibility:
 * Generates natural language clarification questions and interprets user replies (by index,
 * account number tail, exact/partial name, or AI reasoning) to resolve ambiguous account or
 * category selections for pending drafts.
 *
 * Architectural Role:
 * Sits within the brain domain, collaborating with PendingTransactionService (draft shapes),
 * FinancialAiProvider (optional LLM question generation and reply interpretation), and
 * formatting utilities.
 */
export class ClarificationService {
  constructor(private readonly financialAiProvider?: FinancialAiProvider) {}

  public async generateAccountClarificationQuestion(
    draft: PendingAccountSelectionDraft,
    categories: WalletCategoryItem[] = [],
    invalidSelection?: string
  ): Promise<string> {
    return generateAccountClarificationQuestion(
      draft,
      categories,
      invalidSelection,
      this.financialAiProvider
    );
  }

  public async generateCategoryClarificationQuestion(
    draft: PendingCategorySelectionDraft,
    categories: WalletCategoryItem[] = [],
    invalidSelection?: string
  ): Promise<string> {
    return generateCategoryClarificationQuestion(draft, categories, invalidSelection);
  }

  public async generateClarificationQuestion(
    draft: PendingAccountSelectionDraft | PendingCategorySelectionDraft,
    categories: WalletCategoryItem[] = [],
    invalidSelection?: string
  ): Promise<string> {
    if ('candidateAccounts' in draft) {
      return this.generateAccountClarificationQuestion(draft, categories, invalidSelection);
    }
    return this.generateCategoryClarificationQuestion(draft, categories, invalidSelection);
  }

  public async interpretAccountClarificationReply(
    userReply: string,
    claimedDraft: PendingAccountSelectionDraft,
    categories: WalletCategoryItem[] = []
  ): Promise<PendingAccountSelectionCandidate | undefined> {
    return interpretAccountClarificationReply(
      userReply,
      claimedDraft,
      categories,
      this.financialAiProvider
    );
  }

  public async interpretCategoryClarificationReply(
    userReply: string,
    claimedDraft: PendingCategorySelectionDraft,
    availableCategories: WalletCategoryItem[] = []
  ): Promise<PendingCategorySelectionCandidate | undefined> {
    return interpretCategoryClarificationReply(userReply, claimedDraft, availableCategories);
  }

  public async interpretClarificationReply(
    userReply: string,
    claimedDraft: PendingAccountSelectionDraft | PendingCategorySelectionDraft,
    entities: WalletCategoryItem[] = []
  ): Promise<PendingAccountSelectionCandidate | undefined | PendingCategorySelectionCandidate> {
    if ('candidateAccounts' in claimedDraft) {
      return this.interpretAccountClarificationReply(userReply, claimedDraft, entities);
    }
    return this.interpretCategoryClarificationReply(userReply, claimedDraft, entities);
  }

  public async selectBestCategory(
    categoryHint: string,
    candidateCategories: PendingCategorySelectionCandidate[],
    availableCategories: WalletCategoryItem[],
    recordNote?: string
  ): Promise<WalletCategoryItem | undefined> {
    return selectBestCategory(categoryHint, candidateCategories, availableCategories, recordNote);
  }
}

export {
  ClarificationService as AccountClarificationConversationService,
  ClarificationService as CategoryClarificationConversationService,
};
