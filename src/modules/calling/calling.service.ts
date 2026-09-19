import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { Call, CallStatus, CallType, Prisma } from '@prisma/client';
import { AppError, ErrorCodes } from '../../common/errors/app-error';
import {
  CursorPage,
  decodeCursor,
  encodeCursor,
} from '../../common/dto/pagination.dto';
import { PrismaService } from '../../database/prisma.service';
import { QueueService } from '../../queue/queue.service';
import { CALLING_PROVIDER } from '../../providers/calling/calling.tokens';
import type { CallingProvider } from '../../providers/calling/calling-provider';
import { BlockingService } from '../blocking/blocking.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WalletService } from '../wallet/wallet.service';
import {
  canTransition,
  computeBilledSeconds,
  computeCallCostCents,
  computeCreatorEarningCents,
  isTerminal,
  TERMINAL_CALL_STATUSES,
} from './call-state.machine';
import { RealtimeEmitter } from '../../realtime/realtime-emitter';
import { HostsService } from '../hosts/hosts.service';
import { RedisService } from '../../redis/redis.service';
import { rtcChannelName } from '../../providers/calling/rtc-identity';
import { AppConfigService } from '../../config/app-config';

const RING_TIMEOUT_MS = 45_000;
const HEARTBEAT_STALE_MS = 45_000;
const HOLD_SECONDS = 60;
const RTC_JOIN_TTL_SECONDS = 60 * 60 * 6;

const RTC_TOKEN_ALLOWED: CallStatus[] = [
  CallStatus.ACCEPTED,
  CallStatus.CONNECTING,
  CallStatus.CONNECTED,
];

@Injectable()
export class CallingService implements OnModuleInit {
  private readonly logger = new Logger(CallingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly blocking: BlockingService,
    private readonly notifications: NotificationsService,
    private readonly queue: QueueService,
    private readonly realtime: RealtimeEmitter,
    private readonly hosts: HostsService,
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
    @Inject(CALLING_PROVIDER) private readonly provider: CallingProvider,
  ) {}

  onModuleInit(): void {
    this.queue.registerWorker('call-lifecycle', async (job) => {
      if (job.name === 'ring-timeout') {
        await this.timeoutIfStillRinging(job.data.callId as string);
      }
      if (job.name === 'heartbeat-check') {
        await this.failIfHeartbeatStale(job.data.callId as string);
      }
      if (job.name === 'extend-hold') {
        await this.extendHoldIfConnected(job.data.callId as string);
      }
    });
  }

  async createCall(
    callerId: string,
    calleeId: string,
    idempotencyKey?: string,
    callType: CallType = CallType.VOICE,
  ) {
    if (idempotencyKey && idempotencyKey.length >= 8) {
      const prior = await this.prisma.call.findUnique({
        where: { idempotencyKey },
      });
      if (prior) {
        if (prior.callerId !== callerId) {
          throw new AppError(
            ErrorCodes.CONFLICT,
            'Idempotency key already used',
            HttpStatus.CONFLICT,
          );
        }
        const payload = await this.publicCall(prior);
        return { ...payload, idempotencyKey };
      }
    }

    if (callerId === calleeId) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, 'Cannot call yourself');
    }
    if (await this.blocking.isBlockedEitherWay(callerId, calleeId)) {
      throw new AppError(
        ErrorCodes.USER_BLOCKED,
        'User is unavailable',
        HttpStatus.FORBIDDEN,
      );
    }
    const callee = await this.prisma.user.findUnique({
      where: { id: calleeId },
      include: { profile: true },
    });
    if (!callee || callee.status !== 'ACTIVE' || !callee.profile) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'User not found',
        HttpStatus.NOT_FOUND,
      );
    }
    const host = await this.hosts.assertCallable(calleeId, callType);
    const rate =
      callType === CallType.VIDEO
        ? host.videoRatePerMinuteCents
        : host.voiceRatePerMinuteCents;
    const minHold = Math.max(rate, 1);
    const wallet = await this.wallet.getByUserId(callerId);
    if (wallet.availableBalanceCents < minHold) {
      throw new AppError(
        ErrorCodes.WALLET_INSUFFICIENT_FUNDS,
        'Insufficient balance to start a call',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const active = await this.prisma.call.findFirst({
      where: {
        status: { notIn: TERMINAL_CALL_STATUSES },
        OR: [
          { callerId },
          { calleeId: callerId },
          { callerId: calleeId },
          { calleeId },
        ],
      },
    });
    if (active) {
      if (idempotencyKey && idempotencyKey.length >= 8) {
        const prior = await this.prisma.call.findUnique({
          where: { idempotencyKey },
        });
        if (prior && prior.callerId === callerId) {
          const payload = await this.publicCall(prior);
          return { ...payload, idempotencyKey };
        }
      }
      throw new AppError(
        ErrorCodes.CALL_ALREADY_ACTIVE,
        'An active call already exists',
        HttpStatus.CONFLICT,
      );
    }

    let call;
    try {
      call = await this.prisma.call.create({
        data: {
          callerId,
          calleeId,
          callType,
          status: CallStatus.INITIATED,
          provider: this.provider.name,
          providerSessionId: `pending_${crypto.randomUUID()}`,
          ratePerMinuteCents: rate,
          ...(idempotencyKey && idempotencyKey.length >= 8
            ? { idempotencyKey }
            : {}),
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        idempotencyKey
      ) {
        const dup = await this.prisma.call.findUnique({
          where: { idempotencyKey },
        });
        if (dup && dup.callerId === callerId) {
          return {
            ...(await this.publicCall(dup)),
            idempotencyKey,
          };
        }
      }
      throw error;
    }

    const session = await this.provider.createSession({
      callId: call.id,
      callerId,
      calleeId,
    });

    const ringing = await this.transition(call.id, CallStatus.RINGING, {
      actorId: callerId,
      source: 'api.create',
      extra: { providerSessionId: session.sessionId },
    });

    await this.queue.enqueue(
      this.queue.callLifecycle,
      'ring-timeout',
      { callId: call.id },
      { delay: RING_TIMEOUT_MS, jobId: `ring-timeout-${call.id}` },
    );

    await this.notifications.notifyUser(calleeId, {
      type: 'incoming_call',
      title: 'Incoming call',
      body: 'You have an incoming call',
      data: { callId: call.id },
    });

    this.logger.log({ callId: call.id, callerId, calleeId }, 'call initiated');
    const payload = await this.publicCall(ringing);
    this.realtime.emitToUser(callerId, 'call.ringing', payload);
    this.realtime.emitToUser(calleeId, 'call.ringing', payload);
    return {
      ...payload,
      rtc: {
        channelName: session.channelName,
        appId: session.appId,
        callerUid: session.callerUid,
        calleeUid: session.calleeUid,
      },
      callerToken:
        this.provider.name === 'mock' ? session.callerToken : undefined,
      idempotencyKey,
    };
  }

  async accept(callId: string, userId: string) {
    const call = await this.getParticipantCall(callId, userId);
    if (call.calleeId !== userId) {
      throw new AppError(
        ErrorCodes.FORBIDDEN,
        'Only the callee can accept',
        HttpStatus.FORBIDDEN,
      );
    }
    const updated = await this.transition(callId, CallStatus.ACCEPTED, {
      actorId: userId,
      source: 'api.accept',
    });
    let current = updated;
    if (this.provider.name === 'mock') {
      current = await this.transition(callId, CallStatus.CONNECTING, {
        actorId: userId,
        source: 'provider.mock.connect',
      });
      current = await this.transition(callId, CallStatus.CONNECTED, {
        actorId: userId,
        source: 'provider.mock.connect',
        extra: { connectedAt: new Date() },
      });
      await this.onConnected(current);
      const mockCreds = await this.provider.issueParticipantToken({
        callId: call.id,
        callerId: call.callerId,
        calleeId: call.calleeId,
        userId,
      });
      return {
        ...(await this.publicCall(current)),
        calleeToken: mockCreds.token,
        rtc: {
          ...mockCreds,
          callType: call.callType,
        },
      };
    }

    current = await this.transition(callId, CallStatus.CONNECTING, {
      actorId: userId,
      source: 'api.accept.rtc',
    });
    const rtc = await this.provider.issueParticipantToken({
      callId: call.id,
      callerId: call.callerId,
      calleeId: call.calleeId,
      userId,
    });
    return {
      ...(await this.publicCall(current)),
      calleeToken: rtc.token,
      rtc: {
        ...rtc,
        callType: call.callType,
      },
    };
  }

  /**
   * Issue / renew a short-lived RTC token. Participant + non-terminal RTC states only.
   */
  async issueRtcToken(callId: string, userId: string) {
    const call = await this.getParticipantCall(callId, userId);
    if (!RTC_TOKEN_ALLOWED.includes(call.status)) {
      throw new AppError(
        ErrorCodes.CALL_RTC_FORBIDDEN,
        `RTC token not available in status ${call.status}`,
        HttpStatus.CONFLICT,
      );
    }
    const rtc = await this.provider.issueParticipantToken({
      callId: call.id,
      callerId: call.callerId,
      calleeId: call.calleeId,
      userId,
    });
    return {
      callId: call.id,
      callType: call.callType,
      status: call.status,
      ...rtc,
    };
  }

  /**
   * Client confirms Agora joinChannel success. First report drives CONNECTED + billing.
   */
  async markRtcJoined(callId: string, userId: string) {
    const call = await this.getParticipantCall(callId, userId);
    if (
      call.status !== CallStatus.ACCEPTED &&
      call.status !== CallStatus.CONNECTING &&
      call.status !== CallStatus.CONNECTED
    ) {
      throw new AppError(
        ErrorCodes.CALL_RTC_FORBIDDEN,
        `Cannot join RTC in status ${call.status}`,
        HttpStatus.CONFLICT,
      );
    }

    await this.redis.client.sadd(this.rtcJoinedKey(callId), userId);
    await this.redis.client.expire(
      this.rtcJoinedKey(callId),
      RTC_JOIN_TTL_SECONDS,
    );

    let current = call;
    if (call.status === CallStatus.ACCEPTED) {
      current = await this.transition(callId, CallStatus.CONNECTING, {
        actorId: userId,
        source: 'api.rtc-joined',
      });
    }
    if (current.status === CallStatus.CONNECTING) {
      current = await this.transition(callId, CallStatus.CONNECTED, {
        actorId: userId,
        source: 'api.rtc-joined',
        extra: { connectedAt: new Date() },
      });
      await this.onConnected(current);
    }
    return this.publicCall(current);
  }

  async reportRtcFailed(callId: string, userId: string, reason?: string) {
    const call = await this.getParticipantCall(callId, userId);
    if (isTerminal(call.status)) {
      return this.publicCall(call);
    }
    if (
      call.status === CallStatus.CONNECTED ||
      call.status === CallStatus.CONNECTING ||
      call.status === CallStatus.ACCEPTED
    ) {
      const updated = await this.transition(callId, CallStatus.FAILED, {
        actorId: userId,
        source: 'api.rtc-failed',
        extra: {
          endedAt: new Date(),
          endReason: reason?.slice(0, 120) || 'rtc_failed',
        },
      });
      await this.settle(updated);
      return this.publicCall(updated);
    }
    throw new AppError(
      ErrorCodes.CALL_RTC_FORBIDDEN,
      `Cannot fail RTC from ${call.status}`,
      HttpStatus.CONFLICT,
    );
  }

  private rtcJoinedKey(callId: string): string {
    return `call:${callId}:rtc-joined`;
  }

  async reject(callId: string, userId: string) {
    const call = await this.getParticipantCall(callId, userId);
    if (call.calleeId !== userId) {
      throw new AppError(
        ErrorCodes.FORBIDDEN,
        'Only the callee can reject',
        HttpStatus.FORBIDDEN,
      );
    }
    return this.transition(callId, CallStatus.REJECTED, {
      actorId: userId,
      source: 'api.reject',
    });
  }

  async cancel(callId: string, userId: string) {
    const call = await this.getParticipantCall(callId, userId);
    if (call.callerId !== userId) {
      throw new AppError(
        ErrorCodes.FORBIDDEN,
        'Only the caller can cancel',
        HttpStatus.FORBIDDEN,
      );
    }
    const updated = await this.transition(callId, CallStatus.CANCELLED, {
      actorId: userId,
      source: 'api.cancel',
    });
    await this.wallet.releaseHold(call.callerId, call.id);
    return updated;
  }

  async end(callId: string, userId: string) {
    const call = await this.getParticipantCall(callId, userId);
    const target =
      call.status === CallStatus.CONNECTED
        ? CallStatus.ENDED
        : CallStatus.CANCELLED;
    if (call.status === CallStatus.CONNECTED) {
      const ended = await this.transition(callId, CallStatus.ENDED, {
        actorId: userId,
        source: 'api.end',
        extra: { endedAt: new Date() },
      });
      await this.settle(ended);
      const settled = await this.prisma.call.findUniqueOrThrow({
        where: { id: callId },
      });
      return this.publicCall(settled);
    }
    if (canTransition(call.status, target)) {
      const updated = await this.transition(callId, target, {
        actorId: userId,
        source: 'api.end',
      });
      await this.wallet.releaseHold(call.callerId, call.id);
      return this.publicCall(updated);
    }
    if (isTerminal(call.status)) {
      return this.publicCall(call);
    }
    throw new AppError(
      ErrorCodes.CALL_INVALID_TRANSITION,
      `Cannot end call from ${call.status}`,
      HttpStatus.CONFLICT,
    );
  }

  async heartbeat(callId: string, userId: string) {
    const call = await this.getParticipantCall(callId, userId);
    const data =
      call.callerId === userId
        ? { callerHeartbeatAt: new Date() }
        : { calleeHeartbeatAt: new Date() };
    return this.prisma.call.update({ where: { id: callId }, data });
  }

  async getOwn(callId: string, userId: string) {
    return this.publicCall(
      await this.getParticipantCall(callId, userId),
      userId,
    );
  }

  async listHistory(
    userId: string,
    limit: number,
    cursor?: string,
    filters?: {
      status?: CallStatus;
      callType?: CallType;
      role?: 'caller' | 'callee';
    },
  ): Promise<CursorPage<Awaited<ReturnType<CallingService['presentCall']>>>> {
    const cursorFilter = cursor ? decodeCursor(cursor) : undefined;
    const roleFilter =
      filters?.role === 'caller'
        ? { callerId: userId }
        : filters?.role === 'callee'
          ? { calleeId: userId }
          : { OR: [{ callerId: userId }, { calleeId: userId }] };
    const rows = await this.prisma.call.findMany({
      where: {
        AND: [
          roleFilter,
          ...(filters?.status ? [{ status: filters.status }] : []),
          ...(filters?.callType ? [{ callType: filters.callType }] : []),
          cursorFilter
            ? {
                OR: [
                  { createdAt: { lt: cursorFilter.createdAt } },
                  {
                    createdAt: cursorFilter.createdAt,
                    id: { lt: cursorFilter.id },
                  },
                ],
              }
            : {},
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    const profiles = await this.profilesForCalls(items);
    return {
      items: items.map((call) => this.presentCall(call, profiles, userId)),
      nextCursor:
        hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  async handleProviderCallback(rawBody: string, signature: string | undefined) {
    if (!this.provider.verifyCallback(rawBody, signature)) {
      throw new AppError(
        ErrorCodes.UNAUTHENTICATED,
        'Invalid calling callback signature',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const event = this.provider.parseCallback(rawBody);
    try {
      await this.prisma.providerEvent.create({
        data: {
          provider: this.provider.name,
          eventId: event.eventId,
          eventType: `call.${event.type}`,
          payloadHash: Buffer.from(rawBody).toString('base64').slice(0, 128),
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return { duplicate: true };
      }
      throw error;
    }

    const call = await this.prisma.call.findUnique({
      where: { providerSessionId: event.sessionId },
    });
    if (!call) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Call session not found',
        HttpStatus.NOT_FOUND,
      );
    }

    const target = this.mapProviderEvent(call.status, event.type);
    if (!target) {
      return { ignored: true, callId: call.id };
    }
    const updated = await this.transition(call.id, target, {
      source: `provider.${event.type}`,
      extra:
        target === CallStatus.CONNECTED
          ? { connectedAt: new Date() }
          : target === CallStatus.ENDED || target === CallStatus.FAILED
            ? { endedAt: new Date(), endReason: event.reason }
            : {},
    });
    if (updated.status === CallStatus.CONNECTED) {
      await this.onConnected(updated);
    }
    if (isTerminal(updated.status)) {
      await this.settle(updated);
    }
    return { duplicate: false, callId: updated.id, status: updated.status };
  }

  async timeoutIfStillRinging(callId: string): Promise<void> {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) {
      return;
    }
    if (
      call.status === CallStatus.INITIATED ||
      call.status === CallStatus.RINGING
    ) {
      const updated = await this.transition(callId, CallStatus.TIMEOUT, {
        source: 'job.ring-timeout',
      });
      await this.wallet.releaseHold(call.callerId, call.id);
      this.logger.log({ callId: updated.id }, 'call timed out');
    }
  }

  async failIfHeartbeatStale(callId: string): Promise<void> {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call || call.status !== CallStatus.CONNECTED) {
      return;
    }
    const latest = [
      call.callerHeartbeatAt,
      call.calleeHeartbeatAt,
      call.connectedAt,
    ]
      .filter((d): d is Date => Boolean(d))
      .map((d) => d.getTime());
    const mostRecent = Math.max(...latest, 0);
    if (Date.now() - mostRecent > HEARTBEAT_STALE_MS) {
      const updated = await this.transition(callId, CallStatus.FAILED, {
        source: 'job.heartbeat',
        extra: { endedAt: new Date(), endReason: 'heartbeat_timeout' },
      });
      await this.settle(updated);
    } else {
      await this.queue.enqueue(
        this.queue.callLifecycle,
        'heartbeat-check',
        { callId },
        { delay: 15_000, jobId: `heartbeat-${callId}-${Date.now()}` },
      );
    }
  }

  async extendHoldIfConnected(callId: string): Promise<void> {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call || call.status !== CallStatus.CONNECTED) {
      return;
    }
    try {
      await this.wallet.hold(call.callerId, call.ratePerMinuteCents, call.id);
      await this.queue.enqueue(
        this.queue.callLifecycle,
        'extend-hold',
        { callId },
        { delay: HOLD_SECONDS * 1000, jobId: `hold-${callId}-${Date.now()}` },
      );
    } catch (error) {
      if (
        error instanceof AppError &&
        error.code === ErrorCodes.WALLET_INSUFFICIENT_FUNDS
      ) {
        const updated = await this.transition(callId, CallStatus.ENDED, {
          source: 'job.insufficient-funds',
          extra: { endedAt: new Date(), endReason: 'insufficient_funds' },
        });
        await this.settle(updated);
        return;
      }
      throw error;
    }
  }

  private async onConnected(call: Call): Promise<void> {
    await this.wallet.hold(call.callerId, call.ratePerMinuteCents, call.id);
    await this.prisma.call.update({
      where: { id: call.id },
      data: {
        callerHeartbeatAt: new Date(),
        calleeHeartbeatAt: new Date(),
      },
    });
    await this.queue.enqueue(
      this.queue.callLifecycle,
      'heartbeat-check',
      { callId: call.id },
      { delay: 15_000, jobId: `heartbeat-${call.id}-0` },
    );
    await this.queue.enqueue(
      this.queue.callLifecycle,
      'extend-hold',
      { callId: call.id },
      { delay: HOLD_SECONDS * 1000, jobId: `hold-${call.id}-0` },
    );
  }

  private async settle(call: Call): Promise<void> {
    const fresh = await this.prisma.call.findUnique({ where: { id: call.id } });
    if (!fresh) {
      return;
    }
    if (fresh.settlementAppliedAt) {
      return;
    }
    if (!fresh.connectedAt || !fresh.endedAt) {
      await this.wallet.releaseHold(fresh.callerId, fresh.id);
      return;
    }
    const billedSeconds = computeBilledSeconds(
      fresh.connectedAt,
      fresh.endedAt,
    );
    const amount = computeCallCostCents(
      fresh.ratePerMinuteCents,
      billedSeconds,
    );
    const creatorShareBps = this.config.get('CREATOR_SHARE_BPS');
    await this.prisma.call.update({
      where: { id: call.id },
      data: { billedSeconds, billedAmountCents: amount },
    });
    await this.wallet.settleCallCharge({
      userId: fresh.callerId,
      callId: fresh.id,
      amountCents: amount,
      idempotencyKey: `call:${call.id}:charge`,
    });
    const earningCents = computeCreatorEarningCents(amount, creatorShareBps);
    if (earningCents > 0) {
      await this.wallet.applyLedger({
        userId: fresh.calleeId,
        type: 'CREDIT',
        reason: 'CREATOR_EARNING',
        amountCents: earningCents,
        idempotencyKey: `call:${call.id}:earning`,
        referenceType: 'call',
        referenceId: fresh.id,
        metadata: {
          creatorShareBps,
          platformFeeCents: amount - earningCents,
        },
      });
    }
    await this.prisma.call.update({
      where: { id: call.id },
      data: { settlementAppliedAt: new Date() },
    });
    await this.provider.expireSession(fresh.providerSessionId);
    const callerWallet = await this.wallet.getByUserId(fresh.callerId);
    const calleeWallet = await this.wallet.getByUserId(fresh.calleeId);
    this.realtime.emitToUser(fresh.callerId, 'wallet.updated', {
      availableBalanceCents: callerWallet.availableBalanceCents,
      heldBalanceCents: callerWallet.heldBalanceCents,
      currency: callerWallet.currency,
    });
    this.realtime.emitToUser(fresh.calleeId, 'wallet.updated', {
      availableBalanceCents: calleeWallet.availableBalanceCents,
      heldBalanceCents: calleeWallet.heldBalanceCents,
      currency: calleeWallet.currency,
    });
    this.logger.log({
      callId: call.id,
      billedSeconds,
      amountCents: amount,
      earningCents,
      creatorShareBps,
    });
  }

  /**
   * Idempotent admin/support refund of a settled call charge.
   * Reverses caller charge and host earning when present.
   */
  async refundSettledCall(actorId: string, callId: string, reason?: string) {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Call not found',
        HttpStatus.NOT_FOUND,
      );
    }
    if (!call.settlementAppliedAt || call.billedAmountCents <= 0) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Call has no billable settlement to refund',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const amount = call.billedAmountCents;
    const creatorShareBps = this.config.get('CREATOR_SHARE_BPS');
    const earningCents = computeCreatorEarningCents(amount, creatorShareBps);

    await this.wallet.applyLedger({
      userId: call.callerId,
      type: 'CREDIT',
      reason: 'CALL_REFUND',
      amountCents: amount,
      idempotencyKey: `call:${call.id}:refund`,
      referenceType: 'call',
      referenceId: call.id,
      metadata: { reason: reason ?? 'admin_refund', actorId },
    });
    if (earningCents > 0) {
      await this.wallet.applyLedger({
        userId: call.calleeId,
        type: 'DEBIT',
        reason: 'ADMIN_ADJUSTMENT',
        amountCents: earningCents,
        idempotencyKey: `call:${call.id}:earning:reverse`,
        referenceType: 'call',
        referenceId: call.id,
        metadata: { reversalOf: 'CREATOR_EARNING', actorId },
      });
    }
    await this.prisma.auditLog.create({
      data: {
        actorId,
        action: 'call.refund',
        targetType: 'call',
        targetId: callId,
        metadata: { amountCents: amount, earningReversed: earningCents },
      },
    });
    return this.publicCall(call);
  }

  private mapProviderEvent(
    current: CallStatus,
    type: 'ringing' | 'connecting' | 'connected' | 'ended' | 'failed',
  ): CallStatus | null {
    if (type === 'ringing' && canTransition(current, CallStatus.RINGING)) {
      return CallStatus.RINGING;
    }
    if (
      type === 'connecting' &&
      canTransition(current, CallStatus.CONNECTING)
    ) {
      return CallStatus.CONNECTING;
    }
    if (type === 'connected' && canTransition(current, CallStatus.CONNECTED)) {
      return CallStatus.CONNECTED;
    }
    if (type === 'ended' && canTransition(current, CallStatus.ENDED)) {
      return CallStatus.ENDED;
    }
    if (type === 'failed' && canTransition(current, CallStatus.FAILED)) {
      return CallStatus.FAILED;
    }
    return null;
  }

  private async getParticipantCall(
    callId: string,
    userId: string,
  ): Promise<Call> {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Call not found',
        HttpStatus.NOT_FOUND,
      );
    }
    if (call.callerId !== userId && call.calleeId !== userId) {
      throw new AppError(
        ErrorCodes.CALL_NOT_PARTICIPANT,
        'Not a call participant',
        HttpStatus.FORBIDDEN,
      );
    }
    return call;
  }

  private async transition(
    callId: string,
    to: CallStatus,
    opts: {
      actorId?: string;
      source: string;
      extra?: Record<string, unknown>;
    },
  ): Promise<Call> {
    const current = await this.prisma.call.findUnique({
      where: { id: callId },
    });
    if (!current) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Call not found',
        HttpStatus.NOT_FOUND,
      );
    }
    if (current.status === to) {
      return current;
    }
    if (!canTransition(current.status, to)) {
      throw new AppError(
        ErrorCodes.CALL_INVALID_TRANSITION,
        `Invalid call transition ${current.status} -> ${to}`,
        HttpStatus.CONFLICT,
      );
    }
    const extra = opts.extra ?? {};
    const updated = await this.prisma.call.updateMany({
      where: { id: callId, version: current.version, status: current.status },
      data: {
        status: to,
        version: { increment: 1 },
        ...(typeof extra.providerSessionId === 'string'
          ? { providerSessionId: extra.providerSessionId }
          : {}),
        ...(extra.connectedAt instanceof Date
          ? { connectedAt: extra.connectedAt }
          : {}),
        ...(extra.endedAt instanceof Date ? { endedAt: extra.endedAt } : {}),
        ...(typeof extra.endReason === 'string'
          ? { endReason: extra.endReason }
          : {}),
      },
    });
    if (updated.count === 0) {
      const reload = await this.prisma.call.findUnique({
        where: { id: callId },
      });
      if (reload?.status === to) {
        return reload;
      }
      throw new AppError(
        ErrorCodes.CONFLICT,
        'Call was updated concurrently',
        HttpStatus.CONFLICT,
      );
    }
    const next = await this.prisma.call.findUniqueOrThrow({
      where: { id: callId },
    });
    await this.prisma.callEvent.create({
      data: {
        callId,
        fromStatus: current.status,
        toStatus: to,
        actorId: opts.actorId,
        source: opts.source,
      },
    });
    const payload = await this.publicCall(next);
    this.realtime.emitToUser(next.callerId, this.eventName(to), payload);
    this.realtime.emitToUser(next.calleeId, this.eventName(to), payload);
    if (to === CallStatus.CONNECTED) {
      await this.hosts.markBusy(next.calleeId);
    }
    if (isTerminal(to)) {
      await this.hosts.clearBusy(next.calleeId);
    }
    return next;
  }

  async publicCall(call: Call, viewerId?: string) {
    return this.presentCall(
      call,
      await this.profilesForCalls([call]),
      viewerId,
    );
  }

  presentCall(
    call: Call,
    profiles: Map<string, { displayName: string; avatarUrl: string | null }>,
    viewerId?: string,
  ) {
    const caller = profiles.get(call.callerId);
    const callee = profiles.get(call.calleeId);
    const creatorShareBps = this.config.get('CREATOR_SHARE_BPS');
    const creatorEarningCents = call.billedAmountCents
      ? computeCreatorEarningCents(call.billedAmountCents, creatorShareBps)
      : 0;
    const platformFeeCents = Math.max(
      0,
      call.billedAmountCents - creatorEarningCents,
    );
    const direction =
      viewerId === call.callerId
        ? 'outgoing'
        : viewerId === call.calleeId
          ? 'incoming'
          : undefined;
    return {
      id: call.id,
      callId: call.id,
      callerId: call.callerId,
      calleeId: call.calleeId,
      callerDisplayName: caller?.displayName ?? 'User',
      calleeDisplayName: callee?.displayName ?? 'User',
      callerAvatarUrl: caller?.avatarUrl ?? null,
      calleeAvatarUrl: callee?.avatarUrl ?? null,
      callType: call.callType,
      status: call.status,
      settlementStatus: this.settlementStatusFor(call),
      provider: call.provider,
      providerSessionId: call.providerSessionId,
      rtcChannelName: rtcChannelName(call.id),
      ratePerMinuteCents: call.ratePerMinuteCents,
      billedSeconds: call.billedSeconds,
      billedAmountCents: call.billedAmountCents,
      creatorEarningCents,
      platformFeeCents,
      creatorShareBps,
      direction,
      connectedAt: call.connectedAt,
      endedAt: call.endedAt,
      endReason: call.endReason,
      createdAt: call.createdAt,
    };
  }

  /**
   * Derived settlement contract (no separate DB enum in Phase 1).
   * PENDING — call still in progress or billable end not finished
   * SETTLED — ENDED after CONNECTED with settlement applied (incl. $0 duration)
   * NOT_APPLICABLE — never reached CONNECTED (reject/cancel/timeout/fail)
   * REFUNDED — charge reversed via CALL_REFUND (still SETTLED historically; clients may check ledger)
   */
  settlementStatusFor(call: Call): 'PENDING' | 'SETTLED' | 'NOT_APPLICABLE' {
    const terminalNonBillable = [
      'REJECTED',
      'CANCELLED',
      'TIMEOUT',
      'FAILED',
    ] as const;
    if ((terminalNonBillable as readonly string[]).includes(call.status)) {
      return 'NOT_APPLICABLE';
    }
    if (call.status === 'ENDED') {
      return call.connectedAt ? 'SETTLED' : 'NOT_APPLICABLE';
    }
    return 'PENDING';
  }

  private async profilesForCalls(calls: Call[]) {
    const ids = [
      ...new Set(calls.flatMap((call) => [call.callerId, call.calleeId])),
    ];
    if (ids.length === 0) {
      return new Map<
        string,
        { displayName: string; avatarUrl: string | null }
      >();
    }
    const rows = await this.prisma.profile.findMany({
      where: { userId: { in: ids } },
      select: { userId: true, displayName: true, avatarUrl: true },
    });
    return new Map(
      rows.map((row) => [
        row.userId,
        { displayName: row.displayName, avatarUrl: row.avatarUrl },
      ]),
    );
  }

  private eventName(status: CallStatus): string {
    switch (status) {
      case CallStatus.INITIATED:
        return 'call.initiated';
      case CallStatus.RINGING:
        return 'call.ringing';
      case CallStatus.ACCEPTED:
        return 'call.accepted';
      case CallStatus.CONNECTING:
        return 'call.connecting';
      case CallStatus.CONNECTED:
        return 'call.connected';
      case CallStatus.REJECTED:
        return 'call.rejected';
      case CallStatus.CANCELLED:
        return 'call.cancelled';
      case CallStatus.TIMEOUT:
        return 'call.timeout';
      case CallStatus.FAILED:
        return 'call.failed';
      case CallStatus.ENDED:
        return 'call.ended';
      default:
        return 'call.updated';
    }
  }
}
