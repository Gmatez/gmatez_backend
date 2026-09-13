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

const RING_TIMEOUT_MS = 45_000;
const HEARTBEAT_STALE_MS = 45_000;
const HOLD_SECONDS = 60;

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
      throw new AppError(
        ErrorCodes.CALL_ALREADY_ACTIVE,
        'An active call already exists',
        HttpStatus.CONFLICT,
      );
    }

    const call = await this.prisma.call.create({
      data: {
        callerId,
        calleeId,
        callType,
        status: CallStatus.INITIATED,
        provider: this.provider.name,
        providerSessionId: `pending_${crypto.randomUUID()}`,
        ratePerMinuteCents: rate,
      },
    });

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
      callerToken: session.callerToken,
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
    const session = await this.provider.createSession({
      callId: call.id,
      callerId: call.callerId,
      calleeId: call.calleeId,
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
    }
    return {
      ...(await this.publicCall(current)),
      calleeToken: session.calleeToken,
    };
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
      return ended;
    }
    if (canTransition(call.status, target)) {
      const updated = await this.transition(callId, target, {
        actorId: userId,
        source: 'api.end',
      });
      await this.wallet.releaseHold(call.callerId, call.id);
      return updated;
    }
    if (isTerminal(call.status)) {
      return call;
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
    return this.publicCall(await this.getParticipantCall(callId, userId));
  }

  async listHistory(
    userId: string,
    limit: number,
    cursor?: string,
  ): Promise<CursorPage<Awaited<ReturnType<CallingService['presentCall']>>>> {
    const cursorFilter = cursor ? decodeCursor(cursor) : undefined;
    const rows = await this.prisma.call.findMany({
      where: {
        AND: [
          { OR: [{ callerId: userId }, { calleeId: userId }] },
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
      items: items.map((call) => this.presentCall(call, profiles)),
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
    await this.prisma.call.update({
      where: { id: call.id },
      data: { billedSeconds },
    });
    await this.wallet.settleCallCharge({
      userId: fresh.callerId,
      callId: fresh.id,
      amountCents: amount,
      idempotencyKey: `call:${call.id}:charge`,
    });
    const earningCents = computeCreatorEarningCents(amount);
    if (earningCents > 0) {
      await this.wallet.applyLedger({
        userId: fresh.calleeId,
        type: 'CREDIT',
        reason: 'CREATOR_EARNING',
        amountCents: earningCents,
        idempotencyKey: `call:${call.id}:earning`,
        referenceType: 'call',
        referenceId: fresh.id,
      });
    }
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
    });
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

  async publicCall(call: Call) {
    return this.presentCall(call, await this.profilesForCalls([call]));
  }

  presentCall(
    call: Call,
    profiles: Map<
      string,
      { displayName: string; avatarUrl: string | null }
    >,
  ) {
    const caller = profiles.get(call.callerId);
    const callee = profiles.get(call.calleeId);
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
      provider: call.provider,
      providerSessionId: call.providerSessionId,
      ratePerMinuteCents: call.ratePerMinuteCents,
      billedSeconds: call.billedSeconds,
      billedAmountCents: call.billedAmountCents,
      connectedAt: call.connectedAt,
      endedAt: call.endedAt,
      endReason: call.endReason,
      createdAt: call.createdAt,
    };
  }

  private async profilesForCalls(calls: Call[]) {
    const ids = [
      ...new Set(calls.flatMap((call) => [call.callerId, call.calleeId])),
    ];
    if (ids.length === 0) {
      return new Map<string, { displayName: string; avatarUrl: string | null }>();
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
