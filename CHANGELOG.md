# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [0.1.5](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/compare/v0.1.4...v0.1.5) (2026-09-06)

## [0.1.4](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/compare/v0.1.3...v0.1.4) (2026-09-06)

## [0.1.3](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/compare/v0.1.2...v0.1.3) (2026-09-06)

## [0.1.2](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/compare/v0.1.1...v0.1.2) (2026-09-06)


### Features

* **currency:** account-aware multi-currency formatting and default currency configuration ([3def789](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/3def7899fa2b3da90f7aac906e065bd258cb56b8))

## 0.1.1 (2026-09-06)


### Features

* add comprehensive diagnostic file logging across bot execution pipeline ([ddc7f45](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/ddc7f45abaa2af165078cc32398633065ba2e24c))
* add real-time bank and e-wallet email sync via gmail imap idle ([#1](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/issues/1)) ([65543a8](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/65543a8065f2db58e2ee8fbb2b9ec9f559ab5507)), closes [#2](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/issues/2)
* **ai:** implement agnostic AI provider architecture ([#2](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/issues/2)) ([bb54434](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/bb54434408a8aac1232e4062efc9a3e50df65a8e))
* **ai:** summarize provider fallback error logs using concise error formatter ([a9808b1](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/a9808b1ce32ff6b673f27144de72f48e4b1bd07f))
* bootstrap application and start whatsapp bookkeeper bot ([9d9b154](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/9d9b154309d4d8d95c7556ef3e31d1da72ed0742))
* **config:** add gemini request timeout setting ([62a6b39](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/62a6b3900e76ce28aecbd471dc7d3fbaf031069f))
* **config:** implement environment configuration loader and validation ([93fa541](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/93fa541f48567e64fbfe6cc46b35217f4c8b0dba))
* **config:** normalize allowed phone number to numeric digits ([73d8b8d](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/73d8b8d9a33020d31bcd5df447efca5007537dac))
* **config:** support gemini fallback models and log retention setting ([b4921ff](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/b4921ffc96baccca683d4727f73c1cfc30273f21))
* display whatsapp typing indicator and enforce gemini request timeout ([c7e1b4d](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/c7e1b4d2a1866b3f437b09889a790f78b8dca8d9))
* enforce phone whitelist on startup and validate records before mcp dispatch ([d24a94c](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/d24a94cae4f2d50c2002ba06bf1eca80558b5fec))
* **i18n:** support english response dictionary and multi-language formatting ([31a6160](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/31a61601f0af9912c5e3e21446f3170984cd85b2))
* initialize gemini fallback models and auto-purge expired logs on startup ([9d5a38e](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/9d5a38e8e726983c067cc42700f384b79b876eb1))
* integrate human response formatters into whatsapp message handler ([6e516ad](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/6e516ad3f3d0d125b55bff001bc0eb0513af4fcb))
* **messaging:** add channel-agnostic bot architecture and Telegram bot integration ([f5fdacb](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/f5fdacb816dc0ae3084e8f9ff4be7504966412fc))
* **service:** add abort timeout and progress heartbeat to gemini request loop ([ee03c83](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/ee03c83b8b3f781a7ba65f81a0ef2637df3cfefc))
* **service:** add detailed file tracing for wallet mcp operations ([d51bed6](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/d51bed60f273986bcdcf03ac995e40fdcf7491cf))
* **service:** add file diagnostic logging to whatsapp bot lifecycle and messaging ([c07031b](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/c07031b5ab6869799f9d712d786268abfea7161b))
* **service:** add incoming message deduplication and strict whitelist validation ([d6fad09](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/d6fad09338031d41d5019bffce8b74552ffdfa15))
* **service:** add latency tracking and diagnostic file logging to gemini service ([946b7f2](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/946b7f2081efef52bd6472293980cd4bf707c9c5))
* **service:** add typing presence indicators to whatsapp bot ([e7d47bd](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/e7d47bd6987443d2ace3dc78bc1c431a86577a83))
* **service:** enhance whatsapp session management and message parsing ([5a54093](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/5a54093fa3586c19f67524aeac0c25f888bc36d6))
* **service:** harden gemini system prompt against injection and mask image logs ([2b87039](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/2b870399c4d2602aa21b4f3af6fa0055feba531a))
* **service:** implement automatic fallback cascade for gemini models ([a2b82a8](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/a2b82a8a92be066664b0cc2fd9e43ef00b47e30f))
* **service:** implement gemini ai service with function calling ([f5a251a](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/f5a251a1c94a80b0bd6de44e2f3fb7744757b8e1))
* **service:** implement wallet mcp client for api interactions ([0972ab5](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/0972ab5bbcaf013aacd1bdb0bdd46a8b043b6880))
* **service:** implement whatsapp bot service using baileys ([9a7e6a8](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/9a7e6a83981c19cba1bc62d43bb8e89cadd3706d))
* **service:** track outgoing message ids to prevent feedback loops in self chat ([8c3b0a8](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/8c3b0a8c9873b78726656c2b71d658f86768a505))
* **service:** track token usage metrics and provide exact transaction timestamps to gemini ([f5fde6f](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/f5fde6f9844b424e6430ccbfa6536b4c7bc2389e))
* simplify user message error logs in main orchestrator ([d43afd9](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/d43afd96964e43bc366f257fcf605369bd57cf55))
* **types:** align record payload fields with wallet mcp schema ([58ee2f3](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/58ee2f351ddf7e24c61d1efe218603f44dd1cc55))
* **types:** define wallet mcp interfaces and transaction types ([573cb62](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/573cb6253eaaf0f41fb4295256fa0666bc27e72a))
* update response formatting and integrate application logger ([eb6e979](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/eb6e9791808db3a6e9f86a2f1d2e1a88635d6d23))
* **utils:** add application logger utility with timestamping ([c046cd3](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/c046cd39bcf23d3556a0fcd20ca1b270134cc1b7))
* **utils:** add concise error message formatter for console output ([f792412](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/f792412c6e1717f6b0b3afb9d0a7afdebadf703e))
* **utils:** add fast-path intent classifier for zero-token command detection ([f94d76c](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/f94d76c2ab93361d0d498055ef12ce13f5ac207e))
* **utils:** add fileDetail logging helper and payload formatter ([243068c](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/243068c0536ad913db876a4e3cad7b68020d2525))
* **utils:** add financial record validator and sanitizer ([cee8941](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/cee894113b50b2560220dce6bbbf19f54b975809))
* **utils:** add human-friendly response and error formatters for whatsapp ([7c4ccdb](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/7c4ccdb15827add4eca68b90a3ed74182e196a6e))
* **utils:** add persistent daily file logging and log rotation ([ca7fc4f](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/ca7fc4f7a81bf3ed6d94e94281ed05e8659aca6d))
* **utils:** display contextual transaction dates in whatsapp success replies ([b526cfe](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/b526cfea340e5762afd959e2417118128e4e9c28))
* **utils:** support index and fuzzy matching for account and category resolution ([06810ee](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/06810eea4f4332f8e8ec82fa7a0f6fa9aea26745))


### Bug Fixes

* **service:** improve wallet mcp account balance and currency resolution ([19b7fa2](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/19b7fa2577b347b02876ee423a3da5654ef4d69a))
* **service:** normalize midnight utc record dates to preserve transaction time ([4d2bc0e](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/4d2bc0eafa9c1001a99bcf10e461ee8609caa5d7))
* **service:** sanitize record payload before submitting to wallet mcp ([20345c2](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/20345c2e3e23fd44c1861647776523549a26e0fb))
* **utils:** improve visual hierarchy and mobile layout of whatsapp responses ([3044a8e](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/3044a8e7ca9498d65521875e480a2c287ae9d40f))

## 0.1.0 (2026-09-06)


### Features

* add comprehensive diagnostic file logging across bot execution pipeline ([ddc7f45](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/ddc7f45abaa2af165078cc32398633065ba2e24c))
* add real-time bank and e-wallet email sync via gmail imap idle ([#1](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/issues/1)) ([65543a8](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/65543a8065f2db58e2ee8fbb2b9ec9f559ab5507)), closes [#2](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/issues/2)
* **ai:** implement agnostic AI provider architecture ([#2](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/issues/2)) ([bb54434](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/bb54434408a8aac1232e4062efc9a3e50df65a8e))
* **ai:** summarize provider fallback error logs using concise error formatter ([a9808b1](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/a9808b1ce32ff6b673f27144de72f48e4b1bd07f))
* bootstrap application and start whatsapp bookkeeper bot ([9d9b154](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/9d9b154309d4d8d95c7556ef3e31d1da72ed0742))
* **config:** add gemini request timeout setting ([62a6b39](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/62a6b3900e76ce28aecbd471dc7d3fbaf031069f))
* **config:** implement environment configuration loader and validation ([93fa541](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/93fa541f48567e64fbfe6cc46b35217f4c8b0dba))
* **config:** normalize allowed phone number to numeric digits ([73d8b8d](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/73d8b8d9a33020d31bcd5df447efca5007537dac))
* **config:** support gemini fallback models and log retention setting ([b4921ff](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/b4921ffc96baccca683d4727f73c1cfc30273f21))
* display whatsapp typing indicator and enforce gemini request timeout ([c7e1b4d](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/c7e1b4d2a1866b3f437b09889a790f78b8dca8d9))
* enforce phone whitelist on startup and validate records before mcp dispatch ([d24a94c](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/d24a94cae4f2d50c2002ba06bf1eca80558b5fec))
* initialize gemini fallback models and auto-purge expired logs on startup ([9d5a38e](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/9d5a38e8e726983c067cc42700f384b79b876eb1))
* integrate human response formatters into whatsapp message handler ([6e516ad](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/6e516ad3f3d0d125b55bff001bc0eb0513af4fcb))
* **messaging:** add channel-agnostic bot architecture and Telegram bot integration ([f5fdacb](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/f5fdacb816dc0ae3084e8f9ff4be7504966412fc))
* **service:** add abort timeout and progress heartbeat to gemini request loop ([ee03c83](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/ee03c83b8b3f781a7ba65f81a0ef2637df3cfefc))
* **service:** add detailed file tracing for wallet mcp operations ([d51bed6](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/d51bed60f273986bcdcf03ac995e40fdcf7491cf))
* **service:** add file diagnostic logging to whatsapp bot lifecycle and messaging ([c07031b](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/c07031b5ab6869799f9d712d786268abfea7161b))
* **service:** add incoming message deduplication and strict whitelist validation ([d6fad09](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/d6fad09338031d41d5019bffce8b74552ffdfa15))
* **service:** add latency tracking and diagnostic file logging to gemini service ([946b7f2](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/946b7f2081efef52bd6472293980cd4bf707c9c5))
* **service:** add typing presence indicators to whatsapp bot ([e7d47bd](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/e7d47bd6987443d2ace3dc78bc1c431a86577a83))
* **service:** enhance whatsapp session management and message parsing ([5a54093](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/5a54093fa3586c19f67524aeac0c25f888bc36d6))
* **service:** harden gemini system prompt against injection and mask image logs ([2b87039](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/2b870399c4d2602aa21b4f3af6fa0055feba531a))
* **service:** implement automatic fallback cascade for gemini models ([a2b82a8](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/a2b82a8a92be066664b0cc2fd9e43ef00b47e30f))
* **service:** implement gemini ai service with function calling ([f5a251a](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/f5a251a1c94a80b0bd6de44e2f3fb7744757b8e1))
* **service:** implement wallet mcp client for api interactions ([0972ab5](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/0972ab5bbcaf013aacd1bdb0bdd46a8b043b6880))
* **service:** implement whatsapp bot service using baileys ([9a7e6a8](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/9a7e6a83981c19cba1bc62d43bb8e89cadd3706d))
* **service:** track outgoing message ids to prevent feedback loops in self chat ([8c3b0a8](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/8c3b0a8c9873b78726656c2b71d658f86768a505))
* **service:** track token usage metrics and provide exact transaction timestamps to gemini ([f5fde6f](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/f5fde6f9844b424e6430ccbfa6536b4c7bc2389e))
* simplify user message error logs in main orchestrator ([d43afd9](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/d43afd96964e43bc366f257fcf605369bd57cf55))
* **types:** align record payload fields with wallet mcp schema ([58ee2f3](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/58ee2f351ddf7e24c61d1efe218603f44dd1cc55))
* **types:** define wallet mcp interfaces and transaction types ([573cb62](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/573cb6253eaaf0f41fb4295256fa0666bc27e72a))
* update response formatting and integrate application logger ([eb6e979](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/eb6e9791808db3a6e9f86a2f1d2e1a88635d6d23))
* **utils:** add application logger utility with timestamping ([c046cd3](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/c046cd39bcf23d3556a0fcd20ca1b270134cc1b7))
* **utils:** add concise error message formatter for console output ([f792412](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/f792412c6e1717f6b0b3afb9d0a7afdebadf703e))
* **utils:** add fast-path intent classifier for zero-token command detection ([f94d76c](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/f94d76c2ab93361d0d498055ef12ce13f5ac207e))
* **utils:** add fileDetail logging helper and payload formatter ([243068c](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/243068c0536ad913db876a4e3cad7b68020d2525))
* **utils:** add financial record validator and sanitizer ([cee8941](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/cee894113b50b2560220dce6bbbf19f54b975809))
* **utils:** add human-friendly response and error formatters for whatsapp ([7c4ccdb](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/7c4ccdb15827add4eca68b90a3ed74182e196a6e))
* **utils:** add persistent daily file logging and log rotation ([ca7fc4f](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/ca7fc4f7a81bf3ed6d94e94281ed05e8659aca6d))
* **utils:** display contextual transaction dates in whatsapp success replies ([b526cfe](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/b526cfea340e5762afd959e2417118128e4e9c28))
* **utils:** support index and fuzzy matching for account and category resolution ([06810ee](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/06810eea4f4332f8e8ec82fa7a0f6fa9aea26745))


### Bug Fixes

* **service:** improve wallet mcp account balance and currency resolution ([19b7fa2](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/19b7fa2577b347b02876ee423a3da5654ef4d69a))
* **service:** normalize midnight utc record dates to preserve transaction time ([4d2bc0e](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/4d2bc0eafa9c1001a99bcf10e461ee8609caa5d7))
* **service:** sanitize record payload before submitting to wallet mcp ([20345c2](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/20345c2e3e23fd44c1861647776523549a26e0fb))
* **utils:** improve visual hierarchy and mobile layout of whatsapp responses ([3044a8e](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/commit/3044a8e7ca9498d65521875e480a2c287ae9d40f))
