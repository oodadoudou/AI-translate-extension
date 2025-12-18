export const STORAGE_KEY = 'aiTranslateConfig';

export const DEFAULT_CONFIG = {
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  model: 'deepseek-v3-2-251201',
  apiKey: '',
  targetLanguage: 'Simplified Chinese',
  sourceLanguage: '',
  systemInstruction: 'You are a precise translation engine.',
  autoDetect: true,
  enabled: true,
  lastValidatedAt: 0,
};

const storageAreas = [chrome?.storage?.sync, chrome?.storage?.local].filter(Boolean);

function resolveStorageArea() {
  return storageAreas[0];
}

async function readConfig(area) {
  return new Promise((resolve) => {
    area.get([STORAGE_KEY], (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        resolve({ ok: false, value: null });
        return;
      }
      resolve({ ok: true, value: result?.[STORAGE_KEY] || null });
    });
  });
}

async function writeConfig(area, config) {
  return new Promise((resolve) => {
    area.set({ [STORAGE_KEY]: config }, () => {
      const error = chrome.runtime.lastError;
      resolve(!error);
    });
  });
}

export async function getConfig() {
  const area = resolveStorageArea();
  const response = area ? await readConfig(area) : { ok: false, value: null };
  if (!response.ok || !response.value) {
    const fallback = storageAreas[1];
    if (fallback && fallback !== area) {
      const fallbackResponse = await readConfig(fallback);
      if (fallbackResponse.ok && fallbackResponse.value) {
        return { ...DEFAULT_CONFIG, ...fallbackResponse.value };
      }
    }
  }
  return { ...DEFAULT_CONFIG, ...(response.value || {}) };
}

export async function setConfig(update) {
  const current = await getConfig();
  const next = { ...current, ...update };
  for (const area of storageAreas) {
    const ok = await writeConfig(area, next);
    if (ok) break;
  }
  return next;
}

export async function setEnabled(enabled) {
  return setConfig({ enabled });
}

export function watchConfig(callback) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' && areaName !== 'local') return;
    if (!changes[STORAGE_KEY]) return;
    callback({ ...DEFAULT_CONFIG, ...(changes[STORAGE_KEY].newValue || {}) });
  });
}

export async function resetConfig() {
  for (const area of storageAreas) {
    const ok = await writeConfig(area, DEFAULT_CONFIG);
    if (ok) break;
  }
  return DEFAULT_CONFIG;
}
