import { convertWhatsAppMarkupToTelegramHtml } from '../src/services/messaging/messageFormatHelper.js';

function runFormatTests(): void {
  console.log('Testing WhatsApp to Telegram HTML conversion:');

  const testCases = [
    {
      name: 'Bold and Italic',
      input: '✅ *Makan Siang* & _Kopi Susu_ berhasil dicatat!',
      expectedContains: ['<b>Makan Siang</b>', '&amp;', '<i>Kopi Susu</i>'],
    },
    {
      name: 'HTML brackets escaping',
      input: 'Perbandingan: <Rp 50.000> vs >Rp 20.000 & 10%',
      expectedContains: ['&lt;Rp 50.000&gt;', '&gt;Rp 20.000', '&amp; 10%'],
    },
    {
      name: 'Inline and multi-line code',
      input: 'Ref ID: `TRX12345`\n```sql\nSELECT * FROM table\n```',
      expectedContains: ['<code>TRX12345</code>', '<pre>sql\nSELECT * FROM table\n</pre>'],
    },
    {
      name: 'Strikethrough',
      input: 'Harga: ~Rp 100.000~ Rp 80.000',
      expectedContains: ['<s>Rp 100.000</s>'],
    },
  ];

  let allPassed = true;
  for (const testCase of testCases) {
    const output = convertWhatsAppMarkupToTelegramHtml(testCase.input);
    console.log(`\n[TEST] ${testCase.name}`);
    console.log(`Input:  ${testCase.input}`);
    console.log(`Output: ${output}`);

    for (const expected of testCase.expectedContains) {
      if (!output.includes(expected)) {
        console.error(`[FAIL] Expected output to contain "${expected}"`);
        allPassed = false;
      }
    }
  }

  if (allPassed) {
    console.log('\n[PASS] All format conversion tests passed!');
  } else {
    process.exit(1);
  }
}

runFormatTests();
