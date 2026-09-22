import { CallStatus, Prisma } from '@prisma/client';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_ANALYTICS_DAYS = 90;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PageQuery = {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
};

export function parsePageQuery(page?: string, pageSize?: string): PageQuery {
  if (page !== undefined && page !== '') {
    if (!/^\d+$/.test(page) || Number(page) < 1) {
      throw new Error('page must be an integer greater than 0');
    }
  }
  if (pageSize !== undefined && pageSize !== '') {
    if (!/^\d+$/.test(pageSize)) {
      throw new Error(`pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}`);
    }
    const size = Number(pageSize);
    if (size < 1 || size > MAX_PAGE_SIZE) {
      throw new Error(`pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}`);
    }
  }
  const pageNum = page ? Number(page) : 1;
  const size = pageSize ? Number(pageSize) : DEFAULT_PAGE_SIZE;
  return {
    page: pageNum,
    pageSize: size,
    skip: (pageNum - 1) * size,
    take: size,
  };
}

export function parseAnalyticsDays(days?: string): number {
  if (days === undefined || days === '') {
    return 14;
  }
  if (!/^\d+$/.test(days)) {
    throw new Error(`days must be an integer between 1 and ${MAX_ANALYTICS_DAYS}`);
  }
  const value = Number(days);
  if (value < 1 || value > MAX_ANALYTICS_DAYS) {
    throw new Error(`days must be an integer between 1 and ${MAX_ANALYTICS_DAYS}`);
  }
  return value;
}

export function parseDateBound(value: string | undefined, label: string): Date | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be an ISO date`);
  }
  return date;
}

export function assertOneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  label: string,
): T | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${label} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function createdAtRange(
  from?: Date,
  to?: Date,
): Prisma.DateTimeFilter | undefined {
  if (!from && !to) {
    return undefined;
  }
  return {
    ...(from ? { gte: from } : {}),
    ...(to ? { lte: to } : {}),
  };
}

/**
 * Matches CallingService.settlementStatusFor.
 * SETTLED is ENDED after the call connected. NOT_APPLICABLE never connected.
 */
export function callSettlementWhere(
  settlement?: 'PENDING' | 'SETTLED' | 'NOT_APPLICABLE',
): Prisma.CallWhereInput | undefined {
  if (!settlement) {
    return undefined;
  }
  const nonBillable: CallStatus[] = [
    'REJECTED',
    'CANCELLED',
    'TIMEOUT',
    'FAILED',
  ];
  if (settlement === 'SETTLED') {
    return { status: 'ENDED', connectedAt: { not: null } };
  }
  if (settlement === 'NOT_APPLICABLE') {
    return {
      OR: [
        { status: { in: nonBillable } },
        { status: 'ENDED', connectedAt: null },
      ],
    };
  }
  return {
    status: { notIn: [...nonBillable, 'ENDED'] },
  };
}

export function maskSecret(
  value: string,
  keepStart = 4,
  keepEnd = 4,
): string {
  const clean = value.trim();
  if (clean.length <= keepStart + keepEnd) {
    return '••••';
  }
  const start = keepStart > 0 ? clean.slice(0, keepStart) : '';
  const end = clean.slice(-keepEnd);
  return keepStart > 0 ? `${start}…${end}` : `••••${end}`;
}

export function maskDestinationDetails(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => maskDestinationDetails(item));
  }
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? maskSecret(value, 0, 4) : value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === 'string') {
      out[key] = /^(type|label|bankName|currency)$/i.test(key)
        ? child
        : maskSecret(child, 0, 4);
    } else {
      out[key] = maskDestinationDetails(child);
    }
  }
  return out;
}

export type ProviderConfigStatus =
  | 'CONFIGURED'
  | 'CONFIG_REQUIRED'
  | 'DISABLED';

export function classifyProvider(input: {
  mode: 'mock' | 'live';
  credentialsPresent: boolean;
}): {
  status: ProviderConfigStatus;
  verification: 'NOT_APPLICABLE' | 'INTEGRATED_NOT_VERIFIED';
} {
  if (input.mode === 'mock') {
    return { status: 'DISABLED', verification: 'NOT_APPLICABLE' };
  }
  if (!input.credentialsPresent) {
    return { status: 'CONFIG_REQUIRED', verification: 'NOT_APPLICABLE' };
  }
  return {
    status: 'CONFIGURED',
    verification: 'INTEGRATED_NOT_VERIFIED',
  };
}

export function utcDayKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function startOfUtcDay(daysAgo: number): Date {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date;
}

export function fillCountDays(
  from: Date,
  days: number,
  counts: Map<string, number>,
): Array<{ date: string; count: number }> {
  const rows: Array<{ date: string; count: number }> = [];
  for (let index = 0; index < days; index += 1) {
    const date = new Date(from);
    date.setUTCDate(from.getUTCDate() + index);
    const key = utcDayKey(date);
    rows.push({ date: key, count: counts.get(key) ?? 0 });
  }
  return rows;
}
