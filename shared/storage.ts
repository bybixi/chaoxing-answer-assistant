import { storage } from '#imports';
import { DEFAULT_SETTINGS, type Settings } from './types/settings';

/** 设置项：带默认值兜底，读取时与默认值合并，防止旧数据缺字段 */
export const settingsItem = storage.defineItem<Settings>('local:settings', {
  fallback: DEFAULT_SETTINGS,
});

export async function getSettings(): Promise<Settings> {
  const saved = await settingsItem.getValue();
  return { ...DEFAULT_SETTINGS, ...saved };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await settingsItem.setValue(next);
  return next;
}
