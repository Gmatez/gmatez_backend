import { Injectable } from '@nestjs/common';

export type RealtimeEmitFn = (
  userId: string,
  event: string,
  payload: unknown,
) => void;

@Injectable()
export class RealtimeEmitter {
  private emitFn: RealtimeEmitFn | null = null;

  register(emitFn: RealtimeEmitFn): void {
    this.emitFn = emitFn;
  }

  emitToUser(userId: string, event: string, payload: unknown): void {
    this.emitFn?.(userId, event, payload);
  }
}
