import { describe, expect, it, vi } from 'vitest';
import { UserMessageHandler } from '../src/handlers/userMessageHandler.js';
import {
  createTestUserMessageHandler,
  createTestApplicationConfiguration,
} from './fixtures/compositionFixtures.js';
import { Application } from '../src/app.js';
import { PendingTransactionService } from '../src/services/pendingTransactionService.js';
import { IncomingUserMessageEvent } from '../src/services/messaging/index.js';
import {
  SemanticToolBoundary,
  SemanticToolEvaluationContext,
} from '../src/services/ai/index.js';

describe('UserMessageHandler Composition Root and Semantic Contract Regression', () => {
  it('preserves gateway-owned authorization contract and does not infer authorization from senderIdentifier presence', async () => {
    let capturedEvaluationContext: SemanticToolEvaluationContext | null = null;

    const mockBoundary = {
      evaluate: vi.fn((context: SemanticToolEvaluationContext) => {
        capturedEvaluationContext = context;
        return {
          accepted: false,
          code: 'REJECTED_TEST',
          reason: 'Test rejection',
        };
      }),
    } as unknown as SemanticToolBoundary;

    const proposalActionIntent = {
      action: 'TRANSACTION_HISTORY',
      queryOptions: { categoryName: 'Food' },
    };

    // Case 1: Event with populated senderIdentifier
    const populatedSenderEvent: IncomingUserMessageEvent = {
      channel: 'whatsapp',
      chatIdentifier: 'chat-100',
      senderIdentifier: '6281234567890',
      messageType: 'text',
      textPayload: 'riwayat belanja',
    };

    const handlerWithCustomBoundary = createTestUserMessageHandler({
      financialAiProvider: {
        providerName: 'test-ai',
        processTextMessage: vi.fn().mockResolvedValue(proposalActionIntent),
        processImageMessage: vi.fn().mockResolvedValue(proposalActionIntent),
      } as any,
      semanticToolBoundary: mockBoundary,
    });

    await handlerWithCustomBoundary.handleIncomingUserMessage(populatedSenderEvent);

    expect(capturedEvaluationContext).not.toBeNull();
    expect(capturedEvaluationContext!.authorization).toEqual({
      isAuthorized: true,
      source: 'whatsapp-gateway-authorization',
    });

    // Case 2: Event with empty senderIdentifier - gateway authorization must still be preserved
    capturedEvaluationContext = null;
    const emptySenderEvent: IncomingUserMessageEvent = {
      channel: 'telegram',
      chatIdentifier: 'chat-200',
      senderIdentifier: '',
      messageType: 'text',
      textPayload: 'riwayat belanja',
    };

    await handlerWithCustomBoundary.handleIncomingUserMessage(emptySenderEvent);

    expect(capturedEvaluationContext).not.toBeNull();
    expect(capturedEvaluationContext!.authorization).toEqual({
      isAuthorized: true,
      source: 'telegram-gateway-authorization',
    });
  });

  it('respects explicitly injected semanticToolAuthorizationResolver override', async () => {
    let capturedEvaluationContext: SemanticToolEvaluationContext | null = null;

    const mockBoundary = {
      evaluate: vi.fn((context: SemanticToolEvaluationContext) => {
        capturedEvaluationContext = context;
        return {
          accepted: false,
          code: 'REJECTED_TEST',
          reason: 'Test rejection',
        };
      }),
    } as unknown as SemanticToolBoundary;

    const proposalActionIntent = {
      action: 'TRANSACTION_HISTORY',
      queryOptions: { categoryName: 'Food' },
    };

    const customResolver = vi.fn().mockReturnValue({
      isAuthorized: false,
      source: 'SecurityGateway:CustomDenied',
    });

    const handler = createTestUserMessageHandler({
      financialAiProvider: {
        providerName: 'test-ai',
        processTextMessage: vi.fn().mockResolvedValue(proposalActionIntent),
        processImageMessage: vi.fn().mockResolvedValue(proposalActionIntent),
      } as any,
      semanticToolBoundary: mockBoundary,
      semanticToolAuthorizationResolver: customResolver,
    });

    const incomingEvent: IncomingUserMessageEvent = {
      channel: 'whatsapp',
      chatIdentifier: 'chat-300',
      senderIdentifier: 'user-300',
      messageType: 'text',
      textPayload: 'riwayat belanja',
    };

    await handler.handleIncomingUserMessage(incomingEvent);

    expect(customResolver).toHaveBeenCalledWith(incomingEvent);
    expect(capturedEvaluationContext).not.toBeNull();
    expect(capturedEvaluationContext!.authorization).toEqual({
      isAuthorized: false,
      source: 'SecurityGateway:CustomDenied',
    });
  });

  it('verifies createTestUserMessageHandler provides canonical hasPendingTransactions and routes accordingly', async () => {
    const pendingService = new PendingTransactionService();
    expect(typeof pendingService.hasPendingTransactions).toBe('function');
    expect(pendingService.hasPendingTransactions()).toBe(false);

    const mockPendingActionHandler = {
      handlePendingAction: vi.fn().mockResolvedValue(true),
    };

    const handler = createTestUserMessageHandler({
      pendingTransactionManager: pendingService,
      pendingActionHandler: mockPendingActionHandler as any,
    });

    const confirmationEvent: IncomingUserMessageEvent = {
      channel: 'whatsapp',
      chatIdentifier: 'chat-400',
      senderIdentifier: 'user-400',
      messageType: 'text',
      textPayload: 'ya',
    };

    // When no pending transactions exist, confirmation is not intercepted by pendingActionHandler
    await handler.handleIncomingUserMessage(confirmationEvent);
    expect(mockPendingActionHandler.handlePendingAction).not.toHaveBeenCalled();

    // Add a pending transaction to activate canonical hasPendingTransactions() === true
    pendingService.addPendingTransaction({
      sourceType: 'WHATSAPP',
      bankDisplayName: 'BCA',
      accountNameHint: 'Checking',
      counterParty: 'Store',
      amount: -50000,
      transactionType: 'EXPENSE',
      matchedAccountId: 'acc-1',
      note: 'Grocery store',
      recordDate: '2026-09-20',
      currency: 'IDR',
    });

    expect(pendingService.hasPendingTransactions()).toBe(true);

    // With active pending transaction, confirmation is intercepted
    await handler.handleIncomingUserMessage(confirmationEvent);
    expect(mockPendingActionHandler.handlePendingAction).toHaveBeenCalled();
  });

  it('verifies Application composition root successfully constructs unified dependency graph', () => {
    const configuration = createTestApplicationConfiguration({
      enabledMessengerChannels: ['whatsapp'],
      allowedPhoneNumber: '6281234567890',
    });

    const applicationInstance = new Application(configuration);
    expect(applicationInstance).toBeDefined();

    // Verify private dependencies are wired correctly
    const applicationRecord = applicationInstance as unknown as Record<string, unknown>;
    expect(applicationRecord.fastPathHandler).toBeDefined();
    expect(applicationRecord.userMessageHandler).toBeDefined();
    expect(applicationRecord.financialActionRegistry).toBeDefined();
    expect(applicationRecord.financialActionExecutor).toBeDefined();
    expect(applicationRecord.walletCapabilityService).toBeDefined();
  });
});
