import { DEFAULT_CONFIG, getConfig, setConfig, setEnabled, watchConfig } from './shared/config.js';

const SYSTEM_PROMPT_SUFFIX = 'Return only valid JSON per the provided schema; do not add prose. Strictly preserve original paragraph formatting and line breaks.';

let cachedConfig = { ...DEFAULT_CONFIG };

init();

function init() {
  hydrateConfig();
  watchConfig((config) => {
    cachedConfig = config;
  });
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
      void setConfig(DEFAULT_CONFIG);
    }
  });
  chrome.runtime.onMessage.addListener(handleMessage);
  chrome.runtime.onConnect.addListener(handleConnect);
}

async function hydrateConfig() {
  cachedConfig = await getConfig();
}

function normalizeEndpoint(baseUrl) {
  if (!baseUrl) return '';
  const trimmed = baseUrl.replace(/\/$/, '');
  if (/chat\/completions$/i.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

function buildUserPrompt(text, targetLanguage, sourceLanguage, autoDetect, isStream) {
  const sourceDescriptor = autoDetect
    ? 'auto-detect the source language'
    : `source language: ${sourceLanguage || 'unknown'}`;

  if (isStream) {
    return [
      `Translate the provided text. Target language: ${targetLanguage}.`,
      `${sourceDescriptor}.`,
      'Output format: First line "Detected: <LanguageName>". Second line onwards: The translated text. Preserve paragraph formatting.',
      'Text:',
      text,
    ].join(' ');
  }

  return [
    `Translate the provided text. Target language: ${targetLanguage}.`,
    `${sourceDescriptor}.`,
    'Return JSON exactly matching: { "translated_text": "string", "detected_source_language": "string (human readable name, e.g. English)", "target_language": "string (human readable name)" }.',
    'Text to translate:',
    text,
  ].join(' ');
}

async function performChatCompletion(config, text) {
  const apiKey = (config.apiKey || '').trim();
  if (!apiKey) {
    throw new Error('API key is missing. Please add it in options.');
  }
  const endpoint = normalizeEndpoint(config.baseUrl || DEFAULT_CONFIG.baseUrl);
  if (!endpoint) {
    throw new Error('Base URL is missing.');
  }

  const body = {
    model: config.model || DEFAULT_CONFIG.model,
    messages: [
      { role: 'system', content: `${config.systemInstruction || DEFAULT_CONFIG.systemInstruction} ${SYSTEM_PROMPT_SUFFIX}` },
      {
        role: 'user',
        content: buildUserPrompt(
          text,
          config.targetLanguage || DEFAULT_CONFIG.targetLanguage,
          config.sourceLanguage || DEFAULT_CONFIG.sourceLanguage,
          config.autoDetect !== false
        ),
      },
    ],
    temperature: 0.2,
    stream: false,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }
    let data;
    try {
      data = await response.json();
    } catch (error) {
      const fallbackText = await response.text();
      data = { choices: [{ message: { content: fallbackText } }] };
    }
    const raw = data?.choices?.[0]?.message?.content || '';
    return extractTranslation(raw, config);
  } finally {
    clearTimeout(timeout);
  }
}

function extractTranslation(raw, config) {
  const fallbackDetected = config.autoDetect !== false
    ? 'unknown'
    : config.sourceLanguage || 'unknown';
  const fallback = {
    translatedText: raw?.trim() || 'No response received.',
    detectedSourceLanguage: fallbackDetected,
    targetLanguage: config.targetLanguage || DEFAULT_CONFIG.targetLanguage,
  };

  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return {
        translatedText: parsed.translated_text || fallback.translatedText,
        detectedSourceLanguage: parsed.detected_source_language || fallback.detectedSourceLanguage,
        targetLanguage: parsed.target_language || fallback.targetLanguage,
      };
    }
  } catch (error) {
  }
  return fallback;
}

function handleMessage(message, sender, sendResponse) {
  if (!message || !message.type) return false;

  switch (message.type) {
    case 'TRANSLATE_SELECTION': {
      const text = (message.text || '').trim();
      if (!text) {
        sendResponse({ ok: false, error: 'No text selected.' });
        return true;
      }
      if (!cachedConfig.enabled) {
        sendResponse({ ok: false, error: 'Translation is disabled.' });
        return true;
      }
      void performChatCompletion(cachedConfig, text)
        .then((result) => {
          sendResponse({ ok: true, result });
        })
        .catch((error) => {
          sendResponse({ ok: false, error: error.message || 'Translation failed.' });
        });
      return true;
    }

    case 'GET_STATE': {
      sendResponse({
        ok: true,
        state: {
          enabled: cachedConfig.enabled,
          targetLanguage: cachedConfig.targetLanguage,
          autoDetect: cachedConfig.autoDetect,
          sourceLanguage: cachedConfig.sourceLanguage,
        },
      });
      return true;
    }

    case 'SET_ENABLED': {
      void setEnabled(Boolean(message.enabled))
        .then((config) => {
          cachedConfig = config;
          sendResponse({ ok: true, state: { enabled: config.enabled } });
        })
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    case 'TEST_CONNECTION': {
      const candidate = {
        ...DEFAULT_CONFIG,
        ...(message.config || {}),
      };
      void performChatCompletion(candidate, 'hello')
        .then((result) => {
          sendResponse({ ok: true, result });
        })
        .catch((error) => {
          sendResponse({ ok: false, error: error.message || 'Test call failed.' });
        });
      return true;
    }

    case 'TRANSLATE_BATCH': {
      const texts = message.texts || [];
      if (!texts.length) {
        sendResponse({ ok: true, result: [] });
        return true;
      }
      void performBatchChatCompletion(cachedConfig, texts)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    default:
      break;
  }

  return false;
}

function handleConnect(port) {
  if (port.name !== 'translate_stream') return;
  port.onMessage.addListener((msg) => {
    if (msg.type === 'START_STREAM') {
      streamChatCompletion(cachedConfig, msg.text, port).catch(err => {
        try {
          port.postMessage({ type: 'ERROR', error: err.message });
          port.disconnect();
        } catch (e) {
          // Port already disconnected, ignore
        }
      });
    }
  });
}

async function performBatchChatCompletion(config, texts) {
  const apiKey = (config.apiKey || '').trim();
  if (!apiKey) throw new Error('API key is missing.');

  const endpoint = normalizeEndpoint(config.baseUrl || DEFAULT_CONFIG.baseUrl);
  const target = config.targetLanguage || DEFAULT_CONFIG.targetLanguage;

  const requestPayload = { segments: texts };
  const userPrompt = `Translate the following text segments to ${target}. Input JSON: ${JSON.stringify(requestPayload)}`;
  const customInstruction = config.systemInstruction || DEFAULT_CONFIG.systemInstruction;
  const systemMessage = `${customInstruction} Return a JSON object with a "translations" key containing the array of translated strings in the same order.`;

  const body = {
    model: config.model || DEFAULT_CONFIG.model,
    messages: [
      { role: 'system', content: systemMessage },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.2,
    response_format: { type: "json_object" }
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw new Error(`Batch request failed: ${response.status}`);

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content || '{}';

  try {
    const parsed = JSON.parse(raw);
    return parsed.translations || [];
  } catch (e) {
    console.error('Batch translation parse error', e, raw);
    return [];
  }
}

async function streamChatCompletion(config, text, port) {
  const apiKey = (config.apiKey || '').trim();
  if (!apiKey) throw new Error('API key is missing.');

  const endpoint = normalizeEndpoint(config.baseUrl || DEFAULT_CONFIG.baseUrl);
  const userPrompt = buildUserPrompt(
    text,
    config.targetLanguage || DEFAULT_CONFIG.targetLanguage,
    config.sourceLanguage || DEFAULT_CONFIG.sourceLanguage,
    config.autoDetect !== false,
    true
  );

  const body = {
    model: config.model || DEFAULT_CONFIG.model,
    messages: [
      { role: 'system', content: config.systemInstruction || DEFAULT_CONFIG.systemInstruction },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.2,
    stream: true,
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw new Error(`Request failed: ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let isFirstChunk = true;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (trimmed.startsWith('data: ')) {
        try {
          const json = JSON.parse(trimmed.slice(6));
          const content = json.choices?.[0]?.delta?.content || '';
          if (content) {
            port.postMessage({ type: 'CHUNK', value: content });
          }
        } catch (e) { }
      }
    }
  }

  port.postMessage({ type: 'DONE' });
}
