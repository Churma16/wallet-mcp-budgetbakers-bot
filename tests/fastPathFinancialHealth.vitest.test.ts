import { describe, it, expect } from 'vitest';
import { detectFastPathAction } from '../src/utils/fastPathIntentDetector.js';

describe('Fast-Path Financial Health Intent Detection Tests', () => {
  it('detects Indonesian financial health and runway questions', () => {
    expect(detectFastPathAction('uang cukup ga')).toBe('CHECK_FINANCIAL_HEALTH');
    expect(detectFastPathAction('uangku cukup gak')).toBe('CHECK_FINANCIAL_HEALTH');
    expect(detectFastPathAction('apakah uang cukup')).toBe('CHECK_FINANCIAL_HEALTH');
    expect(detectFastPathAction('apakah uang saya cukup')).toBe('CHECK_FINANCIAL_HEALTH');
    expect(detectFastPathAction('cek runway')).toBe('CHECK_FINANCIAL_HEALTH');
    expect(detectFastPathAction('runway keuangan')).toBe('CHECK_FINANCIAL_HEALTH');
    expect(detectFastPathAction('cek kesehatan keuangan')).toBe('CHECK_FINANCIAL_HEALTH');
    expect(detectFastPathAction('kesehatan keuangan')).toBe('CHECK_FINANCIAL_HEALTH');
    expect(detectFastPathAction('cek kondisi keuangan')).toBe('CHECK_FINANCIAL_HEALTH');
    expect(detectFastPathAction('cek duit')).toBe('CHECK_FINANCIAL_HEALTH');
    expect(detectFastPathAction('cek keuangan')).toBe('CHECK_FINANCIAL_HEALTH');
  });

  it('detects English financial health and runway questions', () => {
    expect(detectFastPathAction('do i have money')).toBe('CHECK_FINANCIAL_HEALTH');
    expect(detectFastPathAction('do i have money to fill that')).toBe('CHECK_FINANCIAL_HEALTH');
    expect(detectFastPathAction('can i afford')).toBe('CHECK_FINANCIAL_HEALTH');
    expect(detectFastPathAction('can i afford this')).toBe('CHECK_FINANCIAL_HEALTH');
    expect(detectFastPathAction('check runway')).toBe('CHECK_FINANCIAL_HEALTH');
    expect(detectFastPathAction('financial health')).toBe('CHECK_FINANCIAL_HEALTH');
    expect(detectFastPathAction('check financial health')).toBe('CHECK_FINANCIAL_HEALTH');
  });

  it('does not trigger on unrelated commands', () => {
    expect(detectFastPathAction('halo')).toBe('HELP_MENU');
    expect(detectFastPathAction('selamat pagi')).toBeNull();
    expect(detectFastPathAction('beli kopi 25000')).toBeNull();
    expect(detectFastPathAction('cek saldo')).toBe('CHECK_BALANCE');
    expect(detectFastPathAction('antrean')).toBe('CHECK_QUEUE');
  });
});
