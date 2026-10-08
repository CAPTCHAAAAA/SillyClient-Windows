import type { InstanceRelocationResult, LegacyInstanceLocation } from "../capacitor-plugin";
import type { TavernInstance } from "../types";

export function applyInstanceLocation(
  instance: TavernInstance,
  previousId: string,
  instanceId: string,
  newPath: string,
  newName?: string,
): TavernInstance {
  if (instance.id !== previousId && instance.installDir !== previousId) return instance;
  return {
    ...instance,
    id: instanceId,
    installDir: instanceId,
    installPath: newPath,
    installPathMode: "exact",
    ...(newName === undefined ? {} : { name: newName, subtitle: newName }),
  };
}

export function requireRelocationResult(result: InstanceRelocationResult): InstanceRelocationResult {
  if (!result?.success || !result.instanceId?.trim() || !result.newPath?.trim()) {
    throw new Error("迁移未成功完成，实例信息保持不变");
  }
  return result;
}

/** Publish every committed item before attempting the next one; retries skip committed items. */
export async function relocateLegacyItems(
  items: LegacyInstanceLocation[],
  completedIds: ReadonlySet<string>,
  relocate: (item: LegacyInstanceLocation) => Promise<InstanceRelocationResult>,
  onCommitted: (item: LegacyInstanceLocation, result: InstanceRelocationResult) => void,
  ensureCurrent: () => void = () => {},
): Promise<void> {
  for (const item of items) {
    ensureCurrent();
    if (completedIds.has(item.instanceId)) continue;
    const result = requireRelocationResult(await relocate(item));
    onCommitted(item, result);
    ensureCurrent();
  }
}
