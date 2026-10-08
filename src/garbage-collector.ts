/**
 * 孤立资源与临时文件垃圾清理业务服务
 */

import type { CleanupService } from './runtime/cleanup';
import type { OperationCoordinator } from './runtime/operations';
import type {
  CleanGarbageParams,
  CleanGarbageResult,
  DeleteGarbageItemParams,
} from './contracts/ipc-contracts';

export async function executeCleanGarbage(
  garbage: CleanupService,
  operations: OperationCoordinator,
  opts?: CleanGarbageParams,
): Promise<CleanGarbageResult> {
  const options = opts || {};
  return operations.enqueue(async () => {
    const scanned = await garbage.scan(options);
    if (options.dryRun !== false) return scanned;
    let freedBytes = 0;
    const failures: { path: string; error?: string }[] = [];
    for (const item of scanned.items) {
      const result = await garbage.remove(item);
      if (result.success) freedBytes += item.sizeBytes;
      else failures.push({ path: item.path, error: result.error });
    }
    return { ...scanned, success: failures.length === 0, freedBytes, failures };
  });
}

export function executeDeleteGarbageItem(
  garbage: CleanupService,
  operations: OperationCoordinator,
  opts?: DeleteGarbageItemParams,
): Promise<{ success: boolean; error?: string }> {
  return operations.enqueue(() => garbage.remove(opts || { path: '' }));
}
