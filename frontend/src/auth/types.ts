/**
 * Auth types shared across the auth module.
 */

export type AppRole = 'admin' | 'branch_manager' | 'field_operator' | 'read_only';

/** Minimal profile surfaced from auth user + app_metadata. */
export interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  role: AppRole;
  tenant: string;
  localeCode?: string;
  taxRegionCode?: string;
  timezone?: string;
  currencyCode?: string;
  currencyMinorUnit?: number;
  branchId?: string;
  regionId?: string;
  companyId?: string;
  customerId?: string;
  billingAccountId?: string;
  billingAccountIds?: string[];
  jobSiteId?: string;
  jobSiteIds?: string[];
  contractId?: string;
  contractIds?: string[];
}

export const ROLE_LABELS: Record<AppRole, string> = {
  admin: 'Admin',
  branch_manager: 'Branch Manager',
  field_operator: 'Field Operator',
  read_only: 'Read Only',
};

/** Returns true when the given role has write capability on core entity data. */
export function canWrite(role: AppRole | undefined): boolean {
  return role === 'admin' || role === 'branch_manager';
}

/** Returns true when the given role can create operational records. */
export function canOperate(role: AppRole | undefined): boolean {
  return role === 'admin' || role === 'branch_manager' || role === 'field_operator';
}

/** Returns true when the given role can view accounting general-ledger data. */
export function canViewGeneralLedger(role: AppRole | undefined): boolean {
  return role === 'admin' || role === 'branch_manager';
}

/** Returns true when the given role can configure accounting export mode. */
export function canConfigureAccountingExport(role: AppRole | undefined): boolean {
  return role === 'admin';
}
