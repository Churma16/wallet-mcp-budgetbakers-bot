# WhatsApp AI Bookkeeper for BudgetBakers Wallet

Automated personal bookkeeping via WhatsApp using Google Gemini 2.0 Flash (Free Tier) and BudgetBakers Wallet Model Context Protocol (MCP).

---

## Features

- **Natural Language Recording:** Send messages like *"Makan siang di McD 45rb pakai BCA"* or *"Gaji masuk 7.5jt ke Mandiri"*.
- **Receipt Photo OCR:** Take a photo of a shopping receipt or invoice; the AI extracts merchant, date, total amount, and categorizes it automatically.
- **Real-Time Bank & E-Wallet Email Sync (Gmail IMAP IDLE):** Automatically captures transaction emails from **Mandiri, Bank Jago, GoPay, OVO, DANA, and ShopeePay** in real-time, filtered via a Two-Gate defense engine, and requests interactive confirmation via WhatsApp before recording.
- **Budget & Balance Inquiries:** Ask *"Berapa sisa budget makan bulan ini?"* or *"Cek saldo BCA"*.
- **100% Free Architecture:** Powered by Google Gemini 2.0 Flash (Free Tier) and official Wallet MCP Streamable HTTP endpoint.
- **Security Whitelist:** Restricts interaction to your own verified WhatsApp phone number.

---

## Prerequisites

1. **Node.js**: v18 LTS or v20+ installed.
2. **Google Gemini API Key (Free):**
   - Obtain your free API key at [https://aistudio.google.com](https://aistudio.google.com).
3. **BudgetBakers Wallet MCP Token & Permissions:**
   - Go to [https://web.budgetbakers.com/settings/mcp-server](https://web.budgetbakers.com/settings/mcp-server).
   - Generate a **Personal Access Token**.
   - Ensure the following permissions are checked:
     - `records.create` and `records.read`
     - `accounts.read`
     - `categories.read`
     - `budgets.read`

---

## Setup & Configuration

### 1. Configure Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Open `.env` and fill in your credentials:
```env
# Google Gemini API Key
GEMINI_API_KEY=your_gemini_api_key_here

# BudgetBakers Wallet MCP
WALLET_MCP_BASE_URL=https://mcp.wallet.budgetbakers.com
WALLET_MCP_ACCESS_TOKEN=your_personal_access_token_here

# Your WhatsApp Phone Number (International format without '+' or spaces)
# Example: 6281234567890
ALLOWED_PHONE_NUMBER=6281234567890

# Email Bank Synchronization (Optional - Gmail IMAP IDLE)
EMAIL_SYNC_ENABLED=true
EMAIL_IMAP_HOST=imap.gmail.com
EMAIL_IMAP_PORT=993
EMAIL_IMAP_USER=your_email@gmail.com
EMAIL_IMAP_PASSWORD=your_16_char_google_app_password
EMAIL_LOOKBACK_MINUTES=10
```

### 2. Verify Connections & Rules
Test your Wallet MCP connection and permissions:
```bash
npm run test:mcp
```

Test Bank Email Rules & WhatsApp confirmation intent detection (Gate 1):
```bash
npm run test:email-rules
```

Verify Gmail IMAP connection:
```bash
npm run test:email
```

### 3. Start the WhatsApp Bot
```bash
npm start
```
1. A QR code will appear in your terminal.
2. Open WhatsApp on your phone > Settings > **Linked Devices** > **Link a Device**.
3. Scan the QR code.
4. Once connected, your session will be saved in `./auth_session` so you won't need to scan again on restarts.

---

## Usage Examples

Send messages from your whitelisted WhatsApp number to the bot:

| Intent | Example WhatsApp Message |
| :--- | :--- |
| **Expense** | *"Kopi kenangan 28rb bca"* |
| **Expense with details** | *"Beli bensin pertamax 50rb cash, note: isi di spbu rest area"* |
| **Income** | *"Terima transfer freelance 1.5jt ke Mandiri"* |
| **Receipt Photo** | Send a photo of your receipt (optional caption: *"bayar pakai kartu kredit"* ) |
| **Email Confirmation (Single)** | Reply *"Ya"* or *"Catat"* (records latest ticket) / *"Batal"* (cancels ticket) |
| **Email Confirmation (Specific)** | Reply *"Ya 1"* or *"Catat #2"* / *"Batal 1"* |
| **Email Confirmation (Bulk)** | Reply *"Ya semua"* or *"Catat semua"* / *"Batal semua"* |
| **Check Balances** | *"Cek saldo rekening"* or *"Berapa saldo BCA?"* |
| **Check Budgets** | *"Status budget bulan ini"* |

---

## Project Structure

```
wallet_mcp/
├── src/
│   ├── config/
│   │   ├── environmentConfig.ts    # Environment variables validation & loader
│   │   └── bankEmailRules.ts       # Modular bank dictionary (Mandiri, Jago, GoPay, OVO, DANA, ShopeePay)
│   ├── types/
│   │   └── walletTypes.ts          # TypeScript interfaces for Wallet MCP
│   ├── services/
│   │   ├── walletMcpClient.ts      # BudgetBakers MCP Client (JSON-RPC over HTTP)
│   │   ├── geminiAiService.ts      # Gemini 2.0 Flash NLU & Vision processing + Gate 2
│   │   ├── whatsappBotService.ts   # Baileys WhatsApp Web socket gateway
│   │   ├── emailListenerService.ts # Gmail IMAP IDLE real-time listener & persistent cache
│   │   └── pendingTransactionManager.ts # WhatsApp confirmation queue manager (#1, #2)
│   ├── utils/
│   │   ├── emailLogicGate.ts       # Gate 1 rule evaluator (sender, blacklist, currency, anti-dupe)
│   │   ├── fastPathIntentDetector.ts # Fast-path zero-token classifier & confirmation parser
│   │   ├── humanResponseFormatter.ts # Human-friendly WhatsApp Indonesian formatting
│   │   ├── logger.ts               # File and console logger
│   │   └── recordValidator.ts      # Data sanitizer & validator before Wallet MCP
│   ├── scripts/
│   │   ├── testWalletMcp.ts        # Standalone MCP verification test
│   │   ├── testEmailGateRules.ts   # Automated test suite for Gate 1 & confirmation intent
│   │   └── testEmailImap.ts        # Standalone Gmail IMAP connection test
│   └── index.ts                    # Main application bootstrap & orchestrator
├── .env.example                    # Blueprint for environment variables
├── package.json                    # Dependencies & execution scripts
├── tsconfig.json                   # TypeScript configuration
└── README.md                       # Documentation & guide
```

