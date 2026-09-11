import assert from 'node:assert';
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

console.log('[TEST] Starting Hashtag Parsing and Label Auto-Creation Tests (Issue #20)...');

const mockAccounts: WalletAccountItem[] = [
  { id: 'acc-bca', name: 'BCA', currency: 'IDR' },
  { id: 'acc-cash', name: 'Cash', currency: 'IDR' },
];

const mockCategories: WalletCategoryItem[] = [
  { id: 'cat-food', name: 'Makanan & Minuman' },
  { id: 'cat-travel', name: 'Liburan' },
];

// ---------------------------------------------------------------------------
// 1. Hashtag Parser Unit Tests
// ---------------------------------------------------------------------------
{
  console.log('  [SUITE 1] Hashtag Parser Unit Tests');

  // Single tag extraction
  const singleResult = extractHashtags('Makan siang 50rb #bandung');
  assert.deepEqual(singleResult.tags, ['bandung']);
  assert.equal(singleResult.cleanedText, 'Makan siang 50rb');

  // Multiple tags in different positions
  const multiResult = extractHashtags('Kopi 25rb #reimburse meeting kantor #proyek_a');
  assert.deepEqual(multiResult.tags, ['reimburse', 'proyek_a']);
  assert.equal(multiResult.cleanedText, 'Kopi 25rb meeting kantor');

  // Tags with hyphens
  const hyphenResult = extractHashtags('Tiket bioskop #trip-bali');
  assert.deepEqual(hyphenResult.tags, ['trip-bali']);
  assert.equal(hyphenResult.cleanedText, 'Tiket bioskop');

  // Case-insensitive deduplication
  const dedupResult = extractHashtags('Makan enak #Bandung #bandung #BANDUNG');
  assert.deepEqual(dedupResult.tags, ['Bandung']);
  assert.equal(dedupResult.cleanedText, 'Makan enak');

  // Punctuation adjacent to hashtags
  const punctResult = extractHashtags('Makan (#bandung, #liburan!) bareng teman.');
  assert.deepEqual(punctResult.tags, ['bandung', 'liburan']);
  assert.equal(punctResult.cleanedText, 'Makan bareng teman.');

  // Note containing only hashtags becomes empty string
  const onlyTagsResult = extractHashtags('#bandung #kuliner');
  assert.deepEqual(onlyTagsResult.tags, ['bandung', 'kuliner']);
  assert.equal(onlyTagsResult.cleanedText, '');

  // No hashtags present
  const noTagsResult = extractHashtags('Nasi padang 30rb pake bca');
  assert.deepEqual(noTagsResult.tags, []);
  assert.equal(noTagsResult.cleanedText, 'Nasi padang 30rb pake bca');

  // Non-hashtag tokens: C# or standalone #
  const nonTagResult = extractHashtags('Buku belajar C# harga # murah');
  assert.deepEqual(nonTagResult.tags, []);
  assert.equal(nonTagResult.cleanedText, 'Buku belajar C# harga # murah');

  // Malformed or non-token hash sequences must NOT be recognized or removed
  const malformedResult1 = extractHashtags('Bayar #trip/bali');
  assert.deepEqual(malformedResult1.tags, []);
  assert.equal(malformedResult1.cleanedText, 'Bayar #trip/bali');

  const malformedResult2 = extractHashtags('Tiket #trip/bali dan belanja #oleh-oleh.');
  assert.deepEqual(malformedResult2.tags, ['oleh-oleh']);
  assert.equal(malformedResult2.cleanedText, 'Tiket #trip/bali dan belanja');

  const malformedResult3 = extractHashtags('#123/456 email#domain.com #valid-tag');
  assert.deepEqual(malformedResult3.tags, ['valid-tag']);
  assert.equal(malformedResult3.cleanedText, '#123/456 email#domain.com');

  // normalizeTagName & deduplicateTags helpers
  assert.equal(normalizeTagName('#reimburse'), 'reimburse');
  assert.equal(normalizeTagName('###tag'), 'tag');
  assert.deepEqual(deduplicateTags(['#alpha', 'Alpha', 'ALPHA', '#beta']), ['alpha', 'beta']);
}

// ---------------------------------------------------------------------------
// 2. Record Validator Sanitization & Note Cleaning
// ---------------------------------------------------------------------------
{
  console.log('  [SUITE 2] Record Validator Sanitization & Note Cleaning');

  // Hashtags in note are extracted and stripped from note
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

  // Note with only hashtags results in note: undefined
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

  // Merging note hashtags with existing labels without duplicates when explicit hashtags are present
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

  // Discard AI-invented labels that do not appear as explicit hashtags in input
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

  // Discard AI-supplied labelIds at the validation boundary
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
}

// ---------------------------------------------------------------------------
// 3. Label Resolution, Caching & MCP Auto-Creation
// ---------------------------------------------------------------------------
{
  console.log('  [SUITE 3] Label Resolution, Caching & MCP Auto-Creation');

  const initialLabels: WalletLabelItem[] = [
    { id: 'lbl-bandung', name: 'bandung' },
    { id: 'lbl-reimburse', name: 'Reimburse' },
  ];

  const createdCalls: string[] = [];

  const mockMcpClient = {
    fetchLabels: async () => initialLabels,
    createLabel: async (name: string) => {
      createdCalls.push(name);
      if (name === 'fail-create') {
        throw new Error('MCP creation failed');
      }
      if (name === 'unsupported') {
        return null;
      }
      return { id: `lbl-${name.toLowerCase()}`, name };
    },
  } as unknown as WalletMcpClientService;

  const mockCacheService = new WalletCacheService(mockMcpClient);
  // Seed cache manually
  for (const label of initialLabels) {
    mockCacheService.addLabelToCache(label);
  }
  mockCacheService.setLabelsLoaded(true);

  // A: Reuse existing label case-insensitively
  const existingResolveResult = await resolveAndEnsureLabels(
    ['#BANDUNG', 'reimburse'],
    mockCacheService,
    mockMcpClient
  );
  assert.deepEqual(existingResolveResult.resolvedLabelIds, ['lbl-bandung', 'lbl-reimburse']);
  assert.deepEqual(existingResolveResult.resolvedLabelNames, ['bandung', 'Reimburse']);
  assert.equal(createdCalls.length, 0, 'Should not call createLabel for existing labels');

  // B: Auto-create missing label
  const newResolveResult = await resolveAndEnsureLabels(
    ['liburan'],
    mockCacheService,
    mockMcpClient
  );
  assert.deepEqual(newResolveResult.resolvedLabelIds, ['lbl-liburan']);
  assert.deepEqual(newResolveResult.resolvedLabelNames, ['liburan']);
  assert.equal(createdCalls.length, 1);
  assert.equal(createdCalls[0], 'liburan');

  // Verify label was added to cache
  const cachedLiburan = mockCacheService.findLabelByName('LIBURAN');
  assert.ok(cachedLiburan);
  assert.equal(cachedLiburan?.id, 'lbl-liburan');

  // C: Graceful fallback when createLabel returns null
  const unsupportedResult = await resolveAndEnsureLabels(
    ['unsupported'],
    mockCacheService,
    mockMcpClient
  );
  assert.deepEqual(unsupportedResult.resolvedLabelIds, [], 'Unsupported label should have no ID');
  assert.deepEqual(unsupportedResult.resolvedLabelNames, ['unsupported']);

  // D: Graceful fallback when createLabel throws
  const failedResult = await resolveAndEnsureLabels(
    ['fail-create'],
    mockCacheService,
    mockMcpClient
  );
  assert.deepEqual(failedResult.resolvedLabelIds, [], 'Failed label should have no ID');
  assert.deepEqual(failedResult.resolvedLabelNames, ['fail-create']);

  // E: Cold-start read failure followed by successful refresh reconciling existing label
  // First fetchLabels failed, so cache is empty and not loaded
  let getLabelsCallCount = 0;
  const createLabelCallsE: string[] = [];

  const mockMcpClientE = {
    fetchAccounts: async () => [],
    fetchCategories: async () => [],
    fetchLabels: async () => {
      getLabelsCallCount++;
      if (getLabelsCallCount === 1) {
        throw new Error('Timeout fetching labels on cold start');
      }
      return [{ id: 'lbl-reimburse', name: 'reimburse' }];
    },
    createLabel: async (name: string) => {
      createLabelCallsE.push(name);
      return { id: `lbl-${name}`, name };
    },
  } as unknown as WalletMcpClientService;

  const coldStartCache = new WalletCacheService(mockMcpClientE);
  // initialize fails to fetch labels
  await coldStartCache.initialize();
  assert.equal(coldStartCache.isLabelsLoaded(), false, 'Cache should mark labels as not loaded after failure');
  assert.equal(coldStartCache.getLabels().length, 0);

  // User message arrives with #reimburse; resolver must refresh, find existing, and NEVER call createLabel
  const reconciledResult = await resolveAndEnsureLabels(
    ['reimburse'],
    coldStartCache,
    mockMcpClientE
  );
  assert.deepEqual(reconciledResult.resolvedLabelIds, ['lbl-reimburse']);
  assert.deepEqual(reconciledResult.resolvedLabelNames, ['reimburse']);
  assert.equal(createLabelCallsE.length, 0, 'Must reuse existing label and NEVER call createLabel on read recovery');
  assert.equal(coldStartCache.isLabelsLoaded(), true, 'Cache should now be marked as loaded');

  // F: Persistent read failure must NEVER trigger createLabel
  const createLabelCallsF: string[] = [];
  const persistentFailMcpClient = {
    fetchAccounts: async () => [],
    fetchCategories: async () => [],
    fetchLabels: async () => {
      throw new Error('Persistent network error');
    },
    createLabel: async (name: string) => {
      createLabelCallsF.push(name);
      return { id: `lbl-${name}`, name };
    },
  } as unknown as WalletMcpClientService;

  const failCache = new WalletCacheService(persistentFailMcpClient);
  await failCache.initialize();

  const failResult = await resolveAndEnsureLabels(
    ['kantor'],
    failCache,
    persistentFailMcpClient
  );
  assert.deepEqual(failResult.resolvedLabelIds, [], 'Unverified label must have no ID');
  assert.deepEqual(failResult.resolvedLabelNames, ['kantor']);
  assert.equal(createLabelCallsF.length, 0, 'Persistent read failure must NEVER trigger createLabel');
}

// ---------------------------------------------------------------------------
// 4. Human-Facing Success Message Formatting with Labels
// ---------------------------------------------------------------------------
{
  console.log('  [SUITE 4] Human-Facing Success Message Formatting with Labels');

  // Indonesian single record with labels
  const singleRecordWithLabels: CreateRecordInputPayload = {
    accountId: 'acc-bca',
    amount: -75_000,
    recordDate: '2026-09-11T12:00:00Z',
    note: 'Makan bersama',
    categoryId: 'cat-food',
    labels: ['bandung', 'liburan'],
  };

  const idMessage = formatRecordSuccessMessage(
    [singleRecordWithLabels],
    mockAccounts,
    mockCategories,
    'id'
  );

  assert.ok(idMessage.includes('Makan bersama') && idMessage.includes('berhasil dicatat!'));
  assert.ok(idMessage.includes('🔖 #bandung #liburan'));

  // English single record with labels
  const enMessage = formatRecordSuccessMessage(
    [singleRecordWithLabels],
    mockAccounts,
    mockCategories,
    'en'
  );

  assert.ok(enMessage.includes('recorded successfully!'));
  assert.ok(enMessage.includes('🔖 #bandung #liburan'));

  // Multi-record with labels
  const multiRecordWithLabels: CreateRecordInputPayload[] = [
    {
      accountId: 'acc-bca',
      amount: -50_000,
      recordDate: '2026-09-11T12:00:00Z',
      note: 'Makan',
      categoryId: 'cat-food',
      labels: ['kuliner'],
    },
    {
      accountId: 'acc-cash',
      amount: -20_000,
      recordDate: '2026-09-11T12:00:00Z',
      note: 'Ojek',
      categoryId: 'cat-travel',
      labels: ['transport'],
    },
  ];

  const multiIdMessage = formatRecordSuccessMessage(
    multiRecordWithLabels,
    mockAccounts,
    mockCategories,
    'id'
  );

  assert.ok(multiIdMessage.includes('2 transaksi') && multiIdMessage.includes('berhasil dicatat!'));
  assert.ok(multiIdMessage.includes('🔖 #kuliner'));
  assert.ok(multiIdMessage.includes('🔖 #transport'));

  // Record without labels preserves standard output without 🔖
  const noLabelRecord: CreateRecordInputPayload = {
    accountId: 'acc-bca',
    amount: -15_000,
    recordDate: '2026-09-11T12:00:00Z',
    note: 'Parkir',
  };

  const noLabelMessage = formatRecordSuccessMessage(
    [noLabelRecord],
    mockAccounts,
    mockCategories,
    'id'
  );
  assert.ok(!noLabelMessage.includes('🔖'));
}

// ---------------------------------------------------------------------------
// 5. End-to-End Record Payload Generation with labelIds
// ---------------------------------------------------------------------------
{
  console.log('  [SUITE 5] End-to-End Record Payload Generation with labelIds');

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

  // Simulating user input with hashtags
  const userInputNote = 'Kopi kenangan 28rb #reimburse #kantor';
  const rawRecord: CreateRecordInputPayload = {
    accountId: 'acc-bca',
    amount: -28_000,
    recordDate: '2026-09-11T10:00:00Z',
    note: userInputNote,
  };

  const validation = validateAndSanitizeFinancialRecords([rawRecord], mockAccounts, mockCategories);
  assert.equal(validation.isValid, true);
  const validatedRecord = validation.sanitizedRecords[0];

  assert.equal(validatedRecord.note, 'Kopi kenangan 28rb');
  assert.deepEqual(validatedRecord.labels, ['reimburse', 'kantor']);

  // Resolve labels
  const { resolvedLabelIds, resolvedLabelNames } = await resolveAndEnsureLabels(
    validatedRecord.labels!,
    cache,
    mockClient
  );

  validatedRecord.labelIds = resolvedLabelIds;
  validatedRecord.labels = resolvedLabelNames;

  assert.deepEqual(validatedRecord.labelIds, ['lbl-reimburse', 'lbl-kantor']);
  assert.deepEqual(validatedRecord.labels, ['reimburse', 'kantor']);

  // Dispatch to MCP
  await mockClient.createRecords([validatedRecord]);

  assert.equal(dispatchedRecordsPayload.length, 1);
  assert.deepEqual(dispatchedRecordsPayload[0].labelIds, ['lbl-reimburse', 'lbl-kantor']);
  assert.equal(dispatchedRecordsPayload[0].note, 'Kopi kenangan 28rb');
}

// ---------------------------------------------------------------------------
// 6. WalletMcpClientService & WalletCacheService Label Integration
// ---------------------------------------------------------------------------
{
  console.log('  [SUITE 6] WalletMcpClientService & WalletCacheService Label Integration');

  const realMcpClient = new WalletMcpClientService('http://localhost:8080');

  // Stub callMcpTool to test fetchLabels parsing varieties
  let mockToolResponse: unknown = [
    { id: 'lbl-1', name: 'makan', color: '#ff0000', icon: 'food' },
    { labelId: 'lbl-2', labelName: 'transport', color: '#00ff00', icon: 'car' },
    { id: '', name: 'invalid-empty-id' }, // should be filtered out
  ];

  realMcpClient.callMcpTool = async (toolName: string, _args: Record<string, unknown> = {}) => {
    if (toolName === 'get_labels') {
      return mockToolResponse as any;
    }
    if (toolName === 'create_label') {
      return mockToolResponse as any;
    }
    if (toolName === 'create_records') {
      return { summary: { total: 1, succeeded: 1, failed: 0 } } as any;
    }
    return {} as any;
  };

  // Test fetchLabels with raw array
  const fetchedLabels = await realMcpClient.fetchLabels(true);
  assert.equal(fetchedLabels.length, 2);
  assert.equal(fetchedLabels[0].id, 'lbl-1');
  assert.equal(fetchedLabels[0].name, 'makan');
  assert.equal(fetchedLabels[0].color, '#ff0000');
  assert.equal(fetchedLabels[1].id, 'lbl-2');
  assert.equal(fetchedLabels[1].name, 'transport');

  // Test fetchLabels cache hit
  let callToolInvoked = false;
  const originalCallMcp = realMcpClient.callMcpTool;
  realMcpClient.callMcpTool = async (toolName: string, args: Record<string, unknown> = {}) => {
    callToolInvoked = true;
    return originalCallMcp(toolName, args);
  };
  const cachedLabels = await realMcpClient.fetchLabels(false);
  assert.equal(callToolInvoked, false, 'Should return cached labels without calling MCP');
  assert.equal(cachedLabels.length, 2);
  realMcpClient.callMcpTool = originalCallMcp;

  // Test fetchLabels with wrapped object response ({ labels: [...] })
  mockToolResponse = {
    labels: [
      { id: 'lbl-3', title: 'proyek' },
    ],
  };
  const wrappedLabels = await realMcpClient.fetchLabels(true);
  assert.equal(wrappedLabels.length, 1);
  assert.equal(wrappedLabels[0].id, 'lbl-3');
  assert.equal(wrappedLabels[0].name, 'proyek');

  // Test fetchLabels error handling (rethrow error on tool failure so caller knows read failed)
  realMcpClient.callMcpTool = async (toolName: string) => {
    if (toolName === 'get_labels') {
      throw new Error('Network timeout');
    }
    return {} as any;
  };
  await assert.rejects(
    async () => realMcpClient.fetchLabels(true),
    /Network timeout/,
    'fetchLabels should rethrow error when tool call fails'
  );

  // Test createLabel with empty name
  const emptyResult = await realMcpClient.createLabel('  #   ');
  assert.equal(emptyResult, null, 'Empty label name should return null');

  // Test createLabel with valid response
  mockToolResponse = { id: 'lbl-new', name: 'investasi' };
  realMcpClient.callMcpTool = async () => mockToolResponse as any;
  const createdLabel = await realMcpClient.createLabel('#investasi');
  assert.ok(createdLabel);
  assert.equal(createdLabel?.id, 'lbl-new');
  assert.equal(createdLabel?.name, 'investasi');

  // Test createLabel with wrapped response ({ label: { id, name } })
  mockToolResponse = { label: { labelId: 'lbl-wrap', name: 'wrapped' } };
  const wrappedCreatedLabel = await realMcpClient.createLabel('wrapped');
  assert.ok(wrappedCreatedLabel);
  assert.equal(wrappedCreatedLabel?.id, 'lbl-wrap');

  // Test createLabel updates existing entry in cachedLabelList
  mockToolResponse = { id: 'lbl-wrap', name: 'wrapped-updated', color: '#123456' };
  const updatedCreatedLabel = await realMcpClient.createLabel('wrapped');
  assert.ok(updatedCreatedLabel);
  assert.equal(updatedCreatedLabel?.name, 'wrapped-updated');

  // Test createLabel when tool returns invalid payload (no id)
  mockToolResponse = { success: true };
  const invalidResult = await realMcpClient.createLabel('invalid');
  assert.equal(invalidResult, null);

  // Test createLabel when tool throws
  realMcpClient.callMcpTool = async () => {
    throw new Error('Not implemented');
  };
  const throwingResult = await realMcpClient.createLabel('throwing');
  assert.equal(throwingResult, null);

  // Test createRecords preserving labelIds
  let capturedRecordsPayload: any[] = [];
  realMcpClient.callMcpTool = async (toolName: string, args: Record<string, unknown> = {}) => {
    if (toolName === 'create_records') {
      capturedRecordsPayload = args.records as any[];
      return { summary: { total: 1, succeeded: 1, failed: 0 } };
    }
    return {};
  };
  await realMcpClient.createRecords([
    {
      accountId: 'acc-bca',
      amount: -10000,
      recordDate: '2026-09-11T10:00:00Z',
      labelIds: ['lbl-1', 'lbl-2'],
      note: 'test note',
    },
  ]);
  assert.equal(capturedRecordsPayload.length, 1);
  assert.deepEqual(capturedRecordsPayload[0].labelIds, ['lbl-1', 'lbl-2']);

  // Test WalletCacheService label methods
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

  assert.equal(realCacheService.isLabelsLoaded(), true, 'isLabelsLoaded should be true after successful initialize');
  assert.equal(realCacheService.getLabels().length, 2);
  const foundById = realCacheService.findLabelById('lbl-cache-1');
  assert.equal(foundById?.name, 'Keluarga');
  const notFoundById = realCacheService.findLabelById('lbl-nonexistent');
  assert.equal(notFoundById, undefined);

  const foundByName = realCacheService.findLabelByName('keluarga');
  assert.equal(foundByName?.id, 'lbl-cache-1');
  const foundByHashName = realCacheService.findLabelByName('#GADGET');
  assert.equal(foundByHashName?.id, 'lbl-cache-2');

  // Test setLabelsLoaded helper
  realCacheService.setLabelsLoaded(false);
  assert.equal(realCacheService.isLabelsLoaded(), false);
  realCacheService.setLabelsLoaded(true);
  assert.equal(realCacheService.isLabelsLoaded(), true);

  // Test addLabelToCache (new & update)
  realCacheService.addLabelToCache({ id: 'lbl-cache-3', name: 'Hiburan' });
  assert.equal(realCacheService.findLabelByName('hiburan')?.id, 'lbl-cache-3');
  realCacheService.addLabelToCache({ id: 'lbl-cache-3', name: 'Hiburan-Updated' });
  assert.equal(realCacheService.findLabelById('lbl-cache-3')?.name, 'Hiburan-Updated');

  // Test refreshLabels
  mockToolResponse = [{ id: 'lbl-refreshed', name: 'Refreshed' }];
  const refreshedList = await realCacheService.refreshLabels();
  assert.equal(refreshedList.length, 1);
  assert.equal(refreshedList[0].id, 'lbl-refreshed');
  assert.equal(realCacheService.isLabelsLoaded(), true);

  // Test refreshLabels failure marks isLabelsLoaded = false and rethrows
  realMcpClient.callMcpTool = async (toolName: string) => {
    if (toolName === 'get_labels') throw new Error('Refresh error');
    return {};
  };
  await assert.rejects(async () => realCacheService.refreshLabels(), /Refresh error/);
  assert.equal(realCacheService.isLabelsLoaded(), false);
}

// ---------------------------------------------------------------------------
// 7. UserMessageHandler Hashtag Fallback & Label Resolution
// ---------------------------------------------------------------------------
{
  console.log('  [SUITE 7] UserMessageHandler Hashtag Fallback & Label Resolution');

  const dispatchedMcpRecords: CreateRecordInputPayload[][] = [];
  const sentMessages: string[] = [];

  const mockMessagingGateway = {
    sendTypingPresence: async () => {},
    clearTypingPresence: async () => {},
    sendMessage: async (_channel: string, _chatId: string, content: string) => {
      sentMessages.push(content);
    },
  };

  const mockPendingService = new PendingTransactionService();
  const mockPendingActionHandler = {
    handlePendingAction: async () => false,
  };
  const mockFastPathHandler = {
    handleFastPath: async () => false,
  };

  let aiRecordOutput: CreateRecordInputPayload[] = [];
  const mockAiProvider = {
    providerName: 'mock',
    processTextMessage: async () => ({
      action: 'CREATE_RECORD',
      explanation: 'Expense parsed',
      records: aiRecordOutput,
    }),
  };

  const testLabels: WalletLabelItem[] = [
    { id: 'lbl-kantor', name: 'kantor' },
  ];

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

  const userMessageHandler = new UserMessageHandler(
    mockMessagingGateway as any,
    mockPendingService as any,
    mockPendingActionHandler as any,
    mockFastPathHandler as any,
    mockAiProvider as any,
    testCache,
    mockClient
  );

  // Scenario A: Single record where AI didn't include labels, but user message has hashtag
  aiRecordOutput = [
    {
      accountId: 'acc-bca',
      amount: -25000,
      recordDate: '2026-09-11T12:00:00Z',
      categoryId: 'cat-food',
      note: 'Kopi siang',
      // labels intentionally omitted to trigger user message fallback
    },
  ];

  const incomingEvent: IncomingUserMessageEvent = {
    channel: 'whatsapp',
    senderIdentifier: '+628123456789',
    chatIdentifier: '+628123456789',
    messageType: 'text',
    textPayload: 'Kopi siang 25rb #kantor',
  };

  await userMessageHandler.handleIncomingUserMessage(incomingEvent);

  assert.equal(dispatchedMcpRecords.length, 1);
  const createdRecord = dispatchedMcpRecords[0][0];
  assert.deepEqual(createdRecord.labelIds, ['lbl-kantor']);
  assert.deepEqual(createdRecord.labels, ['kantor']);
  assert.ok(sentMessages[0].includes('🔖 #kantor'));

  // Scenario B: Multi-record with existing and newly created labels
  sentMessages.length = 0;
  dispatchedMcpRecords.length = 0;
  aiRecordOutput = [
    {
      accountId: 'acc-bca',
      amount: -15000,
      recordDate: '2026-09-11T12:00:00Z',
      categoryId: 'cat-food',
      note: 'Snack #kantor',
      labels: ['kantor'],
    },
    {
      accountId: 'acc-cash',
      amount: -30000,
      recordDate: '2026-09-11T12:00:00Z',
      categoryId: 'cat-food',
      note: 'Makan #liburan',
      labels: ['liburan'], // 'liburan' is not in cache yet, will be auto-created
    },
  ];

  const multiEvent: IncomingUserMessageEvent = {
    channel: 'whatsapp',
    senderIdentifier: '+628123456789',
    chatIdentifier: '+628123456789',
    messageType: 'text',
    textPayload: 'Snack 15rb #kantor, Makan 30rb #liburan',
  };

  await userMessageHandler.handleIncomingUserMessage(multiEvent);

  assert.equal(dispatchedMcpRecords.length, 1);
  const multiRecords = dispatchedMcpRecords[0];
  assert.equal(multiRecords.length, 2);
  assert.deepEqual(multiRecords[0].labelIds, ['lbl-kantor']);
  assert.deepEqual(multiRecords[1].labelIds, ['lbl-liburan']);
  assert.ok(sentMessages[0].includes('🔖 #kantor'));
  assert.ok(sentMessages[0].includes('🔖 #liburan'));

  // Scenario C: Message contains no #, but mock AI output contains labels: ['bandung'] and arbitrary labelIds
  sentMessages.length = 0;
  dispatchedMcpRecords.length = 0;
  let createLabelCallsCount = 0;
  (mockClient as any).createLabel = async (name: string) => {
    createLabelCallsCount++;
    return { id: `lbl-${name}`, name };
  };

  aiRecordOutput = [
    {
      accountId: 'acc-bca',
      amount: -50000,
      recordDate: '2026-09-11T12:00:00Z',
      categoryId: 'cat-food',
      note: 'makan di Bandung',
      labels: ['bandung'],
      labelIds: ['lbl-injected-id'],
    } as any,
  ];

  const noHashEvent: IncomingUserMessageEvent = {
    channel: 'whatsapp',
    senderIdentifier: '+628123456789',
    chatIdentifier: '+628123456789',
    messageType: 'text',
    textPayload: 'makan di Bandung 50rb',
  };

  await userMessageHandler.handleIncomingUserMessage(noHashEvent);

  assert.equal(createLabelCallsCount, 0, 'createLabel() must never be called when input has no explicit #');
  assert.equal(dispatchedMcpRecords.length, 1);
  const outboundRecordNoHash = dispatchedMcpRecords[0][0];
  assert.equal(outboundRecordNoHash.labels, undefined, 'Outbound record must have no label when input has no explicit #');
  assert.equal(outboundRecordNoHash.labelIds, undefined, 'Outbound record must have no labelIds from raw AI JSON');
  assert.ok(!sentMessages[0].includes('🔖'), 'Confirmation reply must not show label icon when no explicit tag was present');
}

// ---------------------------------------------------------------------------
// 8. AccountClarificationHandler Label Resolution on Draft Finalization
// ---------------------------------------------------------------------------
{
  console.log('  [SUITE 8] AccountClarificationHandler Label Resolution on Draft Finalization');

  const dispatchedMcpRecords: CreateRecordInputPayload[][] = [];
  const sentMessages: string[] = [];

  const mockMessagingGateway = {
    sendTypingPresence: async () => {},
    clearTypingPresence: async () => {},
    sendMessage: async (_channel: string, _chatId: string, content: string) => {
      sentMessages.push(content);
    },
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

  // Draft with missing account but having labels
  const unresolvedRecord: CreateRecordInputPayload = {
    accountId: '', // missing, requires clarification
    amount: -50000,
    recordDate: '2026-09-11T12:00:00Z',
    note: 'Bensin',
    labels: ['reimburse', 'proyek-baru'], // 'reimburse' in cache, 'proyek-baru' to auto-create
  };

  const incomingEvent: IncomingUserMessageEvent = {
    channel: 'whatsapp',
    senderIdentifier: '+628123456789',
    chatIdentifier: '+628123456789',
    messageType: 'text',
    textPayload: 'Bensin 50rb #reimburse #proyek-baru',
  };

  await clarificationHandler.createPendingAccountSelectionDraft(
    incomingEvent,
    [unresolvedRecord],
    [{ recordIndex: 0, accountHint: '', reason: 'UNRESOLVED', candidates: [] }],
    mockAccounts,
    mockCategories
  );

  assert.equal(mockPendingService.getAllPendingAccountSelectionDrafts().length, 1);

  // User selects option 1 (BCA)
  const handled = await clarificationHandler.handlePendingAccountSelectionReply(
    incomingEvent,
    '1',
    Date.now()
  );

  assert.equal(handled, true);
  assert.equal(dispatchedMcpRecords.length, 1);
  const finalizedRecord = dispatchedMcpRecords[0][0];
  assert.equal(finalizedRecord.accountId, 'acc-bca');
  assert.deepEqual(finalizedRecord.labelIds, ['lbl-reimburse', 'lbl-proyek-baru']);
  assert.deepEqual(finalizedRecord.labels, ['reimburse', 'proyek-baru']);
  assert.ok(sentMessages[1].includes('🔖 #reimburse #proyek-baru'));
}

console.log('[SUCCESS] All Hashtag Parsing & Label Auto-Creation tests passed cleanly!');

