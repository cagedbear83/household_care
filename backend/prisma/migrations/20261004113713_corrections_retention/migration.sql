-- CreateEnum
CREATE TYPE "CorrectionKind" AS ENUM ('COMPLETION_ERROR', 'ATTENDANCE', 'NOTE');

-- CreateEnum
CREATE TYPE "CorrectionRequestStatus" AS ENUM ('OPEN', 'RESOLVED', 'DECLINED');

-- AlterEnum
ALTER TYPE "TaskState" ADD VALUE 'COMPLETION_ERROR_CORRECTED';

-- CreateTable
CREATE TABLE "CorrectionRequest" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "taskInstanceId" TEXT,
    "shiftId" TEXT,
    "linkedEventId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "CorrectionRequestStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "correctionId" TEXT,
    "declineReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CorrectionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Correction" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "kind" "CorrectionKind" NOT NULL,
    "linkedEventId" TEXT NOT NULL,
    "taskInstanceId" TEXT,
    "shiftId" TEXT,
    "reason" TEXT NOT NULL,
    "byUserId" TEXT NOT NULL,
    "byRole" "Role" NOT NULL,
    "requestId" TEXT,
    "eventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Correction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetentionPolicy" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "retentionDays" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "setByUserId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RetentionPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetentionHold" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "fromDate" TEXT,
    "toDate" TEXT,
    "placedByUserId" TEXT NOT NULL,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedByUserId" TEXT,
    "releasedAt" TIMESTAMP(3),
    "releaseReason" TEXT,

    CONSTRAINT "RetentionHold_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CorrectionRequest_correctionId_key" ON "CorrectionRequest"("correctionId");

-- CreateIndex
CREATE INDEX "CorrectionRequest_householdId_status_idx" ON "CorrectionRequest"("householdId", "status");

-- CreateIndex
CREATE INDEX "CorrectionRequest_requestedByUserId_createdAt_idx" ON "CorrectionRequest"("requestedByUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Correction_requestId_key" ON "Correction"("requestId");

-- CreateIndex
CREATE INDEX "Correction_householdId_createdAt_idx" ON "Correction"("householdId", "createdAt");

-- CreateIndex
CREATE INDEX "Correction_taskInstanceId_idx" ON "Correction"("taskInstanceId");

-- CreateIndex
CREATE INDEX "RetentionPolicy_householdId_effectiveFrom_idx" ON "RetentionPolicy"("householdId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "RetentionHold_householdId_releasedAt_idx" ON "RetentionHold"("householdId", "releasedAt");

