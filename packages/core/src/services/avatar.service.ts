import { newId, type Database, type User } from '@smartchat/database';
import { AppError, ErrorCode } from '@smartchat/types';
import { identifyFile } from '../storage/signature.js';
import type { StorageService } from '../storage/storage.service.js';

/**
 * Profile pictures.
 *
 * The same three steps as an attachment - sign, upload, confirm - with one difference at the end:
 * a picture is public. It is shown to visitors in the chat window, on a website that is not ours,
 * so it cannot live behind a ten-minute signed link. Instead the API serves it at a fixed address
 * (`/avatars/:userId/:avatarId`) that the browser may cache forever, because a new picture gets a
 * new id and the old address stops answering.
 *
 * What is served is what was verified: the bytes are read back after the upload and identified
 * by their leading bytes, and only an image goes through. A "picture" that is a script is
 * refused at confirm and never has an address at all.
 */

export interface AvatarServiceOptions {
  db: Database;
  storage: StorageService;
  /** Where the API answers, so the stored URL is absolute: `https://api.example.com`. */
  apiUrl: string;
}

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const ACCEPTED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function avatarKey(userId: string, avatarId: string): string {
  if (!UUID.test(userId) || !UUID.test(avatarId)) throw new Error('refusing to build an avatar key');
  return `p/${userId}/${avatarId}`;
}

export class AvatarService {
  constructor(private readonly options: AvatarServiceOptions) {}

  /** The public address of a user's picture, or null. */
  urlFor(userId: string, avatarId: string): string {
    return `${this.options.apiUrl.replace(/\/+$/, '')}/api/v1/avatars/${userId}/${avatarId}`;
  }

  async sign(userId: string, input: { contentType: string; byteSize: number }): Promise<{ avatarId: string; uploadUrl: string; expiresInSeconds: number }> {
    if (!ACCEPTED.has(input.contentType)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Use a PNG, JPEG, WebP or GIF picture.');
    }
    if (input.byteSize <= 0 || input.byteSize > AVATAR_MAX_BYTES) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Pictures can be up to 2 MB.');
    }
    const avatarId = newId();
    return { avatarId, uploadUrl: this.options.storage.signUpload(avatarKey(userId, avatarId), 300), expiresInSeconds: 300 };
  }

  /** The upload happened: check it really is a picture, then make it the user's. */
  async confirm(userId: string, avatarId: string): Promise<User> {
    if (!UUID.test(avatarId)) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Unknown upload.');
    const key = avatarKey(userId, avatarId);
    const stored = await this.options.storage.read(key, AVATAR_MAX_BYTES);
    if (!stored) throw new AppError(ErrorCode.VALIDATION_FAILED, 'The picture was not uploaded.');
    const kind = identifyFile(stored.bytes, 'avatar');
    if (stored.byteSize > AVATAR_MAX_BYTES || !kind || !kind.isImage || !ACCEPTED.has(kind.contentType)) {
      await this.options.storage.delete(key).catch(() => undefined);
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'That file is not a picture we can use (PNG, JPEG, WebP or GIF, up to 2 MB).');
    }
    const previous = await this.options.db.user.findUnique({ where: { id: userId }, select: { avatarKey: true } });
    const user = await this.options.db.user.update({
      where: { id: userId },
      data: { avatarKey: key, avatarContentType: kind.contentType, avatarUrl: this.urlFor(userId, avatarId) },
    });
    if (previous?.avatarKey && previous.avatarKey !== key) {
      await this.options.storage.delete(previous.avatarKey).catch(() => undefined);
    }
    return user;
  }

  async remove(userId: string): Promise<User> {
    const previous = await this.options.db.user.findUnique({ where: { id: userId }, select: { avatarKey: true } });
    const user = await this.options.db.user.update({
      where: { id: userId },
      data: { avatarKey: null, avatarContentType: null, avatarUrl: null },
    });
    if (previous?.avatarKey) await this.options.storage.delete(previous.avatarKey).catch(() => undefined);
    return user;
  }

  /**
   * The bytes to serve for a public address, or null when there is no such picture. Only the
   * user's current picture answers: an old id is a 404, which is what lets the current one be
   * cached forever.
   */
  async serve(userId: string, avatarId: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    if (!UUID.test(userId) || !UUID.test(avatarId)) return null;
    const user = await this.options.db.user.findUnique({
      where: { id: userId },
      select: { avatarKey: true, avatarContentType: true, deletedAt: true },
    });
    if (!user || user.deletedAt || !user.avatarKey || !user.avatarContentType) return null;
    if (user.avatarKey !== avatarKey(userId, avatarId)) return null;
    const stored = await this.options.storage.read(user.avatarKey, AVATAR_MAX_BYTES);
    if (!stored) return null;
    return { bytes: stored.bytes, contentType: user.avatarContentType };
  }
}
