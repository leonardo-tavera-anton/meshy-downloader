// content.js

// ===== TOKEN EXTRACTION FROM COOKIES =====

function extractTokenFromCookies() {
  let token = null;

  try {
    const cookies = document.cookie.split(';');
    let authTokenPart0 = null;
    let authTokenPart1 = null;

    for (let cookie of cookies) {
      const [name, value] = cookie.split('=');
      const trimmedName = name.trim();

      if (trimmedName === 'sb-auth-auth-token.0') {
        authTokenPart0 = value.trim();
      }
      if (trimmedName === 'sb-auth-auth-token.1') {
        authTokenPart1 = value.trim();
      }
    }

    if (authTokenPart0 && authTokenPart1) {
      let part0 = authTokenPart0;
      if (part0.startsWith('base64-')) {
        part0 = part0.substring(7);
      }

      const combined = part0 + authTokenPart1;

      try {
        const decoded = atob(combined);
        const parsed = JSON.parse(decoded);

        if (parsed.access_token) {
          token = parsed.access_token;
          console.log('✓ TOKEN FOUND FROM COOKIES');
        }
      } catch (e) {
        console.error('❌ Decode error:', e.message);
      }
    }
  } catch (e) {
    console.error('❌ Cookie error:', e.message);
  }

  return token;
}

setTimeout(() => {
  const token = extractTokenFromCookies();
  if (token) {
    chrome.runtime.sendMessage({ action: 'saveToken', token: token });
  }
}, 1500);


// ===== FETCH INTERCEPTION FOR BEARER TOKEN =====

let tokenSaved = false;
const originalFetch = window.fetch;

window.fetch = function (...args) {
  const request = args[0];
  const options = args[1] || {};

  if (typeof request === 'string' && request.includes('api.meshy.ai')) {
    const authHeader = options.headers?.Authorization || options.headers?.authorization;

    if (authHeader && authHeader.startsWith('Bearer ') && !tokenSaved) {
      const token = authHeader.replace('Bearer ', '');
      chrome.runtime.sendMessage({ action: 'saveToken', token: token });
      tokenSaved = true;
      console.log('✓ TOKEN INTERCEPTED FROM FETCH');
    }
  }

  return originalFetch.apply(this, args);
};


// Auth hook is in main_world.js (registered with world: MAIN in manifest)


// ===== CONTENT SCRIPT: Auth Storage + Decrypt Worker =====

let wasmAuth = null;

// Listen for auth from main world
window.addEventListener('__meshy_auth__', (e) => {
  try {
    wasmAuth = JSON.parse(e.detail);
    console.log('✓ WASM auth credentials captured in content script');
    chrome.runtime.sendMessage({ action: 'saveWasmAuth', auth: wasmAuth });
  } catch (e) {
    console.error('Failed to parse WASM auth:', e);
  }
});


// ===== DECRYPT WORKER (runs in content script context) =====

let decryptWorker = null;
let workerReady = false;
let pendingOps = {};
let opCounter = 0;

function initDecryptWorker() {
  return new Promise((resolve, reject) => {
    if (decryptWorker && workerReady) {
      resolve();
      return;
    }

    if (!wasmAuth) {
      reject(new Error('No WASM auth. View a 3D model on meshy.ai first.'));
      return;
    }

    const workerUrl = window.location.origin + '/resource/decrypt/loader-worker.js';
    console.log('[Meshy DL] Creating Worker from:', workerUrl);

    try {
      decryptWorker = new Worker(workerUrl);
    } catch (e) {
      console.error('[Meshy DL] Worker creation failed:', e);
      reject(new Error('Worker creation failed: ' + e.message));
      return;
    }

    decryptWorker.onmessage = (e) => {
      const msg = e.data;
      console.log('[Meshy DL] Worker message:', msg.type);

      if (msg.type === 'loaded') {
        console.log('[Meshy DL] WASM loaded, authorizing...');
        decryptWorker.postMessage({
          type: 'authorize',
          hostname: wasmAuth.hostname,
          timestamp: wasmAuth.timestamp,
          signature: wasmAuth.signature
        });
      } else if (msg.type === 'ready') {
        console.log('[Meshy DL] ✓ Worker authorized and ready');
        workerReady = true;
        resolve();
      } else if (msg.type === 'auth_error') {
        console.error('[Meshy DL] Auth error:', msg.error);
        reject(new Error('WASM auth failed: ' + msg.error));
      } else if (msg.type === 'error') {
        console.error('[Meshy DL] Worker error:', msg.error);
        reject(new Error('Worker error: ' + msg.error));
      } else if (msg.type === 'process') {
        const op = pendingOps[msg.id];
        if (op) {
          if (msg.success) {
            op.resolve(msg.data);
          } else {
            if (msg.error === 'auth_expired') {
              workerReady = false;
              decryptWorker.terminate();
              decryptWorker = null;
            }
            op.reject(new Error(msg.error));
          }
          delete pendingOps[msg.id];
        }
      }
    };

    decryptWorker.onerror = (e) => {
      console.error('[Meshy DL] Worker error event:', e);
      reject(new Error('Worker load failed'));
    };
  });
}

async function decryptAndDownload(modelInput, filename, requestId) {
  try {
    await initDecryptWorker();

    const parts = Array.isArray(modelInput) ? modelInput : [{ url: modelInput, filename: filename }];

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const currentUrl = part.url || part;
      const currentFilename = part.filename || (parts.length > 1 ? `part_${i + 1}_${filename}` : filename);

      chrome.runtime.sendMessage({ action: 'decryptStatus', requestId, status: `fetching (${i + 1}/${parts.length})` });
      console.log(`[Meshy DL] Fetching part ${i + 1}/${parts.length}:`, currentUrl);

      const response = await fetch(currentUrl);
      if (!response.ok) throw new Error(`Fetch failed for part ${i + 1}: ${response.status}`);
      const meshyData = await response.arrayBuffer();

      chrome.runtime.sendMessage({ action: 'decryptStatus', requestId, status: `decrypting (${i + 1}/${parts.length})` });
      console.log(`[Meshy DL] Decrypting part ${i + 1}...`);

      const id = ++opCounter;
      const glbData = await new Promise((resolve, reject) => {
        pendingOps[id] = { resolve, reject };
        decryptWorker.postMessage({ id, type: 'process', data: meshyData }, [meshyData]);
      });

      const blob = new Blob([glbData], { type: 'model/gltf-binary' });
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = currentFilename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
      console.log(`[Meshy DL] ✓ Downloaded part:`, currentFilename);
    }

    chrome.runtime.sendMessage({ action: 'decryptStatus', requestId, status: 'done' });
  } catch (err) {
    console.error('[Meshy DL] Decrypt failed:', err);
    chrome.runtime.sendMessage({ action: 'decryptStatus', requestId, status: 'error', error: err.message });
  }
}

// Handle messages from background
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'decryptAndDownload') {
    console.log('[Meshy DL] Received decrypt request:', request.requestId);
    
    // Asegurar que use las partes si vienen definidas, de lo contrario usa el modelUrl único
    const payload = (request.parts && request.parts.length > 0) ? request.parts : request.modelUrl;
    
    decryptAndDownload(payload, request.filename, request.requestId);
    sendResponse({ success: true });
  }
});