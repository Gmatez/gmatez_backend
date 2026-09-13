export type PushMessage = {
  title: string;
  body: string;
  data?: Record<string, string>;
};

export interface PushProvider {
  readonly name: string;
  send(
    tokens: string[],
    message: PushMessage,
  ): Promise<{ successCount: number; failedTokens: string[] }>;
}
