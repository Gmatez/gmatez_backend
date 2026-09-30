import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  HostDocumentsService,
  normalizeIdentityCardNumber,
} from './host-documents.service';
import { ErrorCodes } from '../../common/errors/app-error';

const userId = 'doc-spec-user';
const folder = join(process.cwd(), 'storage', 'private', 'hosts', userId);

function bytes(size = 40) {
  return Buffer.alloc(size, 7).toString('base64');
}

function harness() {
  const prisma = {
    hostProfile: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    profile: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  return { service: new HostDocumentsService(prisma as never), prisma };
}

describe('identity card number', () => {
  it('rejects a blank identity card number', () => {
    expect(() => normalizeIdentityCardNumber('   ')).toThrow(
      /Identity card number/,
    );
  });
});

describe('host documents', () => {
  afterAll(async () => {
    await fs.rm(folder, { recursive: true, force: true });
  });

  it('rejects an unsupported image type', async () => {
    const { service } = harness();
    await expect(
      service.saveIdProof('admin-1', userId, {
        mime: 'image/gif',
        dataBase64: bytes(),
        idProofType: 'AADHAAR',
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_FAILED });
  });

  it('stores an ID proof and replaces it', async () => {
    const { service, prisma } = harness();
    prisma.hostProfile.findUnique
      .mockResolvedValueOnce({ userId })
      .mockResolvedValueOnce({ idProofMime: 'image/png' })
      .mockResolvedValueOnce({ userId })
      .mockResolvedValue({ idProofMime: 'image/jpeg' });
    prisma.hostProfile.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => data,
    );
    const first = await service.saveIdProof('admin-1', userId, {
      mime: 'image/png',
      dataBase64: bytes(),
      idProofType: 'AADHAAR',
      idProofLast4: '123456789012',
    });
    expect(first.idProofLast4).toBe('9012');
    const stored = await service.read(userId, 'id-proof');
    expect(stored.data.length).toBe(40);
    await service.saveIdProof('admin-1', userId, {
      mime: 'image/jpeg',
      dataBase64: bytes(48),
      idProofType: 'AADHAAR',
    });
    const replaced = await service.read(userId, 'id-proof');
    expect(replaced.data.length).toBe(48);
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  it('does not write a file for an unknown host', async () => {
    const { service, prisma } = harness();
    prisma.hostProfile.findUnique.mockResolvedValue(null);
    await expect(
      service.saveIdProof('admin-1', 'missing-host', {
        mime: 'image/png',
        dataBase64: bytes(),
        idProofType: 'AADHAAR',
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.NOT_FOUND });
  });
});
