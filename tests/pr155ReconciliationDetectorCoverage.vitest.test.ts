import { describe, expect, it } from 'vitest';
import {
  detectFastPathAction,
  detectReconciliationAction,
} from '../src/utils/fastPathIntentDetector.js';

describe('PR #155 reconciliation detector branch coverage', () => {
  it.each([
    ['sudah ada 1', 'CONFIRM_RECORDED', 1],
    ['sudah masuk #2', 'CONFIRM_RECORDED', 2],
    ['already exists 3', 'CONFIRM_RECORDED', 3],
    ['already exist #4', 'CONFIRM_RECORDED', 4],
    ['already recorded 5', 'CONFIRM_RECORDED', 5],
    ['already there #6', 'CONFIRM_RECORDED', 6],
    ['already in wallet 7', 'CONFIRM_RECORDED', 7],
    ['confirm recorded #8', 'CONFIRM_RECORDED', 8],
    ['belum ada 9', 'CONFIRM_ABSENT', 9],
    ['belum masuk #10', 'CONFIRM_ABSENT', 10],
    ['tidak ada 11', 'CONFIRM_ABSENT', 11],
    ['ga ada #12', 'CONFIRM_ABSENT', 12],
    ['gak ada 13', 'CONFIRM_ABSENT', 13],
    ['not there #14', 'CONFIRM_ABSENT', 14],
    ['not yet 15', 'CONFIRM_ABSENT', 15],
    ['not recorded #16', 'CONFIRM_ABSENT', 16],
    ['not in wallet 17', 'CONFIRM_ABSENT', 17],
    ['missing #18', 'CONFIRM_ABSENT', 18],
    ['not found 19', 'CONFIRM_ABSENT', 19],
    ['confirm absent #20', 'CONFIRM_ABSENT', 20],
    ['sudah 21', 'CONFIRM_RECORDED', 21],
    ['ada #22', 'CONFIRM_RECORDED', 22],
    ['exist 23', 'CONFIRM_RECORDED', 23],
    ['exists #24', 'CONFIRM_RECORDED', 24],
    ['belum 25', 'CONFIRM_ABSENT', 25],
  ] as const)('parses numbered reconciliation command %s', (input, actionType, ticketId) => {
    expect(detectReconciliationAction(input)).toEqual({ actionType, targetTicketId: ticketId });
  });

  it.each([
    ['sudah ada', 'CONFIRM_RECORDED'],
    ['sudah masuk', 'CONFIRM_RECORDED'],
    ['already exists', 'CONFIRM_RECORDED'],
    ['already exist', 'CONFIRM_RECORDED'],
    ['already recorded', 'CONFIRM_RECORDED'],
    ['already there', 'CONFIRM_RECORDED'],
    ['already in wallet', 'CONFIRM_RECORDED'],
    ['sudah', 'CONFIRM_RECORDED'],
    ['ada', 'CONFIRM_RECORDED'],
    ['belum ada', 'CONFIRM_ABSENT'],
    ['belum masuk', 'CONFIRM_ABSENT'],
    ['tidak ada', 'CONFIRM_ABSENT'],
    ['ga ada', 'CONFIRM_ABSENT'],
    ['gak ada', 'CONFIRM_ABSENT'],
    ['not there', 'CONFIRM_ABSENT'],
    ['not yet', 'CONFIRM_ABSENT'],
    ['not recorded', 'CONFIRM_ABSENT'],
    ['not in wallet', 'CONFIRM_ABSENT'],
    ['missing', 'CONFIRM_ABSENT'],
    ['not found', 'CONFIRM_ABSENT'],
    ['belum', 'CONFIRM_ABSENT'],
  ] as const)('parses unnumbered reconciliation alias %s', (input, actionType) => {
    expect(detectReconciliationAction(input)).toEqual({ actionType });
  });

  it.each([
    'sudah ada 0',
    'belum ada #0',
    'sudah 0',
    'belum #0',
  ])('rejects non-positive ticket in %s', input => {
    expect(detectReconciliationAction(input)).toBeNull();
  });

  it('covers empty, non-string, unrelated, and whitespace normalization paths', () => {
    expect(detectReconciliationAction('')).toBeNull();
    expect(detectReconciliationAction(undefined as any)).toBeNull();
    expect(detectReconciliationAction(123 as any)).toBeNull();
    expect(detectReconciliationAction('  SUDAH ADA #31  ')).toEqual({
      actionType: 'CONFIRM_RECORDED',
      targetTicketId: 31,
    });
    expect(detectReconciliationAction('halo bot')).toBeNull();
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
