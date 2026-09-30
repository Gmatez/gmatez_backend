-- PostgreSQL cannot add an enum value inside the same transaction as later uses of that value.
-- This migration is only the new ledger reason. Columns are added in the next migration.
ALTER TYPE "LedgerReason" ADD VALUE IF NOT EXISTS 'PAYMENT_REFUND';
