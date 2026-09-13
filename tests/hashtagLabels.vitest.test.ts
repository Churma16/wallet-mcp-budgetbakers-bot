import assert from 'node:assert';
import { test } from 'vitest';
import { extractHashtags, normalizeTagName, deduplicateTags } from '../src/utils/hashtagParser.js';
import { validateAndSanitizeFinancialRecords } from '../src/utils/recordValidator.js';
import { resolveAndEnsureLabels } from '../src/services/walletLabelResolver.js';
import { WalletCacheService } from '../src/services/walletCacheService.js';
import { WalletMcpClientService } from '../src/services/walletMcpService.js';
import { formatRecordSuccessMessage } from '../src/utils/humanResponseFormatter.js';
import {
  WalletAccountItem,
  WalletCategoryItem,
  WalletLabelItem,
  CreateRecordInputPayload,
} from '../src/types/walletTypes.js';
import { UserMessageHandler } from '../src/handlers/userMessageHandler.js';
import { AccountClarificationHandler } from '../src/handlers/accountClarificationHandler.js';
import { PendingTransactionService } from '../src/services/pendingTransactionService.js';
import { IncomingUserMessageEvent } from '../src/services/messaging/index.js';

const mockAccounts: WalletAccountItem[] = [
  { id: 'acc-bca', name: 'BCA', currency: 'IDR' },
  { id: 'acc-cash', name: 'Cash', currency: 'IDR' },
];

const mockCategories: WalletCategoryItem[] = [
  { id: 'cat-food', name: 'Makanan & Minuman' },
  { id: 'cat-travel', name: 'Liburan' },
];

test('1. Hashtag Parser Unit Tests', () => {
  const singleResult = extractHashtags('Makan siang 50rb #bandung');
  assert.deepEqual(singleResult.tags, ['bandung']);
  assert.equal(singleResult.cleanedText, 'Makan siang 50rb');

  const multiResult = extractHashtags('Kopi 25rb #reimburse meeting kantor #proyek_a');
  assert.deepEqual(multiResult.tags, ['reimburse', 'proyek_a']);
  assert.equal(multiResult.cleanedText, 'Kopi 25rb meeting kantor');

  const hyphenResult = extractHashtags('Tiket bioskop #trip-bali');
  assert.deepEqual(hyphenResult.tags, ['trip-bali']);
  assert.equal(hyphenResult.cleanedText, 'Tiket bioskop');

  const dedupResult = extractHashtags('Makan enak #Bandung #bandung #BANDUNG');
  assert.deepEqual(dedupResult.tags, ['Bandung']);
  assert.equal(dedupResult.cleanedText, 'Makan enak');

  const punctResult = extractHashtags('Makan (#bandung, #liburan!) bareng teman.');
  assert.deepEqual(punctResult.tags, ['bandung', 'liburan']);
  assert.equal(punctResult.cleanedText, 'Makan bareng teman.');

  const onlyTagsResult = extractHashtags('#bandung #kuliner');
  assert.deepEqual(onlyTagsResult.tags, ['bandung', 'kuliner']);
  assert.equal(onlyTagsResult.cleanedText, '');

  const noTagsResult = extractHashtags('Nasi padang 30rb pake bca');
  assert.deepEqual(noTagsResult.tags, []);
  assert.equal(noTagsResult.cleanedText, 'Nasi padang 30rb pake bca');

  const nonTagResult = extractHashtags('Buku belajar C# harga # murah');
  assert.deepEqual(nonTagResult.tags, []);
  assert.equal(nonTagResult.cleanedText, 'Buku belajar C# harga # murah');

  const malformedResult1 = extractHashtags('Bayar #trip/bali');
  assert.deepEqual(malformedResult1.tags, []);
  assert.equal(malformedResult1.cleanedText, 'Bayar #trip/bali');

  const malformedResult2 = extractHashtags('Tiket #trip/bali dan belanja #oleh-oleh.');
  assert.deepEqual(malformedResult2.tags, ['oleh-oleh']);
  assert.equal(malformedResult2.cleanedText, 'Tiket #trip/bali dan belanja');

  const malformedResult3 = extractHashtags('#123/456 email#domain.com #valid-tag');
  assert.deepEqual(malformedResult3.tags, ['valid-tag']);
  assert.equal(malformedResult3.cleanedText, '#123/456 email#domain.com');

  assert.equal(normalizeTagName('#reimburse'), 'reimburse');
  assert.equal(normalizeTagName('###tag'), 'tag');
  assert.deepEqual(deduplicateTags(['#alpha', 'Alpha', 'ALPHA', '#beta']), ['alpha', 'beta']);
});

test('2. Record Validator Sanitization & Note Cleaning', () => {
  const rawRecord: CreateRecordInputPayload = {
    accountId: 'acc-bca',
    amount: -50_000,
    recordDate: '2026-09-11T10:00:00Z',
    note: 'Makan sate #kuliner #bandung',
    categoryId: 'cat-food',
  };

  const validationResult = validateAndSanitizeFinancialRecords([rawRecord], mockAccounts, mockCategories);
  assert.equal(validationResult.isValid, true);
  assert.equal(validationResult.sanitizedRecords.length, 1);
  const sanitized = validationResult.sanitizedRecords[0];
  assert.equal(sanitized.note, 'Makan sate');
  assert.deepEqual(sanitized.labels, ['kuliner', 'bandung']);

  const onlyTagRecord: CreateRecordInputPayload = {
    accountId: 'acc-cash',
    amount: -25_000,
    recordDate: '2026-09-11T10:00:00Z',
    note: '#reimburse',
  };
  const onlyTagValidation = validateAndSanitizeFinancialRecords([onlyTagRecord], mockAccounts, mockCategories);
  assert.equal(onlyTagValidation.isValid, true);
  assert.equal(onlyTagValidation.sanitizedRecords[0].note, undefined);
  assert.deepEqual(onlyTagValidation.sanitizedRecords[0].labels, ['reimburse']);

  const preLabeledRecord: CreateRecordInputPayload = {
    accountId: 'acc-bca',
    amount: -10_000,
    recordDate: '2026-09-11T10:00:00Z',
    note: 'Kopi #reimburse #kantor',
    labels: ['reimburse', 'kantor'],
  };
  const preLabeledValidation = validateAndSanitizeFinancialRecords([preLabeledRecord], mockAccounts, mockCategories);
  assert.equal(preLabeledValidation.isValid, true);
  assert.equal(preLabeledValidation.sanitizedRecords[0].note, 'Kopi');
  assert.deepEqual(preLabeledValidation.sanitizedRecords[0].labels, ['reimburse', 'kantor']);

  const unmentionedLabelRecord: CreateRecordInputPayload = {
    accountId: 'acc-bca',
    amount: -50_000,
    recordDate: '2026-09-11T10:00:00Z',
    note: 'makan di Bandung',
    labels: ['bandung'],
  };
  const unmentionedValidation = validateAndSanitizeFinancialRecords(
    [unmentionedLabelRecord],
    mockAccounts,
    mockCategories,
    'makan di Bandung 50rb'
  );
  assert.equal(unmentionedValidation.isValid, true);
  assert.equal(unmentionedValidation.sanitizedRecords[0].labels, undefined, 'AI labels without explicit # must be discarded');

  const injectedLabelIdsRecord: CreateRecordInputPayload = {
    accountId: 'acc-bca',
    amount: -50_000,
    recordDate: '2026-09-11T10:00:00Z',
    note: 'makan siang',
    labelIds: ['lbl-injected-id', 'lbl-fake'],
  };
  const injectedValidation = validateAndSanitizeFinancialRecords(
    [injectedLabelIdsRecord],
    mockAccounts,
    mockCategories,
    'makan siang 50rb'
  );
  assert.equal(injectedValidation.isValid, true);
  assert.equal(injectedValidation.sanitizedRecords[0].labelIds, undefined, 'Incoming labelIds must be discarded during validation');

  const hallucinatedNoteRecord: CreateRecordInputPayload = {
    accountId: 'acc-bca',
    amount: -50_000,
    recordDate: '2026-09-11T10:00:00Z',
    note: 'makan di Bandung #bandung',
  };
  const hallucinatedNoteValidation = validateAndSanitizeFinancialRecords(
    [hallucinatedNoteRecord],
    mockAccounts,
    mockCategories,
    'makan di Bandung 50rb'
  );
  assert.equal(hallucinatedNoteValidation.isValid, true);
  assert.equal(hallucinatedNoteValidation.sanitizedRecords[0].note, 'makan di Bandung');
  assert.equal(
    hallucinatedNoteValidation.sanitizedRecords[0].labels,
    undefined,
    'AI note hashtags absent from raw user text must not become labels'
  );

  const partialAiRecord: CreateRecordInputPayload = {
    accountId: 'acc-bca',
    amount: -50_000,
    recordDate: '2026-09-11T10:00:00Z',
    note: 'makan siang',
    labels: ['kantor'],
  };
  const unionValidation = validateAndSanitizeFinancialRecords(
    [partialAiRecord],
    mockAccounts,
    mockCategories,
    'makan siang 50rb #kantor #reimburse'
  );
  assert.equal(unionValidation.isValid, true);
  assert.deepEqual(
    unionValidation.sanitizedRecords[0].labels,
    ['kantor', 'reimburse'],
    'Single-record input must union all explicit hashtags from user input'
  );
});

test('3. Label Resolution, Caching & MCP Auto-Creation', async () => {
  const initialLabels: WalletLabelItem[] = [
    { id: 'lbl-bandung', name: 'bandung' },
    { id: 'lbl-reimburse', name: 'Reimburse' },
  ];
  const createdCalls: string[] = [];

  const mockMcpClient = {
    fetchLabels: async () => initialLabels,
    createLabel: async (name: string) => {
      createdCalls.push(name);
      if (name === 'fail-create') throw new Error('MCP creation failed');
      if (name === 'unsupported') return null;
      return { id: `lbl-${name.toLowerCase()}`, name };
    },
  } as unknown as WalletMcpClientService;

  const mockCacheService = new WalletCacheService(mockMcpClient);
  for (const label of initialLabels) mockCacheService.addLabelToCache(label);
  mockCacheService.setLabelsLoaded(true);

  const existingResolveResult = await resolveAndEnsureLabels(['#BANDUNG', 'reimburse'], mockCacheService, mockMcpClient);
  assert.deepEqual(existingResolveResult.resolvedLabelIds, ['lbl-bandung', 'lbl-reimburse']);
  assert.deepEqual(existingResolveResult.resolvedLabelNames, ['bandung', 'Reimburse']);
  assert.equal(createdCalls.length, 0);

  const newResolveResult = await resolveAndEnsureLabels(['liburan'], mockCacheService, mockMcpClient);
  assert.deepEqual(newResolveResult.resolvedLabelIds, ['lbl-liburan']);
  assert.deepEqual(newResolveResult.resolvedLabelNames, ['liburan']);
  assert.equal(createdCalls.length, 1);
  assert.equal(createdCalls[0], 'liburan');
  assert.equal(mockCacheService.findLabelByName('LIBURAN')?.id, 'lbl-liburan');

  const unsupportedResult = await resolveAndEnsureLabels(['unsupported'], mockCacheService, mockMcpClient);
  assert.deepEqual(unsupportedResult.resolvedLabelIds, []);
  assert.deepEqual(unsupportedResult.resolvedLabelNames, []);
  assert.deepEqual(unsupportedResult.unresolvedLabelNames, ['unsupported']);

  const failedResult = await resolveAndEnsureLabels(['fail-create'], mockCacheService, mockMcpClient);
  assert.deepEqual(failedResult.resolvedLabelIds, []);
  assert.deepEqual(failedResult.resolvedLabelNames, []);
  assert.deepEqual(failedResult.unresolvedLabelNames, ['fail-create']);

  let getLabelsCallCount = 0;
  const createLabelCallsE: string[] = [];
  const mockMcpClientE = {
    fetchAccounts: async () => [],
    fetchCategories: async () => [],
    fetchLabels: async () => {
      getLabelsCallCount++;
      if (getLabelsCallCount === 1) throw new Error('Timeout fetching labels on cold start');
      return [{ id: 'lbl-reimburse', name: 'reimburse' }];
    },
    createLabel: async (name: string) => {
      createLabelCallsE.push(name);
      return { id: `lbl-${name}`, name };
    },
  } as unknown as WalletMcpClientService;

  const coldStartCache = new WalletCacheService(mockMcpClientE);
  await coldStartCache.initialize();
  assert.equal(coldStartCache.isLabelsLoaded(), false);
  assert.equal(coldStartCache.getLabels().length, 0);
  const reconciledResult = await resolveAndEnsureLabels(['reimburse'], coldStartCache, mockMcpClientE);
  assert.deepEqual(reconciledResult.resolvedLabelIds, ['lbl-reimburse']);
  assert.deepEqual(reconciledResult.resolvedLabelNames, ['reimburse']);
  assert.equal(createLabelCallsE.length, 0);
  assert.equal(coldStartCache.isLabelsLoaded(), true);

  const createLabelCallsF: string[] = [];
  const persistentFailMcpClient = {
    fetchAccounts: async () => [],
    fetchCategories: async () => [],
    fetchLabels: async () => { throw new Error('Persistent network error'); },
    createLabel: async (name: string) => {
      createLabelCallsF.push(name);
      return { id: `lbl-${name}`, name };
    },
  } as unknown as WalletMcpClientService;
  const failCache = new WalletCacheService(persistentFailMcpClient);
  await failCache.initialize();
  const failResult = await resolveAndEnsureLabels(['kantor'], failCache, persistentFailMcpClient);
  assert.deepEqual(failResult.resolvedLabelIds, []);
  assert.deepEqual(failResult.resolvedLabelNames, []);
  assert.deepEqual(failResult.unresolvedLabelNames, ['kantor']);
  assert.equal(createLabelCallsF.length, 0);
});

test('4. Human-Facing Success Message Formatting with Labels', () => {
  const singleRecordWithLabels: CreateRecordInputPayload = {
    accountId: 'acc-bca',
    amount: -75_000,
    recordDate: '2026-09-11T12:00:00Z',
    note: 'Makan bersama',
    categoryId: 'cat-food',
    labels: ['bandung', 'liburan'],
  };

  const idMessage = formatRecordSuccessMessage([singleRecordWithLabels], mockAccounts, mockCategories, 'id');
  assert.ok(idMessage.includes('Makan bersama') && idMessage.includes('berhasil dicatat!'));
  assert.ok(idMessage.includes('🔖 #bandung #liburan'));

  const enMessage = formatRecordSuccessMessage([singleRecordWithLabels], mockAccounts, mockCategories, 'en');
  assert.ok(enMessage.includes('recorded successfully!'));
  assert.ok(enMessage.includes('🔖 #bandung #liburan'));

  const multiRecordWithLabels: CreateRecordInputPayload[] = [
    {
      accountId: 'acc-bca', amount: -50_000, recordDate: '2026-09-11T12:00:00Z', note: 'Makan',
      categoryId: 'cat-food', labels: ['kuliner'],
    },
    {
      accountId: 'acc-cash', amount: -20_000, recordDate: '2026-09-11T12:00:00Z', note: 'Ojek',
      categoryId: 'cat-travel', labels: ['transport'],
    },
  ];
  const multiIdMessage = formatRecordSuccessMessage(multiRecordWithLabels, mockAccounts, mockCategories, 'id');
  assert.ok(multiIdMessage.includes('2 transaksi') && multiIdMessage.includes('berhasil dicatat!'));
  assert.ok(multiIdMessage.includes('🔖 #kuliner'));
  assert.ok(multiIdMessage.includes('🔖 #transport'));

  const noLabelRecord: CreateRecordInputPayload = {
    accountId: 'acc-bca', amount: -15_000, recordDate: '2026-09-11T12:00:00Z', note: 'Parkir',
  };
  const noLabelMessage = formatRecordSuccessMessage([noLabelRecord], mockAccounts, mockCategories, 'id');
  assert.ok(!noLabelMessage.includes('🔖'));
});

test('5. End-to-End Record Payload Generation with labelIds', async () => {
  let dispatchedRecordsPayload: CreateRecordInputPayload[] = [];
  const mockClient = {
    fetchAccounts: async () => mockAccounts,
    fetchCategories: async () => mockCategories,
    fetchLabels: async () => [{ id: 'lbl-reimburse', name: 'reimburse' }],
    createLabel: async (name: string) => ({ id: `lbl-${name}`, name }),
    createRecords: async (records: CreateRecordInputPayload[]) => {
      dispatchedRecordsPayload = records;
      return { summary: { total: records.length, succeeded: records.length, failed: 0 } };
    },
  } as unknown as WalletMcpClientService;

  const cache = new WalletCacheService(mockClient);
  await cache.initialize();
  const rawRecord: CreateRecordInputPayload = {
    accountId: 'acc-bca', amount: -28_000, recordDate: '2026-09-11T10:00:00Z',
    note: 'Kopi kenangan 28rb #reimburse #kantor',
  };
  const validation = validateAndSanitizeFinancialRecords([rawRecord], mockAccounts, mockCategories);
  assert.equal(validation.isValid, true);
  const validatedRecord = validation.sanitizedRecords[0];
  assert.equal(validatedRecord.note, 'Kopi kenangan 28rb');
  assert.deepEqual(validatedRecord.labels, ['reimburse', 'kantor']);

  const { resolvedLabelIds, resolvedLabelNames } = await resolveAndEnsureLabels(validatedRecord.labels!, cache, mockClient);
  validatedRecord.labelIds = resolvedLabelIds;
  validatedRecord.labels = resolvedLabelNames;
  assert.deepEqual(validatedRecord.labelIds, ['lbl-reimburse', 'lbl-kantor']);
  assert.deepEqual(validatedRecord.labels, ['reimburse', 'kantor']);

  await mockClient.createRecords([validatedRecord]);
  assert.equal(dispatchedRecordsPayload.length, 1);
  assert.deepEqual(dispatchedRecordsPayload[0].labelIds, ['lbl-reimburse', 'lbl-kantor']);
  assert.equal(dispatchedRecordsPayload[0].note, 'Kopi kenangan 28rb');
});

test('6. WalletMcpClientService & WalletCacheService Label Integration', async () => {
  const realMcpClient = new WalletMcpClientService('http://localhost:8080');
  let mockToolResponse: unknown = [
    { id: 'lbl-1', name: 'makan', color: '#ff0000', icon: 'food' },
    { labelId: 'lbl-2', labelName: 'transport', color: '#00ff00', icon: 'car' },
    { id: '', name: 'invalid-empty-id' },
  ];

  realMcpClient.callMcpTool = async (toolName: string, _args: Record<string, unknown> = {}) => {
    if (toolName === 'get_labels') return mockToolResponse as any;
    if (toolName === 'create_label') return mockToolResponse as any;
    if (toolName === 'create_records') return { summary: { total: 1, succeeded: 1, failed: 0 } } as any;
    return {} as any;
  };

  const fetchedLabels = await realMcpClient.fetchLabels(true);
  assert.equal(fetchedLabels.length, 2);
  assert.equal(fetchedLabels[0].id, 'lbl-1');
  assert.equal(fetchedLabels[0].name, 'makan');
  assert.equal(fetchedLabels[0].color, '#ff0000');
  assert.equal(fetchedLabels[1].id, 'lbl-2');
  assert.equal(fetchedLabels[1].name, 'transport');

  let callToolInvoked = false;
  const originalCallMcp = realMcpClient.callMcpTool;
  realMcpClient.callMcpTool = async (toolName: string, args: Record<string, unknown> = {}) => {
    callToolInvoked = true;
    return originalCallMcp(toolName, args);
  };
  const cachedLabels = await realMcpClient.fetchLabels(false);
  assert.equal(callToolInvoked, false);
  assert.equal(cachedLabels.length, 2);
  realMcpClient.callMcpTool = originalCallMcp;

  mockToolResponse = { labels: [{ id: 'lbl-3', title: 'proyek' }] };
  const wrappedLabels = await realMcpClient.fetchLabels(true);
  assert.equal(wrappedLabels.length, 1);
  assert.equal(wrappedLabels[0].id, 'lbl-3');
  assert.equal(wrappedLabels[0].name, 'proyek');

  realMcpClient.callMcpTool = async (toolName: string) => {
    if (toolName === 'get_labels') throw new Error('Network timeout');
    return {} as any;
  };
  await assert.rejects(async () => realMcpClient.fetchLabels(true), /Network timeout/);

  const emptyResult = await realMcpClient.createLabel('  #   ');
  assert.equal(emptyResult, null);

  mockToolResponse = { id: 'lbl-new', name: 'investasi' };
  realMcpClient.callMcpTool = async () => mockToolResponse as any;
  const createdLabel = await realMcpClient.createLabel('#investasi');
  assert.ok(createdLabel);
  assert.equal(createdLabel?.id, 'lbl-new');
  assert.equal(createdLabel?.name, 'investasi');

  mockToolResponse = { label: { labelId: 'lbl-wrap', name: 'wrapped' } };
  const wrappedCreatedLabel = await realMcpClient.createLabel('wrapped');
  assert.ok(wrappedCreatedLabel);
  assert.equal(wrappedCreatedLabel?.id, 'lbl-wrap');

  mockToolResponse = { id: 'lbl-wrap', name: 'wrapped-updated', color: '#123456' };
  const updatedCreatedLabel = await realMcpClient.createLabel('wrapped');
  assert.ok(updatedCreatedLabel);
  assert.equal(updatedCreatedLabel?.name, 'wrapped-updated');

  mockToolResponse = { success: true };
  const invalidResult = await realMcpClient.createLabel('invalid');
  assert.equal(invalidResult, null);

  realMcpClient.callMcpTool = async () => { throw new Error('Not implemented'); };
  const throwingResult = await realMcpClient.createLabel('throwing');
  assert.equal(throwingResult, null);

  let capturedRecordsPayload: any[] = [];
  realMcpClient.callMcpTool = async (toolName: string, args: Record<string, unknown> = {}) => {
    if (toolName === 'create_records') {
      capturedRecordsPayload = args.records as any[];
      return { summary: { total: 1, succeeded: 1, failed: 0 } };
    }
    return {};
  };
  await realMcpClient.createRecords([{
    accountId: 'acc-bca', amount: -10000, recordDate: '2026-09-11T10:00:00Z',
    labelIds: ['lbl-1', 'lbl-2'], note: 'test note',
  }]);
  assert.equal(capturedRecordsPayload.length, 1);
  assert.deepEqual(capturedRecordsPayload[0].labelIds, ['lbl-1', 'lbl-2']);

  mockToolResponse = [
    { id: 'lbl-cache-1', name: 'Keluarga' },
    { id: 'lbl-cache-2', name: 'Gadget' },
  ];
  realMcpClient.callMcpTool = async (toolName: string) => {
    if (toolName === 'get_labels') return mockToolResponse;
    if (toolName === 'get_accounts') return mockAccounts;
    if (toolName === 'get_categories') return mockCategories;
    return {};
  };

  const realCacheService = new WalletCacheService(realMcpClient);
  await realCacheService.initialize();
  assert.equal(realCacheService.isLabelsLoaded(), true);
  assert.equal(realCacheService.getLabels().length, 2);
  assert.equal(realCacheService.findLabelById('lbl-cache-1')?.name, 'Keluarga');
  assert.equal(realCacheService.findLabelById('lbl-nonexistent'), undefined);
  assert.equal(realCacheService.findLabelByName('keluarga')?.id, 'lbl-cache-1');
  assert.equal(realCacheService.findLabelByName('#GADGET')?.id, 'lbl-cache-2');

  realCacheService.setLabelsLoaded(false);
  assert.equal(realCacheService.isLabelsLoaded(), false);
  realCacheService.setLabelsLoaded(true);
  assert.equal(realCacheService.isLabelsLoaded(), true);

  realCacheService.addLabelToCache({ id: 'lbl-cache-3', name: 'Hiburan' });
  assert.equal(realCacheService.findLabelByName('hiburan')?.id, 'lbl-cache-3');
  realCacheService.addLabelToCache({ id: 'lbl-cache-3', name: 'Hiburan-Updated' });
  assert.equal(realCacheService.findLabelById('lbl-cache-3')?.name, 'Hiburan-Updated');

  mockToolResponse = [{ id: 'lbl-refreshed', name: 'Refreshed' }];
  const refreshedList = await realCacheService.refreshLabels();
  assert.equal(refreshedList.length, 1);
  assert.equal(refreshedList[0].id, 'lbl-refreshed');
  assert.equal(realCacheService.isLabelsLoaded(), true);

  realMcpClient.callMcpTool = async (toolName: string) => {
    if (toolName === 'get_labels') throw new Error('Refresh error');
    return {};
  };
  await assert.rejects(async () => realCacheService.refreshLabels(), /Refresh error/);
  assert.equal(realCacheService.isLabelsLoaded(), false);
});

test('7. UserMessageHandler Hashtag Fallback & Label Resolution', async () => {
  const dispatchedMcpRecords: CreateRecordInputPayload[][] = [];
  const sentMessages: string[] = [];
  const mockMessagingGateway = {
    sendTypingPresence: async () => {},
    clearTypingPresence: async () => {},
    sendMessage: async (_channel: string, _chatId: string, content: string) => { sentMessages.push(content); },
  };
  const mockPendingService = new PendingTransactionService();
  const mockPendingActionHandler = { handlePendingAction: async () => false };
  const mockFastPathHandler = { handleFastPath: async () => false };
  let aiRecordOutput: CreateRecordInputPayload[] = [];
  const mockAiProvider = {
    providerName: 'mock',
    processTextMessage: async () => ({ action: 'CREATE_RECORD', explanation: 'Expense parsed', records: aiRecordOutput }),
  };
  const testLabels: WalletLabelItem[] = [{ id: 'lbl-kantor', name: 'kantor' }];
  const mockClient = {
    fetchAccounts: async () => mockAccounts,
    fetchCategories: async () => mockCategories,
    fetchLabels: async () => testLabels,
    createLabel: async (name: string) => ({ id: `lbl-${name}`, name }),
    createRecords: async (records: CreateRecordInputPayload[]) => {
      dispatchedMcpRecords.push(records);
      return { summary: { total: records.length, succeeded: records.length, failed: 0 } };
    },
    fetchBudgets: async () => [],
  } as unknown as WalletMcpClientService;
  const testCache = new WalletCacheService(mockClient);
  await testCache.initialize();
  const handler = new UserMessageHandler(
    mockMessagingGateway as any,
    mockPendingService as any,
    mockPendingActionHandler as any,
    mockFastPathHandler as any,
    mockAiProvider as any,
    testCache,
    mockClient
  );

  aiRecordOutput = [{
    accountId: 'acc-bca', amount: -25000, recordDate: '2026-09-11T12:00:00Z',
    categoryId: 'cat-food', note: 'Kopi siang',
  }];
  const incomingEvent: IncomingUserMessageEvent = {
    channel: 'whatsapp', senderIdentifier: '+628123456789', chatIdentifier: '+628123456789',
    messageType: 'text', textPayload: 'Kopi siang 25rb #kantor',
  };
  await handler.handleIncomingUserMessage(incomingEvent);
  assert.equal(dispatchedMcpRecords.length, 1);
  assert.deepEqual(dispatchedMcpRecords[0][0].labelIds, ['lbl-kantor']);
  assert.deepEqual(dispatchedMcpRecords[0][0].labels, ['kantor']);
  assert.ok(sentMessages[0].includes('🔖 #kantor'));

  sentMessages.length = 0;
  dispatchedMcpRecords.length = 0;
  aiRecordOutput = [
    { accountId: 'acc-bca', amount: -15000, recordDate: '2026-09-11T12:00:00Z', categoryId: 'cat-food', note: 'Snack #kantor', labels: ['kantor'] },
    { accountId: 'acc-cash', amount: -30000, recordDate: '2026-09-11T12:00:00Z', categoryId: 'cat-food', note: 'Makan #liburan', labels: ['liburan'] },
  ];
  const multiEvent: IncomingUserMessageEvent = {
    channel: 'whatsapp', senderIdentifier: '+628123456789', chatIdentifier: '+628123456789',
    messageType: 'text', textPayload: 'Snack 15rb #kantor, Makan 30rb #liburan',
  };
  await handler.handleIncomingUserMessage(multiEvent);
  assert.equal(dispatchedMcpRecords.length, 1);
  assert.equal(dispatchedMcpRecords[0].length, 2);
  assert.deepEqual(dispatchedMcpRecords[0][0].labelIds, ['lbl-kantor']);
  assert.deepEqual(dispatchedMcpRecords[0][1].labelIds, ['lbl-liburan']);
  assert.ok(sentMessages[0].includes('🔖 #kantor'));
  assert.ok(sentMessages[0].includes('🔖 #liburan'));

  sentMessages.length = 0;
  dispatchedMcpRecords.length = 0;
  let createLabelCallsCount = 0;
  (mockClient as any).createLabel = async (name: string) => {
    createLabelCallsCount++;
    return { id: `lbl-${name}`, name };
  };
  aiRecordOutput = [{
    accountId: 'acc-bca', amount: -50000, recordDate: '2026-09-11T12:00:00Z', categoryId: 'cat-food',
    note: 'makan di Bandung #bandung', labels: ['bandung'], labelIds: ['lbl-injected-id'],
  } as any];
  const noHashEvent: IncomingUserMessageEvent = {
    channel: 'whatsapp', senderIdentifier: '+628123456789', chatIdentifier: '+628123456789',
    messageType: 'text', textPayload: 'makan di Bandung 50rb',
  };
  await handler.handleIncomingUserMessage(noHashEvent);
  assert.equal(createLabelCallsCount, 0);
  assert.equal(dispatchedMcpRecords.length, 1);
  assert.equal(dispatchedMcpRecords[0][0].note, 'makan di Bandung');
  assert.equal(dispatchedMcpRecords[0][0].labels, undefined);
  assert.equal(dispatchedMcpRecords[0][0].labelIds, undefined);
  assert.ok(!sentMessages[0].includes('🔖'));

  sentMessages.length = 0;
  dispatchedMcpRecords.length = 0;
  createLabelCallsCount = 0;
  aiRecordOutput = [{
    accountId: 'acc-bca', amount: -50000, recordDate: '2026-09-11T12:00:00Z', categoryId: 'cat-food',
    note: 'makan siang', labels: ['kantor'],
  }];
  const partialAiEvent: IncomingUserMessageEvent = {
    channel: 'whatsapp', senderIdentifier: '+628123456789', chatIdentifier: '+628123456789',
    messageType: 'text', textPayload: 'makan siang 50rb #kantor #reimburse',
  };
  await handler.handleIncomingUserMessage(partialAiEvent);
  assert.equal(dispatchedMcpRecords.length, 1);
  assert.deepEqual(dispatchedMcpRecords[0][0].labelIds, ['lbl-kantor', 'lbl-reimburse']);
  assert.deepEqual(dispatchedMcpRecords[0][0].labels, ['kantor', 'reimburse']);
  assert.ok(sentMessages[0].includes('🔖 #kantor #reimburse'));

  sentMessages.length = 0;
  dispatchedMcpRecords.length = 0;
  (mockClient as any).createLabel = async (name: string) => {
    if (name === 'throwing-tag') throw new Error('Wallet MCP tool error');
    return null;
  };
  aiRecordOutput = [{
    accountId: 'acc-bca', amount: -50000, recordDate: '2026-09-11T12:00:00Z', categoryId: 'cat-food',
    note: 'makan siang', labels: ['reimburse-fail'],
  }];
  const failingLabelEvent: IncomingUserMessageEvent = {
    channel: 'whatsapp', senderIdentifier: '+628123456789', chatIdentifier: '+628123456789',
    messageType: 'text', textPayload: 'makan siang 50rb #reimburse-fail',
  };
  await handler.handleIncomingUserMessage(failingLabelEvent);
  assert.equal(dispatchedMcpRecords.length, 1);
  assert.equal(dispatchedMcpRecords[0][0].labelIds, undefined);
  assert.equal(dispatchedMcpRecords[0][0].labels, undefined);
  assert.ok(!sentMessages[0].includes('🔖'));
  assert.ok(!sentMessages[0].includes('#reimburse-fail'));

  sentMessages.length = 0;
  dispatchedMcpRecords.length = 0;
  aiRecordOutput = [{
    accountId: 'acc-bca', amount: -50000, recordDate: '2026-09-11T12:00:00Z', categoryId: 'cat-food',
    note: 'makan siang', labels: ['kantor', 'throwing-tag'],
  }];
  const mixedLabelEvent: IncomingUserMessageEvent = {
    channel: 'whatsapp', senderIdentifier: '+628123456789', chatIdentifier: '+628123456789',
    messageType: 'text', textPayload: 'makan siang 50rb #kantor #throwing-tag',
  };
  await handler.handleIncomingUserMessage(mixedLabelEvent);
  assert.equal(dispatchedMcpRecords.length, 1);
  assert.deepEqual(dispatchedMcpRecords[0][0].labelIds, ['lbl-kantor']);
  assert.deepEqual(dispatchedMcpRecords[0][0].labels, ['kantor']);
  assert.ok(sentMessages[0].includes('🔖 #kantor'));
  assert.ok(!sentMessages[0].includes('#throwing-tag'));
});

test('8. AccountClarificationHandler Label Resolution on Draft Finalization', async () => {
  const dispatchedMcpRecords: CreateRecordInputPayload[][] = [];
  const sentMessages: string[] = [];
  const mockMessagingGateway = {
    sendTypingPresence: async () => {},
    clearTypingPresence: async () => {},
    sendMessage: async (_channel: string, _chatId: string, content: string) => { sentMessages.push(content); },
  };
  const mockPendingService = new PendingTransactionService();
  const mockClient = {
    fetchAccounts: async () => mockAccounts,
    fetchCategories: async () => mockCategories,
    fetchLabels: async () => [{ id: 'lbl-reimburse', name: 'reimburse' }],
    createLabel: async (name: string) => ({ id: `lbl-${name}`, name }),
    createRecords: async (records: CreateRecordInputPayload[]) => {
      dispatchedMcpRecords.push(records);
      return { summary: { total: records.length, succeeded: records.length, failed: 0 } };
    },
    fetchBudgets: async () => [],
  } as unknown as WalletMcpClientService;
  const testCache = new WalletCacheService(mockClient);
  await testCache.initialize();
  const clarificationHandler = new AccountClarificationHandler(
    mockPendingService,
    mockClient,
    testCache,
    mockMessagingGateway as any
  );

  const unresolvedRecord: CreateRecordInputPayload = {
    accountId: '', amount: -50000, recordDate: '2026-09-11T12:00:00Z', note: 'Bensin',
    labels: ['reimburse', 'proyek-baru'],
  };
  const incomingEvent: IncomingUserMessageEvent = {
    channel: 'whatsapp', senderIdentifier: '+628123456789', chatIdentifier: '+628123456789',
    messageType: 'text', textPayload: 'Bensin 50rb #reimburse #proyek-baru',
  };
  await clarificationHandler.createPendingAccountSelectionDraft(
    incomingEvent,
    [unresolvedRecord],
    [{ recordIndex: 0, accountHint: '', reason: 'UNRESOLVED', candidates: [] }],
    mockAccounts,
    mockCategories
  );
  assert.equal(mockPendingService.getAllPendingAccountSelectionDrafts().length, 1);
  const handled = await clarificationHandler.handlePendingAccountSelectionReply(incomingEvent, '1', Date.now());
  assert.equal(handled, true);
  assert.equal(dispatchedMcpRecords.length, 1);
  assert.equal(dispatchedMcpRecords[0][0].accountId, 'acc-bca');
  assert.deepEqual(dispatchedMcpRecords[0][0].labelIds, ['lbl-reimburse', 'lbl-proyek-baru']);
  assert.deepEqual(dispatchedMcpRecords[0][0].labels, ['reimburse', 'proyek-baru']);
  assert.ok(sentMessages[1].includes('🔖 #reimburse #proyek-baru'));

  sentMessages.length = 0;
  dispatchedMcpRecords.length = 0;
  (mockClient as any).createLabel = async () => null;
  const failedDraftRecord: CreateRecordInputPayload = {
    accountId: '', amount: -30000, recordDate: '2026-09-11T12:00:00Z', note: 'Kopi', labels: ['uncreatable-tag'],
  };
  const draftEvent: IncomingUserMessageEvent = {
    channel: 'whatsapp', senderIdentifier: '+628123456789', chatIdentifier: '+628123456789',
    messageType: 'text', textPayload: 'Kopi 30rb #uncreatable-tag',
  };
  await clarificationHandler.createPendingAccountSelectionDraft(
    draftEvent,
    [failedDraftRecord],
    [{ recordIndex: 0, accountHint: '', reason: 'UNRESOLVED', candidates: [] }],
    mockAccounts,
    mockCategories
  );
  const draftHandled = await clarificationHandler.handlePendingAccountSelectionReply(draftEvent, '1', Date.now());
  assert.equal(draftHandled, true);
  assert.equal(dispatchedMcpRecords.length, 1);
  assert.equal(dispatchedMcpRecords[0][0].accountId, 'acc-bca');
  assert.equal(dispatchedMcpRecords[0][0].labelIds, undefined);
  assert.equal(dispatchedMcpRecords[0][0].labels, undefined);
  assert.ok(!sentMessages[1].includes('🔖'));
  assert.ok(!sentMessages[1].includes('#uncreatable-tag'));
});
