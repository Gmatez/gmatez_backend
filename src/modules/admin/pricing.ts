export type MinuteSplit = {
  userRatePerMinuteCents: number;
  hostEarningPerMinuteCents: number;
  platformPerMinuteCents: number;
  hostShareBps: number;
};

/** A call keeps the share captured when it started. Later config edits do not apply. */
export function shareBpsForSettlement(
  snapshot: number | null | undefined,
  liveBps: number,
): number {
  return snapshot ?? liveBps;
}

export function splitMinuteRate(
  userRatePerMinuteCents: number,
  hostEarningPerMinuteCents: number,
): MinuteSplit {
  if (
    !Number.isInteger(userRatePerMinuteCents) ||
    userRatePerMinuteCents <= 0
  ) {
    throw new Error('User rate must be a positive integer minor amount');
  }
  if (
    !Number.isInteger(hostEarningPerMinuteCents) ||
    hostEarningPerMinuteCents < 0 ||
    hostEarningPerMinuteCents > userRatePerMinuteCents
  ) {
    throw new Error('Host earning must be between zero and the user rate');
  }
  return {
    userRatePerMinuteCents,
    hostEarningPerMinuteCents,
    platformPerMinuteCents: userRatePerMinuteCents - hostEarningPerMinuteCents,
    hostShareBps: Math.round(
      (hostEarningPerMinuteCents * 10_000) / userRatePerMinuteCents,
    ),
  };
}
