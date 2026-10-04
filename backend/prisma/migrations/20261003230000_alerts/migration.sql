-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('URGENT', 'NORMAL', 'INFO');

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "audience" "Role"[],
    "link" TEXT,
    "shiftId" TEXT,
    "actorUserId" TEXT,
    "eventId" TEXT,
    "refId" TEXT,
    "dedupeKey" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "notifyPending" BOOLEAN NOT NULL DEFAULT false,
    "notifiedAt" TIMESTAMP(3),
    "notifyAttempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertRead" (
    "alertId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertRead_pkey" PRIMARY KEY ("alertId","userId")
);

-- CreateIndex
CREATE INDEX "Alert_householdId_createdAt_idx" ON "Alert"("householdId", "createdAt");

-- CreateIndex
CREATE INDEX "Alert_householdId_type_refId_idx" ON "Alert"("householdId", "type", "refId");

-- CreateIndex
CREATE UNIQUE INDEX "Alert_householdId_dedupeKey_key" ON "Alert"("householdId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "AlertRead" ADD CONSTRAINT "AlertRead_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
