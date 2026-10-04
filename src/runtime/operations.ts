import { randomUUID } from 'node:crypto';

export class OperationCancelledError extends Error {
  constructor() {
    super('Operation cancelled');
    this.name = 'AbortError';
  }
}

export interface OperationContext {
  instanceId: string;
  operationId: string;
  signal: AbortSignal;
  check(): void;
}

interface Operation extends OperationContext {
  controller: AbortController;
}

/** A new launch invalidates old work immediately, but mutations remain serialized. */
export class OperationCoordinator {
  private tail: Promise<unknown> = Promise.resolve();
  private active: Operation | null = null;

  matches(options?: { instanceId?: string; operationId?: string }): boolean {
    if (!this.active) return false;
    return (!options?.instanceId || options.instanceId === this.active.instanceId)
      && (!options?.operationId || options.operationId === this.active.operationId);
  }

  cancel(options?: { instanceId?: string; operationId?: string }): boolean {
    if (!this.matches(options)) return false;
    this.active!.controller.abort();
    return true;
  }

  getActive(): { instanceId: string; operationId: string } | null {
    return this.active ? {
      instanceId: this.active.instanceId,
      operationId: this.active.operationId,
    } : null;
  }

  runLatest<T>(
    instanceId: string,
    operationId: string | undefined,
    work: (context: OperationContext) => Promise<T>,
  ): Promise<T> {
    this.cancel();
    const controller = new AbortController();
    const operation: Operation = {
      instanceId,
      operationId: typeof operationId === 'string' && operationId.trim()
        ? operationId.trim().slice(0, 160)
        : randomUUID(),
      controller,
      signal: controller.signal,
      check: () => {
        if (controller.signal.aborted || this.active !== operation) throw new OperationCancelledError();
      },
    };
    this.active = operation;
    return this.enqueue(async () => {
      try {
        operation.check();
        return await work(operation);
      } finally {
        if (this.active === operation) this.active = null;
      }
    });
  }

  enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new OperationCancelledError();
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  checkSignal(signal);
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new OperationCancelledError());
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
