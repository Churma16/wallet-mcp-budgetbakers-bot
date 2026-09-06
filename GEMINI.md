# Project Rules - wallet_mcp

## Emoji Usage Allowed
In this project (`wallet_mcp`), raw emojis are **explicitly allowed** in the codebase.
- **WhatsApp Chat & Templates**: Raw emojis (e.g., 👋, ✅, ⚠️, 📊, 📈, 💰) are permitted in WhatsApp messages, user-facing formatting templates, and bot replies.
- **Exceptions**: Maintain standard alphanumeric conventions for identifiers, functions, variables, and API contracts.
- **Precedence**: This overrides the global "No Emojis in Codebase" rule for this project repository only.

## Personal Project - No JIRA Required
This repository (`wallet_mcp`) is a personal project, not an enterprise/company project.
- **No JIRA ID Required**: Do not prompt the user for a JIRA ticket ID when creating/switching branches, writing commit messages, or generating PR descriptions.
- **Branch Naming**: Use standard descriptive kebab-cased branch names without JIRA ticket prefixes:
  `<branch-type>/<short-kebab-description>`
  *Examples*: `feature/email-bank-sync`, `fix/token-timeout`, `chore/update-readme`
- **Commit Messages**: Follow standard Conventional Commits format (e.g. `feat: add email bank sync`, `fix: ...`, `refactor: ...`) without `[JIRA-ID]` prefix.
- **Precedence**: This overrides the global `git-branch-commit-rules` JIRA ID requirement for this repository only.

