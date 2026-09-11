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

  // Merging note hashtags with existing labels without duplicates
  const preLabeledRecord: CreateRecordInputPayload = {
    accountId: 'acc-bca',
    amount: -10_000,
    recordDate: '2026-09-11T10:00:00Z',
    note: 'Kopi #reimburse',
    labels: ['reimburse', 'kantor'],
  };

  const preLabeledValidation = validateAndSanitizeFinancialRecords([preLabeledRecord], mockAccounts, mockCategories);
  assert.equal(preLabeledValidation.isValid, true);
  assert.equal(preLabeledValidation.sanitizedRecords[0].note, 'Kopi');
  assert.deepEqual(preLabeledValidation.sanitizedRecords[0].labels, ['reimburse', 'kantor']);
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

console.log('[SUCCESS] All Hashtag Parsing & Label Auto-Creation tests passed cleanly!');
