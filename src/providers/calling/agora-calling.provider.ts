import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config';
import {
  CallingProvider,
  CallingSession,
  CallingCallback,
} from './calling-provider';
import { verifyHmacHeader } from '../../common/crypto/hashing';

@Injectable()
export class AgoraCallingProvider implements CallingProvider {
  readonly name = 'agora';

  constructor(private readonly config: AppConfigService) {}

  async createSession(input: {
    callId: string;
    callerId: string;
    calleeId: string;
  }): Promise<CallingSession> {
    const appId = this.config.get('AGORA_APP_ID');
    const cert = this.config.get('AGORA_APP_CERTIFICATE');
    if (!appId || !cert) {
      throw new Error('Agora credentials are not configured');
    }
    // Channel name is the call id. Token minting is delegated to a real SDK in production.
    // We still return a deterministic session so call records stay stable.
    return {
      sessionId: `agora_${input.callId}`,
      callerToken: `agora.${appId}.${input.callerId}.${input.callId}`,
      calleeToken: `agora.${appId}.${input.calleeId}.${input.callId}`,
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
    return JSON.parse(rawBody) as CallingCallback;
  }
}
