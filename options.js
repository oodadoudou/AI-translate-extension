import { DEFAULT_CONFIG, getConfig, setConfig } from './shared/config.js';

document.addEventListener('DOMContentLoaded', init);

const form = document.getElementById('config-form');
const statusEl = document.getElementById('status');
const testButton = document.getElementById('test-button');
const resetButton = document.getElementById('reset-button');

async function init() {
  const config = await getConfig();
  populateForm(config);
  form.addEventListener('submit', handleSave);
  testButton.addEventListener('click', handleTest);
  resetButton.addEventListener('click', handleReset);
}

function populateForm(config) {
  form.baseUrl.value = config.baseUrl || DEFAULT_CONFIG.baseUrl;
  form.model.value = config.model || DEFAULT_CONFIG.model;
  form.systemInstruction.value = config.systemInstruction || DEFAULT_CONFIG.systemInstruction;
  form.apiKey.value = config.apiKey || '';
  form.targetLanguage.value = config.targetLanguage || DEFAULT_CONFIG.targetLanguage;
  form.sourceLanguage.value = config.sourceLanguage || '';
  form.autoDetect.checked = config.autoDetect !== false;
  form.enabled.checked = config.enabled !== false;
}

function readForm() {
  return {
    baseUrl: form.baseUrl.value.trim(),
    model: form.model.value.trim(),
    systemInstruction: form.systemInstruction.value.trim(),
    apiKey: form.apiKey.value.trim(),
    targetLanguage: form.targetLanguage.value.trim(),
    sourceLanguage: form.sourceLanguage.value.trim(),
    autoDetect: form.autoDetect.checked,
    enabled: form.enabled.checked,
    lastValidatedAt: Date.now(),
  };
}

async function handleSave(event) {
  event.preventDefault();
  setStatus('Saving…');
  try {
    const saved = await setConfig(readForm());
    populateForm(saved);
    setStatus('Saved', 'success');
  } catch (error) {
    setStatus(error.message || 'Failed to save', 'error');
  }
}

async function handleTest() {
  setStatus('Testing connectivity…');
  const config = readForm();
  const response = await sendMessage({ type: 'TEST_CONNECTION', config });
  if (response?.ok) {
    setStatus('Connection OK with current settings.', 'success');
  } else {
    setStatus(response?.error || 'Test failed.', 'error');
  }
}

async function handleReset() {
  const current = readForm();
  const resetConfig = { ...DEFAULT_CONFIG, apiKey: current.apiKey };
  const saved = await setConfig(resetConfig);
  populateForm(saved);
  setStatus('Reset to defaults (kept API key).', 'success');
}

function setStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = type || '';
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        resolve({ ok: false, error: error.message });
        return;
      }
      resolve(response);
    });
  });
}
