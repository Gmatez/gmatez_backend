require('dotenv').config({ quiet: true });
const { PrismaClient, LedgerReason } = require('@prisma/client');

const prisma = new PrismaClient();

/**
 * Phase 4A backfill: copies every existing HostProfile + its owning User's
 * host-relevant data into the new standalone Host table and its satellite
 * tables (HostWallet, HostRefreshToken, HostDeviceToken, HostAppNotification,
 * HostNotificationPreference).
 *
 * Reuses HostProfile.userId as the new Host.id (see schema.prisma's comment
 * on the Host model) so every existing FK that already points at that id
 * keeps working once later migrations repoint it at Host instead of User.
 *
 * Idempotent: re-running skips any Host row that already exists for a given
 * id, so a partial run can be safely retried.
 *
 * Does NOT delete the old User/HostProfile rows or touch any other table —
 * that happens only once Phase 4C has moved Call/Conversation/Message/Block/
 * Report off the old User id for each host.
 */
async function main() {
  const hostProfiles = await prisma.hostProfile.findMany({
    include: { user: true, agreementAcceptances: true },
  });
  console.log(`found ${hostProfiles.length} HostProfile rows`);

  let created = 0;
  let skipped = 0;

  for (const hp of hostProfiles) {
    const existing = await prisma.host.findUnique({ where: { id: hp.userId } });
    if (existing) {
      skipped += 1;
      continue;
    }

    const user = hp.user;
    const profile = await prisma.profile.findUnique({ where: { userId: hp.userId } });
    const wallet = await prisma.wallet.findUnique({
      where: { userId: hp.userId },
      include: { ledger: true },
    });
    const deviceTokens = await prisma.deviceToken.findMany({ where: { userId: hp.userId } });
    const notifications = await prisma.appNotification.findMany({ where: { userId: hp.userId } });
    const notificationPreference = await prisma.notificationPreference.findUnique({
      where: { userId: hp.userId },
    });
    const refreshTokens = await prisma.refreshToken.findMany({ where: { userId: hp.userId } });

    const earningEntries = (wallet?.ledger ?? []).filter(
      (entry) => entry.reason === LedgerReason.CREATOR_EARNING || entry.reason === LedgerReason.PAYOUT,
    );

    await prisma.$transaction(async (tx) => {
      await tx.host.create({
        data: {
          id: hp.userId,
          phone: user.phone ?? `unknown-${hp.userId}`,
          email: user.email.endsWith('@phone.gmatez.invalid') ? null : user.email,
          accountStatus: user.status,
          status: hp.status,
          availability: hp.availability,
          verificationStatus: hp.verificationStatus,
          displayName: profile?.displayName ?? '',
          bio: profile?.bio ?? '',
          gender: profile?.gender ?? 'UNSPECIFIED',
          country: profile?.country ?? null,
          language: profile?.language ?? null,
          avatarUrl: profile?.avatarUrl ?? null,
          isDiscoverable: profile?.isDiscoverable ?? true,
          lastActiveAt: profile?.lastActiveAt ?? new Date(),
          voiceEnabled: hp.voiceEnabled,
          videoEnabled: hp.videoEnabled,
          voiceRatePerMinuteCents: hp.voiceRatePerMinuteCents,
          videoRatePerMinuteCents: hp.videoRatePerMinuteCents,
          languages: hp.languages,
          interests: hp.interests,
          applicationBio: hp.applicationBio,
          reviewNote: hp.reviewNote,
          internalNote: hp.internalNote,
          submittedAt: hp.submittedAt,
          reviewedAt: hp.reviewedAt,
          reviewedById: hp.reviewedById,
          idProofType: hp.idProofType,
          idProofLast4: hp.idProofLast4,
          idProofMime: hp.idProofMime,
          idProofUpdatedAt: hp.idProofUpdatedAt,
          identityCardNumber: hp.identityCardNumber,
          identityFrontMime: hp.identityFrontMime,
          identityBackMime: hp.identityBackMime,
          profileImageMime: hp.profileImageMime,
          createdAt: hp.createdAt,
          updatedAt: hp.updatedAt,
        },
      });

      if (wallet) {
        const hostWallet = await tx.hostWallet.create({
          data: {
            hostId: hp.userId,
            currency: wallet.currency,
            availableBalanceCents: earningEntries.length > 0 ? wallet.availableBalanceCents : 0,
            heldBalanceCents: 0,
            version: 0,
            createdAt: wallet.createdAt,
            updatedAt: wallet.updatedAt,
          },
        });
        for (const entry of earningEntries) {
          await tx.hostWalletLedgerEntry.create({
            data: {
              walletId: hostWallet.id,
              type: entry.type,
              reason: entry.reason,
              amountCents: entry.amountCents,
              balanceAfterCents: entry.balanceAfterCents,
              idempotencyKey: `host-backfill:${entry.idempotencyKey}`,
              referenceType: entry.referenceType,
              referenceId: entry.referenceId,
              metadata: entry.metadata ?? undefined,
              createdAt: entry.createdAt,
            },
          });
        }
      }

      for (const token of deviceTokens) {
        await tx.hostDeviceToken.create({
          data: {
            hostId: hp.userId,
            token: `host:${token.token}`,
            platform: token.platform,
            createdAt: token.createdAt,
            updatedAt: token.updatedAt,
          },
        });
      }

      for (const note of notifications) {
        await tx.hostAppNotification.create({
          data: {
            hostId: hp.userId,
            type: note.type,
            title: note.title,
            body: note.body,
            data: note.data ?? undefined,
            status: note.status,
            readAt: note.readAt,
            createdAt: note.createdAt,
          },
        });
      }

      if (notificationPreference) {
        await tx.hostNotificationPreference.create({
          data: {
            hostId: hp.userId,
            incomingCall: notificationPreference.incomingCall,
            chatMessage: notificationPreference.chatMessage,
            payout: notificationPreference.payout,
            system: notificationPreference.system,
            updatedAt: notificationPreference.updatedAt,
          },
        });
      }

      for (const rt of refreshTokens) {
        if (rt.revokedAt) continue;
        await tx.hostRefreshToken.create({
          data: {
            hostId: hp.userId,
            familyId: rt.familyId,
            tokenHash: `host:${rt.tokenHash}`,
            expiresAt: rt.expiresAt,
            revokedAt: rt.revokedAt,
            createdAt: rt.createdAt,
          },
        });
      }
    });

    created += 1;
  }

  console.log(`created ${created} Host rows, skipped ${skipped} already-backfilled`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
