/**
 * Server-authoritative Agora channel + UID mapping.
 * Channel never embeds PII — only opaque call id.
 * UIDs are fixed per role within a 1:1 call (unique in-channel).
 */
export function rtcChannelName(callId: string): string {
  return `gmatez-call-${callId}`;
}

export const RTC_UID_CALLER = 1;
export const RTC_UID_CALLEE = 2;

export function rtcUidForUser(params: {
  userId: string;
  callerId: string;
  calleeId: string;
}): number {
  if (params.userId === params.callerId) {
    return RTC_UID_CALLER;
  }
  if (params.userId === params.calleeId) {
    return RTC_UID_CALLEE;
  }
  throw new Error('User is not a call participant');
}
