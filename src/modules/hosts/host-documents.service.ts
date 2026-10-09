import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { AppError, ErrorCodes } from '../../common/errors/app-error';
import { PrismaService } from '../../database/prisma.service';

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 4_500_000;
const APPLICATION_KINDS = [
  'identity-front',
  'identity-back',
  'profile-image',
] as const;

export type ApplicationImageKind = (typeof APPLICATION_KINDS)[number];

export function normalizeIdentityCardNumber(value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  if (trimmed.length < 4 || trimmed.length > 32) {
    throw new AppError(
      ErrorCodes.VALIDATION_FAILED,
      'Identity card number is required',
    );
  }
  return trimmed;
}

@Injectable()
export class HostDocumentsService {
  constructor(private readonly prisma: PrismaService) {}

  async saveIdProof(
    actorId: string,
    userId: string,
    input: {
      mime: string;
      dataBase64: string;
      idProofType: string;
      idProofLast4?: string;
    },
  ) {
    const data = this.decode(input.mime, input.dataBase64);
    const host = await this.prisma.hostProfile.findUnique({
      where: { userId },
    });
    if (!host) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Host not found',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.write(userId, 'id-proof', data);
    const last4 = (input.idProofLast4 ?? '').replace(/\D/g, '').slice(-4);
    const updated = await this.prisma.hostProfile.update({
      where: { userId },
      data: {
        idProofType: input.idProofType.slice(0, 40),
        idProofLast4: last4 || null,
        idProofMime: input.mime,
        idProofUpdatedAt: new Date(),
      },
    });
    await this.audit(actorId, userId, 'host.id_proof', {
      idProofType: updated.idProofType,
      hasFile: true,
    });
    return {
      idProofType: updated.idProofType,
      idProofLast4: updated.idProofLast4,
      idProofMime: updated.idProofMime,
      idProofUpdatedAt: updated.idProofUpdatedAt,
    };
  }

  async storeProfilePhoto(
    userId: string,
    input: { mime: string; dataBase64: string },
  ) {
    const data = this.decode(input.mime, input.dataBase64);
    const profile = await this.prisma.profile.findUnique({ where: { userId } });
    if (!profile) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Profile not found',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.write(userId, 'avatar', data);
    await this.write(userId, 'profile-image', data);
    await this.prisma.hostProfile.updateMany({
      where: { userId },
      data: { profileImageMime: input.mime },
    });
    return { stored: true, mime: input.mime };
  }

  async saveAvatar(
    actorId: string,
    userId: string,
    input: { mime: string; dataBase64: string },
  ) {
    const data = this.decode(input.mime, input.dataBase64);
    const profile = await this.prisma.profile.findUnique({ where: { userId } });
    if (!profile) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Profile not found',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.write(userId, 'avatar', data);
    await this.write(userId, 'profile-image', data);
    await this.prisma.hostProfile.updateMany({
      where: { userId },
      data: { profileImageMime: input.mime },
    });
    await this.audit(actorId, userId, 'host.avatar', { mime: input.mime });
    return { stored: true, mime: input.mime };
  }

  async saveApplicationDocument(
    userId: string,
    input: {
      kind: ApplicationImageKind;
      mime: string;
      dataBase64: string;
      identityCardNumber?: string;
      idProofType?: string;
    },
  ) {
    if (!APPLICATION_KINDS.includes(input.kind)) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Document kind is not supported',
      );
    }
    const data = this.decode(input.mime, input.dataBase64);
    await this.write(userId, input.kind, data);
    let identityCardNumber: string | undefined;
    if (input.identityCardNumber !== undefined) {
      identityCardNumber = normalizeIdentityCardNumber(input.identityCardNumber);
      await this.write(
        userId,
        'identity-number',
        Buffer.from(identityCardNumber, 'utf8'),
      );
    }
    const proofType = input.idProofType?.trim().slice(0, 40);
    const hostPatch: Prisma.HostProfileUpdateManyMutationInput = {};
    if (input.kind === 'identity-front') {
      hostPatch.identityFrontMime = input.mime;
      hostPatch.idProofMime = input.mime;
      hostPatch.idProofUpdatedAt = new Date();
    }
    if (input.kind === 'identity-back') {
      hostPatch.identityBackMime = input.mime;
    }
    if (input.kind === 'profile-image') {
      hostPatch.profileImageMime = input.mime;
      await this.write(userId, 'avatar', data);
    }
    if (identityCardNumber) {
      hostPatch.identityCardNumber = identityCardNumber;
      const last4 = identityCardNumber.replace(/\D/g, '').slice(-4);
      hostPatch.idProofLast4 = last4 || null;
    }
    if (proofType) {
      hostPatch.idProofType = proofType;
      await this.write(userId, 'identity-type', Buffer.from(proofType, 'utf8'));
    }
    if (Object.keys(hostPatch).length > 0) {
      await this.prisma.hostProfile.updateMany({
        where: { userId },
        data: hostPatch,
      });
    }
    return { stored: true, kind: input.kind };
  }

  async requireApplicationDocuments(userId: string) {
    const missing: string[] = [];
    for (const kind of APPLICATION_KINDS) {
      try {
        await fs.access(this.path(userId, kind));
      } catch {
        missing.push(kind);
      }
    }
    let identityCardNumber = '';
    try {
      identityCardNumber = (
        await fs.readFile(this.path(userId, 'identity-number'), 'utf8')
      ).trim();
    } catch {
      identityCardNumber = '';
    }
    if (identityCardNumber.length < 4) {
      missing.push('identityCardNumber');
    }
    if (missing.length > 0) {
      throw new AppError(
        ErrorCodes.HOST_APPLICATION_INVALID,
        'Identity card number, identity card front image, identity card back image, and profile image are required',
        HttpStatus.UNPROCESSABLE_ENTITY,
        { missing },
      );
    }
    const front = await fs.readFile(this.path(userId, 'identity-front'));
    const back = await fs.readFile(this.path(userId, 'identity-back'));
    const profile = await fs.readFile(this.path(userId, 'profile-image'));
    let idProofType = 'IDENTITY_CARD';
    try {
      const stored = (
        await fs.readFile(this.path(userId, 'identity-type'), 'utf8')
      ).trim();
      if (stored) {
        idProofType = stored.slice(0, 40);
      }
    } catch {
      idProofType = 'IDENTITY_CARD';
    }
    return {
      identityCardNumber,
      idProofType,
      identityFrontMime: sniffMime(front),
      identityBackMime: sniffMime(back),
      profileImageMime: sniffMime(profile),
    };
  }

  async read(userId: string, kind: 'id-proof' | 'avatar' | ApplicationImageKind) {
    const mime =
      kind === 'id-proof'
        ? (await this.prisma.hostProfile.findUnique({ where: { userId } }))
            ?.idProofMime
        : 'image/jpeg';
    if (kind === 'id-proof' && !mime) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'ID proof not found',
        HttpStatus.NOT_FOUND,
      );
    }
    try {
      const data = await fs.readFile(this.path(userId, kind));
      const resolved =
        kind === 'id-proof' ? mime || 'image/jpeg' : sniffMime(data);
      return { mime: resolved, data };
    } catch {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'File not found',
        HttpStatus.NOT_FOUND,
      );
    }
  }

  private decode(mime: string, dataBase64: string) {
    if (!ALLOWED.has(mime)) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Use a JPEG, PNG, or WebP image',
      );
    }
    const data = Buffer.from(dataBase64, 'base64');
    if (data.length < 32 || data.length > MAX_BYTES) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Image must be under 4 MB',
      );
    }
    return data;
  }

  private path(userId: string, kind: string) {
    return join(process.cwd(), 'storage', 'private', 'hosts', userId, kind);
  }

  private async write(userId: string, kind: string, data: Buffer) {
    const file = this.path(userId, kind);
    await fs.mkdir(join(file, '..'), { recursive: true });
    await fs.writeFile(file, data);
  }

  private async audit(
    actorId: string,
    userId: string,
    action: string,
    metadata: Record<string, unknown>,
  ) {
    await this.prisma.auditLog.create({
      data: {
        actorId,
        action,
        targetType: 'host',
        targetId: userId,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }
}

function sniffMime(data: Buffer): string {
  if (data[0] === 0xff && data[1] === 0xd8) {
    return 'image/jpeg';
  }
  if (data[0] === 0x89 && data[1] === 0x50) {
    return 'image/png';
  }
  if (
    data.length > 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return 'image/jpeg';
}
