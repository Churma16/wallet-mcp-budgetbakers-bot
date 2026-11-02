# BudgetBakers Wallet MCP Specification and Reference

> **Authoritative Upstream Documentation Reference**
> - **Live MCP Docs**: `https://mcp.wallet.budgetbakers.com/docs`
> - **REST OpenAPI Schema**: `https://rest.budgetbakers.com/wallet/openapi`
> - **Interactive Swagger UI**: `https://rest.budgetbakers.com/wallet/openapi/ui`
> - **MCP Server URL**: `https://mcp.wallet.budgetbakers.com`
> - **Protocol**: Model Context Protocol (MCP) over Streamable HTTP

---

## 1. Overview & Connection Architecture

BudgetBakers Wallet provides an official Model Context Protocol (MCP) server that connects AI assistants and client services directly to user financial data.

- **Authentication**: OAuth 2.0 with PKCE (automated flows) or manual Personal Access Token generated via Wallet web app settings (`web.budgetbakers.com/settings/mcp-server`).
- **Session**: Each request is authenticated with a Personal Access Token.
- **Permissions**: Read-only by default. Write and delete operations are opt-in and permission-controlled per entity type (`records.create`, `records.read`, `accounts.read`, `categories.read`, `budgets.read`, etc.).
- **Dual-Layer Permissions**:
  1. *Wallet-level (MCP Settings)*: Controls which operations the MCP server exposes at all.
  2. *Agent-level (Tool Permissions)*: Client-side authorization rules.

---

## 2. Complete Inventory of Available Tools (20 Tools)

The BudgetBakers MCP server exposes 20 tools organized into four functional groups:

### A. Read Tools (9 Tools)

| Tool Name | Summary | Key Parameters / Features |
|---|---|---|
| `get_client_profile` | Client profile: permissions, sync state, tool inventory, base currency, budget settings. | Checks `grantedScopes`, `syncState` (`complete`, `syncing`, `error`), `baseCurrency`, `usedCurrencies`, `toolCount`, `mcpTools`, and rate limit status. |
| `get_records` | List and filter transactions with sorting, pagination, and on-demand currency conversion. | Filters: `accountId`, `categoryId`, `categoryGroup`, `labelId`, `recordType`, `isTransfer`, `transferId`, `source`, `recordState`, `amount`, `recordDate`, `createdAt`, `updatedAt`, `counterParty`, `note`, `limit`, `offset`, `sortBy`, `convertTo`. |
| `get_accounts` | List bank accounts and wallets with balances, record statistics, and bank-sync status. | Masked bank account numbers by default (`****1234`). Set `revealBankAccountNumber: true` only upon explicit user request. Returns `isBankSynced`, `syncState`, `connectedBank`. |
| `get_categories` | List all base categories (~90) plus user-created custom categories with group hierarchy. | Supports hierarchy traversal, category icons, default colors, and spending nature (`cardinality`). |
| `get_budgets` | List budgets with pre-computed spending data. | Pre-computed analytics: current/past period spent, remaining, progress percentage, and per-period limit overrides. Controlled via `spending` depth (`none`, `current`, `current+N`). |
| `get_labels` | List custom labels (hashtags) for tagging and filtering transactions. | Returns label IDs, names, colors, and archive status. |
| `get_records_aggregation` | Aggregate transactions with flexible grouping and expressions. | `groupBy`: `category`, `categoryGroup`, `month`, `account`, `currency`, `recordType`. Computes: `amount:sum`, `avg`, `min`, `max`, `median`, `absSum`. Automatic base-currency conversion via historical forex rates. |
| `get_entity` | Unified read access to supplementary entity types. | Read access for: `standing-orders` (subscriptions / recurring), `standing-order-items`, `goals` (savings targets), and `record-rules` (auto-categorization rules). |
| `get_references` | Check which entities reference a given record, account, category, or label. | Mandatory safety pre-flight check before deleting entities to avoid referential integrity rejection. |

### B. Create Tools (5 Tools)

| Tool Name | Summary | Constraints & Notes |
|---|---|---|
| `create_records` | Batch-create up to 50 transactions per request. | Supports regular records, paired transfers (two linked records across accounts), unpaired transfers, cross-currency transfers with automatic forex conversion, and `pairingMode: "existing"` to bind to existing records. |
| `create_account` | Create a single bank account or wallet. | Supported types: `General`, `Cash`, `CurrentAccount`, `SavingAccount`, `Insurance`. Requires currency, initial balance, name, and color. |
| `create_budget` | Create a single budget with spending limits. | Types: `weekly`, `monthly`, `yearly`, or custom date range. Scoped to accounts, categories, or labels. |
| `create_category` | Create a single custom category derived from a base category. | Inherits the parent group and optionally its color. |
| `create_label` | Create a single custom label (hashtag) for tagging transactions. | Strips leading `#` automatically. |

### C. Update Tools (5 Tools)

| Tool Name | Summary | Constraints & Notes |
|---|---|---|
| `patch_records` | Batch-update up to 20 records. | Fields: `categoryId`, `labelIds` (or add/remove), `note`, `counterParty`, `recordState`, `recordDate`, `amount`, `place`, `accountId` (move between accounts). Supports `$clear` to reset fields and dissolve transfer states. |
| `patch_accounts` | Batch-update up to 20 accounts. | Fields: `name`, `color`, `initialBalance`, `archived`, `bankAccountNumber`. Currency is immutable. |
| `patch_budgets` | Batch-update up to 20 budgets. | Fields: limits (uniform or per-period overrides), name, account/category/label filters, close/reopen. |
| `patch_categories` | Batch-update up to 20 categories. | Rename, recolor, set cardinality, or reset base category names to defaults. |
| `patch_labels` | Batch-update up to 20 labels. | Rename, recolor, or change archive status. |

### D. Delete Tools (1 Tool)

| Tool Name | Summary | Constraints & Notes |
|---|---|---|
| `delete_documents` | Permanently delete up to 20 records, accounts, budgets, categories, labels, standing orders, or record rules. | Enforces referential integrity: accounts and labels with active references are rejected until dependencies are removed. Paired transfer records must be deleted together in the same batch. |

---

## 3. Critical Behavioral Mechanics & Constraints

### 3.1 Field Resetting and Transfer Dissolution via `$clear`
In `patch_records`, the `$clear` array resets fields to empty:
- Valid values: `["note", "place", "counterParty", "categoryId", "labelIds", "transfer"]`.
- `$clear: ["transfer"]` cancels transfer state on paired records, dissolving the link and resetting category to Unknown.
- `$clear` cannot be combined with an explicit value for the same field in the same patch item.

### 3.2 Moving Records Between Accounts (`accountId` in `patch_records`)
- A record can be moved to another account by setting `accountId`.
- **Constraint**: Both source and destination accounts must have the **exact same currency**.
- **Constraint**: Neither account can be a bank-synced account. If currencies differ, the record must be deleted and re-created.

### 3.3 Bank-Synced Account Immutability
Records originating from bank-synced feeds have restricted write capabilities:
- **Immutable fields**: `amount`, `recordDate`, `recordState`, and `accountId` are strictly locked by the bank feed.
- **Mutable fields**: `category`, `labelIds`, `note`, and `counterParty` can be patched.
- Bank-synced records can be converted into transfers with `pairingMode: "new"` only if the counter-record target account is **not bank-synced**.

### 3.4 Transfer Pairing Modes (`create_records` and `patch_records`)
- `pairingMode: "new"` (default): Creates two paired records (one debit, one credit) atomically.
- `pairingMode: "existing"`: Binds the new or patched transaction to an already existing transaction (`recordId`) on the target account. Crucial for reconciling incoming bank notifications against bank-synced feeds.
- `pairingMode: "unpaired"`: Unlinked transfer record.
- **Mirror propagation**: For same-currency pairs, updating amount on one side automatically propagates to the mirror leg. For cross-currency pairs, each leg must be patched individually.

### 3.5 Special Category Value `'unknown'`
In `get_records` and `get_budgets`:
- Passing `categoryId: 'unknown'` automatically expands server-side to the 3 system categories:
  1. *Unknown income*
  2. *Unknown expense*
  3. *Uncategorized*
- Eliminates the need for client-side category ID expansion when querying unclassified records.

### 3.6 On-Demand Currency Conversion (`convertTo`)
In `get_records` and `get_records_aggregation`:
- Parameter: `convertTo: 'base' | 'account' | '<ISO_4217_CODE>'` (e.g. `convertTo: 'base'`).
- The response annotates each record with `convertedAmount`:
  ```json
  "convertedAmount": {
    "value": -15.50,
    "ratio": 0.000065,
    "currencyCode": "EUR",
    "conversionPair": "IDR/EUR"
  }
  ```
- Conversions use historical exchange rates matching the transaction date.

### 3.7 Deletion Semantics & Paired Transfers
- Tool name is **`delete_documents`** (accepts `{ type: "records", ids: ["..."] }`).
- Deleting paired transfers requires providing **both record IDs** in the same request. Deleting only one leg returns an error identifying the missing partner leg ID.
- Check references via `get_references` before deleting categories, accounts, or labels.

---

## 4. Rate Limiting and Fair Use Policy

- **Algorithm**: Dual-bucket (burst + sustained).
- **Metadata**: Every response contains `_meta.rateLimit`:
  - `capacity`: Maximum burst token bucket capacity.
  - `remaining`: Tokens remaining in current window.
  - `refillPerMinute`: Token replenishment rate.
- **Handling 429**: Treat `429 Too Many Requests` as an instruction to back off and pause, not as an obstacle to aggressively retry through.
- **Sync Latency**: Data syncs from mobile/web app periodically (typically within 1 to 15 minutes).
