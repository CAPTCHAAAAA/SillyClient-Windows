import * as fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const MAX_LINE_LENGTH = 8192;
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_BYTES = 256 * 1024;

export function createLineSink(emit: (line: string) => void): {
  write(data: Buffer): void;
  end(): void;
} {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const drain = () => {
    let newline: number;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      if (line) emit(line.slice(0, MAX_LINE_LENGTH));
    }
    while (pending.length > MAX_LINE_LENGTH) {
      emit(pending.slice(0, MAX_LINE_LENGTH));
      pending = pending.slice(MAX_LINE_LENGTH);
    }
  };
  return {
    write(data) {
      pending += decoder.write(data);
      drain();
    },
    end() {
      pending += decoder.end();
      drain();
      if (pending) emit(pending);
      pending = '';
    },
  };
}

/** Ordered async disk writes, a bounded queue, and one rotated predecessor. */
export class RotatingLog {
  private queue: Buffer[] = [];
  private queuedBytes = 0;
  private draining: Promise<void> | null = null;
  private closed = false;
  private size: number | null = null;
  private dropped = false;

  constructor(private readonly file: string, private readonly onError: (error: Error) => void) {}

  write(data: Buffer): void {
    if (this.closed) return;
    if (this.queuedBytes + data.byteLength > MAX_PENDING_BYTES) {
      this.dropped = true;
      return;
    }
    const copy = Buffer.from(data);
    this.queue.push(copy);
    this.queuedBytes += copy.byteLength;
    this.startDrain();
  }

  private startDrain(): void {
    if (this.draining) return;
    this.draining = this.drain().catch((error) => {
      this.closed = true;
      this.queue = [];
      this.queuedBytes = 0;
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }).finally(() => {
      this.draining = null;
      if (this.queue.length && !this.closed) this.startDrain();
    });
  }

  private async drain(): Promise<void> {
    if (this.size === null) {
      try {
        this.size = (await fs.promises.stat(this.file)).size;
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
        this.size = 0;
      }
    }
    while (this.queue.length) {
      const batch = Buffer.concat(this.queue);
      this.queue = [];
      this.queuedBytes = 0;
      if (this.size! + batch.byteLength > MAX_LOG_BYTES) {
        await fs.promises.rm(`${this.file}.1`, { force: true });
        try {
          await fs.promises.rename(this.file, `${this.file}.1`);
        } catch (error: any) {
          if (error?.code !== 'ENOENT') throw error;
        }
        this.size = 0;
      }
      await fs.promises.appendFile(this.file, batch);
      this.size! += batch.byteLength;
      if (this.dropped) {
        this.dropped = false;
        this.write(Buffer.from('\n[Log queue overflow: some output omitted]\n'));
      }
    }
  }

  async end(): Promise<void> {
    while (this.draining || this.queue.length) {
      if (!this.draining) this.startDrain();
      await this.draining;
    }
    this.closed = true;
  }
}
