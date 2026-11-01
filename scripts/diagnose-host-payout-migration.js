require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

/**
 * Read-only diagnostic for the production migration failure on
 * 20261101095744_repoint_host_supervision_and_payouts_to_host.
 *
 * That migration assumed PayoutDestination/PayoutRequest/HostSupervision
 * were empty (true in dev/test) but production has real rows, so the
 * blind DROP+ADD NOT NULL failed. Before applying the corrected migration,
 * run this against the SAME DATABASE_URL to confirm every existing row's
 * owner actually has a HostProfile (the backfill's source of truth) — if
 * this reports zero orphans, the corrected migration is safe to run.
 *
 * Makes no writes.
 */
async function main() {
  const [hostProfiles, hosts, destinations, requests, supervisions] =
    await Promise.all([
      prisma.hostProfile.count(),
      prisma.host.count(),
      prisma.payoutDestination.count(),
      prisma.payoutRequest.count(),
      prisma.hostSupervision.count(),
    ]);
  console.log({ hostProfiles, hosts, destinations, requests, supervisions });

  const orphanDestinations = await prisma.$queryRaw`
    SELECT pd."id", pd."userId" FROM "PayoutDestination" pd
    LEFT JOIN "HostProfile" hp ON hp."userId" = pd."userId"
    WHERE hp."userId" IS NULL
  `;
  const orphanRequests = await prisma.$queryRaw`
    SELECT pr."id", pr."userId" FROM "PayoutRequest" pr
    LEFT JOIN "HostProfile" hp ON hp."userId" = pr."userId"
    WHERE hp."userId" IS NULL
  `;
  const orphanSupervisions = await prisma.$queryRaw`
    SELECT hs."id", hs."hostUserId" FROM "HostSupervision" hs
    LEFT JOIN "HostProfile" hp ON hp."userId" = hs."hostUserId"
    WHERE hp."userId" IS NULL
  `;

  console.log('orphan PayoutDestination rows (no matching HostProfile):', orphanDestinations);
  console.log('orphan PayoutRequest rows (no matching HostProfile):', orphanRequests);
  console.log('orphan HostSupervision rows (no matching HostProfile):', orphanSupervisions);

  const safe =
    orphanDestinations.length === 0 &&
    orphanRequests.length === 0 &&
    orphanSupervisions.length === 0;
  console.log(safe ? '\nSAFE to run the corrected migration.' : '\nNOT SAFE — resolve the orphan rows above first.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
