import { describe, expect, it } from 'vitest';
import { formatTelegramHtml } from '../src/gateway/telegram.js';

describe('formatTelegramHtml', () => {
  it.each([
    {
      name: 'bold and italic markup',
      input: '✅ *Makan Siang* & _Kopi Susu_ berhasil dicatat!',
      expectedContains: ['<b>Makan Siang</b>', '&amp;', '<i>Kopi Susu</i>'],
    },
    {
      name: 'HTML bracket escaping',
      input: 'Perbandingan: <Rp 50.000> vs >Rp 20.000 & 10%',
      expectedContains: ['&lt;Rp 50.000&gt;', '&gt;Rp 20.000', '&amp; 10%'],
    },
    {
      name: 'inline and multi-line code',
      input: 'Ref ID: `TRX12345`\n```sql\nSELECT * FROM table\n```',
      expectedContains: ['<code>TRX12345</code>', '<pre>sql\nSELECT * FROM table\n</pre>'],
    },
    {
      name: 'strikethrough markup',
      input: 'Harga: ~Rp 100.000~ Rp 80.000',
      expectedContains: ['<s>Rp 100.000</s>'],
    },
    {
      name: 'bold with trailing colon in quick commands and bullet lists',
      input: 'Perintah Cepat:\n• Saldo / *Cek Saldo*: Cek saldo semua rekening\n• Budget / *Cek Budget*: Cek status limit anggaran',
      expectedContains: [
        '• Saldo / <b>Cek Saldo</b>: Cek saldo semua rekening',
        '• Budget / <b>Cek Budget</b>: Cek status limit anggaran',
      ],
    },
    {
      name: 'bold account items with colon in balance breakdown',
      input: '📊 *Saldo Rekening* (01:07 WIB)\n\n• *BNI Tapcash*: Rp 37.500\n• *Cash*: Rp 206.750\n• *Dana*: Rp 1.324',
      expectedContains: [
        '📊 <b>Saldo Rekening</b> (01:07 WIB)',
        '• <b>BNI Tapcash</b>: Rp 37.500',
        '• <b>Cash</b>: Rp 206.750',
        '• <b>Dana</b>: Rp 1.324',
      ],
    },
    {
      name: 'budget status items with nested parens and trailing colons',
      input: '• *Makan Hangout*: Rp 0 / Rp 450.000 (sisa Rp 450.000)\n• *Makan Nafsu Ngemil (1m)*: Rp 0 / Rp 600.000 (sisa Rp 600.000)',
      expectedContains: [
        '• <b>Makan Hangout</b>: Rp 0 / Rp 450.000 (sisa Rp 450.000)',
        '• <b>Makan Nafsu Ngemil (1m)</b>: Rp 0 / Rp 600.000 (sisa Rp 600.000)',
      ],
    },
    {
      name: 'punctuation boundaries with semicolon, brackets, and quotes',
      input: 'Tipe: [*Penting*]; status: "*Aktif*"; catatan: _Rutin_; diskon: ~10%~;',
      expectedContains: [
        '[<b>Penting</b>];',
        '"<b>Aktif</b>";',
        '<i>Rutin</i>;',
        '<s>10%</s>;',
      ],
    },
  ])('$name', ({ input, expectedContains }) => {
    const output = formatTelegramHtml(input);

    for (const expected of expectedContains) {
      expect(output).toContain(expected);
    }
  });

  it('preserves non-markup characters and variable names without conversion', () => {
    expect(formatTelegramHtml('5 * 5 = 25')).toBe('5 * 5 = 25');
    expect(formatTelegramHtml('user_name_variable')).toBe('user_name_variable');
    expect(formatTelegramHtml('https://example.com/some_path_here')).toBe('https://example.com/some_path_here');
    expect(formatTelegramHtml('* item 1\n* item 2')).toBe('* item 1\n* item 2');
    expect(formatTelegramHtml('test * not bold * test')).toBe('test * not bold * test');
    expect(formatTelegramHtml('test _ not italic _ test')).toBe('test _ not italic _ test');
  });
});
