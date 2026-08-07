// Bridge to the Electron main process (exposed by electron/preload.cjs).
// All calls are no-ops when running in a plain browser.

export interface UpdateInfo {
  version: string;
  url?: string;
}

export interface UpdateCheckResult {
  ok: boolean;
  available?: boolean;
  noRelease?: boolean;
  version?: string;
  current?: string;
  url?: string;
  error?: string;
}

interface DesktopAPI {
  setTrayTitle: (title: string) => void;
  closeTrayPopup: () => void;
  openMainWindow: () => void;
  getAppVersion: () => Promise<string>;
  updaterCheck: () => Promise<UpdateCheckResult>;
  openExternal: (url: string) => void;
  onUpdaterEvent: (callback: (type: string, data: UpdateInfo) => void) => void;
  onSystemSync?: (callback: () => void) => () => void;
}

declare global {
  interface Window {
    desktopAPI?: DesktopAPI;
  }
}

export const isDesktop = typeof window !== 'undefined' && window.desktopAPI !== undefined;

export function setTrayTitle(title: string): void {
  window.desktopAPI?.setTrayTitle(title);
}

export function closeTrayPopup(): void {
  window.desktopAPI?.closeTrayPopup();
}

export function openMainWindow(): void {
  window.desktopAPI?.openMainWindow();
}

export function openExternal(url: string): void {
  window.desktopAPI?.openExternal(url);
}

export function getAppVersion(): Promise<string | undefined> {
  return Promise.resolve(window.desktopAPI?.getAppVersion());
}

export function checkForUpdates(): Promise<UpdateCheckResult | undefined> {
  return Promise.resolve(window.desktopAPI?.updaterCheck());
}

/**
 * The main process rewrote timers (Mac asleep, session locked, midnight crossed,
 * crash recovered): reload. Returns an unsubscribe function.
 */
export function onSystemSync(callback: () => void): () => void {
  return window.desktopAPI?.onSystemSync?.(callback) ?? (() => {});
}

export function onUpdaterEvent(
  callback: (type: string, data: UpdateInfo) => void,
): void {
  window.desktopAPI?.onUpdaterEvent(callback);
}
