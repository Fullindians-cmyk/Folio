# Security Specification — Portfolio & Goal Tracker

## 1. Data Invariants
1. **Strict Ownership Isolation**: Every document in `/transactions/{transactionId}`, `/instruments/{instrumentId}`, `/snapshots/{snapshotId}`, `/goals/{goalId}`, and `/goal_recalcs/{recalcId}` belongs strictly to a single authenticated and email-verified user (`ownerId == request.auth.uid` and `request.auth.token.email_verified == true`).
2. **Path Variable Hardening**: Every single-document ID (`transactionId`, `instrumentId`, `snapshotId`, `goalId`, `recalcId`) must match `^[a-zA-Z0-9_\-\.]+$` and be `<= 128` characters.
3. **Immutable Ownership & Creation Timestamps**: `ownerId` and `createdAt` can never be mutated on update (`incoming().ownerId == existing().ownerId && incoming().createdAt == existing().createdAt`).
4. **Server-Side Temporal Integrity**: `createdAt` on create and `updatedAt` on create/update must equal `request.time`.
5. **Relational Integrity on Goal Recalculations**: Creating a `/goal_recalcs/{recalcId}` document requires that the referenced `/goals/{goal_id}` document exists or belongs to the same `request.auth.uid`.
6. **Query Enforcement**: Every `allow list` rule explicitly validates `resource.data.ownerId == request.auth.uid` without delegating filtering trust to the client.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Identity Spoofing on Transaction Create**: Authenticated user `uid_A` creates `/transactions/tx_1` with `ownerId: "uid_B"`. -> `PERMISSION_DENIED`
2. **Unverified Email Write**: Authenticated user with `email_verified: false` attempts to create `/transactions/tx_1`. -> `PERMISSION_DENIED`
3. **Shadow Field Injection on Create**: Creating `/goals/goal_1` with an undeclared field `"isAdmin": true`. -> `PERMISSION_DENIED`
4. **Shadow Field Injection on Update**: Updating `/goals/goal_1` with an undeclared field `"hacked": 1`. -> `PERMISSION_DENIED`
5. **Owner Mutation on Update**: Updating `/transactions/tx_1` to change `ownerId` from `"uid_A"` to `"uid_B"`. -> `PERMISSION_DENIED`
6. **CreatedAt Tampering on Update**: Updating `/goals/goal_1` with a modified `createdAt` timestamp. -> `PERMISSION_DENIED`
7. **Forged Client Timestamp on Create**: Creating `/transactions/tx_1` where `createdAt != request.time`. -> `PERMISSION_DENIED`
8. **Cross-Tenant Read**: User `uid_B` calls `get` on `/transactions/tx_owned_by_A`. -> `PERMISSION_DENIED`
9. **Unfiltered List Scraping**: User `uid_B` runs an unfiltered `list` query across `/transactions` without `where('ownerId', '==', 'uid_B')`. -> `PERMISSION_DENIED`
10. **Denial-of-Wallet Oversized String**: Creating `/transactions/tx_1` with `name` of 5,000 characters (`maxLength: 160`). -> `PERMISSION_DENIED`
11. **Invalid Enum Value**: Creating `/transactions/tx_1` with `transaction_type: "borrow"` instead of `"buy"` or `"sell"`. -> `PERMISSION_DENIED`
12. **Negative Quantity or Price**: Creating `/transactions/tx_1` with `quantity: -50` or `price: 0`. -> `PERMISSION_DENIED`
