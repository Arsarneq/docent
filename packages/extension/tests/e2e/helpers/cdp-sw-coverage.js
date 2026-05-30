/**
 * cdp-sw-coverage.js — Raw CDP connection to service worker target.
 *
 * Playwright can't attach a CDP session to a service worker.
 * This module connects to Chrome's DevTools HTTP endpoint (exposed via
 * --remote-debugging-port), finds the SW target's WebSocket URL,
 * connects directly, and starts/collects V8 coverage.
 */

import WebSocket from 'ws';
import http from 'http';

let msgId = 1;

/**
 * Send a CDP command over WebSocket and wait for the response.
 */
function sendCommand(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    const msg = { id, method, params };

    const timeout = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 5000);

    const handler = (data) => {
      const response = JSON.parse(data.toString());
      if (response.id === id) {
        clearTimeout(timeout);
        ws.off('message', handler);
        if (response.error) {
          reject(new Error(`CDP error: ${response.error.message}`));
        } else {
          resolve(response.result);
        }
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify(msg));
  });
}

/**
 * Fetch JSON from an HTTP URL.
 */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

/**
 * Connect to the service worker's DevTools WebSocket and start coverage.
 *
 * @param {number} debugPort - The --remote-debugging-port value
 * @param {string} extensionId - The extension's ID
 * @returns {{ ws: WebSocket }}
 */
export async function connectToServiceWorker(debugPort, extensionId) {
  // Get all targets from Chrome's DevTools HTTP API
  const targets = await fetchJson(`http://127.0.0.1:${debugPort}/json`);

  // Find the service worker target
  const swTarget = targets.find(
    (t) => t.type === 'service_worker' && t.url.includes(`chrome-extension://${extensionId}/`),
  );

  if (!swTarget) {
    throw new Error(`Service worker target not found for extension ${extensionId}`);
  }

  if (!swTarget.webSocketDebuggerUrl) {
    throw new Error('Service worker target has no webSocketDebuggerUrl');
  }

  // Connect directly to the service worker's WebSocket
  const ws = new WebSocket(swTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  // Start precise coverage
  await sendCommand(ws, 'Profiler.enable');
  await sendCommand(ws, 'Profiler.startPreciseCoverage', {
    callCount: true,
    detailed: true,
  });

  return { ws };
}

/**
 * Collect coverage from the service worker and close the connection.
 *
 * @param {{ ws: WebSocket }} connection
 * @param {string} extensionId
 * @returns {Array} Coverage entries for extension scripts
 */
export async function collectAndClose({ ws }, extensionId) {
  const extensionPrefix = `chrome-extension://${extensionId}/`;

  const { result: coverage } = await sendCommand(ws, 'Profiler.takePreciseCoverage');

  await sendCommand(ws, 'Profiler.stopPreciseCoverage');
  await sendCommand(ws, 'Profiler.disable');
  ws.close();

  return coverage
    .filter((entry) => entry.url.startsWith(extensionPrefix))
    .map((entry) => ({
      url: entry.url,
      functions: entry.functions,
    }));
}
