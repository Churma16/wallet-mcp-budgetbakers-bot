import { describe, it, expect } from 'vitest';
import { extractCleanEmailBody } from '../src/email/index.js';

describe('extractCleanEmailBody (HTML to clean text extraction)', () => {
  it('strips heavy inline <style> CSS completely from HTML emails (e.g. Grab E-Receipt)', () => {
    const rawHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          table { border-collapse: collapse; }
          @media screen {
            .all-font-sans { font-family: Roboto, sans-serif !important; }
          }
          @media (max-width: 480px) {
            .sm-text-xl { font-size: 24px !important; }
            .gfb-ads-wrapper-mobile { display: none !important; }
          }
        </style>
      </head>
      <body>
        <h1>Grab E-Receipt</h1>
        <p>Booking ID: A-9VNE5TRGWUABAV</p>
        <table>
          <tr><td>Service:</td><td>GrabBike</td></tr>
          <tr><td>Pick-up:</td><td>Stasiun Gambir, Jl. Medan Merdeka Timur</td></tr>
          <tr><td>Drop-off:</td><td>Grand Indonesia, Jl. M.H. Thamrin</td></tr>
          <tr><td>Total Fare:</td><td>Rp 65.800</td></tr>
        </table>
      </body>
      </html>
    `;

    const cleanText = extractCleanEmailBody(undefined, rawHtml);

    // Must NOT contain CSS styling rules
    expect(cleanText).not.toContain('border-collapse');
    expect(cleanText).not.toContain('@media');
    expect(cleanText).not.toContain('.gfb-ads-wrapper-mobile');
    expect(cleanText).not.toContain('font-family');

    // Must contain essential receipt details including route
    expect(cleanText).toMatch(/grab e-receipt/i);
    expect(cleanText).toContain('A-9VNE5TRGWUABAV');
    expect(cleanText).toContain('GrabBike');
    expect(cleanText).toContain('Stasiun Gambir');
    expect(cleanText).toContain('Grand Indonesia');
    expect(cleanText).toContain('65.800');
  });

  it('strips <script> and image tags while preserving text formatting', () => {
    const rawHtml = `
      <div>
        <script>console.log("tracking pixel");</script>
        <img src="https://tracker.com/pixel.png" alt="tracker" />
        <p>Pembayaran Berhasil</p>
        <p>Merchant: <b>Kopi Kenangan</b></p>
      </div>
    `;

    const cleanText = extractCleanEmailBody(undefined, rawHtml);
    expect(cleanText).not.toContain('tracking pixel');
    expect(cleanText).not.toContain('pixel.png');
    expect(cleanText).toContain('Pembayaran Berhasil');
    expect(cleanText).toContain('Kopi Kenangan');
  });

  it('decodes HTML entities properly', () => {
    const rawHtml = '<p>Total &amp; Pajak: Rp&nbsp;50.000 &#40;Lunas&#41;</p>';
    const cleanText = extractCleanEmailBody(undefined, rawHtml);
    expect(cleanText).toContain('Total & Pajak: Rp 50.000 (Lunas)');
  });

  it('falls back to raw text when HTML is undefined or empty', () => {
    const rawText = 'Bank Jago: Anda telah melakukan transaksi Rp 65.800';
    const cleanText = extractCleanEmailBody(rawText, undefined);
    expect(cleanText).toBe(rawText);
  });

  it('handles empty inputs gracefully', () => {
    expect(extractCleanEmailBody(undefined, undefined)).toBe('');
    expect(extractCleanEmailBody('', '')).toBe('');
  });
});
