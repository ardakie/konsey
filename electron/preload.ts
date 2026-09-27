/**
 * Arayuze acilan guvenli kopru.
 *
 * contextIsolation acik; arayuz Node API'lerine dogrudan erisemez,
 * yalnizca burada tanimlanan islevleri cagirabilir.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { KonseyEvent } from '../src/shared/types';

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? '';

const api = {
  /** Arayuz dili ve isletim sistemi; ana surec belirler. */
  lang: arg('konsey-lang') || 'en',
  platform: arg('konsey-platform') || process.platform,
  system: () => invoke('konsey:system'),
  connectList: () => invoke('konsey:connect:list'),
  connectRun: (id: string, action: 'install' | 'login') => invoke('konsey:connect:run', id, action),
  openExternal: (url: string) => invoke('konsey:openExternal', url),
  relaunch: () => invoke('konsey:relaunch'),
  checkUpdate: () => invoke('konsey:update:check'),
  setupChecks: (projectDir?: string | null) => invoke('konsey:setup:checks', projectDir),
  setupFix: (id: string) => invoke('konsey:setup:fix', id),
  integrations: () => invoke('konsey:integrations:list'),
  saveIntegration: (input: unknown) => invoke('konsey:integrations:save', input),
  removeIntegration: (id: string) => invoke('konsey:integrations:remove', id),
  testIntegration: (id: string, token?: string) => invoke('konsey:integrations:test', id, token),
  openDownloads: () => invoke('konsey:update:open'),

  browser: (action: string, value?: unknown) => invoke('preview:browser', action, value),
  simulator: (action: string, id?: string) => invoke('preview:simulator', action, id),

  availability: (preferWorkspace?: string) => invoke('konsey:availability', preferWorkspace),
  quotas: (refresh?: boolean) => invoke('konsey:quotas', refresh),
  usage: () => invoke('konsey:usage'),

  pickImages: () => invoke('konsey:images:pick'),
  imagesFromPaths: (paths: string[]) => invoke('konsey:images:fromPaths', paths),
  saveImage: (input: { name?: string; mime: string; bytes: ArrayBuffer }) => invoke('konsey:images:save', input),
  filePath: (file: File) => webUtils.getPathForFile(file),

  loadConfig: () => invoke('konsey:config:load'),
  saveConfig: (config: unknown) => invoke('konsey:config:save', config),
  setTheme: (theme: string) => invoke('konsey:theme', theme),

  setProviderKey: (slug: string, apiKey: string) => invoke('konsey:provider:setKey', slug, apiKey),
  hasProviderKey: (slug: string) => invoke('konsey:provider:hasKey', slug),
  testProvider: (provider: unknown, apiKey?: string) => invoke('konsey:provider:test', provider, apiKey),

  pickProject: () => invoke('konsey:pickProject'),
  selectProject: (dir: string) => invoke('konsey:project:select', dir),
  describeProject: (dir: string) => invoke('konsey:project:describe', dir),
  prepareProject: (dir: string) => invoke('konsey:project:prepare', dir),
  openPath: (target: string) => invoke('konsey:openPath', target),
  reveal: (target: string) => invoke('konsey:reveal', target),

  loadChats: (projectDir: string | null) => invoke('konsey:chat:load', projectDir),
  sendChat: (args: { projectDir: string | null; thread: string; text: string }) => invoke('konsey:chat:send', args),
  cancelChat: (thread: string) => invoke('konsey:chat:cancel', thread),
  clearChat: (projectDir: string | null, thread: string) => invoke('konsey:chat:clear', projectDir, thread),

  listDebates: (projectDir: string | null) => invoke('konsey:debates:list', projectDir),
  getDebate: (id: string) => invoke('konsey:debates:get', id),
  startDebate: (args: { topic: string; projectDir: string | null; depth: number }) => invoke('konsey:debates:start', args),
  sayDebate: (id: string, text: string) => invoke('konsey:debates:say', id, text),
  roundDebate: (id: string) => invoke('konsey:debates:round', id),
  summarizeDebate: (id: string) => invoke('konsey:debates:summarize', id),
  cancelDebate: (id: string) => invoke('konsey:debates:cancel', id),
  deleteDebate: (id: string) => invoke('konsey:debates:delete', id),
  renameDebate: (id: string, title: string) => invoke('konsey:debates:rename', id, title),
  convertDebate: (args: unknown) => invoke('konsey:debates:convert', args),
  pickFolder: (defaultPath?: string) => invoke('konsey:pickFolder', defaultPath),
  defaultProjectsDir: () => invoke('konsey:projectsDir'),

  listRuns: (projectDir?: string | null) => invoke('konsey:runs:list', projectDir),
  getRun: (id: string) => invoke('konsey:runs:get', id),
  deleteRun: (id: string) => invoke('konsey:runs:delete', id),
  applyRun: (id: string) => invoke('konsey:runs:apply', id),

  startRun: (args: { projectDir: string; prompt: string; mode?: string }) => invoke('konsey:run:start', args),
  cancelRun: () => invoke('konsey:run:cancel'),

  onEvent: (handler: (event: KonseyEvent) => void) => {
    const listener = (_e: unknown, event: KonseyEvent) => handler(event);
    ipcRenderer.on('konsey:event', listener);
    return () => ipcRenderer.off('konsey:event', listener);
  },
};

contextBridge.exposeInMainWorld('konsey', api);

export type KonseyApi = typeof api;
