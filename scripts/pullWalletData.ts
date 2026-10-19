import fs from 'node:fs';
import path from 'node:path';
import { loadEnvironmentConfiguration } from '../src/config/environmentConfig.js';
import { WalletMcpClientService } from '../src/services/walletMcpService.js';
import { WalletCacheService } from '../src/services/walletCacheService.js';
import { TransactionHistoryService } from '../src/services/transactionHistoryService.js';
import { WalletRecordItem, WalletAccountItem, WalletBudgetItem } from '../src/types/walletTypes.js';

interface CompactTransactionRecord {
  recordId: string;
  recordDate: string;
  amount: number;
  currency: string;
  recordType: 'expense' | 'income' | 'transfer';
  categoryName: string;
  categoryGroup?: string;
  accountName: string;
  counterParty: string;
  note: string;
}

interface FinancialHealthSnapshotPayload {
  metadata: {
    generatedAt: string;
    referenceDate: string;
    currentYear: number;
    currentMonth: number;
    dayOfMonth: number;
    totalDaysInMonth: number;
    remainingDaysInMonth: number;
  };
  liquidAccounts: {
    accounts: WalletAccountItem[];
    totalLiquidBalanceIdr: number;
    currencyBalances: Record<string, number>;
  };
  activeBudgets: WalletBudgetItem[];
  transactionRecords: {
    thisMonth: CompactTransactionRecord[];
    lastMonth: CompactTransactionRecord[];
  };
  userCategoryContext?: Record<string, unknown>;
}

function parseCommandLineArguments(): { referenceDate: Date; outputFilePath: string } {
  const argumentList = process.argv.slice(2);
  let parsedReferenceDate = new Date();
  let customOutputFilePath = path.resolve(process.cwd(), 'data', 'financial_health_snapshot.json');

  for (let argumentIndex = 0; argumentIndex < argumentList.length; argumentIndex += 1) {
    const argumentToken = argumentList[argumentIndex];

    if (argumentToken.startsWith('--date=')) {
      const dateStringValue = argumentToken.replace('--date=', '').trim();
      const candidateDate = new Date(dateStringValue);
      if (!Number.isNaN(candidateDate.getTime())) {
        parsedReferenceDate = candidateDate;
      }
    } else if (argumentToken === '--date' && argumentList[argumentIndex + 1]) {
      const candidateDate = new Date(argumentList[argumentIndex + 1].trim());
      if (!Number.isNaN(candidateDate.getTime())) {
        parsedReferenceDate = candidateDate;
      }
      argumentIndex += 1;
    } else if (argumentToken.startsWith('--output=')) {
      customOutputFilePath = path.resolve(process.cwd(), argumentToken.replace('--output=', '').trim());
    } else if (argumentToken === '--output' && argumentList[argumentIndex + 1]) {
      customOutputFilePath = path.resolve(process.cwd(), argumentList[argumentIndex + 1].trim());
      argumentIndex += 1;
    }
  }

  return {
    referenceDate: parsedReferenceDate,
    outputFilePath: customOutputFilePath,
  };
}

async function fetchAllTransactionsForPeriod(
  transactionHistoryService: TransactionHistoryService,
  datePeriodName: 'this_month' | 'last_month',
  referenceDate: Date
): Promise<WalletRecordItem[]> {
  const accumulatedRecords: WalletRecordItem[] = [];
  let currentPageNumber = 1;
  const maximumPageLimit = 50;

  while (currentPageNumber <= maximumPageLimit) {
    const historyPageResult = await transactionHistoryService.getTransactionHistory(
      {
        datePeriod: datePeriodName,
        limit: 50,
        page: currentPageNumber,
        sort: 'newest',
      },
      referenceDate
    );

    accumulatedRecords.push(...historyPageResult.records);

    if (!historyPageResult.hasMore || historyPageResult.records.length === 0) {
      break;
    }

    currentPageNumber += 1;
  }

  return accumulatedRecords;
}

function mapToCompactTransactionRecord(sourceRecord: WalletRecordItem): CompactTransactionRecord {
  return {
    recordId: sourceRecord.id,
    recordDate: sourceRecord.recordDate,
    amount: sourceRecord.amount,
    currency: sourceRecord.currency || 'IDR',
    recordType: sourceRecord.recordType,
    categoryName: sourceRecord.category?.name || 'Uncategorized',
    categoryGroup: sourceRecord.category?.group?.name,
    accountName: sourceRecord.accountName || sourceRecord.accountId || 'Unknown Account',
    counterParty: sourceRecord.counterParty || '',
    note: sourceRecord.note || '',
  };
}

async function runFinancialDataPull(): Promise<void> {
  const { referenceDate, outputFilePath } = parseCommandLineArguments();

  console.log('[INFO] Initializing Wallet MCP Financial Data Puller...');
  console.log(`[INFO] Reference Evaluation Date: ${referenceDate.toISOString().slice(0, 10)}`);

  let environmentConfig: ReturnType<typeof loadEnvironmentConfiguration>;
  try {
    environmentConfig = loadEnvironmentConfiguration();
  } catch (configError: unknown) {
    const errorMessage = configError instanceof Error ? configError.message : String(configError);
    console.error(`[ERROR] Configuration failed to load: ${errorMessage}`);
    process.exitCode = 1;
    return;
  }

  if (!environmentConfig.walletMcpAccessToken) {
    console.error('[ERROR] WALLET_MCP_ACCESS_TOKEN is missing in .env configuration');
    process.exitCode = 1;
    return;
  }

  const walletMcpClient = new WalletMcpClientService(
    environmentConfig.walletMcpBaseUrl,
    environmentConfig.walletMcpAccessToken
  );
  const walletCacheService = new WalletCacheService(walletMcpClient);
  const transactionHistoryService = new TransactionHistoryService(walletMcpClient, walletCacheService);

  try {
    console.log('[INFO] Initializing wallet metadata cache (accounts, categories, labels)...');
    await walletCacheService.initialize();

    console.log('[INFO] Fetching real-time account balances...');
    const accountList = await walletMcpClient.fetchAccounts(true);

    const currencyBalanceMap: Record<string, number> = {};
    let totalLiquidBalanceIdr = 0;

    for (const accountItem of accountList) {
      const accountCurrency = (accountItem.currency || 'IDR').toUpperCase();
      const accountBalanceValue = accountItem.balance || 0;
      currencyBalanceMap[accountCurrency] = (currencyBalanceMap[accountCurrency] || 0) + accountBalanceValue;

      if (accountCurrency === 'IDR') {
        totalLiquidBalanceIdr += accountBalanceValue;
      }
    }

    console.log('[INFO] Fetching active budget limits...');
    const budgetList = await walletMcpClient.fetchBudgets(true);

    console.log('[INFO] Fetching transaction records for this month (MTD)...');
    const thisMonthRawRecords = await fetchAllTransactionsForPeriod(
      transactionHistoryService,
      'this_month',
      referenceDate
    );

    console.log('[INFO] Fetching transaction records for last month...');
    const lastMonthRawRecords = await fetchAllTransactionsForPeriod(
      transactionHistoryService,
      'last_month',
      referenceDate
    );

    const referenceYear = referenceDate.getFullYear();
    const referenceMonthOneIndexed = referenceDate.getMonth() + 1;
    const currentDayOfMonth = referenceDate.getDate();
    const totalDaysInMonth = new Date(referenceYear, referenceMonthOneIndexed, 0).getDate();
    const remainingDaysInMonth = Math.max(0, totalDaysInMonth - currentDayOfMonth);

    let loadedCategoryContextData: Record<string, unknown> | undefined;
    const categoryContextFilePath = path.resolve(process.cwd(), 'config', 'category-context.json');
    if (fs.existsSync(categoryContextFilePath)) {
      try {
        const rawJsonContent = fs.readFileSync(categoryContextFilePath, 'utf8');
        loadedCategoryContextData = JSON.parse(rawJsonContent) as Record<string, unknown>;
        console.log('[INFO] Loaded user category context overrides from config/category-context.json');
      } catch {
        console.log('[WARN] Failed to parse config/category-context.json. Proceeding without overrides.');
      }
    }

    const snapshotPayload: FinancialHealthSnapshotPayload = {
      metadata: {
        generatedAt: new Date().toISOString(),
        referenceDate: referenceDate.toISOString().slice(0, 10),
        currentYear: referenceYear,
        currentMonth: referenceMonthOneIndexed,
        dayOfMonth: currentDayOfMonth,
        totalDaysInMonth,
        remainingDaysInMonth,
      },
      liquidAccounts: {
        accounts: accountList,
        totalLiquidBalanceIdr,
        currencyBalances: currencyBalanceMap,
      },
      activeBudgets: budgetList,
      transactionRecords: {
        thisMonth: thisMonthRawRecords.map(mapToCompactTransactionRecord),
        lastMonth: lastMonthRawRecords.map(mapToCompactTransactionRecord),
      },
      userCategoryContext: loadedCategoryContextData,
    };

    const targetOutputDirectory = path.dirname(outputFilePath);
    if (!fs.existsSync(targetOutputDirectory)) {
      fs.mkdirSync(targetOutputDirectory, { recursive: true });
    }

    fs.writeFileSync(outputFilePath, JSON.stringify(snapshotPayload, null, 2), 'utf8');

    console.log('----------------------------------------------------');
    console.log('[SUCCESS] Financial data snapshot successfully generated:');
    console.log(`  - Target file: ${outputFilePath}`);
    console.log(`  - Accounts found: ${accountList.length} (Total Liquid IDR: Rp ${totalLiquidBalanceIdr.toLocaleString('id-ID')})`);
    console.log(`  - Active budgets: ${budgetList.length}`);
    console.log(`  - This month records: ${thisMonthRawRecords.length}`);
    console.log(`  - Last month records: ${lastMonthRawRecords.length}`);
    console.log(`  - Days remaining in month: ${remainingDaysInMonth} day(s)`);
    console.log('----------------------------------------------------');
  } catch (executionError: unknown) {
    const errorMessage = executionError instanceof Error ? executionError.message : String(executionError);
    console.error(`[ERROR] Financial data retrieval failed: ${errorMessage}`);
    process.exitCode = 1;
  } finally {
    await walletMcpClient.close();
  }
}

runFinancialDataPull().catch(fatalError => {
  console.error('[ERROR] Unexpected fatal error occurred:', fatalError);
  process.exitCode = 1;
});
