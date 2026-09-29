import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { AppError, ErrorCodes } from '../../common/errors/app-error';
import { PrismaService } from '../../database/prisma.service';

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 1_500_000;

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
    await this.prisma.profile.update({
      where: { userId },
      data: { avatarUrl: null },
    });
    await this.audit(actorId, userId, 'host.avatar', { mime: input.mime });
    return { stored: true, mime: input.mime };
  }

  async read(userId: string, kind: 'id-proof' | 'avatar') {
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
      return { mime: mime || 'image/jpeg', data };
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
        'Image must be under 1.5 MB',
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
