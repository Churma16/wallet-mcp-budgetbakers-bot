# Transaction Summaries and Breakdowns

Transaction summaries provide deterministic totals over the same account, category, transaction type, and date filters used by transaction history. They run through the zero-token fast path and do not require an AI provider call.

## Examples

Use either Indonesian or English commands:

```text
total pengeluaran bulan ini
total pemasukan hari ini
ringkasan bulan ini
ringkasan makanan bulan ini
pengeluaran per kategori bulan ini
pengeluaran per akun bulan ini
summary this month
summary by category this month
summary by account yesterday
how much did I spend on food this month?
which category did I spend the most on?
```

The filters have the same meaning as transaction history. For example, `ringkasan makanan bulan ini` uses the same category resolution and local-calendar `this_month` range as `riwayat makanan bulan ini`.

## Totals

An unfiltered summary reports income, expenses, and net amount for every currency present in the matching records. Expense values are displayed as positive spending totals, while net is calculated as:

```text
net = income - expenses
```

When a summary is explicitly filtered to only expenses or only income, the response shows only that requested metric and omits Net. This avoids presenting a one-sided subtotal as if it were the true net for the period.

Transfer records are excluded from income and expense totals so moving money between accounts does not inflate either side of the summary.

## Category and Account Breakdowns

Use `per kategori` / `by category` to group matching transactions by category. Records without usable category metadata are grouped as uncategorized.

Use `per akun` / `by account` to group matching transactions by Wallet account. Account names are enriched through the same cache used by transaction history when the upstream record only contains an account ID.

Natural-language category ranking questions such as `which category did I spend the most on?` use an expense-only category breakdown so the highest-spending category can be identified from deterministic grouped totals.

## Multi-Currency Behavior

Different currencies are never added together. If matching records contain IDR and USD, the response shows separate IDR and USD totals and does not calculate a cross-currency grand total.

This avoids misleading results when no explicit exchange-rate conversion has been requested or supplied.

## Empty and Invalid Queries

If no matching transactions exist, the summary returns a clear no-data response with no fabricated totals.

If an account, category, date range, or other shared filter cannot be resolved, the summary fails closed using the same unresolved-filter behavior as transaction history instead of silently dropping the filter.
