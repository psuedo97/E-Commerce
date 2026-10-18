import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

/** Upload folder; tests point UPLOADS_DIR at a temp directory. */
export const uploadsDir = () => process.env.UPLOADS_DIR ?? join(process.cwd(), 'uploads');

/**
 * Local-disk storage for development. Stored URLs are relative ("/uploads/..."), served by app.setup.ts.
 * To move to S3/R2, implement the same save/remove and store absolute URLs; the web app accepts both.
 */
@Injectable()
export class StorageService {
  private get root() {
    return uploadsDir();
  }

  async save(folder: string, data: Buffer, ext: string): Promise<string> {
    const name = `${randomBytes(12).toString('hex')}.${ext}`;
    const file = join(this.root, folder, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, data);
    return `/uploads/${folder}/${name}`;
  }

  async remove(url: string): Promise<void> {
    if (!url.startsWith('/uploads/')) return;
    const file = join(this.root, url.slice('/uploads/'.length));
    // Guard against path traversal in a tampered DB value.
    if (!file.startsWith(this.root)) return;
    await unlink(file).catch(() => undefined);
  }
}
