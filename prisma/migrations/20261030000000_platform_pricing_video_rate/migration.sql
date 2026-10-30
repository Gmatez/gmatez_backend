-- Optional global VIDEO-call rate override. Nullable and additive: existing
-- rows are unaffected, and calling.service.ts falls back to each host's own
-- videoRatePerMinuteCents when this stays unset, instead of silently reusing
-- the voice rate above it.
ALTER TABLE "PlatformPricing" ADD COLUMN "userVideoRatePerMinuteCents" INTEGER;
