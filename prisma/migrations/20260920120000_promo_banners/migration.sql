-- Promo banners for home screen

CREATE TABLE IF NOT EXISTS "PromoBanner" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT NOT NULL DEFAULT '',
    "imageUrl" TEXT,
    "ctaLabel" TEXT NOT NULL DEFAULT 'Learn more',
    "deepLink" TEXT,
    "audience" TEXT NOT NULL DEFAULT 'ALL',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PromoBanner_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PromoBanner_isActive_priority_createdAt_idx"
  ON "PromoBanner"("isActive", "priority" DESC, "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "PromoBanner_audience_isActive_idx"
  ON "PromoBanner"("audience", "isActive");

INSERT INTO "PromoBanner" ("id", "title", "subtitle", "ctaLabel", "deepLink", "audience", "priority", "isActive", "updatedAt")
VALUES
  (
    'seed-banner-wallet',
    'Top up & keep talking',
    'Add credits in seconds and never miss a conversation.',
    'Open Wallet',
    '/wallet',
    'ALL',
    20,
    true,
    CURRENT_TIMESTAMP
  ),
  (
    'seed-banner-host',
    'Become a Listener',
    'Earn on your schedule with verified voice & video calls.',
    'Apply now',
    '/host/apply',
    'USER',
    10,
    true,
    CURRENT_TIMESTAMP
  )
ON CONFLICT ("id") DO NOTHING;
