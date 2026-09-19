import { RtcRole, RtcTokenBuilder } from 'agora-token';
import {
  RTC_UID_CALLEE,
  RTC_UID_CALLER,
  rtcChannelName,
  rtcUidForUser,
} from './rtc-identity';

describe('rtc identity', () => {
  it('builds opaque channel names and stable uids', () => {
    const callId = '11111111-2222-3333-4444-555555555555';
    expect(rtcChannelName(callId)).toBe(`gmatez-call-${callId}`);
    expect(
      rtcUidForUser({
        userId: 'caller',
        callerId: 'caller',
        calleeId: 'callee',
      }),
    ).toBe(RTC_UID_CALLER);
    expect(
      rtcUidForUser({
        userId: 'callee',
        callerId: 'caller',
        calleeId: 'callee',
      }),
    ).toBe(RTC_UID_CALLEE);
  });
});

describe('agora token builder smoke', () => {
  it('mints a non-empty token with test credentials shape', () => {
    // Deterministic dummy credentials — validates builder wiring only.
    const appId = 'a'.repeat(32);
    const cert = 'b'.repeat(32);
    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      cert,
      'gmatez-call-test',
      1,
      RtcRole.PUBLISHER,
      600,
      600,
    );
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(20);
  });
});
