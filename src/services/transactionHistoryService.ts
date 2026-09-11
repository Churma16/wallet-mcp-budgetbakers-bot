import { WalletMcpClientService } from './walletMcpService.js';
import { WalletCacheService } from './walletCacheService.js';
import {
  TransactionHistoryQueryOptions,
  TransactionHistoryPage,
  WalletRecordItem,
} from '../types/walletTypes.js';
import { applicationLogger } from '../utils/logger.js';

export class TransactionHistoryService {
  constructor(
    private readonly walletMcpClient: WalletMcpClientService,
    private readonly walletCacheService?: WalletCacheService
  ) {}

  /**
   * Retrieves transaction history records with pagination and sorting.
   * Enriches missing account or category names using cached entities if available.
   */
  public async getTransactionHistory(
    queryOptions?: TransactionHistoryQueryOptions
  ): Promise<TransactionHistoryPage> {
    applicationLogger.fileDetail('mcp', 'Retrieving Transaction History', {
      queryOptions: queryOptions ?? {},
    });

    const historyPageResult = await this.walletMcpClient.fetchRecords(queryOptions);

    if (this.walletCacheService) {
      const cachedAccountList = this.walletCacheService.getAccounts();
      const cachedCategoryList = this.walletCacheService.getCategories();

      const enrichedRecordList: WalletRecordItem[] = historyPageResult.records.map(recordItem => {
        let enrichedAccountName = recordItem.accountName;
        if (!enrichedAccountName && recordItem.accountId) {
          const matchedAccount = cachedAccountList.find(
            account => account.id === recordItem.accountId
          );
          if (matchedAccount) {
            enrichedAccountName = matchedAccount.name;
          }
        }

        let enrichedCategory = recordItem.category;
        const categoryId = recordItem.category?.id;
        if ((!enrichedCategory?.name || enrichedCategory.name === 'Unknown') && categoryId) {
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
      };
    }

    return historyPageResult;
  }
}
