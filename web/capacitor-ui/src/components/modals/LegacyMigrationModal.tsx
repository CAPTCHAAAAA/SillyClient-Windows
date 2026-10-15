import React, { useState } from "react";
import { X, AlertCircle, Loader2, Info } from "lucide-react";
import { cn, formatDisplayVersion } from "../../lib/utils";
import { LAYERS } from "../../constants/layers";
import { LayerBackdrop } from "../common/LayerBackdrop";
import { TarvenEnv } from "../../capacitor-plugin";
import { installationSelection } from "../../lib/install-location";

export interface LegacyMigrationItem {
  instanceId: string;
  name: string;
  currentPath: string;
  targetPath: string;
  version?: string;
}

/** 单个实例迁移成功的权威结果（后端 relocateInstance 返回）。 */
export interface LegacyMigrationResult {
  instanceId: string;
  oldPath: string;
  newPath: string;
}

export interface LegacyMigrationModalProps {
  isOpen: boolean;
  isClosing?: boolean;
  onClose: () => void;
  isLight: boolean;
  glassBg: string;
  legacyInstances: LegacyMigrationItem[];
  /** results 为本次实际迁移成功的权威清单；allDone 表示待迁移列表已全部完成。 */
  onMigrationComplete?: (results: LegacyMigrationResult[], allDone: boolean) => void;
}

/**
 * 新版本旧路径实例全屏一键迁移向导 (LegacyMigrationModal)
 * 1. 采用阻断级 Z-Index 与物理弹簧入场动画 (.animate-modal-dialog)；
 * 2. 拔除全部多重嵌套卡片方框与对勾图标，控件与字阶 100% 对齐向导；
 * 3. 仅保留用于产品设计哲学说明的单 Info 图标；
 * 4. 完美支持无旧实例时的优雅空状态展示，便于审查走查。
 */
export const LegacyMigrationModal: React.FC<LegacyMigrationModalProps> = ({
  isOpen,
  isClosing = false,
  onClose,
  isLight,
  glassBg,
  legacyInstances = [],
  onMigrationComplete,
}) => {
  const [migrating, setMigrating] = useState(false);
  const [currentMigratingId, setCurrentMigratingId] = useState<string | null>(null);
  const [completedIds, setCompletedIds] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isAllDone, setIsAllDone] = useState(false);
  const [targetRoot, setTargetRoot] = useState("");

  // 预填：后端建议目标（当前配置根）是所有条目共同的父目录时直接沿用；否则必须手动选择。
  React.useEffect(() => {
    if (!isOpen) return;
    const parents = Array.from(new Set(
      legacyInstances
        .map((item) => {
          const trimmed = (item.targetPath || "").trim().replace(/[\\/]+$/, "");
          const match = trimmed.match(/^(.*)[\\/][^\\/]+$/);
          return match ? match[1] : "";
        })
        .filter(Boolean)
    ));
    if (parents.length === 1) setTargetRoot(parents[0]);
  }, [isOpen, legacyInstances]);

  const handlePickTargetRoot = async () => {
    try {
      const selected = installationSelection(await TarvenEnv.pickDirectory({ purpose: "installation" }));
      setTargetRoot(selected.path);
      setErrorMsg(null);
    } catch { /* 用户取消选择 */ }
  };

  if (!isOpen && !isClosing) return null;

  const handleStartMigration = async () => {
    if (migrating || legacyInstances.length === 0 || !targetRoot) return;
    setMigrating(true);
    setErrorMsg(null);

    const successful: string[] = [];
    const results: LegacyMigrationResult[] = [];
    const failures: string[] = [];
    // 逐项独立迁移：单项失败不阻断其余实例，失败项保留原状并明示原因。
    for (const item of legacyInstances) {
      setCurrentMigratingId(item.instanceId);
      try {
        const res = await TarvenEnv.relocateInstance({
          instanceId: item.instanceId,
          targetPath: targetRoot,
        });
        if (res.success) {
          successful.push(item.instanceId);
          setCompletedIds([...successful]);
          results.push({ instanceId: res.instanceId, oldPath: res.oldPath, newPath: res.newPath });
        }
      } catch (err: any) {
        failures.push(`「${item.name}」：${err?.message || err}`);
      }
    }
    if (results.length > 0) onMigrationComplete?.(results, failures.length === 0);
    // 迁移目标登记为实例存储根：之后创建的实例默认沿用同一位置。
    if (results.length > 0) TarvenEnv.setInstancesRoot({ path: targetRoot }).catch(() => {});
    if (failures.length === 0) {
      setIsAllDone(true);
    } else {
      setErrorMsg(`以下实例未能迁移，数据已保留原状，可点击再次重试：${failures.join("；")}`);
    }
    setMigrating(false);
    setCurrentMigratingId(null);
  };

  return (
    <>
      {/* 阻断级虚化遮罩 */}
      <LayerBackdrop
        isOpen={isOpen}
        isClosing={isClosing}
        onClick={migrating ? undefined : onClose}
        zIndex={LAYERS.DIALOG_BACKDROP}
        blur={true}
        className={cn(
          "transition-all duration-300",
          isLight ? "bg-black/25 backdrop-blur-[12px]" : "bg-black/55 backdrop-blur-[12px]"
        )}
      />

      {/* 居中任务画布 */}
      <div
        className={cn(
          "ios-task-surface fixed rounded-2xl flex flex-col overflow-hidden backdrop-blur-[40px] saturate-180",
          glassBg,
          isLight && "is-light",
          isClosing ? "animate-modal-dialog-exit" : "animate-modal-dialog"
        )}
        style={{
          zIndex: LAYERS.DIALOG_SURFACE,
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: "min(480px, calc(100vw - 2rem))",
          maxHeight: "min(85vh, calc(100vh - 4rem))",
        }}
      >
        {/* 顶部标题栏 */}
        <div
          className={cn(
            "flex items-center justify-between px-5 h-12 flex-shrink-0 border-b",
            isLight ? "border-black/[0.06]" : "border-white/[0.06]"
          )}
        >
          <span className={cn("text-sm font-semibold", isLight ? "text-[#1a1625]" : "text-white")}>
            旧版实例存储迁移
          </span>
          {!migrating && (
            <button
              onClick={onClose}
              className={cn(
                "p-1.5 rounded-lg transition-colors",
                isLight
                  ? "text-[#1a1625]/40 hover:text-[#1a1625]/85"
                  : "text-white/40 hover:text-white/85"
              )}
              aria-label="关闭"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* 正文区域 */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4 scrollbar-hidden text-xs">
          {/* 迁移目标（必选，只读输入框，只能点「浏览」选择） */}
          {legacyInstances.length > 0 && (
            <div className="space-y-1.5">
              <label className={cn("text-xs font-medium", isLight ? "text-[#1a1625]/70" : "text-white/70")}>
                目标存放文件夹（必选）
              </label>
              <div className="flex items-center gap-2 w-full">
                <input
                  type="text"
                  readOnly
                  value={targetRoot}
                  placeholder="点击「浏览」选择存放文件夹"
                  className={cn(
                    "flex-1 h-9 px-3 rounded-xl border text-sm focus:outline-none focus:ring-0 transition-colors cursor-default",
                    isLight
                      ? "bg-black/[0.04] border-black/[0.08] text-[#1a1625] placeholder:text-[#1a1625]/25"
                      : "bg-white/[0.04] border-white/[0.08] text-white placeholder:text-white/25"
                  )}
                />
                <button
                  onClick={handlePickTargetRoot}
                  disabled={migrating}
                  className={cn(
                    "motion-control h-9 px-3 rounded-xl text-[11px] font-medium border flex-shrink-0 transition-colors disabled:opacity-40",
                    isLight
                      ? "border-black/[0.08] text-[#1a1625]/50 hover:text-[#1a1625]/85"
                      : "border-white/[0.08] text-white/50 hover:text-white/85"
                  )}
                >
                  浏览
                </button>
              </div>
              <p className={cn("text-[11px] leading-relaxed", isLight ? "text-[#1a1625]/45" : "text-white/40")}>
                每个实例会搬迁为该文件夹内的同名子目录；该文件夹同时登记为之后新建实例的默认存储位置。
              </p>
            </div>
          )}

          {/* 实例列表或空状态 (完全平铺，无嵌套厚边框卡片) */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className={cn("text-xs font-medium", isLight ? "text-[#1a1625]/70" : "text-white/70")}>
                待迁移实例 ({legacyInstances.length})
              </label>
            </div>

            {legacyInstances.length === 0 ? (
              <div className="py-7 text-center space-y-1.5">
                <div className={cn("text-xs font-medium", isLight ? "text-[#1a1625]/70" : "text-white/70")}>
                  未检测到需要迁移的旧版实例
                </div>
                <p className={cn("text-[11px] opacity-45 max-w-xs mx-auto leading-relaxed", isLight ? "text-[#1a1625]" : "text-white")}>
                  当前所有受管实例均已处于统一规范目录结构下，无需执行额外迁移。
                </p>
              </div>
            ) : (
              <div className="divide-y divide-black/[0.05] dark:divide-white/[0.05]">
                {legacyInstances.map((item) => {
                  const isCompleted = completedIds.includes(item.instanceId);
                  const isCurrent = currentMigratingId === item.instanceId;
                  const displayTarget = targetRoot
                    ? `${targetRoot}\\${item.instanceId}`
                    : (item.targetPath || "待选择目标文件夹");

                  return (
                    <div
                      key={item.instanceId}
                      className="py-2.5 space-y-1 transition-colors"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 truncate">
                          <span className={cn("font-medium text-xs truncate", isLight ? "text-[#1a1625]" : "text-white")}>
                            {item.name}
                          </span>
                          {item.version && (
                            <span
                              className={cn(
                                "px-2 py-0.5 rounded-md text-[10px] font-semibold tracking-wide border flex-shrink-0",
                                isLight
                                  ? "bg-black/[0.06] text-[#1a1625]/55 border-black/[0.08]"
                                  : "bg-white/[0.08] text-white/50 border-white/[0.08]"
                              )}
                            >
                              {formatDisplayVersion(item.version)}
                            </span>
                          )}
                        </div>

                        {/* 状态徽标 (无对勾图标) */}
                        {isCompleted ? (
                          <span className="text-[11px] text-emerald-500 font-medium flex-shrink-0">
                            已就绪
                          </span>
                        ) : isCurrent ? (
                          <span className="text-[11px] text-amber-500 font-medium flex-shrink-0 flex items-center gap-1">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            迁移中
                          </span>
                        ) : (
                          <span className={cn("text-[11px] flex-shrink-0 opacity-40", isLight ? "text-[#1a1625]" : "text-white")}>
                            待迁移
                          </span>
                        )}
                      </div>

                      {/* 路径变化 */}
                      <div className="flex items-center gap-1.5 font-mono text-[10.5px] truncate opacity-50">
                        <span className="truncate max-w-[45%]" title={item.currentPath}>
                          {item.currentPath}
                        </span>
                        <span className="opacity-40">→</span>
                        <span className="truncate max-w-[45%]" title={displayTarget}>
                          {displayTarget}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 异常提示 */}
          {errorMsg && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-start gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* 底部小字解释说明（仅保留单一 information 图标） */}
          <div className="flex items-start gap-2 pt-1 text-[11px] leading-relaxed opacity-55">
            <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <p>
              旧版隐藏目录中的实例将无损搬迁至你在上方选择的文件夹。本应用没有任何软件默认落点——实例只存在于你指定的位置，安装目录与系统缓存目录都不会存放你的数据，更新与重装都不会触碰。迁移过程中自动同步底层注册表与配置，完成后即可继续运行。
            </p>
          </div>
        </div>

        {/* 底部按钮栏 */}
        <div
          className={cn(
            "px-5 py-4 flex-shrink-0 border-t flex items-center justify-end gap-2.5",
            isLight ? "border-black/[0.06] bg-black/[0.01]" : "border-white/[0.06] bg-white/[0.01]"
          )}
        >
          {isAllDone || legacyInstances.length === 0 ? (
            <button
              onClick={onClose}
              className={cn(
                "flat-capsule motion-control px-5 h-8 rounded-full text-xs font-medium border-0",
                isLight
                  ? "text-[#1a1625]/70 hover:text-[#1a1625]"
                  : "text-white/70 hover:text-white"
              )}
            >
              进入控制台
            </button>
          ) : (
            <>
              {!migrating && (
                <button
                  type="button"
                  onClick={onClose}
                  className={cn(
                    "flat-capsule motion-control px-4 h-8 rounded-full text-xs font-medium border-0 disabled:opacity-40",
                    isLight
                      ? "text-[#1a1625]/60 hover:text-[#1a1625]"
                      : "text-white/60 hover:text-white"
                  )}
                >
                  稍后处理
                </button>
              )}
              <button
                type="button"
                disabled={migrating || !targetRoot}
                onClick={handleStartMigration}
                className={cn(
                  "flat-capsule motion-control px-5 h-8 rounded-full text-xs font-medium flex items-center justify-center gap-1.5 border-0 disabled:opacity-40",
                  isLight
                    ? "text-[#1a1625]/70 hover:text-[#1a1625]"
                    : "text-white/70 hover:text-white"
                )}
              >
                {migrating ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    正在搬迁数据与更新注册表...
                  </>
                ) : (
                  "开始一键迁移"
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
};
