# Wallet bot for WhatsApp and Telegram

[![CI](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Record expenses and income in BudgetBakers Wallet by sending a message or receipt photo. The bot runs on your machine and connects to Wallet through its MCP API. Optional email monitoring turns bank notifications into transactions for you to confirm.

Try `Kopi kenangan 28rb bca`, `Gaji masuk 7.5jt ke Mandiri`, or `Lunch sandwich $7.50 cash`. Use account names that exist in your Wallet.

**Chat messages and receipt photos can save records immediately. Email transactions require confirmation.** Review the [save behavior](#when-records-are-saved) before trying an expense.

Responses support Indonesian and English. Gemini is the only AI provider currently reported as tested by the project; OpenRouter, Groq, Ollama, OpenAI, and custom endpoint integrations still need validation.

[Quickstart](#quickstart) · [Usage](#usage) · [Email sync](#optional-email-sync) · [Limitations and privacy](#limitations-and-privacy) · [Documentation](#documentation)

## Quickstart

You need Node.js 22 (the version used in CI), npm, a BudgetBakers Wallet account with an MCP access token, a Gemini API key, and either WhatsApp or a Telegram bot. Keep the process running to receive messages.

### 1. Install

```sh
git clone https://github.com/Churma16/wallet-mcp-budgetbakers-bot.git
cd wallet-mcp-budgetbakers-bot
npm ci
```

Copy the environment template:

```sh
# macOS / Linux
cp .env.example .env
```

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

### 2. Configure Wallet and AI

Edit the existing entries in `.env`:

```dotenv
WALLET_MCP_BASE_URL=https://mcp.wallet.budgetbakers.com
WALLET_MCP_ACCESS_TOKEN=your_wallet_token
AI_PROVIDER=gemini
GEMINI_API_KEY=your_gemini_key
```

Create the Wallet token in [Wallet MCP settings](https://web.budgetbakers.com/settings/mcp-server), with `records.create`, `records.read`, `accounts.read`, `categories.read`, and `budgets.read` permissions. See the [token guide](docs/configuration.md#wallet-access-token) for the steps. Obtain your Gemini key from [Google AI Studio](https://aistudio.google.com).

The template supplies model settings. Check that those model IDs are available to your account and adjust `GEMINI_MODEL` and `GEMINI_FALLBACK_MODELS` if needed; repository defaults do not guarantee provider availability.

### 3. Choose a channel

For **WhatsApp**, replace the sample number with your own international number, including country code:

```dotenv
ENABLED_MESSENGER_CHANNELS=whatsapp
ALLOWED_PHONE_NUMBER=6281234567890
```

For **Telegram**, create a bot with [BotFather](https://t.me/BotFather) and obtain your numeric user ID, for example using [userinfobot](https://t.me/userinfobot). Uncomment and fill in these settings:

```dotenv
ENABLED_MESSENGER_CHANNELS=telegram
ALLOWED_PHONE_NUMBER=
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_ALLOWED_USER_ID=123456789
```

Explicit channel selection avoids accidentally starting WhatsApp using the template's sample number. Always set the access restriction for each enabled channel. To run both, use `ENABLED_MESSENGER_CHANNELS=whatsapp,telegram` and provide both sets of credentials.

The template defaults to Indonesian responses, IDR, and Jakarta time. Change these entries to suit your location:

```dotenv
APP_LANGUAGE=en
DEFAULT_CURRENCY=USD
APP_TIMEZONE=America/New_York
```

`DEFAULT_CURRENCY` supplies a fallback; account-specific formatting uses the account's Wallet currency. Email sync can stay disabled.

### 4. Start and try a query

```sh
npm start
```

- **WhatsApp:** scan the terminal QR code under Settings > Linked Devices > Link a Device. If you link your own account, open its message-yourself chat and send `balance`.
- **Telegram:** open the bot's private chat, press Start, then send `balance` from the configured user account.

The balance query reads Wallet accounts without creating a transaction. Once that works, try an expense using one of your actual account names and check the saved record in Wallet.

If startup or a query fails, see [diagnostics and troubleshooting](docs/development.md#diagnostics-and-troubleshooting). Use `npm run dev` instead of `npm start` when you need automatic reload during development.

## Usage

Send these examples from your configured account:

| Task | Example |
| --- | --- |
| Expense | `Kopi kenangan 28rb bca` or `Lunch sandwich $7.50 cash` |
| Income | `Gaji masuk 7.5jt ke Mandiri` |
| Add a note | `Beli bensin 50rb cash, note: rest area km 57` |
| Receipt | Send a photo, optionally with an account hint in the caption |
| Balances | `Cek saldo` or `Check balance` |
| Budgets | `Cek budget` or `Budget status` |
| Help | `Bantuan` or `Help` |

Common balance, budget, help, and pending-confirmation commands are handled without an AI call. Other text and receipt images go through the configured AI provider.

### When records are saved

| Input | Save behavior |
| --- | --- |
| Expense or income message | AI extraction and local validation are followed by a Wallet write, without a separate approval prompt. |
| Receipt photo | Uses the same direct-save path after image extraction and validation. |
| Bank notification email | Creates a numbered pending ticket. A confirmation command triggers the Wallet write. |
| Balance, budget, or help query | Does not create a financial record. |

For pending email tickets:

| Action | Indonesian | English |
| --- | --- | --- |
| Confirm latest | `Ya` | `Yes` |
| Confirm a ticket | `Ya 1` | `Yes 1` |
| Confirm all | `Ya semua` | `Yes all` |
| Cancel a ticket | `Batal 1` | `Cancel 1` |
| Cancel all | `Batal semua` | `Cancel all` |

Unprocessed pending tickets expire after 24 hours. Tickets being processed or awaiting manual reconciliation are retained in the running process, but all tickets are lost on restart. A confirmed non-commit failure can be retried; an uncertain write outcome blocks another confirmation until you check Wallet and reconcile it manually. Cancellation removes a ticket that is not being processed; it does not undo a saved record.

## Optional email sync

Email sync is disabled by default. It reads an IMAP inbox, applies sender and content rules, and sends matching notifications to AI extraction. Extracted transactions are broadcast as confirmation tickets to configured channels.

Rules currently cover Mandiri, Jago, GoPay, OVO, DANA, and ShopeePay. Coverage depends on the email format; these rules do not guarantee that every notification will be recognized.

For Gmail setup, credentials, and the startup lookback window, see [email configuration](docs/configuration.md#email-sync). This reads notification emails; it does not connect directly to bank accounts.

## Limitations and privacy

- AI can select the wrong amount, date, account, or category. Check direct saves in Wallet and review email tickets before confirming.
- Provider fallback tries another configured provider after a failure. If all providers fail, the operation fails; fallback does not guarantee delivery or recovery. Receipt processing also depends on model image support.
- Pending tickets are not durable. Email deduplication is persisted separately and does not restore tickets after a restart.
- Set a nonempty phone number or Telegram user ID for every enabled channel. Missing access restrictions do not reliably fail closed; hardening is tracked in [#74](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/issues/74).
- WhatsApp uses the unofficial Baileys client and may be disconnected or restricted by WhatsApp. Telegram uses its Bot API. Reconnection settings do not guarantee that an account will avoid restrictions.
- Messaging services carry your messages. Transaction text, receipt images, matching email content, and Wallet account/category context are sent to the configured AI endpoint. Fallback may send that input to additional configured providers. Saved records and account queries go to BudgetBakers.
- Detailed financial payload logs are metadata-only by default. `DEBUG_FINANCIAL_PAYLOADS=true` enables payload logging for local debugging while retaining credential redaction. Treat `.env`, `auth_session/`, `data/`, and `logs/` as private, and review logs before sharing them.
- Email filtering is a heuristic, not a guarantee that sensitive or malicious content will be excluded from AI processing.

## Documentation

- [Configuration reference](docs/configuration.md): Wallet tokens, AI providers, channels, regional settings, email sync, and runtime limits.
- [Architecture](docs/architecture.md): message flow and source locations.
- [Development, logging, and releases](docs/development.md): offline checks, error investigation, live diagnostics, and release workflows.
- [Contributing guide](CONTRIBUTING.md): development conventions and contribution process.

## Support and contributions

Use [Discussions](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/discussions) for questions and setup help, and [Issues](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/issues) for bugs or feature requests. Reports in English or Indonesian are welcome; a short description is enough to start.

Useful contributions include sanitized bank email samples, testing other AI providers, receipt examples across currencies, and messaging reliability reports. Read the [contributing guide](CONTRIBUTING.md) before starting implementation.

## License

Developed by [churma16](https://github.com/churma16). Available under the [MIT License](LICENSE), without warranty. This project is not affiliated with BudgetBakers, the named banks, or messaging and AI providers; product names belong to their respective owners.
