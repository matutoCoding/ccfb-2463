// 全局应用设置（单例，持久化到 IndexedDB）
import { db } from './db';
import { DEFAULT_SETTINGS, type ViewerSettings } from './types';

type Listener = (s: ViewerSettings) => void;

class SettingsStore {
  private value: ViewerSettings = { ...DEFAULT_SETTINGS };
  private listeners = new Set<Listener>();

  async init(): Promise<void> {
    this.value = await db.loadSettings();
  }

  get(): ViewerSettings {
    return this.value;
  }

  async update(patch: Partial<ViewerSettings>): Promise<void> {
    this.value = { ...this.value, ...patch };
    this.listeners.forEach((l) => l(this.value));
    await db.saveSettings(this.value);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export const settingsStore = new SettingsStore();
