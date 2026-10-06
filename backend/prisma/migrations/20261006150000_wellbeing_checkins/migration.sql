-- CreateEnum
CREATE TYPE "CheckInInstrument" AS ENUM ('PHQ2', 'GAD2');

-- CreateTable
CREATE TABLE "CheckInPlan" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "instrument" "CheckInInstrument" NOT NULL,
    "everyDays" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "startDate" TEXT NOT NULL,
    "consentRecordedAt" TIMESTAMP(3) NOT NULL,
    "consentNote" TEXT,
    "setByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckInPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckInResponse" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "instrument" "CheckInInstrument" NOT NULL,
    "localDate" TEXT NOT NULL,
    "skipped" BOOLEAN NOT NULL DEFAULT false,
    "answers" INTEGER[],
    "score" INTEGER,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "answeredByUserId" TEXT NOT NULL,
    "answeredByRole" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckInResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CheckInPlan_householdId_instrument_key" ON "CheckInPlan"("householdId", "instrument");

-- CreateIndex
CREATE UNIQUE INDEX "CheckInResponse_householdId_instrument_localDate_key" ON "CheckInResponse"("householdId", "instrument", "localDate");

