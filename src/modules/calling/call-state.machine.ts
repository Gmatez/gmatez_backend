import { CallStatus } from '@prisma/client';

export const TERMINAL_CALL_STATUSES: CallStatus[] = [
  CallStatus.REJECTED,
  CallStatus.TIMEOUT,
  CallStatus.CANCELLED,
  CallStatus.FAILED,
  CallStatus.ENDED,
];

const ALLOWED: Record<CallStatus, CallStatus[]> = {
  INITIATED: [
    CallStatus.RINGING,
    CallStatus.CANCELLED,
    CallStatus.FAILED,
    CallStatus.TIMEOUT,
  ],
  RINGING: [
    CallStatus.ACCEPTED,
    CallStatus.REJECTED,
    CallStatus.TIMEOUT,
    CallStatus.CANCELLED,
    CallStatus.FAILED,
  ],
  ACCEPTED: [
    CallStatus.CONNECTING,
    CallStatus.CONNECTED,
    CallStatus.FAILED,
    CallStatus.CANCELLED,
  ],
  CONNECTING: [CallStatus.CONNECTED, CallStatus.FAILED, CallStatus.CANCELLED],
  CONNECTED: [CallStatus.ENDED, CallStatus.FAILED],
  REJECTED: [],
  TIMEOUT: [],
  CANCELLED: [],
  FAILED: [],
  ENDED: [],
};

export function isTerminal(status: CallStatus): boolean {
  return TERMINAL_CALL_STATUSES.includes(status);
}

export function canTransition(from: CallStatus, to: CallStatus): boolean {
  return ALLOWED[from].includes(to);
}

export function assertTransition(from: CallStatus, to: CallStatus): void {
  if (!canTransition(from, to)) {
    const error = new Error(`Invalid call transition ${from} -> ${to}`);
    (error as Error & { code: string }).code = 'CALL_INVALID_TRANSITION';
    throw error;
  }
}

export function computeCallCostCents(
  ratePerMinuteCents: number,
  billedSeconds: number,
): number {
  if (billedSeconds <= 0) {
    return 0;
  }
  return Math.ceil((ratePerMinuteCents * billedSeconds) / 60);
}

export function computeBilledSeconds(connectedAt: Date, endedAt: Date): number {
  const seconds = Math.floor(
    (endedAt.getTime() - connectedAt.getTime()) / 1000,
  );
  return Math.max(0, seconds);
}

export function computeCreatorEarningCents(
  chargeCents: number,
  creatorShareBps = 8000,
): number {
  if (chargeCents <= 0) {
    return 0;
  }
  return Math.floor((chargeCents * creatorShareBps) / 10_000);
}
