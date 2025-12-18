import { DEFAULT_CONFIG, getConfig, setConfig } from './shared/config.js';

const enabledCheckbox = document.getElementById('enabled');
const targetInput = document.getElementById('targetLanguage');
const statusEl = document.getElementById('status');
const saveButton = document.getElementById('save');
const translatePageButton = document.getElementById('translatePage');
const openOptionsButton = document.getElementById('openOptions');

document.addEventListener('DOMContentLoaded', init);

async function init() {
  const config = await getConfig();
  enabledCheckbox.checked = config.enabled !== false;
  targetInput.value = config.targetLanguage || DEFAULT_CONFIG.targetLanguage;
  saveButton.addEventListener('click', handleSave);
  translatePageButton.addEventListener('click', handleTranslatePage);
  openOptionsButton.addEventListener('click', () => chrome.runtime.openOptionsPage());
}

async function handleTranslatePage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id) {
    setStatus('Requesting page translation...');
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATE_PAGE' });
      setStatus('Translation started. Check page.', 'success');
      window.close();
    } catch (e) {
      setStatus('Failed to trigger translation: ' + e.message, 'error');
    }
  }
}

async function handleSave() {
  const targetLanguage = targetInput.value.trim() || DEFAULT_CONFIG.targetLanguage;
  const enabled = enabledCheckbox.checked;
  setStatus('Saving…');
  try {
    await setConfig({ targetLanguage, enabled });
    setStatus(enabled ? 'Translation enabled' : 'Translation disabled', 'success');
  } catch (error) {
    setStatus(error.message || 'Save failed', 'error');
  }
}

function setStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = type || '';
}
