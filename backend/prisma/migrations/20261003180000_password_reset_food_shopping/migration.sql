-- CreateEnum
CREATE TYPE "FoodRequestKind" AS ENUM ('DISPOSAL', 'HAZARD');

-- CreateEnum
CREATE TYPE "FoodRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'DISPOSED', 'HAZARD_REPORTED', 'HAZARD_ACKNOWLEDGED');

-- CreateEnum
CREATE TYPE "ShoppingStatus" AS ENUM ('NEEDED', 'LOW', 'OUT', 'PURCHASED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ShoppingSource" AS ENUM ('CLIENT', 'ADMIN', 'IP_REPORT', 'DISPOSAL');

-- AlterTable
ALTER TABLE "CaptureChallenge" ADD COLUMN     "purpose" TEXT NOT NULL DEFAULT 'task_photo',
ALTER COLUMN "taskInstanceId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "tokensValidAfter" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PasswordReset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" "ContactChannel" NOT NULL,
    "contact" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordReset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FoodDisposalRequest" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "kind" "FoodRequestKind" NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "reasonText" TEXT,
    "dateLabel" TEXT,
    "replacement" TEXT,
    "actionTaken" TEXT,
    "status" "FoodRequestStatus" NOT NULL,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "disposedByUserId" TEXT,
    "disposedAt" TIMESTAMP(3),
    "acknowledgedByUserId" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "photoHash" TEXT,
    "photoStorageRef" TEXT,
    "photoViewerRef" TEXT,
    "photoMime" TEXT,
    "photoBytes" INTEGER,
    "photoLocationVerification" TEXT,
    "photoAcceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FoodDisposalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShoppingItem" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "quantity" TEXT,
    "storageLocation" TEXT,
    "status" "ShoppingStatus" NOT NULL,
    "source" "ShoppingSource" NOT NULL,
    "note" TEXT,
    "reportCount" INTEGER NOT NULL DEFAULT 1,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closedByUserId" TEXT,

    CONSTRAINT "ShoppingItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PasswordReset_userId_createdAt_idx" ON "PasswordReset"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "FoodDisposalRequest_householdId_status_idx" ON "FoodDisposalRequest"("householdId", "status");

-- CreateIndex
CREATE INDEX "FoodDisposalRequest_householdId_createdAt_idx" ON "FoodDisposalRequest"("householdId", "createdAt");

-- CreateIndex
CREATE INDEX "ShoppingItem_householdId_status_idx" ON "ShoppingItem"("householdId", "status");

-- CreateIndex
CREATE INDEX "ShoppingItem_householdId_nameKey_idx" ON "ShoppingItem"("householdId", "nameKey");
