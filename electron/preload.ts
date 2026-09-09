/**
 * Arayuze acilan guvenli kopru.
 *
 * contextIsolation acik; arayuz Node API'lerine dogrudan erisemez,
 * yalnizca burada tanimlanan islevleri cagirabilir.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { KonseyEvent } from '../src/shared/types';

const api = {
  browser: (action: string, value?: unknown) => ipcRenderer.invoke('preview:browser', action, value),
  simulator: (action: string, id?: string) => ipcRenderer.invoke('preview:simulator', action, id),
  availability: (preferWorkspace?: string) => ipcRenderer.invoke('konsey:availability', preferWorkspace),
  pickImages: () => ipcRenderer.invoke('konsey:images:pick'),
  imagesFromPaths: (paths: string[]) => ipcRenderer.invoke('konsey:images:fromPaths', paths),
  saveImage: (input: { name?: string; mime: string; bytes: ArrayBuffer }) =>
    ipcRenderer.invoke('konsey:images:save', input),
  filePath: (file: File) => webUtils.getPathForFile(file),

  loadConfig: () => ipcRenderer.invoke('konsey:config:load'),
  saveConfig: (config: unknown) => ipcRenderer.invoke('konsey:config:save', config),

  setProviderKey: (slug: string, apiKey: string) =>
    ipcRenderer.invoke('konsey:provider:setKey', slug, apiKey),
  hasProviderKey: (slug: string) => ipcRenderer.invoke('konsey:provider:hasKey', slug),
  testProvider: (provider: unknown, apiKey?: string) =>
    ipcRenderer.invoke('konsey:provider:test', provider, apiKey),

  pickProject: () => ipcRenderer.invoke('konsey:pickProject'),
  openPath: (target: string) => ipcRenderer.invoke('konsey:openPath', target),

  startRun: (args: { projectDir: string; prompt: string }) =>
    ipcRenderer.invoke('konsey:run:start', args),
  cancelRun: () => ipcRenderer.invoke('konsey:run:cancel'),

  onEvent: (handler: (event: KonseyEvent) => void) => {
    const listener = (_e: unknown, event: KonseyEvent) => handler(event);
    ipcRenderer.on('konsey:event', listener);
    return () => ipcRenderer.off('konsey:event', listener);
  },
};

contextBridge.exposeInMainWorld('konsey', api);

export type KonseyApi = typeof api;
