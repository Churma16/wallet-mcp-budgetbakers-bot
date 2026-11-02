import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  maskSensitiveValue,
  maskAccountNumbersAndPansInString,
  sanitizeSensitiveLogPayload,
  sanitizeLogArgument,
  formatConciseErrorMessage,
  applicationLogger,
} from '../src/lib/logger.js';

describe('logger sanitizer and sensitive value masking', () => {
  describe('maskSensitiveValue', () => {
    it.each([
      ['12-digit bank account number', '507431877335', '5074****7335'],
      ['numeric 12-digit bank account number', 507431877335, '5074****7335'],
      ['13-digit Mandiri bank account number', '1200012497769', '1200****7769'],
      ['19-digit customer PAN', '9360000801144353984', '9360****3984'],
      ['19-digit merchant PAN', '9360054217431877335', '9360****7335'],
      ['hyphenated bank account number', '5074-3187-7335', '5074****7335'],
      ['space-separated bank account number', '5074 3187 7335', '5074****7335'],
      ['bank labeled account string', 'BCA 507431877335', 'BCA 5074****7335'],
      ['short 4-digit code', '1234', '****'],
      ['already masked value', '5074****7335', '5074****7335'],
    ])('masks %s correctly', (_description, input, expectedMasked) => {
      expect(maskSensitiveValue(input)).toBe(expectedMasked);
    });
  });

  describe('maskAccountNumbersAndPansInString', () => {
    it('masks multiple account numbers in continuous text', () => {
      const sentence = 'Transfer dari rekening 507431877335 ke rekening Mandiri 1200012497769 berhasil.';
      const result = maskAccountNumbersAndPansInString(sentence);

      expect(result).toContain('5074****7335');
      expect(result).toContain('1200****7769');
      expect(result).not.toContain('507431877335');
      expect(result).not.toContain('1200012497769');
    });

    it('masks embedded JSON sensitive keys in strings', () => {
      const jsonString = '{"bankAccountNumber": "507431877335", "pan": "9360000801144353984"}';
      const result = maskAccountNumbersAndPansInString(jsonString);

      expect(result).toContain('"bankAccountNumber": "5074****7335"');
      expect(result).toContain('"pan": "9360****3984"');
    });

    it('preserves WhatsApp user JID and email addresses without masking digits', () => {
      const jidString = 'User sender: 6281234567890@s.whatsapp.net incoming';
      expect(maskAccountNumbersAndPansInString(jidString)).toContain('6281234567890@s.whatsapp.net');

      const emailString = 'Alert sent to finance.user1234567890@example.com for verification';
      expect(maskAccountNumbersAndPansInString(emailString)).toContain('finance.user1234567890@example.com');
    });

    it('preserves short numbers below 10 digits and overlong 20-digit numbers', () => {
      const shortNumber = 'Invoice INV-123456789 processed';
      expect(maskAccountNumbersAndPansInString(shortNumber)).toBe(shortNumber);

      const overlong = 'Checksum 12345678901234567890 valid';
      expect(maskAccountNumbersAndPansInString(overlong)).toBe(overlong);
    });
  });

  describe('key-based masking in sanitizeSensitiveLogPayload', () => {
    it('recognizes sensitive account and PAN keys across casings and formats', () => {
      const sensitiveKeysPayload = {
        bankAccountNumber: '507431877335',
        accountNumber: 1200012497769,
        customerPan: '9360000801144353984',
        merchantPan: 9360054217431877335n,
        pan: '9360000801144353984',
        sourceOfFund: 'BCA 507431877335',
        bank_account_number: '507431877335',
      };

      const result = sanitizeSensitiveLogPayload(sensitiveKeysPayload) as Record<string, unknown>;

      expect(result.bankAccountNumber).toBe('5074****7335');
      expect(result.accountNumber).toBe('1200****7769');
      expect(result.customerPan).toBe('9360****3984');
      expect(result.merchantPan).toBe('9360****7335');
      expect(result.pan).toBe('9360****3984');
      expect(result.sourceOfFund).toBe('BCA 5074****7335');
      expect(result.bank_account_number).toBe('5074****7335');
    });

    it('preserves non-sensitive metadata, amounts, balances, IDs, and timestamps', () => {
      const nonSensitivePayload = {
        amount: 15000000000,
        balance: 25000000000,
        spentAmount: 5000000000,
        limitAmount: 50000000000,
        id: '123456789012',
        accountId: 'acc-jago-expense',
        transactionId: '123456789012',
        recordId: '123456789012',
        categoryId: 'cat-groceries',
        categoryName: 'Food & Beverage',
        timestamp: 1773064485000,
        mtimeMs: 1773064485000,
      };

      const result = sanitizeSensitiveLogPayload(nonSensitivePayload) as typeof nonSensitivePayload;

      expect(result.amount).toBe(15000000000);
      expect(result.balance).toBe(25000000000);
      expect(result.spentAmount).toBe(5000000000);
      expect(result.limitAmount).toBe(50000000000);
      expect(result.transactionId).toBe('123456789012');
      expect(result.recordId).toBe('123456789012');
      expect(result.accountId).toBe('acc-jago-expense');
      expect(result.categoryName).toBe('Food & Beverage');
      expect(result.timestamp).toBe(1773064485000);
    });
  });

  describe('nested structures, arrays, and error traversal', () => {
    it('traverses nested objects and arrays masking sensitive fields in place', () => {
      const mcpResponse = {
        accounts: [
          {
            id: 'acc-bca-checking',
            name: 'BCA Tahapan',
            currency: 'IDR',
            balance: 12500000,
            bankAccountNumber: '507431877335',
          },
          {
            id: 'acc-mandiri-tabungan',
            name: 'Mandiri Payroll',
            currency: 'IDR',
            balance: 45000000,
            bankAccountNumber: '1200012497769',
          },
        ],
        metadata: {
          totalAccounts: 2,
          lastSyncTimestamp: 1773064485000,
          auditNote: 'Customer PAN 9360000801144353984 attached to profile',
        },
      };

      const result = sanitizeSensitiveLogPayload(mcpResponse) as typeof mcpResponse;

      expect(result.accounts[0].bankAccountNumber).toBe('5074****7335');
      expect(result.accounts[1].bankAccountNumber).toBe('1200****7769');
      expect(result.accounts[0].balance).toBe(12500000);
      expect(result.metadata.auditNote).toContain('9360****3984');
      expect(result.metadata.auditNote).not.toContain('9360000801144353984');
    });

    it('masks sensitive details in error message, stack trace, and custom properties', () => {
      const errorWithSensitiveDetails = new Error(
        'Payment gateway rejected PAN 9360000801144353984 for account 507431877335'
      );
      (errorWithSensitiveDetails as unknown as Record<string, unknown>).customAccountPayload = {
        accountNumber: '1200012497769',
      };

      const result = sanitizeSensitiveLogPayload(errorWithSensitiveDetails) as Error & {
        customAccountPayload?: { accountNumber: string };
      };

      expect(result.message).toContain('9360****3984');
      expect(result.message).toContain('5074****7335');
      expect(result.message).not.toContain('9360000801144353984');
      expect(result.message).not.toContain('507431877335');

      expect(result.stack).toBeDefined();
      expect(result.stack).not.toContain('9360000801144353984');
      expect(result.stack).not.toContain('507431877335');

      expect(result.customAccountPayload?.accountNumber).toBe('1200****7769');
    });

    it('handles circular references safely by substituting [CIRCULAR]', () => {
      const circularRoot: Record<string, unknown> = {
        title: 'Circular Reference Test',
        account: {
          bankAccountNumber: '507431877335',
        },
      };
      circularRoot.self = circularRoot;
      (circularRoot.account as Record<string, unknown>).parent = circularRoot;

      let result: Record<string, unknown> = {};
      expect(() => {
        result = sanitizeSensitiveLogPayload(circularRoot) as Record<string, unknown>;
      }).not.toThrow();

      expect((result.account as Record<string, unknown>)?.bankAccountNumber).toBe('5074****7335');
      expect(result.self).toBe('[CIRCULAR]');
      expect((result.account as Record<string, unknown>)?.parent).toBe('[CIRCULAR]');
    });

    it('delegates sanitizeLogArgument to sanitizeSensitiveLogPayload', () => {
      const legacyPayload = {
        bankAccountNumber: '507431877335',
        note: 'Payment to 9360054217431877335',
      };

      const result = sanitizeLogArgument(legacyPayload) as typeof legacyPayload;
      expect(result.bankAccountNumber).toBe('5074****7335');
      expect(result.note).toContain('9360****7335');
    });
  });

  describe('fileDetail logger disk output verification', () => {
    it('writes masked entries to the log file on disk without plain account numbers or PANs', () => {
      const logDir = path.resolve(process.cwd(), 'logs');
      const currentDate = new Date();
      const yearString = currentDate.getFullYear();
      const monthString = String(currentDate.getMonth() + 1).padStart(2, '0');
      const dayString = String(currentDate.getDate()).padStart(2, '0');
      const todayLogFilePath = path.join(logDir, `app-${yearString}-${monthString}-${dayString}.log`);

      const uniqueTestMarker = `SANITIZER_LOG_ENTRY_${Math.random().toString(36).slice(2, 8)}`;
      applicationLogger.fileDetail('mcp', `Test MCP Account Dispatch [${uniqueTestMarker}]`, {
        accountList: [
          {
            accountName: 'BCA Tahapan Gold',
            bankAccountNumber: '507431877335',
            customerPan: '9360000801144353984',
          },
        ],
      });

      expect(fs.existsSync(todayLogFilePath)).toBe(true);
      const fileLogContent = fs.readFileSync(todayLogFilePath, 'utf-8');
      const markerIndex = fileLogContent.lastIndexOf(uniqueTestMarker);
      expect(markerIndex).not.toBe(-1);

      const targetLogBlock = fileLogContent.slice(markerIndex);
      expect(targetLogBlock).toContain('5074****7335');
      expect(targetLogBlock).toContain('9360****3984');
      expect(targetLogBlock).not.toContain('507431877335');
      expect(targetLogBlock).not.toContain('9360000801144353984');
    });
  });

  describe('formatConciseErrorMessage', () => {
    it('extracts embedded JSON error objects and summarizes status codes and reasons', () => {
      const embedded503 = 'Request failed with status 503: {"error":{"code":503,"message":"Model busy","status":"UNAVAILABLE"}}';
      expect(formatConciseErrorMessage(embedded503)).toBe('Model high demand / Temporarily unavailable (503 UNAVAILABLE)');

      const embedded429 = 'Upstream returned {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Quota reached"}}';
      expect(formatConciseErrorMessage(embedded429)).toBe('Rate limit / Quota exceeded (429 RESOURCE_EXHAUSTED)');
    });

    it('falls back to substring heuristics for non-JSON or unstructured errors', () => {
      expect(formatConciseErrorMessage(new Error('Upstream gateway 504 deadline exceeded'))).toBe('Gateway timeout (504)');
      expect(formatConciseErrorMessage('Unexpected body {"status":"OK"} with 404 payload')).toBe('Model not found (404)');
    });
  });
});
