import { describe, it, expect } from 'vitest';
import { inferCategoryFromText, selectBestCategory } from '../src/brain/category/categoryScorer.js';
import type { WalletCategoryItem } from '../src/wallet/types.js';

describe('categoryScorer & inferCategoryFromText', () => {
  const sampleCategories: WalletCategoryItem[] = [
    {
      id: 'cat-food',
      name: 'Makanan & Minuman',
      group: { id: 'food', name: 'Food & Beverage' },
      isAssignable: true,
    },
    {
      id: 'cat-transport',
      name: 'Transportasi',
      group: { id: 'transport', name: 'Transportation' },
      isAssignable: true,
    },
    {
      id: 'cat-groceries',
      name: 'Belanja',
      group: { id: 'shopping', name: 'Shopping' },
      isAssignable: true,
    },
    {
      id: 'cat-health',
      name: 'Kesehatan',
      group: { id: 'health', name: 'Healthcare' },
      isAssignable: true,
    },
    {
      id: 'cat-bills',
      name: 'Tagihan & Utilitas',
      group: { id: 'bills', name: 'Bills' },
      isAssignable: true,
    },
    {
      id: 'cat-entertainment',
      name: 'Hiburan',
      group: { id: 'entertainment', name: 'Life & Entertainment' },
      isAssignable: true,
    },
    {
      id: 'cat-income',
      name: 'Pendapatan',
      group: { id: 'income', name: 'Income' },
      isAssignable: true,
    },
    {
      id: 'cat-system',
      name: 'System Category',
      group: { id: 'system_categories', name: 'System' },
      isAssignable: false,
    },
  ];

  describe('inferCategoryFromText', () => {
    it('infers Food & Drinks from coffee/food notes', () => {
      const match1 = inferCategoryFromText('Kopi Kenangan Mantan', sampleCategories);
      expect(match1?.id).toBe('cat-food');

      const match2 = inferCategoryFromText('Nasi Padang Rendang', sampleCategories);
      expect(match2?.id).toBe('cat-food');

      const match3 = inferCategoryFromText('Makan siang di Warteg', sampleCategories);
      expect(match3?.id).toBe('cat-food');

      const match4 = inferCategoryFromText('Starbucks latte', sampleCategories);
      expect(match4?.id).toBe('cat-food');
    });

    it('infers Transport from fuel, ridehailing, and transport notes', () => {
      const match1 = inferCategoryFromText('Beli Pertamax di SPBU', sampleCategories);
      expect(match1?.id).toBe('cat-transport');

      const match2 = inferCategoryFromText('GrabCar ke stasiun', sampleCategories);
      expect(match2?.id).toBe('cat-transport');

      const match3 = inferCategoryFromText('Tiket KRL Commuter Line', sampleCategories);
      expect(match3?.id).toBe('cat-transport');

      const match4 = inferCategoryFromText('Parkir mall', sampleCategories);
      expect(match4?.id).toBe('cat-transport');
    });

    it('infers Healthcare from pharmacy and medicine notes', () => {
      const match1 = inferCategoryFromText('Beli obat batuk di Apotek Kimia Farma', sampleCategories);
      expect(match1?.id).toBe('cat-health');

      const match2 = inferCategoryFromText('Konsultasi dokter Halodoc', sampleCategories);
      expect(match2?.id).toBe('cat-health');
    });

    it('infers Bills & Utilities from electricity, internet, and phone credit', () => {
      const match1 = inferCategoryFromText('Token Listrik PLN', sampleCategories);
      expect(match1?.id).toBe('cat-bills');

      const match2 = inferCategoryFromText('Pulsa Telkomsel bulanan', sampleCategories);
      expect(match2?.id).toBe('cat-bills');

      const match3 = inferCategoryFromText('Tagihan WiFi IndiHome', sampleCategories);
      expect(match3?.id).toBe('cat-bills');
    });

    it('infers Shopping & Groceries from supermarket and e-commerce notes', () => {
      const match1 = inferCategoryFromText('Indomaret jajan bulanan', sampleCategories);
      expect(match1?.id).toBe('cat-groceries');

      const match2 = inferCategoryFromText('Belanja di Tokopedia', sampleCategories);
      expect(match2?.id).toBe('cat-groceries');
    });

    it('infers Entertainment from movie and streaming notes', () => {
      const match = inferCategoryFromText('Langganan Netflix bulanan', sampleCategories);
      expect(match?.id).toBe('cat-entertainment');
    });

    it('infers Income from salary notes', () => {
      const match = inferCategoryFromText('Gaji bulanan kantor', sampleCategories);
      expect(match?.id).toBe('cat-income');
    });

    it('returns undefined for empty, whitespace, or unclassifiable text', () => {
      expect(inferCategoryFromText('', sampleCategories)).toBeUndefined();
      expect(inferCategoryFromText('   ', sampleCategories)).toBeUndefined();
      expect(inferCategoryFromText(undefined, sampleCategories)).toBeUndefined();
      expect(inferCategoryFromText('xyz123abc 9999', sampleCategories)).toBeUndefined();
    });

    it('never assigns system categories even if tokens collide', () => {
      const match = inferCategoryFromText('system', sampleCategories);
      expect(match?.id).not.toBe('cat-system');
    });
  });

  describe('selectBestCategory handling of c:auto sentinel hint', () => {
    it('ignores categoryHint when given "auto" or "otomatis" to prevent searching for "auto"', () => {
      const match = selectBestCategory('auto', [], sampleCategories, 'Beli Pertamax');
      expect(match?.id).toBe('cat-transport');
    });
  });
});
