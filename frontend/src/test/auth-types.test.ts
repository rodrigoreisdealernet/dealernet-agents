/**
 * Tests for auth type helpers.
 */
import { describe, expect, it } from 'vitest';
import { canWrite, canOperate, canViewGeneralLedger, ROLE_LABELS } from '@/auth/types';
import type { AppRole } from '@/auth/types';

describe('canWrite', () => {
  it('returns true for admin', () => expect(canWrite('admin')).toBe(true));
  it('returns true for branch_manager', () => expect(canWrite('branch_manager')).toBe(true));
  it('returns false for field_operator', () => expect(canWrite('field_operator')).toBe(false));
  it('returns false for read_only', () => expect(canWrite('read_only')).toBe(false));
  it('returns false for undefined', () => expect(canWrite(undefined)).toBe(false));
});

describe('canOperate', () => {
  it('returns true for admin', () => expect(canOperate('admin')).toBe(true));
  it('returns true for branch_manager', () => expect(canOperate('branch_manager')).toBe(true));
  it('returns true for field_operator', () => expect(canOperate('field_operator')).toBe(true));
  it('returns false for read_only', () => expect(canOperate('read_only')).toBe(false));
  it('returns false for undefined', () => expect(canOperate(undefined)).toBe(false));
});

describe('canViewGeneralLedger', () => {
  it('returns true for admin', () => expect(canViewGeneralLedger('admin')).toBe(true));
  it('returns true for branch_manager', () => expect(canViewGeneralLedger('branch_manager')).toBe(true));
  it('returns false for field_operator', () => expect(canViewGeneralLedger('field_operator')).toBe(false));
  it('returns false for read_only', () => expect(canViewGeneralLedger('read_only')).toBe(false));
  it('returns false for undefined', () => expect(canViewGeneralLedger(undefined)).toBe(false));
});

describe('ROLE_LABELS', () => {
  const roles: AppRole[] = ['admin', 'branch_manager', 'field_operator', 'read_only'];

  it('has a non-empty label for every role', () => {
    for (const role of roles) {
      expect(ROLE_LABELS[role]).toBeTruthy();
    }
  });

  it('has human-readable labels', () => {
    expect(ROLE_LABELS.admin).toBe('Admin');
    expect(ROLE_LABELS.branch_manager).toBe('Branch Manager');
    expect(ROLE_LABELS.field_operator).toBe('Field Operator');
    expect(ROLE_LABELS.read_only).toBe('Read Only');
  });
});
