-- CreateTable
CREATE TABLE "ContactChange" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" "ContactChannel" NOT NULL,
    "contact" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContactChange_userId_createdAt_idx" ON "ContactChange"("userId", "createdAt");

