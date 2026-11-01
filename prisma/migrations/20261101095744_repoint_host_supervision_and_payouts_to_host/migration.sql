/*
  This migration repoints HostSupervision, PayoutDestination and
  PayoutRequest at the new Host table instead of User/HostProfile.

  Unlike an empty dev/test database, a database that already has
  PayoutDestination/PayoutRequest rows (or HostSupervision rows) cannot
  have "hostId" simply added as NOT NULL — Postgres rejects that against
  existing rows. This version is safe for a non-empty table: it first
  guarantees every host has a row in "Host" (backfilling from
  HostProfile/User/Profile, matching scripts/backfill-host-identity.js),
  then adds each new column nullable, backfills it from the old "userId"
  column (same UUID value — Host.id intentionally reuses it), makes it
  NOT NULL, and only then drops the old column and adds the new FK.
*/

-- Backfill any Host row that doesn't exist yet, so the FKs added below
-- never fail against real data. Idempotent — ON CONFLICT DO NOTHING.
INSERT INTO "Host" (
  "id", "phone", "email", "accountStatus", "status", "availability", "verificationStatus",
  "displayName", "bio", "gender", "country", "language", "avatarUrl", "isDiscoverable", "lastActiveAt",
  "voiceEnabled", "videoEnabled", "voiceRatePerMinuteCents", "videoRatePerMinuteCents",
  "languages", "interests", "applicationBio", "reviewNote", "internalNote",
  "submittedAt", "reviewedAt", "reviewedById",
  "idProofType", "idProofLast4", "idProofMime", "idProofUpdatedAt",
  "identityCardNumber", "identityFrontMime", "identityBackMime", "profileImageMime",
  "createdAt", "updatedAt"
)
SELECT
  hp."userId",
  COALESCE(u."phone", 'unknown-' || hp."userId"),
  CASE WHEN u."email" LIKE '%@phone.gmatez.invalid' THEN NULL ELSE u."email" END,
  u."status"::text::"HostAccountStatus",
  hp."status",
  hp."availability",
  hp."verificationStatus",
  COALESCE(p."displayName", ''),
  COALESCE(p."bio", ''),
  COALESCE(p."gender", 'UNSPECIFIED'),
  p."country",
  p."language",
  p."avatarUrl",
  COALESCE(p."isDiscoverable", true),
  COALESCE(p."lastActiveAt", now()),
  hp."voiceEnabled",
  hp."videoEnabled",
  hp."voiceRatePerMinuteCents",
  hp."videoRatePerMinuteCents",
  hp."languages",
  hp."interests",
  hp."applicationBio",
  hp."reviewNote",
  hp."internalNote",
  hp."submittedAt",
  hp."reviewedAt",
  hp."reviewedById",
  hp."idProofType",
  hp."idProofLast4",
  hp."idProofMime",
  hp."idProofUpdatedAt",
  hp."identityCardNumber",
  hp."identityFrontMime",
  hp."identityBackMime",
  hp."profileImageMime",
  hp."createdAt",
  hp."updatedAt"
FROM "HostProfile" hp
JOIN "User" u ON u."id" = hp."userId"
LEFT JOIN "Profile" p ON p."userId" = hp."userId"
WHERE NOT EXISTS (SELECT 1 FROM "Host" h WHERE h."id" = hp."userId")
ON CONFLICT ("id") DO NOTHING;

-- DropForeignKey
ALTER TABLE "HostSupervision" DROP CONSTRAINT "HostSupervision_hostUser_fkey";

-- DropForeignKey
ALTER TABLE "HostSupervision" DROP CONSTRAINT "HostSupervision_host_fkey";

-- DropForeignKey
ALTER TABLE "PayoutDestination" DROP CONSTRAINT "PayoutDestination_userId_fkey";

-- DropForeignKey
ALTER TABLE "PayoutRequest" DROP CONSTRAINT "PayoutRequest_userId_fkey";

-- DropIndex
DROP INDEX "PayoutDestination_userId_isDefault_idx";

-- DropIndex
DROP INDEX "PayoutRequest_userId_createdAt_idx";

-- AlterTable: add hostId nullable, backfill from userId, then enforce NOT NULL
ALTER TABLE "PayoutDestination" ADD COLUMN "hostId" TEXT;
UPDATE "PayoutDestination" SET "hostId" = "userId";
ALTER TABLE "PayoutDestination" ALTER COLUMN "hostId" SET NOT NULL;
ALTER TABLE "PayoutDestination" DROP COLUMN "userId";

-- AlterTable: same pattern for PayoutRequest
ALTER TABLE "PayoutRequest" ADD COLUMN "hostId" TEXT;
UPDATE "PayoutRequest" SET "hostId" = "userId";
ALTER TABLE "PayoutRequest" ALTER COLUMN "hostId" SET NOT NULL;
ALTER TABLE "PayoutRequest" DROP COLUMN "userId";

-- CreateIndex
CREATE INDEX "PayoutDestination_hostId_isDefault_idx" ON "PayoutDestination"("hostId", "isDefault");

-- CreateIndex
CREATE INDEX "PayoutRequest_hostId_createdAt_idx" ON "PayoutRequest"("hostId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "HostSupervision" ADD CONSTRAINT "HostSupervision_hostUserId_fkey" FOREIGN KEY ("hostUserId") REFERENCES "Host"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutDestination" ADD CONSTRAINT "PayoutDestination_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "Host"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutRequest" ADD CONSTRAINT "PayoutRequest_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "Host"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
