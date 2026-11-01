/*
  Warnings:

  - You are about to drop the column `userId` on the `PayoutDestination` table. All the data in the column will be lost.
  - You are about to drop the column `userId` on the `PayoutRequest` table. All the data in the column will be lost.
  - Added the required column `hostId` to the `PayoutDestination` table without a default value. This is not possible if the table is not empty.
  - Added the required column `hostId` to the `PayoutRequest` table without a default value. This is not possible if the table is not empty.

*/
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

-- AlterTable
ALTER TABLE "PayoutDestination" DROP COLUMN "userId",
ADD COLUMN     "hostId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "PayoutRequest" DROP COLUMN "userId",
ADD COLUMN     "hostId" TEXT NOT NULL;

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
