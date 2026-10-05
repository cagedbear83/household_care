-- CreateEnum
CREATE TYPE "AwayKind" AS ENUM ('HOSPITAL', 'VACATION', 'OTHER');

-- AlterTable
ALTER TABLE "Evidence" ADD COLUMN     "purgedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Household" ALTER COLUMN "workweekStartWeekday" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isPrimaryFamily" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AwayPeriod" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "kind" "AwayKind" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expectedReturnDate" TEXT,
    "note" TEXT,
    "setByUserId" TEXT NOT NULL,
    "endedAt" TIMESTAMP(3),
    "endedByUserId" TEXT,

    CONSTRAINT "AwayPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Preservation" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "fromDate" TEXT NOT NULL,
    "toDate" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "placedByUserId" TEXT NOT NULL,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "releasedByUserId" TEXT,
    "releaseReason" TEXT,

    CONSTRAINT "Preservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeeklyHoursNotice" (
    "ipUserId" TEXT NOT NULL,
    "weekStartLocalDate" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WeeklyHoursNotice_pkey" PRIMARY KEY ("ipUserId","weekStartLocalDate")
);

-- CreateTable
CREATE TABLE "PayPeriodReminder" (
    "householdId" TEXT NOT NULL,
    "localDate" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayPeriodReminder_pkey" PRIMARY KEY ("householdId","localDate")
);

-- CreateIndex
CREATE INDEX "AwayPeriod_householdId_endedAt_idx" ON "AwayPeriod"("householdId", "endedAt");

-- CreateIndex
CREATE INDEX "Preservation_householdId_releasedAt_idx" ON "Preservation"("householdId", "releasedAt");


-- Data: the workweek is Sunday to Saturday for every existing household.
UPDATE "Household" SET "workweekStartWeekday" = 0;

-- Data: in each household, the earliest-activated family member becomes the primary family member.
UPDATE "User" u SET "isPrimaryFamily" = true
WHERE u."role" = 'FAMILY' AND u."activatedAt" IS NOT NULL
  AND u."id" = (
    SELECT f."id" FROM "User" f
    WHERE f."householdId" = u."householdId" AND f."role" = 'FAMILY' AND f."activatedAt" IS NOT NULL
    ORDER BY f."activatedAt" ASC, f."id" ASC LIMIT 1
  );
