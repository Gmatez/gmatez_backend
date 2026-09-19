import { Injectable } from '@nestjs/common';

export type RealtimeEmitFn = (
  userId: string,
  event: string,
  payload: unknown,
) => void;

export type RealtimeConversationEmitFn = (
  conversationId: string,
  event: string,
  payload: unknown,
) => void;

@Injectable()
export class RealtimeEmitter {
  private emitFn: RealtimeEmitFn | null = null;
  private conversationEmitFn: RealtimeConversationEmitFn | null = null;

  register(emitFn: RealtimeEmitFn): void {
    this.emitFn = emitFn;
  }

  registerConversation(emitFn: RealtimeConversationEmitFn): void {
    this.conversationEmitFn = emitFn;
  }

  emitToUser(userId: string, event: string, payload: unknown): void {
    this.emitFn?.(userId, event, payload);
  }

  emitToConversation(
    conversationId: string,
    event: string,
    payload: unknown,
  ): void {
    this.conversationEmitFn?.(conversationId, event, payload);
  }
}
