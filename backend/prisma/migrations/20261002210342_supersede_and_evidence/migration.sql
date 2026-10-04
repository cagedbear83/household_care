/*
  Warnings:

  - Added the required column `byteSize` to the `Evidence` table without a default value. This is not possible if the table is not empty.
  - Added the required column `mimeType` to the `Evidence` table without a default value. This is not possible if the table is not empty.
  - Added the required column `viewerStorageRef` to the `Evidence` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Evidence" ADD COLUMN     "byteSize" INTEGER NOT NULL,
ADD COLUMN     "mimeType" TEXT NOT NULL,
ADD COLUMN     "viewerStorageRef" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "ScheduledShift" ADD COLUMN     "supersededAt" TIMESTAMP(3),
ADD COLUMN     "supersededByShiftId" TEXT;

-- CreateTable
CREATE TABLE "CaptureChallenge" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "taskInstanceId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "CaptureChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CaptureChallenge_taskInstanceId_idx" ON "CaptureChallenge"("taskInstanceId");
