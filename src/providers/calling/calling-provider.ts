export type CallingSession = {
  sessionId: string;
  channelName: string;
  appId: string;
  callerUid: number;
  calleeUid: number;
  /** Empty until accept / rtc-token for Agora; mock fills immediately. */
  callerToken: string;
  calleeToken: string;
  tokenExpiresAt: string;
};

export type RtcParticipantCredentials = {
  appId: string;
  channelName: string;
  uid: number;
  token: string;
  tokenExpiresAt: string;
  callType: 'VOICE' | 'VIDEO';
};

export type CallingCallback = {
  eventId: string;
  sessionId: string;
  type: 'ringing' | 'connecting' | 'connected' | 'ended' | 'failed';
  reason?: string;
};

export interface CallingProvider {
  readonly name: string;
  createSession(input: {
    callId: string;
    callerId: string;
    calleeId: string;
  }): Promise<CallingSession>;
  /**
   * Mint (or re-mint) a short-lived RTC token for one participant.
   * Agora: real RTC token. Mock: deterministic stub string.
   */
  issueParticipantToken(input: {
    callId: string;
    callerId: string;
    calleeId: string;
    userId: string;
  }): Promise<Omit<RtcParticipantCredentials, 'callType'>>;
  expireSession(sessionId: string): Promise<void>;
  verifyCallback(rawBody: string, signature: string | undefined): boolean;
  parseCallback(rawBody: string): CallingCallback;
}
