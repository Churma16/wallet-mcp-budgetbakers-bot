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
    ['ada', 'CONFIRM_RECORDED'],
    ['sudah', 'CONFIRM_RECORDED'],
    ['already recorded', 'CONFIRM_RECORDED'],
    ['already there', 'CONFIRM_RECORDED'],
    ['sudah masuk', 'CONFIRM_RECORDED'],
    ['belum', 'CONFIRM_ABSENT'],
    ['missing', 'CONFIRM_ABSENT'],
    ['not yet', 'CONFIRM_ABSENT'],
    ['belum masuk', 'CONFIRM_ABSENT'],
    ['tidak ada', 'CONFIRM_ABSENT'],
  ] as const)('keeps exact legacy detector alias %s for direct-call compatibility', (input, actionType) => {
    expect(detectReconciliationAction(input)).toEqual({ actionType });
  });

  it.each([
    ['sudah 3', 'CONFIRM_RECORDED', 3],
    ['ada #4', 'CONFIRM_RECORDED', 4],
    ['exists 5', 'CONFIRM_RECORDED', 5],
    ['confirm recorded 6', 'CONFIRM_RECORDED', 6],
    ['belum #7', 'CONFIRM_ABSENT', 7],
    ['confirm absent 8', 'CONFIRM_ABSENT', 8],
  ] as const)('keeps finite numbered legacy detector form %s', (input, actionType, targetTicketId) => {
    expect(detectReconciliationAction(input)).toEqual({ actionType, targetTicketId });
  });

  it('rejects invalid input, unrelated text, and non-positive ticket ids', () => {
    expect(detectReconciliationAction('')).toBeNull();
    expect(detectReconciliationAction(undefined as any)).toBeNull();
    expect(detectReconciliationAction(123 as any)).toBeNull();
    expect(detectReconciliationAction('halo bot')).toBeNull();
    expect(detectReconciliationAction('sudah ada #0')).toBeNull();
    expect(detectReconciliationAction('belum 0')).toBeNull();
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
