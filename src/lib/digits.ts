/**
 * Removes every non-ASCII digit while preserving digit order.
 */
export function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}
