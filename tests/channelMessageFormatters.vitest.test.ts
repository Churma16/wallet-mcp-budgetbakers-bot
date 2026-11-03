import { describe, expect, it } from 'vitest';
import {
  formatTelegramHtml,
  formatWhatsAppMarkdown,
  formatConsolePlainText,
  formatMessageForChannel,
  decodeHtmlEntities,
  stripHtmlTags,
  TelegramMessageFormatter,
  WhatsAppMessageFormatter,
  ConsoleMessageFormatter,
} from '../src/gateway/formatters/index.js';

describe('Channel Message Formatters Architecture', () => {
  describe('TelegramMessageFormatter', () => {
    const formatter = new TelegramMessageFormatter();

    it('has channelName set to telegram', () => {
      expect(formatter.channelName).toBe('telegram');
    });

    it('converts both standard and WhatsApp bold into Telegram HTML', () => {
      expect(formatTelegramHtml('**Penting** dan *Saldo*')).toBe('<b>Penting</b> dan <b>Saldo</b>');
    });

    it('converts strikethrough (single and double tildes)', () => {
      expect(formatTelegramHtml('~diskon 10%~ dan ~~diskon 20%~~')).toBe('<s>diskon 10%</s> dan <s>diskon 20%</s>');
    });

    it('supports delimiter and punctuation boundaries like colons, brackets, and quotes', () => {
      const input = '• *BNI Tapcash*: Rp 37.500\nStatus: [*Aktif*]; catatan: "*Rutin*"';
      const output = formatTelegramHtml(input);
      expect(output).toContain('• <b>BNI Tapcash</b>: Rp 37.500');
      expect(output).toContain('Status: [<b>Aktif</b>];');
      expect(output).toContain('catatan: "<b>Rutin</b>"');
    });

    it('safely escapes HTML characters and converts code blocks', () => {
      const input = '<Rp 50.000> & `inline code`\n```json\n{"k":"v"}\n```';
      const output = formatTelegramHtml(input);
      expect(output).toContain('&lt;Rp 50.000&gt; &amp; <code>inline code</code>');
      expect(output).toContain('<pre>json\n{"k":"v"}\n</pre>');
    });

    it('preserves non-markup characters and formulas', () => {
      expect(formatTelegramHtml('5 * 5 = 25')).toBe('5 * 5 = 25');
      expect(formatTelegramHtml('variable_name_key')).toBe('variable_name_key');
      expect(formatTelegramHtml('https://example.com/api_path')).toBe('https://example.com/api_path');
    });

    it('returns empty string for empty input', () => {
      expect(formatTelegramHtml('')).toBe('');
    });
  });

  describe('WhatsAppMessageFormatter', () => {
    const formatter = new WhatsAppMessageFormatter();

    it('has channelName set to whatsapp', () => {
      expect(formatter.channelName).toBe('whatsapp');
    });

    it('converts double-asterisk Markdown bold to WhatsApp single-asterisk bold', () => {
      const input = '**Peringatan:** Saldo Anda menipis!';
      expect(formatWhatsAppMarkdown(input)).toBe('*Peringatan:* Saldo Anda menipis!');
    });

    it('converts double-tilde Markdown strikethrough to WhatsApp single-tilde strikethrough', () => {
      const input = 'Harga: ~~Rp 50.000~~ Rp 30.000';
      expect(formatWhatsAppMarkdown(input)).toBe('Harga: ~Rp 50.000~ Rp 30.000');
    });

    it('converts HTML formatting tags to native WhatsApp markdown', () => {
      const input = '<b>Penting</b>, <i>Miring</i>, <s>Coret</s>, dan <code>Kode</code>';
      expect(formatWhatsAppMarkdown(input)).toBe('*Penting*, _Miring_, ~Coret~, dan `Kode`');
    });

    it('converts pre/code blocks and decodes entities', () => {
      const input = 'Saldo &lt;50rb&gt; &amp; <pre>SELECT * FROM accounts</pre>';
      expect(formatWhatsAppMarkdown(input)).toBe('Saldo <50rb> & ```SELECT * FROM accounts```');
    });

    it('preserves native WhatsApp formatting unharmed', () => {
      const input = '• *Cash*: Rp 200.000 _(sisa limit)_ ~Rp 10.000~';
      expect(formatWhatsAppMarkdown(input)).toBe('• *Cash*: Rp 200.000 _(sisa limit)_ ~Rp 10.000~');
    });

    it('returns empty string for empty input', () => {
      expect(formatWhatsAppMarkdown('')).toBe('');
    });
  });

  describe('ConsoleMessageFormatter', () => {
    const formatter = new ConsoleMessageFormatter();

    it('has channelName set to console', () => {
      expect(formatter.channelName).toBe('console');
    });

    it('unwraps bold, italic, and strikethrough markers for clean terminal output', () => {
      const input = '• *BNI Tapcash*: Rp 37.500 _(sisa 10rb)_ ~diskon~';
      expect(formatConsolePlainText(input)).toBe('• BNI Tapcash: Rp 37.500 (sisa 10rb) diskon');
    });

    it('unwraps double-asterisk bold and double-tilde strikethrough', () => {
      const input = '**Penting:** ~~100rb~~ 50rb';
      expect(formatConsolePlainText(input)).toBe('Penting: 100rb 50rb');
    });

    it('strips HTML tags and decodes entities', () => {
      const input = '<b>Title</b>: &lt;data&gt; &amp; info';
      expect(formatConsolePlainText(input)).toBe('Title: <data> & info');
    });

    it('returns empty string for empty input', () => {
      expect(formatConsolePlainText('')).toBe('');
    });
  });

  describe('formatMessageForChannel Dispatcher', () => {
    it('routes correctly to telegram, whatsapp, and console formatters', () => {
      const input = '• **Total**: *Rp 100.000*';

      expect(formatMessageForChannel('telegram', input)).toBe('• <b>Total</b>: <b>Rp 100.000</b>');
      expect(formatMessageForChannel('whatsapp', input)).toBe('• *Total*: *Rp 100.000*');
      expect(formatMessageForChannel('console', input)).toBe('• Total: Rp 100.000');
    });

    it('returns source text unchanged for unrecognized channel', () => {
      expect(formatMessageForChannel('unknown' as any, 'Raw Text')).toBe('Raw Text');
    });
  });

  describe('HTML Security Utilities (Single-Pass Decoding & Iterative Stripping)', () => {
    it('decodes entities in a single pass preventing double-unescaping', () => {
      expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;');
      expect(decodeHtmlEntities('&lt;b&gt;Hello &amp; World&lt;/b&gt;')).toBe('<b>Hello & World</b>');
      expect(decodeHtmlEntities('')).toBe('');
    });

    it('iteratively strips nested HTML tags to fixed point', () => {
      expect(stripHtmlTags('<<script>script>evil()</script>')).toBe('evil()');
      expect(stripHtmlTags('<b<b>>nested</b> text')).toBe('nested text');
      expect(stripHtmlTags('')).toBe('');
    });
  });
});
