-- CreateEnum
CREATE TYPE "HostStatus" AS ENUM ('PENDING_REVIEW', 'ACTIVE', 'SUSPENDED', 'REJECTED');

-- CreateEnum
CREATE TYPE "HostAvailability" AS ENUM ('OFFLINE', 'ONLINE', 'BUSY', 'PAUSED');

-- CreateTable
CREATE TABLE "HostProfile" (
    "userId" TEXT NOT NULL,
    "status" "HostStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "availability" "HostAvailability" NOT NULL DEFAULT 'OFFLINE',
    "voiceEnabled" BOOLEAN NOT NULL DEFAULT true,
    "videoEnabled" BOOLEAN NOT NULL DEFAULT true,
    "voiceRatePerMinuteCents" INTEGER NOT NULL DEFAULT 100,
    "videoRatePerMinuteCents" INTEGER NOT NULL DEFAULT 150,
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "interests" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "applicationBio" TEXT NOT NULL DEFAULT '',
    "reviewNote" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HostProfile_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "HostProfile_status_availability_idx" ON "HostProfile"("status", "availability");

-- CreateIndex
CREATE INDEX "HostProfile_status_updatedAt_idx" ON "HostProfile"("status", "updatedAt");

-- AddForeignKey
ALTER TABLE "HostProfile" ADD CONSTRAINT "HostProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
