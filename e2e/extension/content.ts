import { Responder, Requester } from '../../dist/index.mjs';
import type { TabMethods, BackgroundMethods } from './types';

// Baseline tab responder
const tabResponder = new Responder<TabMethods>('tab-channel');

tabResponder.subscribe('pingTab', () => {
  return {
    fromTab: true,
    title: document.title,
    href: window.location.href,
  };
});

tabResponder.subscribe('echoTab', (text: string) => {
  return {
    echo: text,
    tabUrl: window.location.href,
  };
});

tabResponder.subscribe('tabFailingMethod', () => {
  throw new Error('Error inside tab content script handler');
});

tabResponder.subscribe('slowTabEcho', async (text: string, delayMs: number) => {
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  return { echo: text };
});

// Opt-in large tab responder (16 KiB chunks)
const tabLargeResponder = new Responder<TabMethods>('tab-large-channel', {
  largePayloads: { chunkSize: 16 * 1024 },
});

tabLargeResponder.subscribe('pingTab', () => {
  return {
    fromTab: true,
    title: document.title,
    href: window.location.href,
  };
});

tabLargeResponder.subscribe('echoTab', (text: string) => {
  return {
    echo: text,
    tabUrl: window.location.href,
  };
});

tabLargeResponder.subscribe('tabFailingMethod', () => {
  throw new Error('Error inside tab content script handler');
});

tabLargeResponder.subscribe('slowTabEcho', async (text: string, delayMs: number) => {
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  return { echo: text };
});

tabLargeResponder.subscribe('echoLargeJsonTab', async (payload: unknown) => {
  return payload;
});

tabLargeResponder.subscribe('echoBlobTab', async (payload: { label: string; blob: Blob }) => {
  return {
    label: `tab-echo-${payload.label}`,
    blob: payload.blob,
  };
});

const bgRequester = new Requester<BackgroundMethods>('bg-channel');
const bgLargeRequester = new Requester<BackgroundMethods>('bg-large-channel', undefined, {
  largePayloads: { chunkSize: 16 * 1024 },
});

function markReady() {
  const bridge = document.getElementById('content-bridge');
  if (bridge) {
    bridge.setAttribute('data-ready', 'true');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', markReady);
} else {
  markReady();
}

document.addEventListener('test-trigger-content-call', async (event: Event) => {
  const customEvent = event as CustomEvent<{ method: keyof BackgroundMethods; args: any[] }>;
  const { method, args } = customEvent.detail;
  const resultEl = document.getElementById('content-result');

  try {
    const result = await bgRequester.call(method as any, ...(args || []));
    if (resultEl) {
      resultEl.textContent = JSON.stringify({ success: true, result });
      resultEl.setAttribute('data-status', 'success');
    }
  } catch (err: any) {
    if (resultEl) {
      resultEl.textContent = JSON.stringify({ success: false, error: err.message });
      resultEl.setAttribute('data-status', 'error');
    }
  }
});

document.addEventListener('test-trigger-large-content-call', async (event: Event) => {
  const customEvent = event as CustomEvent<{ method: keyof BackgroundMethods; args: any[] }>;
  const { method, args } = customEvent.detail;
  const resultEl = document.getElementById('content-result');

  try {
    const result = await bgLargeRequester.call(method as any, ...(args || []));
    if (resultEl) {
      resultEl.textContent = JSON.stringify({ success: true, result });
      resultEl.setAttribute('data-status', 'success');
    }
  } catch (err: any) {
    if (resultEl) {
      resultEl.textContent = JSON.stringify({ success: false, error: err.message });
      resultEl.setAttribute('data-status', 'error');
    }
  }
});

document.addEventListener('test-send-raw-v1', async (event: Event) => {
  const customEvent = event as CustomEvent<{ requestId?: string; message: any }>;
  const { requestId = '', message } = customEvent.detail || {};
  const resultEl = document.getElementById('content-result');
  try {
    const reply = await chrome.runtime.sendMessage(message);
    if (resultEl) {
      resultEl.setAttribute('data-req-id', requestId);
      resultEl.setAttribute('data-status', 'done');
      resultEl.textContent = JSON.stringify({ success: true, reply });
    }
  } catch (err: any) {
    if (resultEl) {
      resultEl.setAttribute('data-req-id', requestId);
      resultEl.setAttribute('data-status', 'done');
      resultEl.textContent = JSON.stringify({ success: false, error: err?.message || String(err) });
    }
  }
});
