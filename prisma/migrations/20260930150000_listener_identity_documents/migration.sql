-- Listener application identity documents. Payment tables are unchanged.
ALTER TABLE "HostProfile" ADD COLUMN "identityCardNumber" TEXT;
ALTER TABLE "HostProfile" ADD COLUMN "identityFrontMime" TEXT;
ALTER TABLE "HostProfile" ADD COLUMN "identityBackMime" TEXT;
ALTER TABLE "HostProfile" ADD COLUMN "profileImageMime" TEXT;
