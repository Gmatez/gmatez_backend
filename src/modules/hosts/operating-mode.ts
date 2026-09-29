export type OperatingModeName = 'USER' | 'HOST';

/** A host approval is the only state that operates as HOST. Account login status is separate. */
export function operatingModeForHostStatus(
  hostStatus: string | null | undefined,
): OperatingModeName {
  return hostStatus === 'ACTIVE' ? 'HOST' : 'USER';
}

export function assertSingleOperatingMode(
  mode: OperatingModeName,
): OperatingModeName {
  if (mode !== 'USER' && mode !== 'HOST') {
    throw new Error('Operating mode must be USER or HOST');
  }
  return mode;
}
