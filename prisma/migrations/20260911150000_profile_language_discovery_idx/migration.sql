-- Language filter for discovery feed/search. Justified by GET /discovery/* filtering on language
-- then ordering by lastActiveAt for discoverable profiles.
CREATE INDEX "Profile_language_isDiscoverable_lastActiveAt_idx"
ON "Profile" ("language", "isDiscoverable", "lastActiveAt" DESC);
