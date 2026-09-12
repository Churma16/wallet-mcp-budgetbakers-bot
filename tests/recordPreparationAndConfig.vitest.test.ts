import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  prepareRecordsForWalletDispatch,
  WalletRecordPreparationService,
} from '../src/services/walletRecordPreparationService.js';
import {
  getApplicationTimezone,
  getDefaultCurrency,
  getApplicationLanguage,
  getRuntimeApplicationConfig,
  setRuntimeApplicationConfig,
  resetRuntimeApplicationConfig,
  DEFAULT_APP_TIMEZONE,
  DEFAULT_APP_CURRENCY,
  DEFAULT_APP_LANGUAGE,
  isValidIanaTimezone,
  resolveSafeTimezone,
} from '../src/config/applicationConfig.js';
import {
  loadEnvironmentConfiguration,
  validateApplicationConfiguration,
} from '../src/config/environmentConfig.js';
import {
  formatCurrencyAmount,
  formatBalanceSummaryMessage,
  formatRecordSuccessMessage,
} from '../src/utils/humanResponseFormatter.js';
import { WalletCacheService } from '../src/services/walletCacheService.js';
import {
  WalletMcpClientService,
  WalletMcpRequestError,
} from '../src/services/walletMcpService.js';
import { PendingTransactionService } from '../src/services/pendingTransactionService.js';
import { MessagingGatewayService } from '../src/services/messaging/messagingGatewayService.js';
import { AccountClarificationHandler } from '../src/handlers/accountClarificationHandler.js';
import { UserMessageHandler } from '../src/handlers/userMessageHandler.js';
import { FastPathHandler } from '../src/handlers/fastPathHandler.js';
import { PendingActionHandler } from '../src/handlers/pendingActionHandler.js';
import { FinancialAiProvider } from '../src/services/ai/financialAiProvider.js';
import { CreateRecordInputPayload, WalletAccountItem, WalletCategoryItem, WalletLabelItem } from '../src/types/walletTypes.js';
import { IncomingUserMessageEvent } from '../src/services/messaging/types.js';

describe('Centralized Record Preparation (Issue #110 Part A)', () => {
  let mockWalletCacheService: Partial<WalletCacheService>;
  let mockWalletMcpClient: Partial<WalletMcpClientService>;
  let cachedLabels: WalletLabelItem[];

  beforeEach(() => {
    cachedLabels = [
      { id: 'lbl-1', name: 'groceries' },
      { id: 'lbl-2', name: 'transport' },
    ];

    mockWalletCacheService = {
      isLabelsLoaded: vi.fn(() => true),
      findLabelByName: vi.fn((name: string) => {
        return cachedLabels.find(label => label.name.toLowerCase() === name.toLowerCase());
      }),
      addLabelToCache: vi.fn((label: WalletLabelItem) => {
        cachedLabels.push(label);
      }),
      refreshLabels: vi.fn(async () => cachedLabels),
      getAccounts: vi.fn(() => [
        { id: 'acc-1', name: 'BCA Main', balance: 500000, currency: 'IDR' },
        { id: 'acc-2', name: 'BCA Saving', balance: 1000000, currency: 'IDR' },
      ]),
      getCategories: vi.fn(() => [
        { id: 'cat-1', name: 'Food & Beverage' },
      ]),
    };

    mockWalletMcpClient = {
      createLabel: vi.fn(async (name: string) => {
        const createdLabel: WalletLabelItem = {
          id: `lbl-new-${name.toLowerCase()}`,
          name: name.toLowerCase(),
        };
        return createdLabel;
      }),
      createRecords: vi.fn(async () => ({ success: true, count: 1 })),
    };
  });

  describe('prepareRecordsForWalletDispatch & WalletRecordPreparationService', () => {
    it('leaves records without labels unchanged', async () => {
      const recordsToPrepare: CreateRecordInputPayload[] = [
        {
          accountId: 'acc-1',
          categoryId: 'cat-1',
          amount: -50000,
          recordDate: '2026-09-13T10:00:00.000Z',
          note: 'Coffee without tags',
        },
      ];

      const preparationService = new WalletRecordPreparationService(
        mockWalletCacheService as WalletCacheService,
        mockWalletMcpClient as WalletMcpClientService
      );

      const preparedRecords = await preparationService.prepareRecordsForDispatch(recordsToPrepare);

      expect(preparedRecords[0].labelIds).toBeUndefined();
      expect(preparedRecords[0].labels).toBeUndefined();
      expect(mockWalletCacheService.findLabelByName).not.toHaveBeenCalled();
      expect(mockWalletMcpClient.createLabel).not.toHaveBeenCalled();
    });

    it('resolves existing cached labels and assigns labelIds and canonical label names', async () => {
      const recordsToPrepare: CreateRecordInputPayload[] = [
        {
          accountId: 'acc-1',
          categoryId: 'cat-1',
          amount: -75000,
          recordDate: '2026-09-13T10:00:00.000Z',
          labels: ['Groceries'],
        },
      ];

      const preparedRecords = await prepareRecordsForWalletDispatch(
        recordsToPrepare,
        mockWalletCacheService as WalletCacheService,
        mockWalletMcpClient as WalletMcpClientService
      );

      expect(preparedRecords[0].labelIds).toEqual(['lbl-1']);
      expect(preparedRecords[0].labels).toEqual(['groceries']);
      expect(mockWalletMcpClient.createLabel).not.toHaveBeenCalled();
    });

    it('auto-creates missing labels and updates cache and record attributes', async () => {
      const recordsToPrepare: CreateRecordInputPayload[] = [
        {
          accountId: 'acc-1',
          categoryId: 'cat-1',
          amount: -120000,
          recordDate: '2026-09-13T10:00:00.000Z',
          labels: ['newTag'],
        },
      ];

      const preparationService = new WalletRecordPreparationService(
        mockWalletCacheService as WalletCacheService,
        mockWalletMcpClient as WalletMcpClientService
      );

      const preparedRecords = await preparationService.prepareRecordsForDispatch(recordsToPrepare);

      expect(mockWalletMcpClient.createLabel).toHaveBeenCalledWith('newTag');
      expect(mockWalletCacheService.addLabelToCache).toHaveBeenCalledWith({
        id: 'lbl-new-newtag',
        name: 'newtag',
      });
      expect(preparedRecords[0].labelIds).toEqual(['lbl-new-newtag']);
      expect(preparedRecords[0].labels).toEqual(['newtag']);
    });

    it('handles mixed batches with existing, new, and unlabeled records', async () => {
      const recordsToPrepare: CreateRecordInputPayload[] = [
        {
          accountId: 'acc-1',
          categoryId: 'cat-1',
          amount: -25000,
          recordDate: '2026-09-13T10:00:00.000Z',
          labels: ['transport', 'taxi'],
        },
        {
          accountId: 'acc-2',
          categoryId: 'cat-2',
          amount: -15000,
          recordDate: '2026-09-13T10:00:00.000Z',
        },
      ];

      const preparationService = new WalletRecordPreparationService(
        mockWalletCacheService as WalletCacheService,
        mockWalletMcpClient as WalletMcpClientService
      );

      const preparedRecords = await preparationService.prepareRecordsForDispatch(recordsToPrepare);

      expect(preparedRecords[0].labelIds).toEqual(['lbl-2', 'lbl-new-taxi']);
      expect(preparedRecords[0].labels).toEqual(['transport', 'taxi']);
      expect(preparedRecords[1].labelIds).toBeUndefined();
      expect(preparedRecords[1].labels).toBeUndefined();
    });

    it('continues gracefully without labelId if label creation fails', async () => {
      (mockWalletMcpClient.createLabel as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('MCP server error: label creation unsupported')
      );

      const recordsToPrepare: CreateRecordInputPayload[] = [
        {
          accountId: 'acc-1',
          categoryId: 'cat-1',
          amount: -30000,
          recordDate: '2026-09-13T10:00:00.000Z',
          labels: ['unsupportedTag'],
        },
      ];

      const preparedRecords = await prepareRecordsForWalletDispatch(
        recordsToPrepare,
        mockWalletCacheService as WalletCacheService,
        mockWalletMcpClient as WalletMcpClientService
      );

      expect(preparedRecords[0].labelIds).toBeUndefined();
      expect(preparedRecords[0].labels).toBeUndefined();
    });
  });

  describe('Handler Delegation & Semantics Preservation', () => {
    let mockMessagingGateway: Partial<MessagingGatewayService>;
    let mockPendingTransactionService: PendingTransactionService;

    beforeEach(() => {
      mockMessagingGateway = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
        sendTypingPresence: vi.fn().mockResolvedValue(undefined),
      };
      mockPendingTransactionService = new PendingTransactionService();
    });

    it('AccountClarificationHandler delegates record preparation and preserves definitive failure semantics', async () => {
      const mockRecordPreparationService = {
        prepareRecordsForDispatch: vi.fn(async (records: CreateRecordInputPayload[]) => {
          for (const record of records) {
            record.labelIds = ['lbl-prepared'];
            record.labels = ['prepared-tag'];
          }
          return records;
        }),
      };

      const definitiveError = new WalletMcpRequestError(
        'Account is archived',
        'DEFINITIVE_FAILURE'
      );
      (mockWalletMcpClient.createRecords as ReturnType<typeof vi.fn>).mockRejectedValueOnce(definitiveError);

      const handler = new AccountClarificationHandler(
        mockPendingTransactionService,
        mockWalletMcpClient as WalletMcpClientService,
        mockWalletCacheService as WalletCacheService,
        mockMessagingGateway as MessagingGatewayService,
        mockRecordPreparationService as unknown as WalletRecordPreparationService
      );

      const event: IncomingUserMessageEvent = {
        channel: 'whatsapp',
        senderIdentifier: 'user123',
        chatIdentifier: 'chat123',
        messageType: 'text',
        textPayload: '1',
      };

      const originalRecords: CreateRecordInputPayload[] = [
        {
          accountId: '',
          categoryId: 'cat-1',
          amount: -50000,
          recordDate: '2026-09-13T10:00:00.000Z',
          note: 'Shopping #groceries',
          labels: ['groceries'],
        },
      ];

      const candidateAccounts: WalletAccountItem[] = [
        { id: 'acc-1', name: 'BCA Main', balance: 500000, currency: 'IDR' },
        { id: 'acc-2', name: 'BCA Saving', balance: 1000000, currency: 'IDR' },
      ];

      mockPendingTransactionService.addPendingAccountSelectionDraft({
        sourceType: 'USER',
        channel: event.channel,
        senderIdentifier: event.senderIdentifier,
        chatIdentifier: event.chatIdentifier,
        records: originalRecords,
        pendingRecordIndex: 0,
        accountHint: 'BCA',
        candidateAccounts,
        sourceUserText: 'Shopping #groceries',
        sourceReferenceInstant: new Date(),
      });

      const handled = await handler.handlePendingAccountSelectionReply(event, '1', Date.now());

      expect(handled).toBe(true);
      expect(mockRecordPreparationService.prepareRecordsForDispatch).toHaveBeenCalled();
      expect(mockWalletMcpClient.createRecords).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            accountId: 'acc-1',
            labelIds: ['lbl-prepared'],
          }),
        ])
      );
      // Verify definitive error retains draft in retryable state rather than UNKNOWN
      const latestDraft = mockPendingTransactionService.getLatestPendingAccountSelectionDraft(
        event.channel,
        event.chatIdentifier,
        event.senderIdentifier
      );
      expect(latestDraft).not.toBeNull();
      expect(mockPendingTransactionService.getPendingAccountSelectionDraftState(latestDraft!.ticketId)).toBe('PENDING');
    });

    it('AccountClarificationHandler delegates record preparation and preserves UNKNOWN failure semantics', async () => {
      const mockRecordPreparationService = {
        prepareRecordsForDispatch: vi.fn(async (records: CreateRecordInputPayload[]) => records),
      };

      const unknownError = new Error('Gateway timeout (504)');
      (mockWalletMcpClient.createRecords as ReturnType<typeof vi.fn>).mockRejectedValueOnce(unknownError);

      const handler = new AccountClarificationHandler(
        mockPendingTransactionService,
        mockWalletMcpClient as WalletMcpClientService,
        mockWalletCacheService as WalletCacheService,
        mockMessagingGateway as MessagingGatewayService,
        mockRecordPreparationService as unknown as WalletRecordPreparationService
      );

      const event: IncomingUserMessageEvent = {
        channel: 'whatsapp',
        senderIdentifier: 'user456',
        chatIdentifier: 'chat456',
        messageType: 'text',
        textPayload: '1',
      };

      const originalRecords: CreateRecordInputPayload[] = [
        {
          accountId: '',
          categoryId: 'cat-1',
          amount: -50000,
          recordDate: '2026-09-13T10:00:00.000Z',
          note: 'Dinner',
        },
      ];

      const candidateAccounts: WalletAccountItem[] = [
        { id: 'acc-1', name: 'Mandiri', balance: 200000, currency: 'IDR' },
      ];

      mockPendingTransactionService.addPendingAccountSelectionDraft({
        sourceType: 'USER',
        channel: event.channel,
        senderIdentifier: event.senderIdentifier,
        chatIdentifier: event.chatIdentifier,
        records: originalRecords,
        pendingRecordIndex: 0,
        accountHint: 'Mandiri',
        candidateAccounts,
        sourceUserText: 'Dinner',
        sourceReferenceInstant: new Date(),
      });

      const handled = await handler.handlePendingAccountSelectionReply(event, '1', Date.now());

      expect(handled).toBe(true);
      expect(mockRecordPreparationService.prepareRecordsForDispatch).toHaveBeenCalled();
      const latestDraft = mockPendingTransactionService.getLatestPendingAccountSelectionDraft(
        event.channel,
        event.chatIdentifier,
        event.senderIdentifier
      );
      expect(latestDraft).not.toBeNull();
      expect(mockPendingTransactionService.getPendingAccountSelectionDraftState(latestDraft!.ticketId)).toBe('UNKNOWN');
    });
  });
});

describe('Canonical Application Configuration (Issue #110 Part B)', () => {
  const originalEnvTimezone = process.env.APP_TIMEZONE;
  const originalEnvCurrency = process.env.DEFAULT_CURRENCY;
  const originalEnvLanguage = process.env.APP_LANGUAGE;

  afterEach(() => {
    resetRuntimeApplicationConfig();
    if (originalEnvTimezone !== undefined) {
      process.env.APP_TIMEZONE = originalEnvTimezone;
    } else {
      delete process.env.APP_TIMEZONE;
    }

    if (originalEnvCurrency !== undefined) {
      process.env.DEFAULT_CURRENCY = originalEnvCurrency;
    } else {
      delete process.env.DEFAULT_CURRENCY;
    }

    if (originalEnvLanguage !== undefined) {
      process.env.APP_LANGUAGE = originalEnvLanguage;
    } else {
      delete process.env.APP_LANGUAGE;
    }
  });

  describe('Timezone Resolution & Fallbacks', () => {
    it('returns configured valid IANA timezone', () => {
      process.env.APP_TIMEZONE = 'America/New_York';
      expect(getApplicationTimezone()).toBe('America/New_York');

      process.env.APP_TIMEZONE = 'UTC';
      expect(getApplicationTimezone()).toBe('UTC');

      process.env.APP_TIMEZONE = 'Asia/Tokyo';
      expect(getApplicationTimezone()).toBe('Asia/Tokyo');
    });

    it('safely defaults to Asia/Jakarta when APP_TIMEZONE is unset or empty', () => {
      delete process.env.APP_TIMEZONE;
      expect(getApplicationTimezone()).toBe(DEFAULT_APP_TIMEZONE);

      process.env.APP_TIMEZONE = '';
      expect(getApplicationTimezone()).toBe(DEFAULT_APP_TIMEZONE);

      process.env.APP_TIMEZONE = '   ';
      expect(getApplicationTimezone()).toBe(DEFAULT_APP_TIMEZONE);
    });

    it('safely falls back to Asia/Jakarta on invalid IANA timezone string without throwing', () => {
      process.env.APP_TIMEZONE = 'Invalid/Non_Existent_Timezone';
      expect(getApplicationTimezone()).toBe(DEFAULT_APP_TIMEZONE);

      process.env.APP_TIMEZONE = 'Random_Typo';
      expect(getApplicationTimezone()).toBe(DEFAULT_APP_TIMEZONE);
    });

    it('validates IANA timezone identifiers accurately', () => {
      expect(isValidIanaTimezone('Asia/Jakarta')).toBe(true);
      expect(isValidIanaTimezone('America/New_York')).toBe(true);
      expect(isValidIanaTimezone('UTC')).toBe(true);
      expect(isValidIanaTimezone('Europe/London')).toBe(true);
      expect(isValidIanaTimezone('Invalid_Zone')).toBe(false);
      expect(isValidIanaTimezone('')).toBe(false);
      expect(isValidIanaTimezone(undefined)).toBe(false);
    });

    it('resolveSafeTimezone trims whitespace and falls back safely', () => {
      expect(resolveSafeTimezone('  Asia/Jakarta  ')).toBe('Asia/Jakarta');
      expect(resolveSafeTimezone('invalid')).toBe(DEFAULT_APP_TIMEZONE);
      expect(resolveSafeTimezone('')).toBe(DEFAULT_APP_TIMEZONE);
      expect(resolveSafeTimezone(undefined)).toBe(DEFAULT_APP_TIMEZONE);
    });
  });

  describe('Default Currency & Localization Defaults', () => {
    it('resolves default currency with uppercase trimming and defaults to IDR', () => {
      delete process.env.DEFAULT_CURRENCY;
      expect(getDefaultCurrency()).toBe(DEFAULT_APP_CURRENCY);

      process.env.DEFAULT_CURRENCY = 'usd';
      expect(getDefaultCurrency()).toBe('USD');

      process.env.DEFAULT_CURRENCY = '  eur  ';
      expect(getDefaultCurrency()).toBe('EUR');

      process.env.DEFAULT_CURRENCY = '';
      expect(getDefaultCurrency()).toBe(DEFAULT_APP_CURRENCY);
    });

    it('resolves application language and defaults to id', () => {
      delete process.env.APP_LANGUAGE;
      expect(getApplicationLanguage()).toBe(DEFAULT_APP_LANGUAGE);

      process.env.APP_LANGUAGE = 'en';
      expect(getApplicationLanguage()).toBe('en');

      process.env.APP_LANGUAGE = 'id';
      expect(getApplicationLanguage()).toBe('id');
    });
  });

  describe('Runtime Configuration State Management', () => {
    it('returns loaded environment configuration when no runtime config is set', () => {
      process.env.APP_TIMEZONE = 'Europe/Paris';
      process.env.DEFAULT_CURRENCY = 'EUR';

      const config = getRuntimeApplicationConfig();
      expect(config.appTimezone).toBe('Europe/Paris');
      expect(config.defaultCurrency).toBe('EUR');
    });

    it('respects setRuntimeApplicationConfig overrides over process.env', () => {
      process.env.APP_TIMEZONE = 'Asia/Jakarta';
      process.env.DEFAULT_CURRENCY = 'IDR';

      const customConfig = loadEnvironmentConfiguration();
      customConfig.appTimezone = 'America/Chicago';
      customConfig.defaultCurrency = 'USD';
      customConfig.appLanguage = 'en';

      setRuntimeApplicationConfig(customConfig);

      expect(getRuntimeApplicationConfig().appTimezone).toBe('America/Chicago');
      expect(getApplicationTimezone()).toBe('America/Chicago');
      expect(getDefaultCurrency()).toBe('USD');
      expect(getApplicationLanguage()).toBe('en');
    });

    it('clears runtime config override after resetRuntimeApplicationConfig', () => {
      process.env.APP_TIMEZONE = 'Asia/Jakarta';

      const customConfig = loadEnvironmentConfiguration();
      customConfig.appTimezone = 'America/Chicago';
      setRuntimeApplicationConfig(customConfig);
      expect(getApplicationTimezone()).toBe('America/Chicago');

      resetRuntimeApplicationConfig();
      expect(getApplicationTimezone()).toBe('Asia/Jakarta');
    });

    it('keeps registered runtime config authoritative when localization fields are empty or invalid despite conflicting env values', () => {
      process.env.APP_TIMEZONE = 'Europe/Paris';
      process.env.DEFAULT_CURRENCY = 'EUR';
      process.env.APP_LANGUAGE = 'en';

      const customConfig = loadEnvironmentConfiguration();
      customConfig.appTimezone = '';
      customConfig.defaultCurrency = '';
      customConfig.appLanguage = '' as 'id' | 'en';

      setRuntimeApplicationConfig(customConfig);

      // Must return the documented defaults rather than falling back to process.env values
      expect(getApplicationTimezone()).toBe(DEFAULT_APP_TIMEZONE);
      expect(getDefaultCurrency()).toBe(DEFAULT_APP_CURRENCY);
      expect(getApplicationLanguage()).toBe(DEFAULT_APP_LANGUAGE);

      // Also test with invalid timezone in registered config
      customConfig.appTimezone = 'Invalid/Non_Existent_Timezone';
      expect(getApplicationTimezone()).toBe(DEFAULT_APP_TIMEZONE);
    });
  });

  describe('Configuration Validation Behavior Compatibility', () => {
    it('flags invalid IANA timezone in validateApplicationConfiguration', () => {
      const config = loadEnvironmentConfiguration();
      config.appTimezone = 'Invalid/Timezone_Name';

      const validationResult = validateApplicationConfiguration(config);
      expect(validationResult.isValid).toBe(false);
      expect(
        validationResult.errors.some(error => error.variableName === 'APP_TIMEZONE')
      ).toBe(true);
    });

    it('accepts valid IANA timezone in validateApplicationConfiguration without errors', () => {
      const config = loadEnvironmentConfiguration();
      config.appTimezone = 'Asia/Jakarta';

      const validationResult = validateApplicationConfiguration(config);
      const timezoneErrors = validationResult.errors.filter(
        error => error.variableName === 'APP_TIMEZONE'
      );
      expect(timezoneErrors).toHaveLength(0);
    });
  });

  describe('Formatter Compatibility with Canonical Config', () => {
    it('formatCurrencyAmount uses canonical default currency when no currency is specified', () => {
      process.env.DEFAULT_CURRENCY = 'USD';
      expect(formatCurrencyAmount(100, undefined, 'en')).toBe('$100.00');

      process.env.DEFAULT_CURRENCY = 'IDR';
      expect(formatCurrencyAmount(100000, undefined, 'id')).toBe('Rp 100.000');
    });

    it('formatBalanceSummaryMessage uses canonical default currency for fallback total', () => {
      process.env.DEFAULT_CURRENCY = 'USD';
      const accounts: WalletAccountItem[] = [
        { id: 'acc-1', name: 'Cash', balance: 50 },
      ];

      const balanceMessage = formatBalanceSummaryMessage(accounts, 'en');
      expect(balanceMessage).toContain('$50.00');
    });
  });
});
