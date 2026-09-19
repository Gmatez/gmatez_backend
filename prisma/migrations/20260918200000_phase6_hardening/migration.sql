-- Phase 6: call idempotency, settlement marker, reports refs, payout destinations, notification prefs

ALTER TABLE "Call" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
ALTER TABLE "Call" ADD COLUMN IF NOT EXISTS "settlementAppliedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "Call_idempotencyKey_key" ON "Call"("idempotencyKey");

ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS "referenceType" TEXT;
ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS "referenceId" TEXT;
CREATE INDEX IF NOT EXISTS "Report_referenceType_referenceId_idx" ON "Report"("referenceType", "referenceId");

CREATE TABLE IF NOT EXISTS "PayoutDestination" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "detailsJson" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PayoutDestination_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PayoutDestination_userId_isDefault_idx" ON "PayoutDestination"("userId", "isDefault");

ALTER TABLE "PayoutRequest" ADD COLUMN IF NOT EXISTS "destinationId" TEXT;

DO $$ BEGIN
  ALTER TABLE "PayoutDestination" ADD CONSTRAINT "PayoutDestination_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PayoutRequest" ADD CONSTRAINT "PayoutRequest_destinationId_fkey"
    FOREIGN KEY ("destinationId") REFERENCES "PayoutDestination"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "NotificationPreference" (
    "userId" TEXT NOT NULL,
    "incomingCall" BOOLEAN NOT NULL DEFAULT true,
    "chatMessage" BOOLEAN NOT NULL DEFAULT true,
    "payment" BOOLEAN NOT NULL DEFAULT true,
    "wallet" BOOLEAN NOT NULL DEFAULT true,
    "host" BOOLEAN NOT NULL DEFAULT true,
    "payout" BOOLEAN NOT NULL DEFAULT true,
    "system" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("userId")
);

DO $$ BEGIN
  ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
