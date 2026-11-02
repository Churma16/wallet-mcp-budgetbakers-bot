# Security Policy

## Supported Versions

This project follows a rolling release model on GitHub. We provide security patches only for the latest release and the current `main` branch.

| Version / Branch | Supported |
| :--- | :--- |
| `main` branch | Yes |
| Latest release tag | Yes |
| Older release tags | No |

If you run an older version, update to the latest release before reporting a vulnerability.

## Reporting a Vulnerability

Please report security vulnerabilities privately. Do not open public GitHub issues, pull requests, or discussion threads for unpatched flaws.

### How to Report

1. Open a private report through [GitHub Security Advisories](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/security/advisories/new).
2. If the advisory form is unavailable, contact the maintainer through the email listed on the [maintainer GitHub profile](https://github.com/Churma16).

Include the following details in your report:
- A description of the vulnerability and its potential impact.
- Steps to reproduce the issue, including minimal example inputs or payloads.
- The version or commit hash where you observed the issue.
- Any suggested fixes or mitigations, if known.

### What to Expect

This is an independently maintained personal open-source project. We handle reports on a best-effort basis:
- We aim to acknowledge receipt of your report within 3 to 5 business days.
- We will keep you updated as we validate the issue and prepare a fix.
- Once a fix lands on `main`, we will publish a release and credit your contribution in the release notes if you wish.

Please allow reasonable time for a fix before disclosing any details publicly.

## Trust Boundaries and Security Assumptions

This application runs self-hosted and handles personal financial records, messaging sessions, and API credentials. Keep the following boundaries and trade-offs in mind when deploying:

### Local Environment and Credentials
- All secrets live on your host machine in `.env` and local directories such as `./auth_session`.
- Anyone with read access to your host machine can read your `.env` file, WhatsApp session keys, and database tokens.
- Restrict filesystem permissions on your deployment machine and never commit `.env` or `./auth_session` to version control.

### BudgetBakers MCP Permissions
- The application connects to BudgetBakers Wallet via a Personal Access Token (`WALLET_MCP_ACCESS_TOKEN`).
- Apply least privilege when generating tokens in BudgetBakers Wallet settings. Grant only the scopes this bot requires: `records.create`, `records.read`, `accounts.read`, `categories.read`, and `budgets.read`.
- If your token leaks, revoke it immediately from BudgetBakers settings.

### Messaging Sender Allowlist
- The bot restricts access using a fail-closed allowlist (`ALLOWED_PHONE_NUMBER` for WhatsApp, `TELEGRAM_ALLOWED_USER_ID` for Telegram).
- Messages from unknown numbers or unauthorized Telegram accounts are dropped before they reach the AI or Wallet layers.
- For Telegram, configure the numeric user ID (`TELEGRAM_ALLOWED_USER_ID`). Usernames can change and are not used for authorization.

### External AI Providers
- The bot sends user message text and receipt images directly to your configured AI provider (Google Gemini, OpenRouter, Groq, or OpenAI) to extract intent and transaction details.
- No intermediary proxy server sits between your machine and the AI provider.
- Review your AI provider's data retention and training terms to ensure they meet your privacy expectations.

### Bank Email and Webhook Inputs
- The email sync service reads emails from your configured Gmail inbox via IMAP IDLE. Use a dedicated Google App Password, never your primary account password.
- Email filtering uses a two-stage gate. Rule-based filters drop non-financial emails, spam, OTPs, and login alerts locally before sending verified transaction bodies to the AI provider.
- If you run the Android notification webhook (`/api/webhook/notification`), secure it with a strong random secret (`NOTIFICATION_WEBHOOK_SECRET`).

### Unofficial WhatsApp Client
- The WhatsApp integration uses Baileys, an open-source library that connects through the WhatsApp Web multi-device protocol.
- Meta does not officially support third-party WhatsApp automation. Using automated tools carries a risk of temporary or permanent phone number bans under WhatsApp terms of service.
- If you require an official API with no account suspension risk, use the included Telegram bot adapter.
