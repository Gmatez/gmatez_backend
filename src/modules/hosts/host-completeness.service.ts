import { Injectable } from '@nestjs/common';
import { HostProfile, HostVerificationStatus, Profile } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { REQUIRED_HOST_AGREEMENTS } from './host-agreements';

export type HostCompletenessField =
  | 'displayName'
  | 'bio'
  | 'languages'
  | 'avatar'
  | 'callTypes'
  | 'pricing'
  | 'agreements'
  | 'verification';

export type HostCompletenessResult = {
  isComplete: boolean;
  percentage: number;
  missingFields: HostCompletenessField[];
  verificationStatus: HostVerificationStatus | 'UNKNOWN';
  requiredAgreements: Array<{ agreementType: string; version: string }>;
};

const FIELD_WEIGHT: Record<HostCompletenessField, number> = {
  displayName: 15,
  bio: 10,
  languages: 15,
  avatar: 15,
  callTypes: 15,
  pricing: 10,
  agreements: 15,
  verification: 5,
};

@Injectable()
export class HostCompletenessService {
  constructor(private readonly prisma: PrismaService) {}

  async evaluate(userId: string): Promise<HostCompletenessResult> {
    const [profile, host, acceptances] = await Promise.all([
      this.prisma.profile.findUnique({ where: { userId } }),
      this.prisma.hostProfile.findUnique({ where: { userId } }),
      this.prisma.hostAgreementAcceptance.findMany({ where: { userId } }),
    ]);
    return this.evaluateSnapshot({
      profile,
      host,
      acceptedKeys: new Set(
        acceptances.map((row) => `${row.agreementType}:${row.version}`),
      ),
    });
  }

  evaluateSnapshot(input: {
    profile: Profile | null;
    host: HostProfile | null;
    acceptedKeys: Set<string>;
  }): HostCompletenessResult {
    const missing: HostCompletenessField[] = [];
    const profile = input.profile;
    const host = input.host;

    if (!profile || profile.displayName.trim().length < 2) {
      missing.push('displayName');
    }
    const bio = (host?.applicationBio || profile?.bio || '').trim();
    if (bio.length < 8) {
      missing.push('bio');
    }
    if (!host || host.languages.length === 0) {
      missing.push('languages');
    }
    if (!profile?.avatarUrl || !/^https?:\/\//i.test(profile.avatarUrl)) {
      missing.push('avatar');
    }
    if (!host || (!host.voiceEnabled && !host.videoEnabled)) {
      missing.push('callTypes');
    }
    if (
      !host ||
      !Number.isInteger(host.voiceRatePerMinuteCents) ||
      host.voiceRatePerMinuteCents < 1 ||
      !Number.isInteger(host.videoRatePerMinuteCents) ||
      host.videoRatePerMinuteCents < 1
    ) {
      missing.push('pricing');
    }

    const missingAgreement = REQUIRED_HOST_AGREEMENTS.some(
      (item) =>
        !input.acceptedKeys.has(`${item.agreementType}:${item.version}`),
    );
    if (missingAgreement) {
      missing.push('agreements');
    }

    const verificationStatus = host?.verificationStatus ?? 'UNKNOWN';
    if (
      verificationStatus !== 'NOT_REQUIRED' &&
      verificationStatus !== 'VERIFIED'
    ) {
      missing.push('verification');
    }

    const totalWeight = Object.values(FIELD_WEIGHT).reduce((a, b) => a + b, 0);
    const earned = (Object.keys(FIELD_WEIGHT) as HostCompletenessField[])
      .filter((field) => !missing.includes(field))
      .reduce((sum, field) => sum + FIELD_WEIGHT[field], 0);

    return {
      isComplete: missing.length === 0,
      percentage: Math.round((earned / totalWeight) * 100),
      missingFields: missing,
      verificationStatus,
      requiredAgreements: REQUIRED_HOST_AGREEMENTS.map((item) => ({
        agreementType: item.agreementType,
        version: item.version,
      })),
    };
  }
}
