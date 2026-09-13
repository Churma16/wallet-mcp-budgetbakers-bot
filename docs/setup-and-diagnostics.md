# Setup and Diagnostics

> **Runtime prerequisite:** Node.js 22 or newer. This matches the package metadata, doctor diagnostic, CI runtime, and container image.

## Interactive setup

Install dependencies, then run:

```bash
npm run setup
```

The wizard guides you through:

- Wallet MCP endpoint and access token.
- One or more AI providers in priority order.
- WhatsApp, Telegram, and/or console messaging.
- Language, default currency, and IANA timezone.
- Optional IMAP email synchronization.

Credential prompts include a short acquisition hint and a plain-text link to the relevant section of [Credential Setup Guide](setup-credentials.md). Secret values are masked while entering them in an interactive terminal and are not shown in the final summary.

If `.env` already exists, the wizard updates matching keys while preserving comments, unknown variables, and values the user does not replace. Manual `.env` editing remains fully supported; `.env.example` documents all advanced tuning options that the wizard intentionally leaves alone.

## Unified doctor command

Run:

```bash
npm run doctor
```

The doctor performs read-only diagnostics for the configured application:

- Node.js runtime compatibility.
- Application configuration validation.
- Wallet MCP authentication and connectivity.
- A minimal AI provider/model request for each configured provider.
- WhatsApp configuration and paired-session presence without starting Baileys or showing a QR code.
- Telegram bot-token verification when Telegram is enabled.
- IMAP authentication when email sync is enabled, without scanning messages or entering IDLE mode.

Results use text-only statuses:

```text
[SUCCESS] Runtime: Node.js 22.16.0 is supported.
[WARN] WhatsApp: Configuration is valid, but no paired session was found. Start the bot once and scan the QR code.
[ERROR] Wallet MCP: Connection failed. Check the MCP URL, access token, required scopes, and network access.
```

The command exits with code `1` if any diagnostic returns `[ERROR]`. Warnings alone keep exit code `0`.

Doctor output intentionally uses generic network failure messages rather than raw upstream exceptions because upstream URLs or error payloads may contain credentials.

## Manual setup

The wizard is optional. To configure manually:

```bash
cp .env.example .env
```

Edit `.env`, then run `npm run doctor`. See [Credential Setup Guide](setup-credentials.md) for token and key acquisition steps.
