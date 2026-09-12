import { describe, expect, it } from 'vitest';
import { convertWhatsAppMarkupToTelegramHtml } from '../src/services/messaging/messageFormatHelper.js';

describe('convertWhatsAppMarkupToTelegramHtml', () => {
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
  ])('$name', ({ input, expectedContains }) => {
    const output = convertWhatsAppMarkupToTelegramHtml(input);

    for (const expected of expectedContains) {
      expect(output).toContain(expected);
    }
  });
});
