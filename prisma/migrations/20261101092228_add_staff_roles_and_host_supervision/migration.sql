-- AlterTable
ALTER TABLE "User" ADD COLUMN     "staffRoleId" TEXT;

-- CreateTable
CREATE TABLE "StaffRole" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HostSupervision" (
    "id" TEXT NOT NULL,
    "hostUserId" TEXT NOT NULL,
    "staffUserId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HostSupervision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffRole_name_key" ON "StaffRole"("name");

-- CreateIndex
CREATE UNIQUE INDEX "HostSupervision_hostUserId_key" ON "HostSupervision"("hostUserId");

-- CreateIndex
CREATE INDEX "HostSupervision_staffUserId_idx" ON "HostSupervision"("staffUserId");

-- CreateIndex
CREATE INDEX "User_staffRoleId_idx" ON "User"("staffRoleId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_staffRoleId_fkey" FOREIGN KEY ("staffRoleId") REFERENCES "StaffRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HostSupervision" ADD CONSTRAINT "HostSupervision_host_fkey" FOREIGN KEY ("hostUserId") REFERENCES "HostProfile"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HostSupervision" ADD CONSTRAINT "HostSupervision_staffUserId_fkey" FOREIGN KEY ("staffUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HostSupervision" ADD CONSTRAINT "HostSupervision_hostUser_fkey" FOREIGN KEY ("hostUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
