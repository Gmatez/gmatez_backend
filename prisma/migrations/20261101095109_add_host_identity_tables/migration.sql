-- CreateEnum
CREATE TYPE "HostAccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateTable
CREATE TABLE "Host" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "accountStatus" "HostAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "status" "HostStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "availability" "HostAvailability" NOT NULL DEFAULT 'OFFLINE',
    "verificationStatus" "HostVerificationStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "displayName" TEXT NOT NULL DEFAULT '',
    "bio" TEXT NOT NULL DEFAULT '',
    "gender" "Gender" NOT NULL DEFAULT 'UNSPECIFIED',
    "country" TEXT,
    "language" TEXT,
    "avatarUrl" TEXT,
    "isDiscoverable" BOOLEAN NOT NULL DEFAULT true,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voiceEnabled" BOOLEAN NOT NULL DEFAULT true,
    "videoEnabled" BOOLEAN NOT NULL DEFAULT true,
    "voiceRatePerMinuteCents" INTEGER NOT NULL DEFAULT 100,
    "videoRatePerMinuteCents" INTEGER NOT NULL DEFAULT 150,
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "interests" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "applicationBio" TEXT NOT NULL DEFAULT '',
    "reviewNote" TEXT,
    "internalNote" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "idProofType" TEXT,
    "idProofLast4" TEXT,
    "idProofMime" TEXT,
    "idProofUpdatedAt" TIMESTAMP(3),
    "identityCardNumber" TEXT,
    "identityFrontMime" TEXT,
    "identityBackMime" TEXT,
    "profileImageMime" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Host_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HostRefreshToken" (
    "id" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HostRefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HostDeviceToken" (
    "id" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HostDeviceToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HostAppNotification" (
    "id" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HostAppNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HostNotificationPreference" (
    "hostId" TEXT NOT NULL,
    "incomingCall" BOOLEAN NOT NULL DEFAULT true,
    "chatMessage" BOOLEAN NOT NULL DEFAULT true,
    "payout" BOOLEAN NOT NULL DEFAULT true,
    "system" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HostNotificationPreference_pkey" PRIMARY KEY ("hostId")
);

-- CreateTable
CREATE TABLE "HostWallet" (
    "id" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "availableBalanceCents" INTEGER NOT NULL DEFAULT 0,
    "heldBalanceCents" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HostWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HostWalletLedgerEntry" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "reason" "LedgerReason" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "balanceAfterCents" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HostWalletLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Host_phone_key" ON "Host"("phone");

-- CreateIndex
CREATE INDEX "Host_status_availability_idx" ON "Host"("status", "availability");

-- CreateIndex
CREATE INDEX "Host_status_updatedAt_idx" ON "Host"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "Host_status_verificationStatus_idx" ON "Host"("status", "verificationStatus");

-- CreateIndex
CREATE INDEX "Host_isDiscoverable_lastActiveAt_idx" ON "Host"("isDiscoverable", "lastActiveAt" DESC);

-- CreateIndex
CREATE INDEX "Host_language_isDiscoverable_lastActiveAt_idx" ON "Host"("language", "isDiscoverable", "lastActiveAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "HostRefreshToken_tokenHash_key" ON "HostRefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "HostRefreshToken_hostId_createdAt_idx" ON "HostRefreshToken"("hostId", "createdAt");

-- CreateIndex
CREATE INDEX "HostRefreshToken_familyId_idx" ON "HostRefreshToken"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "HostDeviceToken_token_key" ON "HostDeviceToken"("token");

-- CreateIndex
CREATE INDEX "HostDeviceToken_hostId_idx" ON "HostDeviceToken"("hostId");

-- CreateIndex
CREATE INDEX "HostAppNotification_hostId_createdAt_idx" ON "HostAppNotification"("hostId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "HostWallet_hostId_key" ON "HostWallet"("hostId");

-- CreateIndex
CREATE UNIQUE INDEX "HostWalletLedgerEntry_idempotencyKey_key" ON "HostWalletLedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "HostWalletLedgerEntry_walletId_createdAt_id_idx" ON "HostWalletLedgerEntry"("walletId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "HostWalletLedgerEntry_referenceType_referenceId_idx" ON "HostWalletLedgerEntry"("referenceType", "referenceId");

-- AddForeignKey
ALTER TABLE "HostRefreshToken" ADD CONSTRAINT "HostRefreshToken_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "Host"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HostDeviceToken" ADD CONSTRAINT "HostDeviceToken_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "Host"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HostAppNotification" ADD CONSTRAINT "HostAppNotification_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "Host"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HostNotificationPreference" ADD CONSTRAINT "HostNotificationPreference_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "Host"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HostWallet" ADD CONSTRAINT "HostWallet_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "Host"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HostWalletLedgerEntry" ADD CONSTRAINT "HostWalletLedgerEntry_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "HostWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
