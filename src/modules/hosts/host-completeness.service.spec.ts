import { HostCompletenessService } from './host-completeness.service';

describe('HostCompletenessService', () => {
  const service = new HostCompletenessService({} as never);

  it('marks incomplete when avatar and agreements are missing', () => {
    const result = service.evaluateSnapshot({
      profile: {
        userId: 'u1',
        displayName: 'Ada',
        bio: 'Hello there friend',
        gender: 'UNSPECIFIED',
        country: null,
        language: 'en',
        avatarUrl: null,
        isDiscoverable: false,
        ratePerMinuteCents: 100,
        lastActiveAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      host: {
        userId: 'u1',
        status: 'PENDING_REVIEW',
        availability: 'OFFLINE',
        verificationStatus: 'NOT_REQUIRED',
        voiceEnabled: true,
        videoEnabled: true,
        voiceRatePerMinuteCents: 100,
        videoRatePerMinuteCents: 150,
        languages: ['en'],
        interests: ['music'],
        applicationBio: 'Hello there friend',
        reviewNote: null,
        internalNote: null,
        submittedAt: new Date(),
        reviewedAt: null,
        reviewedById: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      acceptedKeys: new Set(),
    });
    expect(result.isComplete).toBe(false);
    expect(result.missingFields).toEqual(
      expect.arrayContaining(['avatar', 'agreements']),
    );
  });

  it('is complete when all required fields are present', () => {
    const result = service.evaluateSnapshot({
      profile: {
        userId: 'u1',
        displayName: 'Ada',
        bio: 'Hello there friend',
        gender: 'UNSPECIFIED',
        country: null,
        language: 'en',
        avatarUrl: 'https://cdn.example.com/a.png',
        isDiscoverable: false,
        ratePerMinuteCents: 100,
        lastActiveAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      host: {
        userId: 'u1',
        status: 'PENDING_REVIEW',
        availability: 'OFFLINE',
        verificationStatus: 'NOT_REQUIRED',
        voiceEnabled: true,
        videoEnabled: false,
        voiceRatePerMinuteCents: 100,
        videoRatePerMinuteCents: 150,
        languages: ['en'],
        interests: ['music'],
        applicationBio: 'Hello there friend',
        reviewNote: null,
        internalNote: null,
        submittedAt: new Date(),
        reviewedAt: null,
        reviewedById: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      acceptedKeys: new Set([
        'HOST_GUIDELINES:1.0',
        'TERMS_OF_SERVICE:1.0',
        'PRIVACY_POLICY:1.0',
      ]),
    });
    expect(result.isComplete).toBe(true);
    expect(result.percentage).toBe(100);
    expect(result.missingFields).toEqual([]);
  });
});
