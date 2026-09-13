import { describe, expect, it } from 'vitest';
import {
  detectFastPathAction,
  detectReconciliationAction,
} from '../src/utils/fastPathIntentDetector.js';

describe('PR #155 reconciliation detector coverage', () => {
  it.each([
    ['sudah ada', 'CONFIRM_RECORDED', undefined],
    ['sudah ada #7', 'CONFIRM_RECORDED', 7],
    ['sudah ada 8', 'CONFIRM_RECORDED', 8],
    ['belum ada', 'CONFIRM_ABSENT', undefined],
    ['belum ada #9', 'CONFIRM_ABSENT', 9],
    ['already exists', 'CONFIRM_RECORDED', undefined],
    ['already exist #10', 'CONFIRM_RECORDED', 10],
    ['not there', 'CONFIRM_ABSENT', undefined],
    ['not there 11', 'CONFIRM_ABSENT', 11],
  ] as const)('parses canonical reconciliation command %s', (input, actionType, ticketId) => {
    expect(detectReconciliationAction(input)).toEqual(
      ticketId === undefined ? { actionType } : { actionType, targetTicketId: ticketId }
    );
  });

  it.each([
    'ada',
    'sudah',
    'belum',
    'missing',
    'not yet',
    'already recorded',
    'already there',
    'sudah masuk',
    'belum masuk',
    'tidak ada',
    'confirm recorded 3',
    'confirm absent 3',
    'halo bot',
  ])('rejects non-protocol semantic alias %s', input => {
    expect(detectReconciliationAction(input)).toBeNull();
  });

  it('rejects invalid input and non-positive ticket ids', () => {
    expect(detectReconciliationAction('')).toBeNull();
    expect(detectReconciliationAction(undefined as any)).toBeNull();
    expect(detectReconciliationAction(123 as any)).toBeNull();
    expect(detectReconciliationAction('sudah ada #0')).toBeNull();
    expect(detectReconciliationAction('belum ada 0')).toBeNull();
    expect(detectReconciliationAction('  SUDAH ADA #31  ')).toEqual({
      actionType: 'CONFIRM_RECORDED',
      targetTicketId: 31,
    });
  });

  it.each([
    'pending',
    'pending transaksi',
    'cek pending',
    'queue transaksi',
    'view queue',
    'check status',
    'view status transaksi',
    'lihat status antrian',
  ])('covers CHECK_QUEUE protocol variant %s', input => {
    expect(detectFastPathAction(input)).toBe('CHECK_QUEUE');
  });
});
