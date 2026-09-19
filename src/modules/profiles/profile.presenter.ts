import { Gender, HostAvailability, HostStatus } from '@prisma/client';

export const discoveryProfileSelect = {
  userId: true,
  displayName: true,
  bio: true,
  gender: true,
  country: true,
  language: true,
  avatarUrl: true,
  ratePerMinuteCents: true,
  lastActiveAt: true,
  user: {
    select: {
      hostProfile: {
        select: {
          status: true,
          availability: true,
          voiceEnabled: true,
          videoEnabled: true,
          voiceRatePerMinuteCents: true,
          videoRatePerMinuteCents: true,
          languages: true,
          interests: true,
        },
      },
    },
  },
} as const;

export type HostPublic = {
  status: HostStatus;
  availability: HostAvailability;
  voiceEnabled: boolean;
  videoEnabled: boolean;
  voiceRatePerMinuteCents: number;
  videoRatePerMinuteCents: number;
  languages: string[];
  interests: string[];
};

export type DiscoveryProfileRow = {
  userId: string;
  displayName: string;
  bio: string;
  gender: Gender;
  country: string | null;
  language: string | null;
  avatarUrl: string | null;
  ratePerMinuteCents: number;
  lastActiveAt: Date;
  user?: { hostProfile: HostPublic | null };
};

export type OwnProfileRow = Omit<DiscoveryProfileRow, 'user'> & {
  isDiscoverable: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function hostPublic(row: DiscoveryProfileRow): HostPublic | null {
  return row.user?.hostProfile ?? null;
}

export function toDiscoveryItem(row: DiscoveryProfileRow, online: boolean) {
  const host = hostPublic(row);
  const availableForCall =
    Boolean(host) &&
    host!.status === 'ACTIVE' &&
    host!.availability === 'ONLINE';
  return {
    userId: row.userId,
    displayName: row.displayName,
    bio: row.bio,
    gender: row.gender,
    country: row.country,
    language: row.language,
    avatarUrl: row.avatarUrl,
    ratePerMinuteCents: host?.voiceRatePerMinuteCents ?? row.ratePerMinuteCents,
    lastActiveAt: row.lastActiveAt,
    online,
    availableForCall,
    host: host
      ? {
          status: host.status,
          availability: host.availability,
          voiceEnabled: host.voiceEnabled,
          videoEnabled: host.videoEnabled,
          voiceRatePerMinuteCents: host.voiceRatePerMinuteCents,
          videoRatePerMinuteCents: host.videoRatePerMinuteCents,
          languages: host.languages,
          interests: host.interests,
        }
      : null,
  };
}

export function toOwnProfile(row: OwnProfileRow, online: boolean) {
  return {
    userId: row.userId,
    displayName: row.displayName,
    bio: row.bio,
    gender: row.gender,
    country: row.country,
    language: row.language,
    avatarUrl: row.avatarUrl,
    isDiscoverable: row.isDiscoverable,
    ratePerMinuteCents: row.ratePerMinuteCents,
    lastActiveAt: row.lastActiveAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    online,
    availableForCall: online && row.isDiscoverable,
  };
}

export function toPublicProfile(
  userId: string,
  profile: {
    displayName: string;
    bio: string;
    gender: Gender;
    country: string | null;
    language: string | null;
    avatarUrl: string | null;
    isDiscoverable: boolean;
    ratePerMinuteCents: number;
    lastActiveAt: Date;
  },
  online: boolean,
  host?: HostPublic | null,
) {
  const availableForCall =
    Boolean(host) &&
    host!.status === 'ACTIVE' &&
    host!.availability === 'ONLINE';
  return {
    id: userId,
    online,
    availableForCall,
    host: host
      ? {
          status: host.status,
          availability: host.availability,
          voiceEnabled: host.voiceEnabled,
          videoEnabled: host.videoEnabled,
          voiceRatePerMinuteCents: host.voiceRatePerMinuteCents,
          videoRatePerMinuteCents: host.videoRatePerMinuteCents,
          languages: host.languages,
          interests: host.interests,
        }
      : null,
    profile: {
      displayName: profile.displayName,
      bio: profile.bio,
      gender: profile.gender,
      country: profile.country,
      language: profile.language,
      avatarUrl: profile.avatarUrl,
      isDiscoverable: profile.isDiscoverable,
      ratePerMinuteCents:
        host?.voiceRatePerMinuteCents ?? profile.ratePerMinuteCents,
      lastActiveAt: profile.lastActiveAt,
    },
  };
}
