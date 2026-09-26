import { contextBridge, ipcRenderer } from 'electron';
import type { ImportRequest, ImportStatus } from './windows-import';

contextBridge.exposeInMainWorld('migrationDebug', {
  defaults: () => ipcRenderer.invoke('import-debug:defaults'),
  discover: () => ipcRenderer.invoke('import-debug:discover'),
  choose: (field: string) => ipcRenderer.invoke('import-debug:choose', field),

  start: (request: ImportRequest) => ipcRenderer.invoke('import-debug:start', request),
  cancel: () => ipcRenderer.invoke('import-debug:cancel'),
  onStatus: (callback: (status: ImportStatus) => void) => {
    ipcRenderer.on('import-debug:status', (_event, status: ImportStatus) => callback(status));
  },
});
