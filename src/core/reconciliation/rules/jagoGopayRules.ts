import type { BankMutationItem, ReconciliationRule } from '../types.js';

/**
 * Built-in rule: Bank Jago x GoPay Direct Debit integration.
 * In Bank Jago mutations, Gojek payments (GoRide, GoFood, etc.) are labeled as "GoPay".
 * This rule enriches the counterparty and recommends the primary Transportation category.
 */
export const jagoGopayRule: ReconciliationRule = {
  id: 'jago-statement-gopay-flow',
  name: 'Bank Jago GoPay Integration',
  enabled: true,

  targetWalletFilter(walletName: string): boolean {
    return /jago/i.test(walletName);
  },

  matchMutation(mutation: BankMutationItem): boolean {
    return /gopay/i.test(mutation.counterParty) || /gopay/i.test(mutation.note || '');
  },

  applyTransform(_mutation: BankMutationItem) {
    return {
      counterParty: 'Gojek via Jago',
      categoryHint: 'Transportasi',
      note: 'Gojek via Jago',
    };
  },
};

export const activeReconciliationRules: readonly ReconciliationRule[] = [
  jagoGopayRule,
];

/**
 * Applies all active, matching reconciliation rules to the raw bank mutation items.
 */
export function applyReconciliationRules(
  targetWalletName: string,
  mutations: readonly BankMutationItem[],
  customRules: readonly ReconciliationRule[] = activeReconciliationRules
): BankMutationItem[] {
  const applicableRules = customRules.filter(
    rule => rule.enabled && rule.targetWalletFilter(targetWalletName)
  );

  if (applicableRules.length === 0) {
    return [...mutations];
  }

  return mutations.map(mutation => {
    let transformed: BankMutationItem = { ...mutation };

    for (const rule of applicableRules) {
      if (rule.matchMutation(transformed)) {
        const result = rule.applyTransform(transformed);
        transformed = {
          ...transformed,
          counterParty: result.counterParty || transformed.counterParty,
          note: result.note || transformed.note,
        };
      }
    }

    return transformed;
  });
}
