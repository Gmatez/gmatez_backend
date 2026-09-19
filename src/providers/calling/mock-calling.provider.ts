import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppConfigService } from '../../config/app-config';
import { hmacSha256, verifyHmacHeader } from '../../common/crypto/hashing';
import {
  CallingCallback,
  CallingProvider,
  CallingSession,
} from './calling-provider';
import {
  RTC_UID_CALLEE,
  RTC_UID_CALLER,
  rtcChannelName,
  rtcUidForUser,
} from './rtc-identity';

@Injectable()
export class MockCallingProvider implements CallingProvider {
  readonly name = 'mock';

  constructor(private readonly config: AppConfigService) {}

  async createSession(input: {
    callId: string;
    callerId: string;
    calleeId: string;
  }): Promise<CallingSession> {
    const channelName = rtcChannelName(input.callId);
    const tokenExpiresAt = new Date(Date.now() + 3600_000).toISOString();
    return {
      sessionId: `mock_${input.callId}`,
      channelName,
      appId: 'mock-app-id',
      callerUid: RTC_UID_CALLER,
      calleeUid: RTC_UID_CALLEE,
      callerToken: `caller.${input.callerId}.${input.callId}`,
      calleeToken: `callee.${input.calleeId}.${input.callId}`,
      tokenExpiresAt,
    };
  }

  async issueParticipantToken(input: {
    callId: string;
    callerId: string;
    calleeId: string;
    userId: string;
  }) {
    const uid = rtcUidForUser({
      userId: input.userId,
      callerId: input.callerId,
      calleeId: input.calleeId,
    });
    const role = uid === RTC_UID_CALLER ? 'caller' : 'callee';
    return {
      appId: 'mock-app-id',
      channelName: rtcChannelName(input.callId),
      uid,
      token: `${role}.${input.userId}.${input.callId}`,
      tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
  }

  async expireSession(_sessionId: string): Promise<void> {
    return;
  }

  verifyCallback(rawBody: string, signature: string | undefined): boolean {
    return verifyHmacHeader(
      this.config.get('CALLING_WEBHOOK_SECRET'),
      rawBody,
      signature,
    );
  }

  parseCallback(rawBody: string): CallingCallback {
    const parsed = JSON.parse(rawBody) as CallingCallback;
    return {
      eventId: parsed.eventId ?? randomUUID(),
      sessionId: parsed.sessionId,
      type: parsed.type,
      reason: parsed.reason,
    };
  }

  sign(body: string): string {
    return hmacSha256(this.config.get('CALLING_WEBHOOK_SECRET'), body);
  }
}
