export type CallingSession = {
  sessionId: string;
  callerToken: string;
  calleeToken: string;
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
  expireSession(sessionId: string): Promise<void>;
  verifyCallback(rawBody: string, signature: string | undefined): boolean;
  parseCallback(rawBody: string): CallingCallback;
}
