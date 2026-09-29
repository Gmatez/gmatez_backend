CREATE TYPE "OperatingMode" AS ENUM ('USER', 'HOST');

ALTER TABLE "Profile" ADD COLUMN "operatingMode" "OperatingMode" NOT NULL DEFAULT 'USER';

UPDATE "Profile" AS p
SET "operatingMode" = 'HOST'
FROM "HostProfile" AS h
WHERE h."userId" = p."userId" AND h."status" = 'ACTIVE';

ALTER TABLE "HostProfile" ADD COLUMN "idProofType" TEXT;
ALTER TABLE "HostProfile" ADD COLUMN "idProofLast4" TEXT;
ALTER TABLE "HostProfile" ADD COLUMN "idProofMime" TEXT;
ALTER TABLE "HostProfile" ADD COLUMN "idProofUpdatedAt" TIMESTAMP(3);

ALTER TABLE "Call" ADD COLUMN "creatorShareBps" INTEGER;

CREATE TABLE "PlatformPricing" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "userRatePerMinuteCents" INTEGER NOT NULL,
    "hostEarningPerMinuteCents" INTEGER NOT NULL,
    "hostShareBps" INTEGER NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlatformPricing_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RechargePlan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "walletCreditMinor" INTEGER NOT NULL,
    "bonusMinor" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RechargePlan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RechargePlan_isActive_displayOrder_idx" ON "RechargePlan"("isActive", "displayOrder");
