/**
 * SillyClient Windows - 前后端强类型 IPC 契约层
 *
 * 严格与 web/capacitor-ui/src/capacitor-plugin.ts 保持 1:1 语义与字段对齐，
 * 为 Electron 主进程、IPC 路由分发器及运行时各领域服务提供受检的类型安全保护。
 */

// ---------------------------------------------------------------------------
// 基础领域实体类型
// ---------------------------------------------------------------------------

/** 本地实例的 SillyTavern 运行配置 */
export interface InstanceConfig {
  listen: boolean;
  ipv4: boolean;
  ipv6: boolean;
  dnsIpv6: boolean;
  heartbeat: number;
  keepAlive: boolean;
}

/** GitHub release 条目 */
export interface GithubRelease {
  tag: string;
  zipballUrl: string;
  prerelease: boolean;
}

export type ContentOpenMode = 'webview' | 'browser';

/** 自检发现的本地实例 */
export interface ScannedInstance {
  instanceId: string;
  version: string;
  path?: string;
  sizeBytes: number;
  hasServer: boolean;
  createdAt?: string;
  lastUsedAt?: string;
  totalUsageMs?: number;
}

/** 实例详情 */
export interface InstanceInfo {
  instanceId: string;
  version: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
  lastUsedAt?: string;
  totalUsageMs?: number;
  status: string;
}

/** 垃圾清理项 */
export interface GarbageItem {
  path: string;
  token?: string;
  type: 'orphan_instance' | 'orphan_cover' | 'temp_file' | 'cache';
  sizeBytes: number;
  description: string;
}

export type MaintenanceKind = 'download_cache' | 'broken_extension' | 'stale_extension_reference';
export type MaintenanceAction = 'delete_cache' | 'quarantine' | 'remove_disabled_reference';

export interface MaintenanceItem {
  id: string;
  token: string;
  kind: MaintenanceKind;
  relativePath: string;
  sizeBytes: number;
  description: string;
  confidence: 'owned' | 'suspected';
  defaultSelected: boolean;
  action: MaintenanceAction;
}

export interface MaintenanceScan {
  instanceId: string;
  scanId: string;
  expiresAt: number;
  items: MaintenanceItem[];
  warnings: string[];
}

export interface MaintenanceResult {
  id: string;
  success: boolean;
  action?: MaintenanceAction;
  error?: string;
  freedBytes: number;
  quarantinedBytes: number;
  recoveryId?: string;
}

export interface MaintenanceApplyResult {
  success: boolean;
  results: MaintenanceResult[];
  freedBytes: number;
  quarantinedBytes: number;
  recoveryIds: string[];
}

export interface MaintenanceRecovery {
  recoveryId: string;
  token: string;
  createdAt: number;
  description: string;
  relativePath: string;
  kind: MaintenanceKind;
  action: MaintenanceAction;
  sizeBytes: number;
  canRestore: boolean;
  conflict?: string;
}

export interface CompanionPresetSelection {
  bundleId: 'sc-bordeaux';
  revision: number;
}

export type PreinstalledExtensionId = 'tavern-helper' | 'littlewhitebox' | 'prompt-template' | 'dice';

export interface PreinstallSelection {
  revision: 1;
  extensionIds: PreinstalledExtensionId[];
}

export type InstallPathMode = 'root' | 'exact';

export interface LegacyInstanceLocation {
  instanceId: string;
  name: string;
  currentPath: string;
  targetPath: string;
  version?: string;
}

export interface InstanceRelocationResult {
  success: boolean;
  instanceId: string;
  oldPath: string;
  newPath: string;
  unchanged?: boolean;
  retainedSourcePath?: string;
}

// ---------------------------------------------------------------------------
// 运行时事件定义
// ---------------------------------------------------------------------------

export interface TarvenEvent {
  instanceId?: string;
  operationId?: string;
  source?: 'command';
  message?: string;
  line?: string;
  text?: string;
  level?: string;
  percent?: number;
  stage?: string;
  ready?: boolean;
  url?: string;
  port?: number;
  mode?: string;
  tavernRunning?: boolean;
  lastUsedAt?: string;
  totalUsageMs?: number;
}

// ---------------------------------------------------------------------------
// 各 IPC 调用的入参与出参强类型映射
// ---------------------------------------------------------------------------

export interface ProvisionAndStartParams {
  port: number;
  instanceId: string;
  operationId?: string;
  version: string;
  zipballUrl?: string;
  localZipPath?: string;
  installPath?: string;
  installPathMode?: InstallPathMode;
  companionPreset?: CompanionPresetSelection;
  preinstall?: PreinstallSelection;
  config: InstanceConfig;
}

export interface ProvisionAndStartResult {
  ready: boolean;
}

export interface OpenExternalUrlParams {
  url: string;
}

export interface EnterImmersiveParams {
  url: string;
  instanceId?: string;
  showGestureHint?: boolean;
}

export interface CloseTavernParams {
  instanceId?: string;
  operationId?: string;
}

export interface SuccessResult {
  success: boolean;
}

export interface GetStatusResult {
  mode: string;
  serverReady: boolean;
  url: string | null;
  instanceId?: string;
  operationId?: string;
}

export interface SendCommandParams {
  text: string;
  instanceId?: string;
  operationId?: string;
}

export interface GetInstanceInfoParams {
  instanceId: string;
  installPath?: string;
  installPathMode?: InstallPathMode;
  port?: number;
}

export interface PingUrlParams {
  url: string;
  instanceId?: string;
  username?: string;
  password?: string;
}

export interface PingUrlResult {
  online: boolean;
  statusCode?: number;
  authRequired?: boolean;
  error?: string;
}

export interface SetRemoteBasicAuthParams {
  instanceId: string;
  username: string;
  password?: string;
}

export interface SetRemoteBasicAuthResult {
  configured: boolean;
  username: string;
}

export interface GetRemoteBasicAuthStatusParams {
  instanceId: string;
}

export interface GetRemoteBasicAuthStatusResult {
  configured: boolean;
  username?: string;
}

export interface ClearRemoteBasicAuthParams {
  instanceId: string;
}

export interface FetchReleasesResult {
  releases: GithubRelease[];
  warning?: string;
}

export interface GetAppSettingsResult {
  instancesRoot: string;
  defaultInstancesRoot: string;
  configuredInstancesRoot?: string;
}

export interface SetInstancesRootParams {
  path?: string;
}

export interface SetInstancesRootResult {
  instancesRoot: string;
  configured: boolean;
}

export interface PickDirectoryParams {
  purpose?: 'installation' | 'source';
}

export interface PickDirectoryResult {
  name: string;
  path: string;
  installPathMode?: InstallPathMode;
}

export interface PickImageParams {
  instanceId: string;
}

export interface PickImageResult {
  path: string;
  url?: string;
}

export interface PickZipFileResult {
  path: string;
  sizeBytes: number;
}

export interface SaveTextFileParams {
  fileName: string;
  mimeType?: string;
  content: string;
}

export interface ReadTextFileParams {
  mimeType?: string;
}

export interface ReadTextFileResult {
  content: string;
  fileName: string;
}

export interface UninstallInstanceParams {
  instanceId: string;
  installPath?: string;
  installPathMode?: InstallPathMode;
  port?: number;
}

export interface UninstallInstanceResult {
  success: boolean;
  freedBytes: number;
}

export interface CleanGarbageParams {
  dryRun?: boolean;
  activeInstanceIds?: string[];
  activeCoverPaths?: string[];
}

export interface CleanGarbageResult {
  items: GarbageItem[];
  totalBytes: number;
  success?: boolean;
  freedBytes?: number;
  failures?: { path: string; error?: string }[];
}

export interface DeleteGarbageItemParams {
  path: string;
  token?: string;
}

export interface ScanInstanceMaintenanceParams {
  instanceId: string;
  installPath?: string;
}

export interface ApplyInstanceMaintenanceParams {
  instanceId: string;
  scanId: string;
  items: { id: string; token: string }[];
  installPath?: string;
}

export interface ListInstanceMaintenanceRecoveryParams {
  instanceId: string;
  installPath?: string;
}

export interface ListInstanceMaintenanceRecoveryResult {
  items: MaintenanceRecovery[];
  warnings: string[];
}

export interface RestoreInstanceMaintenanceParams {
  instanceId: string;
  recoveryId: string;
  token: string;
  installPath?: string;
}

export interface RestoreInstanceMaintenanceResult {
  success: boolean;
  recoveryId?: string;
  relativePath?: string;
  error?: string;
}

export interface MigrateInstanceParams {
  sourcePath: string;
  targetPath?: string;
  instanceId: string;
  operationId?: string;
  mode?: 'copy' | 'takeover';
  includeSecrets?: boolean;
  preinstall?: PreinstallSelection;
}

export interface MigrateInstanceResult {
  success: boolean;
  instanceId: string;
  targetPath?: string;
}

export interface RelocateInstanceParams {
  instanceId: string;
  targetPath?: string;
  installPath?: string;
}

export interface MigrateLegacyInstancesParams {
  instanceIds?: string[];
}

export interface MigrateLegacyInstancesResult {
  success: boolean;
  results: InstanceRelocationResult[];
}

export interface RenameInstanceParams {
  instanceId: string;
  newName: string;
  installPath?: string;
}

export interface RenameInstanceResult {
  success: boolean;
  oldId: string;
  newId: string;
  oldPath: string;
  newPath: string;
}

export interface InspectImportArchiveParams {
  archivePath: string;
}

export interface InspectImportArchiveResult {
  importEntries: number;
  importBytes: number;
  skippedEntries: number;
  skippedBytes: number;
  hasSecrets: boolean;
  hasConfig: boolean;
  importable: boolean;
}

export interface ImportInstanceDataParams {
  instanceId: string;
  installPath?: string;
  archivePath: string;
  includeOptional?: boolean;
  operationId?: string;
}

export interface ImportInstanceDataResult {
  imported: number;
  bytes: number;
  skipped: number;
}

export interface ExportInstanceParams {
  instanceId: string;
  installPath?: string;
}

export interface ExportInstanceResult {
  path: string;
  bytes: number;
}

export interface SetInstancePasswordParams {
  instanceId: string;
  password?: string;
  oldPassword?: string;
}

export interface SetInstancePasswordResult {
  success: boolean;
  hasPassword: boolean;
}

export interface VerifyInstancePasswordParams {
  instanceId: string;
  password: string;
}

export interface VerifyInstancePasswordResult {
  valid: boolean;
}

export interface HasInstancePasswordParams {
  instanceId: string;
}

export interface HasInstancePasswordResult {
  hasPassword: boolean;
}

export interface ClearInstancePasswordParams {
  instanceId: string;
  oldPassword?: string;
}

export interface SafeInsetsResult {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface ContentOpenModeResult {
  mode: ContentOpenMode;
}

export interface SetContentOpenModeParams {
  mode: ContentOpenMode;
}
