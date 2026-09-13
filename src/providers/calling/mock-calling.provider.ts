import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppConfigService } from '../../config/app-config';
import { hmacSha256, verifyHmacHeader } from '../../common/crypto/hashing';
import {
  CallingCallback,
  CallingProvider,
  CallingSession,
} from './calling-provider';

@Injectable()
export class MockCallingProvider implements CallingProvider {
  readonly name = 'mock';

  constructor(private readonly config: AppConfigService) {}

  async createSession(input: {
    callId: string;
    callerId: string;
    calleeId: string;
  }): Promise<CallingSession> {
    const sessionId = `mock_${input.callId}`;
    return {
      sessionId,
      callerToken: `caller.${input.callerId}.${input.callId}`,
      calleeToken: `callee.${input.calleeId}.${input.callId}`,
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
