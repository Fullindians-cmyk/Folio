/**
 * Security Rules Specification Verification Suite (Dirty Dozen Adversarial Payloads)
 * Verifies that all 12 adversarial payloads defined in security_spec.md are rejected
 * with PERMISSION_DENIED by the Firestore security rules.
 */
export interface AdversarialTestCase {
  id: number;
  name: string;
  collection: string;
  docId: string;
  operation: 'create' | 'update' | 'get' | 'list';
  auth: { uid: string; email_verified: boolean } | null;
  payload?: Record<string, unknown>;
  expectedResult: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_TEST_CASES: AdversarialTestCase[] = [
  {
    id: 1,
    name: 'Identity Spoofing on Transaction Create',
    collection: 'transactions',
    docId: 'tx-1',
    operation: 'create',
    auth: { uid: 'uid_A', email_verified: true },
    payload: {
      id: 'tx-1',
      ownerId: 'uid_B', // Spoofed UID
      instrument_type: 'stock',
      transaction_type: 'buy',
      symbol: 'RELIANCE.NS',
      name: 'Reliance Industries',
      quantity: 10,
      price: 1290,
      date: '2026-11-10',
      exchange: 'NSE'
    },
    expectedResult: 'PERMISSION_DENIED'
  },
  {
    id: 2,
    name: 'Unverified Email Write',
    collection: 'transactions',
    docId: 'tx-1',
    operation: 'create',
    auth: { uid: 'uid_A', email_verified: false },
    payload: {
      id: 'tx-1',
      ownerId: 'uid_A',
      instrument_type: 'stock',
      transaction_type: 'buy',
      symbol: 'RELIANCE.NS',
      name: 'Reliance Industries',
      quantity: 10,
      price: 1290,
      date: '2026-11-10',
      exchange: 'NSE'
    },
    expectedResult: 'PERMISSION_DENIED'
  },
  {
    id: 3,
    name: 'Shadow Field Injection on Create',
    collection: 'goals',
    docId: 'goal-1',
    operation: 'create',
    auth: { uid: 'uid_A', email_verified: true },
    payload: {
      id: 'goal-1',
      ownerId: 'uid_A',
      name: 'Retirement',
      mode: 'A',
      target_amount: 10000000,
      accumulated_amount: 500000,
      created_date: '2026-11-10',
      last_trailing_1y_return_pct: 16.8,
      isAdmin: true // Undeclared shadow field
    },
    expectedResult: 'PERMISSION_DENIED'
  },
  {
    id: 4,
    name: 'Shadow Field Injection on Update',
    collection: 'goals',
    docId: 'goal-1',
    operation: 'update',
    auth: { uid: 'uid_A', email_verified: true },
    payload: {
      hacked: 1
    },
    expectedResult: 'PERMISSION_DENIED'
  },
  {
    id: 5,
    name: 'Owner Mutation on Update',
    collection: 'transactions',
    docId: 'tx-1',
    operation: 'update',
    auth: { uid: 'uid_A', email_verified: true },
    payload: {
      ownerId: 'uid_B'
    },
    expectedResult: 'PERMISSION_DENIED'
  },
  {
    id: 6,
    name: 'CreatedAt Tampering on Update',
    collection: 'goals',
    docId: 'goal-1',
    operation: 'update',
    auth: { uid: 'uid_A', email_verified: true },
    payload: {
      createdAt: '2020-01-01T00:00:00Z'
    },
    expectedResult: 'PERMISSION_DENIED'
  },
  {
    id: 7,
    name: 'Forged Client Timestamp on Create',
    collection: 'transactions',
    docId: 'tx-1',
    operation: 'create',
    auth: { uid: 'uid_A', email_verified: true },
    payload: {
      createdAt: '1999-01-01T00:00:00Z'
    },
    expectedResult: 'PERMISSION_DENIED'
  },
  {
    id: 8,
    name: 'Cross-Tenant Read',
    collection: 'transactions',
    docId: 'tx_owned_by_A',
    operation: 'get',
    auth: { uid: 'uid_B', email_verified: true },
    expectedResult: 'PERMISSION_DENIED'
  },
  {
    id: 9,
    name: 'Unfiltered List Scraping Across Owners',
    collection: 'transactions',
    docId: '*',
    operation: 'list',
    auth: { uid: 'uid_B', email_verified: true },
    expectedResult: 'PERMISSION_DENIED'
  },
  {
    id: 10,
    name: 'Denial-of-Wallet Oversized String',
    collection: 'transactions',
    docId: 'tx-1',
    operation: 'create',
    auth: { uid: 'uid_A', email_verified: true },
    payload: {
      name: 'X'.repeat(5000)
    },
    expectedResult: 'PERMISSION_DENIED'
  },
  {
    id: 11,
    name: 'Invalid Enum Value on Transaction Type',
    collection: 'transactions',
    docId: 'tx-1',
    operation: 'create',
    auth: { uid: 'uid_A', email_verified: true },
    payload: {
      transaction_type: 'borrow'
    },
    expectedResult: 'PERMISSION_DENIED'
  },
  {
    id: 12,
    name: 'Negative Quantity or Price',
    collection: 'transactions',
    docId: 'tx-1',
    operation: 'create',
    auth: { uid: 'uid_A', email_verified: true },
    payload: {
      quantity: -50,
      price: 0
    },
    expectedResult: 'PERMISSION_DENIED'
  }
];
