import type { InstallPathMode } from "../capacitor-plugin";

export function cleanInstallPath(value: string): string | undefined {
  return value.trim().replace(/^["']|["']$/g, "").trim() || undefined;
}

function executablePath(value: string): string | undefined {
  const path = cleanInstallPath(value);
  if (path && /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    throw new Error("安装目录必须是可执行的本地路径，文档提供器位置只能用于导入");
  }
  return path;
}

export function installationSelection(selection: { path?: string; installPathMode?: InstallPathMode }) {
  const path = executablePath(selection.path || "");
  if (!path) throw new Error("目录选择器未返回实际路径");
  const mode = selection.installPathMode ?? "exact";
  if (mode !== "root" && mode !== "exact") throw new Error("目录选择器返回了无效的路径模式");
  return { path, mode };
}

export function instanceParentPath(value: string): string | undefined {
  return executablePath(value);
}

/** Relocation selects a parent, even when it has the same name as the instance. */
export function relocationTargetInParent(parentPath: string, instancePath: string): string {
  const parent = executablePath(parentPath);
  const source = executablePath(instancePath);
  const name = source?.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  if (!parent || !name || name === "." || name === "..") {
    throw new Error("无法确认实例目录，请重新打开存储迁移");
  }
  const separator = parent.includes("\\") || /^[a-z]:/i.test(parent) ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${separator}${name}`;
}

/** Migration targets are exact; the native installer owns root resolution for new installs. */
export function exactInstallTarget(value: string, mode: InstallPathMode, instanceIdOrName: string): string | undefined {
  const path = executablePath(value);
  if (!path) return undefined;
  if (mode === "exact") return path;
  return buildInstanceSubfolder(path, instanceIdOrName);
}

export function sanitizeFolderName(name: string): string {
  return name
    .trim()
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "-")
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, 100) || "instance";
}

/** The selected directory is always a parent, never the instance itself. */
export function buildInstanceSubfolder(parentDir: string, instanceName: string): string {
  const clean = parentDir.trim().replace(/^["']|["']$/g, "").trim().replace(/[\\/]+$/, "");
  const separator = clean.includes("\\") || /^[a-z]:/i.test(clean) ? "\\" : "/";
  const safeName = sanitizeFolderName(instanceName);
  return `${clean}${separator}${safeName}`;
}
