import React, { useState, useEffect, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import {
  X,
  AlertCircle,
  Loader2,
  Info,
} from "lucide-react";
import { cn, formatDisplayVersion } from "../../lib/utils";
import { LAYERS } from "../../constants/layers";
import { LayerBackdrop } from "../common/LayerBackdrop";
import { TarvenEnv } from "../../capacitor-plugin";
import type { TavernInstance } from "../../types";
import { cleanInstallPath, installationSelection, relocationTargetInParent } from "../../lib/install-location";
import { humanizeNativeError } from "../../lib/native-errors";


export interface RelocateInstanceModalProps {
  instance: TavernInstance | null;
  isOpen: boolean;
  isClosing?: boolean;
  onClose: () => void;
  isLight: boolean;
  glassBg: string;
  onRelocated?: (instanceId: string, newPath: string) => void;
}

interface InstanceSourcePath {
  instanceId: string;
  installDir?: string;
  installPath?: string;
  status: "loading" | "confirmed" | "failed";
  path: string;
  error: string | null;
}

/**
 * 单实例存储路径无损重定位弹窗 (RelocateInstanceModal)
 * 1. 采用阻断级 Z-Index (LAYERS.DIALOG_SURFACE 与 LAYERS.DIALOG_BACKDROP)；
 * 2. 具有物理弹性入场与离场动画 (.animate-modal-dialog)；
 * 3. 目标目录只允许通过目录选择器或路径输入指定；
 * 4. 彻底去除冗余方框嵌套与对勾图标，控件字体与交互行为 100% 对齐向导；
 * 5. 底部保留关于受管实例直接无损迁移的设计哲学说明。
 */
export const RelocateInstanceModal: React.FC<RelocateInstanceModalProps> = ({
  instance,
  isOpen,
  isClosing = false,
  onClose,
  isLight,
  glassBg,
  onRelocated,
}) => {
  const isAndroid = Capacitor.getPlatform() === "android";
  const [customPath, setCustomPath] = useState("");
  const [sourcePath, setSourcePath] = useState<InstanceSourcePath | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [pickingDirectory, setPickingDirectory] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successInfo, setSuccessInfo] = useState<{ newPath: string } | null>(null);
  const directoryPickerGeneration = useRef(0);

  useEffect(() => {
    setErrorMsg(null);
    setSuccessInfo(null);
    setMigrating(false);
    setCustomPath("");
  }, [isOpen, instance?.id]);

  useEffect(() => {
    directoryPickerGeneration.current += 1;
    setPickingDirectory(false);
    if (!isOpen || !instance) {
      setSourcePath(null);
      return;
    }

    const identity = {
      instanceId: instance.id,
      installDir: instance.installDir,
      installPath: instance.installPath,
    };
    setSourcePath({
      ...identity,
      status: "loading",
      path: isAndroid ? "" : instance.installPath || "",
      error: null,
    });

    // 原生确认的源路径只属于发起查询时的实例身份。
    let active = true;
    const safeId = instance.installDir || instance.id;
    TarvenEnv.getInstanceInfo({
      instanceId: safeId,
      installPath: instance.installPath,
      port: instance.port ?? 8000,
    })
      .then((info) => {
        if (!active) return;
        const path = isAndroid ? cleanInstallPath(info.path || "") || "" : info.path || instance.installPath || "—";
        setSourcePath({
          ...identity,
          status: isAndroid && !path ? "failed" : "confirmed",
          path,
          error: isAndroid && !path ? "无法确认实例的实际存储目录：原生未返回有效路径，请重新打开后重试。" : null,
        });
      })
      .catch((error) => {
        if (!active) return;
        const reason = humanizeNativeError(error instanceof Error ? error.message : String(error));
        setSourcePath({
          ...identity,
          status: "failed",
          path: isAndroid ? "" : instance.installPath || "—",
          error: isAndroid ? `无法读取实例的实际存储目录：${reason}` : null,
        });
      });
    return () => {
      active = false;
      directoryPickerGeneration.current += 1;
    };
  }, [isOpen, instance?.id, instance?.installDir, instance?.installPath, isAndroid]);

  if (!isOpen && !isClosing) return null;
  if (!instance) return null;

  const isRunning = instance.status === "running" || instance.status === "online";
  const instanceSourcePath = sourcePath?.instanceId === instance.id &&
    sourcePath.installDir === instance.installDir && sourcePath.installPath === instance.installPath
      ? sourcePath : null;
  const hasConfirmedSourcePath = isOpen && !isClosing && instanceSourcePath?.status === "confirmed";
  const currentRealPath = instanceSourcePath?.path || (isAndroid ? "" : instance.installPath || "");
  const visibleError = errorMsg || (isAndroid ? instanceSourcePath?.error : null);

  const handlePickDirectory = async () => {
    if (pickingDirectory || migrating) return;
    const generation = ++directoryPickerGeneration.current;
    setPickingDirectory(true);
    setErrorMsg(null);
    try {
      const selection = installationSelection(await TarvenEnv.pickDirectory({ purpose: "installation" }));
      if (generation !== directoryPickerGeneration.current) return;
      if (isAndroid) {
        try {
          await TarvenEnv.setInstancesRoot({ path: selection.path });
        } catch (error) {
          if (generation !== directoryPickerGeneration.current) return;
          setCustomPath("");
          const reason = humanizeNativeError(error instanceof Error ? error.message : String(error));
          setErrorMsg(`该文件夹不能作为实例存放位置：${reason}`);
          return;
        }
      }
      if (generation === directoryPickerGeneration.current) setCustomPath(selection.path);
    } catch (error) {
      if (generation !== directoryPickerGeneration.current) return;
      const message = error instanceof Error ? error.message : String(error);
      if (!/cancel|取消/i.test(message)) setErrorMsg(humanizeNativeError(message));
    } finally {
      if (generation === directoryPickerGeneration.current) setPickingDirectory(false);
    }
  };

  const handleExecuteRelocate = async () => {
    if (isRunning || migrating || pickingDirectory) return;
    if (isAndroid && !hasConfirmedSourcePath) return;
    const generation = directoryPickerGeneration.current;
    setErrorMsg(null);
    setMigrating(true);

    try {
      const safeId = instance.installDir || instance.id;
      const selected = cleanInstallPath(customPath);
      if (!selected) throw new Error("请先选择目标目录");
      const target = isAndroid ? relocationTargetInParent(selected, currentRealPath) : selected;

      const res = await TarvenEnv.relocateInstance({
        instanceId: safeId,
        targetPath: target,
        installPath: instance.installPath,
      });

      if (res.success) {
        onRelocated?.(instance.id, res.newPath);
        if (generation === directoryPickerGeneration.current) setSuccessInfo({ newPath: res.newPath });
      } else {
        throw new Error("迁移未成功完成");
      }
    } catch (error) {
      if (generation === directoryPickerGeneration.current) {
        setErrorMsg(humanizeNativeError(error instanceof Error ? error.message : "迁移失败，请检查路径权限后重试"));
      }
    } finally {
      if (generation === directoryPickerGeneration.current) setMigrating(false);
    }
  };

  return (
    <>
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
          width: "min(460px, calc(100vw - 2rem))",
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
            迁移实例存储目录
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
          {/* 当前实例信息 (扁平无多重框) */}
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-3">
              <span className={cn("font-medium text-xs truncate", isLight ? "text-[#1a1625]" : "text-white")}>
                {instance.subtitle || instance.name}
              </span>
              <span
                className={cn(
                  "px-2 py-0.5 rounded-md text-[10px] font-semibold tracking-wide border flex-shrink-0",
                  isLight
                    ? "bg-black/[0.06] text-[#1a1625]/55 border-black/[0.08]"
                    : "bg-white/[0.08] text-white/50 border-white/[0.08]"
                )}
              >
                {formatDisplayVersion(instance.version)}
              </span>
            </div>
            <div className="text-[11px] font-mono break-all opacity-45 leading-relaxed">
              当前路径: {currentRealPath || (instanceSourcePath?.status === "failed" ? "无法读取" : "读取中...")}
            </div>
          </div>

          {/* 运行状态警告 */}
          {isRunning && (
            <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-500 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>当前实例正在运行，请先在控制台停止后再执行迁移。</span>
            </div>
          )}

          {/* 成功状态 */}
          {successInfo ? (
            <div className="space-y-2 py-1">
              <div className={cn("text-xs font-medium", isLight ? "text-[#1a1625]" : "text-white")}>
                实例数据无损迁移完成
              </div>
              <div
                className={cn(
                  "text-[11px] font-mono break-all p-3 rounded-xl border leading-relaxed",
                  isLight ? "bg-black/[0.02] border-black/[0.06]" : "bg-white/[0.03] border-white/[0.06]"
                )}
              >
                {successInfo.newPath}
              </div>
              <p className="text-[11px] opacity-50 leading-relaxed">
                底层注册表与配置已一键同步，该实例已就绪，可随时直接启动运行。
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <label className={cn("text-xs font-medium block", isLight ? "text-[#1a1625]/70" : "text-white/70")}>
                  新目标位置
                </label>
              </div>

              <div className="w-full space-y-1.5">
                  <div className="flex items-center gap-2 w-full">
                    <input
                      type="text"
                      value={customPath}
                      readOnly={isAndroid}
                      onChange={(e) => setCustomPath(e.target.value)}
                      placeholder={isAndroid ? "点击浏览，选择实例存放文件夹" : "选择或输入完整目标目录绝对路径"}
                      className={cn(
                        "ios-field-control motion-control flex-1 min-w-0 h-9 px-3 rounded-xl border text-xs transition-colors",
                        isLight
                          ? "bg-black/[0.04] border-black/[0.08] text-[#1a1625] placeholder:text-black/30 focus:border-black/20"
                          : "bg-white/[0.04] border-white/[0.08] text-white placeholder:text-white/30 focus:border-white/20"
                      )}
                    />
                    <button
                      type="button"
                      onClick={handlePickDirectory}
                      disabled={pickingDirectory || migrating}
                      className={cn(
                        "flat-capsule motion-control h-9 px-3 rounded-full text-[11px] font-medium border-0 flex-shrink-0",
                        isLight
                          ? "text-[#1a1625]/60 hover:text-[#1a1625]"
                          : "text-white/60 hover:text-white"
                      )}
                    >
                      {pickingDirectory ? "选择中..." : "浏览"}
                    </button>
                  </div>
                  <p className={cn("text-[11px] opacity-45 leading-relaxed", isLight ? "text-[#1a1625]" : "text-white")}>
                    {isAndroid ? "实例保留原目录名，搬迁到所选文件夹的一级子目录。" : "支持任意磁盘或分区路径。跨盘迁移时将执行安全校验并自动清理原位置。"}
                  </p>
              </div>

              {/* 异常提示 */}
              {visibleError && (
                <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>{visibleError}</span>
                </div>
              )}

              {/* 底部小字解释说明（产品设计哲学说明，仅保留 information 图标） */}
              <div className="flex items-start gap-2 pt-1 text-[11px] leading-relaxed opacity-55">
                <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <p>
                  这是已创建实例的存储目录调整，不会改变实例内容或运行配置；数据导入请在实例管理中选择目标实例后使用 ZIP 导入。
                </p>
              </div>
            </>
          )}
        </div>

        {/* 底部按钮栏 */}
        <div
          className={cn(
            "px-5 py-4 flex-shrink-0 border-t flex items-center justify-end gap-2.5",
            isLight ? "border-black/[0.06] bg-black/[0.01]" : "border-white/[0.06] bg-white/[0.01]"
          )}
        >
          {successInfo ? (
            <button
              onClick={onClose}
              className={cn(
                "flat-capsule motion-control px-5 h-8 rounded-full text-xs font-medium border-0",
                isLight
                  ? "text-[#1a1625]/70 hover:text-[#1a1625]"
                  : "text-white/70 hover:text-white"
              )}
            >
              完成
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={migrating}
                onClick={onClose}
                className={cn(
                  "flat-capsule motion-control px-4 h-8 rounded-full text-xs font-medium border-0 disabled:opacity-40",
                  isLight
                    ? "text-[#1a1625]/60 hover:text-[#1a1625]"
                    : "text-white/60 hover:text-white"
                )}
              >
                取消
              </button>
              <button
                type="button"
                disabled={isRunning || migrating || pickingDirectory || !customPath.trim() || (isAndroid && !hasConfirmedSourcePath)}
                onClick={handleExecuteRelocate}
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
                    正在搬迁与更新注册表...
                  </>
                ) : (
                  "开始无损迁移"
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
};
