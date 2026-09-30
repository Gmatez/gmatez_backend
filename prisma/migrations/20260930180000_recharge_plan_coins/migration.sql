ALTER TABLE "RechargePlan" ADD COLUMN "coins" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RechargePlan" ADD COLUMN "bonusCoins" INTEGER NOT NULL DEFAULT 0;

-- A ₹299 plan stored as 29900 minor units was showing as 2990 coins (minor / 10).
-- Backfill coins from the rupee price so the card matches the amount the member pays.
UPDATE "RechargePlan"
SET "coins" = GREATEST("priceMinor" / 100, 1),
    "bonusCoins" = GREATEST("bonusMinor" / 100, 0);

UPDATE "RechargePlan"
SET "walletCreditMinor" = "coins" * 10,
    "bonusMinor" = "bonusCoins" * 10;
