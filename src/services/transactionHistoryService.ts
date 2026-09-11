import { WalletMcpClientService } from './walletMcpService.js';
import { WalletCacheService } from './walletCacheService.js';
import {
  TransactionHistoryQueryOptions,
  TransactionHistoryPage,
  WalletRecordItem,
} from '../types/walletTypes.js';
import { normalizeTransactionHistoryFilters } from '../utils/transactionHistoryFilterNormalizer.js';
import { applicationLogger } from '../utils/logger.js';

export class TransactionHistoryService {
  constructor(
    private readonly walletMcpClient: WalletMcpClientService,
    private readonly walletCacheService?: WalletCacheService
  ) {}

  /**
   * Retrieves transaction history records with composable filters, pagination, and sorting.
   * Enforces fail-closed validation on invalid filters and enriches missing entity names from cache.
   */
  public async getTransactionHistory(
    queryOptions?: TransactionHistoryQueryOptions,
    referenceDate: Date = new Date()
  ): Promise<TransactionHistoryPage> {
    applicationLogger.fileDetail('mcp', 'Retrieving Transaction History', {
      queryOptions: queryOptions ?? {},
      referenceDate: referenceDate.toISOString(),
    });

    const cachedAccountList = this.walletCacheService?.getAccounts() || [];
    const cachedCategoryList = this.walletCacheService?.getCategories() || [];

    const normalizationResult = normalizeTransactionHistoryFilters(
      queryOptions,
      cachedAccountList,
      cachedCategoryList,
      referenceDate
    );

    if (!normalizationResult.isValid) {
      applicationLogger.fileDetail('warn', 'Transaction History Filter Resolution Issues', {
        unresolvedFilters: normalizationResult.unresolvedFilters,
      });

      const fallbackLimit = (typeof queryOptions?.limit === 'number' && queryOptions.limit > 0)
        ? queryOptions.limit
        : 10;
      const fallbackSort = queryOptions?.sort === 'oldest' ? 'oldest' : 'newest';

      return {
        records: [],
        total: 0,
        limit: fallbackLimit,
        offset: 0,
        page: 1,
        totalPages: 0,
        nextOffset: null,
        hasMore: false,
        sort: fallbackSort,
        appliedFilters: normalizationResult.appliedFilters,
        unresolvedFilters: normalizationResult.unresolvedFilters,
      };
    }

    let historyPageResult: TransactionHistoryPage;
    try {
      historyPageResult = await this.walletMcpClient.fetchRecords(
        normalizationResult.normalizedOptions
      );
    } catch (upstreamError: unknown) {
      const isSearchActive = Boolean(normalizationResult.normalizedOptions.searchQuery);

      const isUnsupportedSearch = isSearchActive && (() => {
        if (!upstreamError) return false;

        const errorObject = upstreamError as Record<string, unknown>;
        if (
          errorObject.parameter === 'query' ||
          (errorObject.data && typeof errorObject.data === 'object' && (errorObject.data as Record<string, unknown>).parameter === 'query') ||
          errorObject.field === 'query'
        ) {
          return true;
        }

        const errorMessage = upstreamError instanceof Error
          ? upstreamError.message.toLowerCase()
          : String(upstreamError).toLowerCase();

        // Must explicitly reference the query/search parameter
        const mentionsQueryParameter =
          errorMessage.includes('query') ||
          errorMessage.includes('search') ||
          errorMessage.includes('text search');

        if (!mentionsQueryParameter) {
          return false;
        }

        return (
          errorMessage.includes('unknown parameter') ||
          errorMessage.includes('unrecognized argument') ||
          errorMessage.includes('unrecognized parameter') ||
          errorMessage.includes('unsupported parameter') ||
          errorMessage.includes('not supported') ||
          errorMessage.includes('unsupported') ||
          errorMessage.includes('not available')
        );
      })();

      if (isUnsupportedSearch) {
        applicationLogger.fileDetail('warn', 'Upstream Wallet MCP text search not supported', {
          searchQuery: normalizationResult.normalizedOptions.searchQuery,
          error: upstreamError instanceof Error ? upstreamError.message : String(upstreamError),
        });

        const fallbackLimit = (typeof queryOptions?.limit === 'number' && queryOptions.limit > 0)
          ? queryOptions.limit
          : 10;
        const fallbackSort = queryOptions?.sort === 'oldest' ? 'oldest' : 'newest';

        return {
          records: [],
          total: 0,
          limit: fallbackLimit,
          offset: 0,
          page: 1,
          totalPages: 0,
          nextOffset: null,
          hasMore: false,
          sort: fallbackSort,
          appliedFilters: normalizationResult.appliedFilters,
          unresolvedFilters: [
            {
              filterKey: 'searchQuery',
              rawValue: normalizationResult.normalizedOptions.searchQuery || '',
              reason: 'UNSUPPORTED',
              subType: 'unsupported_upstream_search',
              message: 'Pencarian teks tidak didukung oleh sumber data upstream.',
            },
          ],
        };
      }

      throw upstreamError;
    }

    const enrichedRecordList: WalletRecordItem[] = historyPageResult.records.map(recordItem => {
      let enrichedAccountName = recordItem.accountName;
      if (!enrichedAccountName && recordItem.accountId && cachedAccountList.length > 0) {
        const matchedAccount = cachedAccountList.find(
          account => account.id === recordItem.accountId
        );
        if (matchedAccount) {
          enrichedAccountName = matchedAccount.name;
        }
      }

      let enrichedCategory = recordItem.category;
      const categoryId = recordItem.category?.id;
      if (
        (!enrichedCategory?.name || enrichedCategory.name === 'Unknown') &&
        categoryId &&
        cachedCategoryList.length > 0
      ) {
        const matchedCategory = cachedCategoryList.find(
          category => category.id === categoryId
        );
        if (matchedCategory) {
          enrichedCategory = {
            id: matchedCategory.id,
            name: matchedCategory.name,
            color: enrichedCategory?.color,
            group: enrichedCategory?.group,
          };
        } else if (!enrichedCategory?.name) {
          enrichedCategory = {
            id: categoryId,
            name: 'Unknown',
          };
        }
      }

      return {
        ...recordItem,
        accountName: enrichedAccountName,
        category: enrichedCategory,
      };
    });

    return {
      ...historyPageResult,
      records: enrichedRecordList,
      appliedFilters: normalizationResult.appliedFilters,
    };
  }
}
