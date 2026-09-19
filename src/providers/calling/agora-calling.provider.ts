import { Injectable } from '@nestjs/common';
import { RtcRole, RtcTokenBuilder } from 'agora-token';
import { AppConfigService } from '../../config/app-config';
import { verifyHmacHeader } from '../../common/crypto/hashing';
import {
  CallingProvider,
  CallingSession,
  CallingCallback,
} from './calling-provider';
import {
  RTC_UID_CALLEE,
  RTC_UID_CALLER,
  rtcChannelName,
  rtcUidForUser,
} from './rtc-identity';

@Injectable()
export class AgoraCallingProvider implements CallingProvider {
  readonly name = 'agora';

  constructor(private readonly config: AppConfigService) {}

  async createSession(input: {
    callId: string;
    callerId: string;
    calleeId: string;
  }): Promise<CallingSession> {
    const appId = this.requireAppId();
    this.requireCertificate();
    const channelName = rtcChannelName(input.callId);
    const expirySeconds = this.tokenExpirySeconds();
    const tokenExpiresAt = new Date(
      Date.now() + expirySeconds * 1000,
    ).toISOString();
    // Session/channel are reserved at ring time; tokens are minted only via
    // issueParticipantToken after the call is accepted (RTC entry gate).
    return {
      sessionId: `agora_${input.callId}`,
      channelName,
      appId,
      callerUid: RTC_UID_CALLER,
      calleeUid: RTC_UID_CALLEE,
      callerToken: '',
      calleeToken: '',
      tokenExpiresAt,
    };
  }

  async issueParticipantToken(input: {
    callId: string;
    callerId: string;
    calleeId: string;
    userId: string;
  }) {
    const appId = this.requireAppId();
    const certificate = this.requireCertificate();
    const channelName = rtcChannelName(input.callId);
    const uid = rtcUidForUser({
      userId: input.userId,
      callerId: input.callerId,
      calleeId: input.calleeId,
    });
    const expirySeconds = this.tokenExpirySeconds();
    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      certificate,
      channelName,
      uid,
      RtcRole.PUBLISHER,
      expirySeconds,
      expirySeconds,
    );
    return {
      appId,
      channelName,
      uid,
      token,
      tokenExpiresAt: new Date(Date.now() + expirySeconds * 1000).toISOString(),
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

  private requireAppId(): string {
    const appId = this.config.get('AGORA_APP_ID');
    if (!appId) {
      throw new Error('AGORA_APP_ID is not configured');
    }
    return appId;
  }

  private requireCertificate(): string {
    const cert = this.config.get('AGORA_APP_CERTIFICATE');
    if (!cert) {
      throw new Error('AGORA_APP_CERTIFICATE is not configured');
    }
    return cert;
  }

  private tokenExpirySeconds(): number {
    return this.config.get('AGORA_TOKEN_EXPIRY_SECONDS');
  }
}
