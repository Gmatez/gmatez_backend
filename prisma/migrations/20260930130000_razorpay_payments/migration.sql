-- Razorpay top-up metadata. Minor units stay on amountCents (paise when currency is INR).
ALTER TABLE "Payment" ADD COLUMN "providerCaptureId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "refundStatus" TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "Payment" ADD COLUMN "refundAttempt" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Payment" ADD COLUMN "providerRefundId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "refundedAmountCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Payment" ADD COLUMN "reconciliationStatus" TEXT NOT NULL DEFAULT 'OK';
ALTER TABLE "Payment" ADD COLUMN "capturedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Payment_providerRefundId_key" ON "Payment"("providerRefundId");
CREATE INDEX "Payment_providerCaptureId_idx" ON "Payment"("providerCaptureId");

ALTER TABLE "PayoutRequest" ADD COLUMN "externalTransferStatus" TEXT NOT NULL DEFAULT 'NOT_TRANSFERRED';
ALTER TABLE "PayoutRequest" ADD COLUMN "providerTransferId" TEXT;
