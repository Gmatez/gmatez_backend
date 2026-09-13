import { toDiscoveryItem, toOwnProfile, toPublicProfile } from './profile.presenter';

describe('profile presenter', () => {
  const host = {
    status: 'ACTIVE' as const,
    availability: 'ONLINE' as const,
    voiceEnabled: true,
    videoEnabled: true,
    voiceRatePerMinuteCents: 150,
    videoRatePerMinuteCents: 200,
    languages: ['en'],
    interests: ['music'],
  };
  const row = {
    userId: 'user-1',
    displayName: 'Alice',
    bio: 'Hi',
    gender: 'FEMALE' as const,
    country: 'US',
    language: 'en',
    avatarUrl: null,
    ratePerMinuteCents: 150,
    lastActiveAt: new Date('2026-01-01T00:00:00.000Z'),
    isDiscoverable: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    user: { hostProfile: host },
  };

  it('marks active online hosts as available for call', () => {
    expect(toDiscoveryItem(row, true).availableForCall).toBe(true);
    expect(
      toDiscoveryItem(
        {
          ...row,
          user: { hostProfile: { ...host, availability: 'OFFLINE' } },
        },
        true,
      ).availableForCall,
    ).toBe(false);
  });

  it('does not expose secrets on own or public profiles', () => {
    const own = toOwnProfile(row, true);
    const pub = toPublicProfile('user-1', row, false, host);
    expect(own).not.toHaveProperty('passwordHash');
    expect(own).not.toHaveProperty('email');
    expect(pub).not.toHaveProperty('passwordHash');
    expect(pub.profile).not.toHaveProperty('passwordHash');
    expect(pub.host?.reviewNote).toBeUndefined();
  });
});
