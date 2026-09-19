-- Phase 3: host verification + versioned agreement acceptances
CREATE TYPE "HostVerificationStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'VERIFIED', 'REJECTED');

ALTER TABLE "HostProfile"
  ADD COLUMN "verificationStatus" "HostVerificationStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN "internalNote" TEXT;

CREATE TABLE "HostAgreementAcceptance" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "agreementType" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HostAgreementAcceptance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HostAgreementAcceptance_userId_agreementType_version_key"
  ON "HostAgreementAcceptance"("userId", "agreementType", "version");

CREATE INDEX "HostAgreementAcceptance_userId_agreementType_idx"
  ON "HostAgreementAcceptance"("userId", "agreementType");

CREATE INDEX "HostProfile_status_verificationStatus_idx"
  ON "HostProfile"("status", "verificationStatus");

ALTER TABLE "HostAgreementAcceptance"
  ADD CONSTRAINT "HostAgreementAcceptance_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "HostProfile"("userId")
  ON DELETE CASCADE ON UPDATE CASCADE;
