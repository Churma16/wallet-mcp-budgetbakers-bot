# Adding Providers (Banks, E-Wallets & Merchants)

This guide explains how to add support for a new bank, digital wallet, or merchant in the bot.

The bot ingests financial transactions through two inbound streams:
1. **Android Push Notifications**: Forwarded by the companion Android app via webhook.
2. **Bank Transaction Emails**: Ingested via IMAP IDLE from your email account.

You do not need to touch AI prompts or MCP tools to add support for a new provider. You only need to add declarative configuration rules and unit tests.

> [!TIP]
> **Prefer not to write code?**
> You do not have to build it yourself. Just [open an issue](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/issues/new) with a sanitized sample of your notification text or transaction email (be sure to redact your real name, account numbers, and balances), and I will happily add it for you!

---

## Quick Reference: Where Things Live

| Component | Rule Configuration File | Unit Test File |
| :--- | :--- | :--- |
| **Push Notifications** | `src/config/notificationRules.ts` | `tests/notificationRules.vitest.test.ts` |
| **Bank Emails** | `src/email/bankRules.ts` | `tests/bankEmailRules.vitest.test.ts` |

---

## Part 1: Adding a Push Notification Rule

When an Android phone receives a financial push notification, the companion app forwards a JSON payload with `packageName`, `title`, and `text` to the bot webhook.

### 1. Find the Android Package Name
Find the unique application ID of the banking or wallet app. You can look it up in the Google Play Store URL:
```
https://play.google.com/store/apps/details?id=com.example.bank
                                            ^^^^^^^^^^^^^^^^
```
In this example, the package name is `com.example.bank`.

### 2. Add an Entry to `RAW_PACKAGE_RULES`
Open `src/config/notificationRules.ts` and locate the `RAW_PACKAGE_RULES` array. Add a new 5-element tuple:

```typescript
// Bank Example
['com.example.bank', 'Example Bank', 'Example', 'example', 'BANK'],
```

The tuple fields are:
1. **`packageName`**: Exact Android application ID (`string`).
2. **`displayName`**: Human-readable name used in notifications and confirmation cards (`string`).
3. **`accountNameHint`**: Name hint used to match against the user's BudgetBakers Wallet account list (`string`).
4. **`bankKey`**: Lowercase alphanumeric identifier used for deduplication and internal correlation (`string`).
5. **`category`**: One of `'BANK'`, `'E_WALLET'`, or `'MERCHANT'`.

### 3. Add a Test Case
Open `tests/notificationRules.vitest.test.ts` and add a test case verifying your new package mapping:

```typescript
it('accepts and correctly maps Example Bank notification', () => {
  const result = evaluateNotificationThroughGate({
    packageName: 'com.example.bank',
    title: 'Transaksi Berhasil',
    text: 'Pembayaran QRIS sebesar Rp 45.000 di Kopi Kenangan sukses.',
  });

  expect(result.passed).toBe(true);
  expect(result.rule?.displayName).toBe('Example Bank');
  expect(result.rule?.accountNameHint).toBe('Example');
  expect(result.extractedAmount).toBe(45000);
});
```

---

## Part 2: Adding a Bank Email Rule

When a transaction email arrives, Gate 1 evaluates it before running any expensive operations. The email must match a trusted sender domain, contain transaction subject keywords, avoid blacklisted promo/OTP terms, and match regular expressions for amount and reference ID.

### 1. Define the Rule in `src/email/bankRules.ts`
Open `src/email/bankRules.ts` and add a new object to the `BANK_DEBIT_AND_GATEWAY_RULES` array:

```typescript
{
  bankKey: 'example',
  displayName: 'Example Bank',
  accountNameHint: 'Example',
  senderDomains: ['examplebank.co.id', 'notif.examplebank.co.id'],
  subjectKeywords: [
    'transaksi berhasil',
    'debet rekening',
    'qris',
    'resi pembayaran',
  ],
  blacklistKeywords: [
    ...COMMON_BANK_BLACKLIST_KEYWORDS,
    'aktivasi kartu',
    'e-statement',
  ],
  bodyRequiredPatterns: [
    /(?:debet|nominal|transaksi|pembayaran|qris)/i,
  ],
  amountPriorityPatterns: [
    /(?:Total\s*Pembayaran|Nominal|Jumlah)[:\s]{0,20}(?:Rp|IDR)?[\s]{0,10}([\d.,]+)/i,
    /(?:Rp|IDR)\s*([\d.,]+)/i,
  ],
  referencePatterns: [
    /(?:No\.?\s*Referensi|Nomor\s*Resi|RRN)[:\s]*([A-Za-z0-9]+)/i,
    /Ref(?:erence)?\s*(?:No|ID)[:\s]*([A-Za-z0-9]+)/i,
  ],
  transferOrTopupKeywords: [
    ...COMMON_TRANSFER_TOPUP_KEYWORDS,
    'transfer dana',
  ],
},
```

### Rule Properties Explained
- **`bankKey`**: Short lowercase key (e.g. `'mandiri'`, `'jago'`, `'bca'`).
- **`displayName`**: User-facing name shown on pending transaction cards.
- **`accountNameHint`**: Hint string matching the account name in BudgetBakers Wallet.
- **`senderDomains`**: Array of allowed email domains without `@`. Only emails with `from` addresses matching these domains pass Gate 1.
- **`subjectKeywords`**: Lowercase phrases that must appear in the email subject line.
- **`blacklistKeywords`**: Keywords that reject the email immediately (OTP, marketing promos, password reset, login alerts). Reuses `COMMON_BANK_BLACKLIST_KEYWORDS`.
- **`bodyRequiredPatterns`**: Regular expressions that confirm the email body contains actual debit or payment wording.
- **`amountPriorityPatterns`**: Ordered array of regular expressions. The first pattern that matches extracts the amount string. Ensure capturing group 1 targets the numeric amount.
- **`referencePatterns`**: Regular expressions to extract the unique reference number or RRN. This prevents duplicate tickets if multiple alerts arrive for the same transaction.
- **`transferOrTopupKeywords`**: Words indicating internal transfers or wallet top-ups (e.g. GoPay, OVO, ShopeePay top-up).

### 2. Add a Test Case
Open `tests/bankEmailRules.vitest.test.ts` and add a test case with a sanitized email sample:

```typescript
it('accepts an Example Bank QRIS notification and extracts its facts', () => {
  const result = evaluateEmail(
    'Notifikasi Transaksi: Resi Pembayaran QRIS',
    'noreply@examplebank.co.id',
    `Yth. Nasabah, transaksi pembayaran QRIS sebesar Rp 50.000 berhasil pada 04 Nov 2026.
No. Referensi: EX1234567890.`
  );

  expect(result.passed).toBe(true);
  expect(result.facts?.amount).toBe(50000);
  expect(result.facts?.referenceId).toBe('EX1234567890');
  expect(result.facts?.accountHint).toBe('Example');
});
```

---

## Part 3: Sanitizing Sample Data (Security First)

Real financial alerts contain sensitive personal data. When copying notification texts or email bodies into test files, sanitize every private detail:

- **Names**: Replace your real name with a placeholder like `Nasabah`, `John Doe`, or `Budi`.
- **Account Numbers / Cards**: Replace real numbers with standard test numbers like `1234567890` or `****1234`.
- **Phone Numbers**: Replace with dummy numbers like `08123456789`.
- **Reference Numbers / RRN**: You can keep the format, but scramble the digits (e.g., `REF987654321`).
- **Balances**: Never include your actual remaining account balance in fixtures.

---

## Part 4: Testing Your Changes

Run the targeted test suites locally before pushing your branch:

```bash
# 1. Run notification rules tests
npx vitest run tests/notificationRules.vitest.test.ts

# 2. Run email rules tests
npx vitest run tests/bankEmailRules.vitest.test.ts

# 3. Check TypeScript compilation
npm run build
```

Both tests run offline in memory. They do not require any `.env` secrets, live IMAP connections, or running bot instances.

---

## Submitting Your Pull Request

1. Create a branch:
   ```bash
   git checkout -b feature/add-<provider>-rules
   ```
2. Commit your changes following Conventional Commits:
   ```bash
   git commit -m "feat(rules): add notification and email support for <Provider>"
   ```
3. Push your branch and open a pull request on GitHub. Include an example of the notification or email format (with sensitive details redacted) in your PR description.

---

## Want Me to Add It Instead?

If you don't feel like writing code or wrestling with regular expressions:
1. Open a new [GitHub Issue](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/issues/new) or start a thread in [Discussions](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/discussions).
2. Let me know the bank or wallet name.
3. Paste a sample of the notification text or email body.
4. **Important**: Make sure all personal info (real name, account/card numbers, phone numbers, real balances) is completely scrubbed or replaced with fake numbers.
5. I'll write the rule, add the test case, and wire it up for you!
