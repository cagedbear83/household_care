-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'CLIENT', 'IP', 'FAMILY');

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('SCHEDULED', 'VACATION', 'SICK', 'CLIENT_UNAVAILABLE', 'NOT_SCHEDULED');

-- CreateEnum
CREATE TYPE "ClosedReason" AS ENUM ('SCHEDULED_END', 'WEEKLY_CAP', 'MANUAL_CHECKOUT');

-- CreateEnum
CREATE TYPE "LocationSource" AS ENUM ('CHECK_IN', 'CHECK_OUT', 'PERIODIC', 'PHOTO_CAPTURE');

-- CreateEnum
CREATE TYPE "VerificationResult" AS ENUM ('VERIFIED', 'UNVERIFIED', 'FAILED');

-- CreateEnum
CREATE TYPE "TaskFrequency" AS ENUM ('VISIT', 'WEEKLY', 'MONTHLY', 'AS_NEEDED');

-- CreateEnum
CREATE TYPE "TaskState" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED_AWAITING_REVIEW', 'APPROVED', 'DISPUTED', 'CORRECTIVE_WORK_SUBMITTED', 'DECLINED_AWAITING_CONFIRMATION', 'CLIENT_DECLINED_CONFIRMED', 'NOT_NEEDED', 'UNABLE_TO_COMPLETE', 'MISSED_AT_SHIFT_END');

-- CreateTable
CREATE TABLE "Household" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Chicago',
    "weeklyHourCapMinutes" INTEGER NOT NULL DEFAULT 2160,
    "workweekStartWeekday" INTEGER NOT NULL DEFAULT 1,
    "apartmentLat" DOUBLE PRECISION NOT NULL,
    "apartmentLng" DOUBLE PRECISION NOT NULL,
    "geofenceRadiusMeters" DOUBLE PRECISION NOT NULL DEFAULT 60.96,
    "periodicPingMinutes" INTEGER NOT NULL DEFAULT 45,
    "retentionDays" INTEGER NOT NULL DEFAULT 730,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Household_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "canViewTimestamps" BOOLEAN NOT NULL DEFAULT false,
    "accessRevokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringScheduleRule" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "ipUserId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startLocal" TEXT NOT NULL,
    "endLocal" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveUntil" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecurringScheduleRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledShift" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "ipUserId" TEXT NOT NULL,
    "localDate" TEXT NOT NULL,
    "scheduledStartUtc" TIMESTAMP(3) NOT NULL,
    "scheduledEndUtc" TIMESTAMP(3) NOT NULL,
    "status" "ShiftStatus" NOT NULL DEFAULT 'SCHEDULED',
    "recurringSourceId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersedesShiftId" TEXT,
    "authorizedEndUtc" TIMESTAMP(3),
    "authorizationClosedAt" TIMESTAMP(3),
    "authorizationClosedReason" "ClosedReason",
    "checkInEventId" TEXT,
    "checkOutEventId" TEXT,
    "observedCheckInUtc" TIMESTAMP(3),
    "observedCheckOutUtc" TIMESTAMP(3),

    CONSTRAINT "ScheduledShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeekAllowance" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "ipUserId" TEXT NOT NULL,
    "weekStartLocalDate" TEXT NOT NULL,
    "consumedMinutes" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WeekAllowance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorRole" "Role" NOT NULL,
    "shiftId" TEXT,
    "taskInstanceId" TEXT,
    "action" TEXT NOT NULL,
    "payload" JSON NOT NULL,
    "serverTimestampUtc" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "previousEventId" TEXT,
    "hash" TEXT NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LocationReading" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "shiftId" TEXT,
    "userId" TEXT NOT NULL,
    "source" "LocationSource" NOT NULL,
    "observedAtDevice" TIMESTAMP(3),
    "receivedAtServer" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "accuracyMeters" DOUBLE PRECISION,
    "distanceMeters" DOUBLE PRECISION,
    "verification" "VerificationResult" NOT NULL,

    CONSTRAINT "LocationReading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskTemplate" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "groupName" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "frequency" "TaskFrequency" NOT NULL,
    "requiresPhoto" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "TaskTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskInstance" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "assignedDate" TEXT NOT NULL,
    "titleSnapshot" TEXT NOT NULL,
    "instructionsSnapshot" TEXT NOT NULL,
    "requiresPhotoSnapshot" BOOLEAN NOT NULL,
    "state" "TaskState" NOT NULL DEFAULT 'NOT_STARTED',
    "reasonCode" TEXT,
    "reasonText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evidence" (
    "id" TEXT NOT NULL,
    "taskInstanceId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "storageRef" TEXT NOT NULL,
    "captureChallengeId" TEXT NOT NULL,
    "capturedAtDevice" TIMESTAMP(3),
    "uploadAcceptedAtServer" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT NOT NULL,

    CONSTRAINT "Evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_householdId_idx" ON "User"("householdId");

-- CreateIndex
CREATE INDEX "RecurringScheduleRule_householdId_ipUserId_idx" ON "RecurringScheduleRule"("householdId", "ipUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledShift_supersedesShiftId_key" ON "ScheduledShift"("supersedesShiftId");

-- CreateIndex
CREATE INDEX "ScheduledShift_householdId_ipUserId_localDate_idx" ON "ScheduledShift"("householdId", "ipUserId", "localDate");

-- CreateIndex
CREATE UNIQUE INDEX "WeekAllowance_householdId_ipUserId_weekStartLocalDate_key" ON "WeekAllowance"("householdId", "ipUserId", "weekStartLocalDate");

-- CreateIndex
CREATE INDEX "Event_householdId_serverTimestampUtc_idx" ON "Event"("householdId", "serverTimestampUtc");

-- CreateIndex
CREATE INDEX "Event_shiftId_idx" ON "Event"("shiftId");

-- CreateIndex
CREATE INDEX "Event_taskInstanceId_idx" ON "Event"("taskInstanceId");

-- CreateIndex
CREATE INDEX "LocationReading_householdId_shiftId_idx" ON "LocationReading"("householdId", "shiftId");

-- CreateIndex
CREATE INDEX "TaskTemplate_householdId_idx" ON "TaskTemplate"("householdId");

-- CreateIndex
CREATE INDEX "TaskInstance_shiftId_idx" ON "TaskInstance"("shiftId");

-- CreateIndex
CREATE INDEX "TaskInstance_householdId_assignedDate_idx" ON "TaskInstance"("householdId", "assignedDate");

-- CreateIndex
CREATE UNIQUE INDEX "Evidence_eventId_key" ON "Evidence"("eventId");

-- CreateIndex
CREATE INDEX "Evidence_taskInstanceId_idx" ON "Evidence"("taskInstanceId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringScheduleRule" ADD CONSTRAINT "RecurringScheduleRule_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledShift" ADD CONSTRAINT "ScheduledShift_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledShift" ADD CONSTRAINT "ScheduledShift_ipUserId_fkey" FOREIGN KEY ("ipUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "ScheduledShift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_taskInstanceId_fkey" FOREIGN KEY ("taskInstanceId") REFERENCES "TaskInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationReading" ADD CONSTRAINT "LocationReading_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationReading" ADD CONSTRAINT "LocationReading_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "ScheduledShift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationReading" ADD CONSTRAINT "LocationReading_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTemplate" ADD CONSTRAINT "TaskTemplate_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskInstance" ADD CONSTRAINT "TaskInstance_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "ScheduledShift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskInstance" ADD CONSTRAINT "TaskInstance_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "TaskTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_taskInstanceId_fkey" FOREIGN KEY ("taskInstanceId") REFERENCES "TaskInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
