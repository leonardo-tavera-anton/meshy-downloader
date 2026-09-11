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

async function decryptAndDownload(modelInput, filename, requestId, targetFormat = 'glb') {
  try {
    await initDecryptWorker();

    const parts = Array.isArray(modelInput) ? modelInput : [{ url: modelInput, filename: filename }];

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const currentUrl = part.url || part;
      
      const ext = targetFormat === 'obj' ? '.obj' : (targetFormat === 'stl' ? '.stl' : '.glb');
      const baseName = (part.filename || filename).replace(/\.(glb|obj|stl|meshy)$/i, '');
      const currentFilename = parts.length > 1 ? `${baseName}_parte_${i + 1}${ext}` : `${baseName}${ext}`;

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

      // Procesar y convertir a GLB, OBJ o STL de forma nativa sin Three.js
      await processAndSaveBlob(glbData, targetFormat, currentFilename);
      console.log(`[Meshy DL] ✓ Downloaded part:`, currentFilename);
    }

    chrome.runtime.sendMessage({ action: 'decryptStatus', requestId, status: 'done' });
  } catch (err) {
    console.error('[Meshy DL] Decrypt failed:', err);
    chrome.runtime.sendMessage({ action: 'decryptStatus', requestId, status: 'error', error: err.message });
  }
}

// ===== CONVERSION & DOWNLOAD UTILS (NATIVO / SIN THREE.JS) =====

async function processAndSaveBlob(glbData, targetFormat, currentFilename) {
  if (targetFormat === 'glb') {
    const blob = new Blob([glbData], { type: 'model/gltf-binary' });
    triggerDownload(blob, currentFilename);
    return;
  }

  try {
    const geometry = parseGLBGeometry(glbData);

    if (!geometry || geometry.positions.length === 0) {
      console.warn('No se pudieron extraer vértices del GLB. Descargando GLB original.');
      triggerDownload(new Blob([glbData], { type: 'model/gltf-binary' }), currentFilename);
      return;
    }

    let finalBlob;
    if (targetFormat === 'obj') {
      finalBlob = convertGeometryToOBJ(geometry);
    } else if (targetFormat === 'stl') {
      finalBlob = convertGeometryToSTL(geometry);
    } else {
      finalBlob = new Blob([glbData], { type: 'model/gltf-binary' });
    }

    triggerDownload(finalBlob, currentFilename);
  } catch (e) {
    console.error('Error al convertir formato:', e);
    triggerDownload(new Blob([glbData], { type: 'model/gltf-binary' }), currentFilename);
  }
}

function parseGLBGeometry(arrayBuffer) {
  const dataView = new DataView(arrayBuffer);
  const magic = dataView.getUint32(0, true);
  if (magic !== 0x46544C67) throw new Error('El archivo no es un GLB válido.');

  const jsonChunkLength = dataView.getUint32(12, true);
  const jsonChunkType = dataView.getUint32(16, true);
  if (jsonChunkType !== 0x4E4F534A) throw new Error('Estructura GLB inválida.');

  const decoder = new TextDecoder('utf-8');
  const jsonBytes = new Uint8Array(arrayBuffer, 20, jsonChunkLength);
  const gltf = JSON.parse(decoder.decode(jsonBytes));

  const binHeaderOffset = 20 + jsonChunkLength;
  const binChunkLength = dataView.getUint32(binHeaderOffset, true);
  const binChunkType = dataView.getUint32(binHeaderOffset + 4, true);
  if (binChunkType !== 0x004E4942) throw new Error('Bloque binario no encontrado.');

  const binBufferOffset = binHeaderOffset + 8;

  let allPositions = [];
  let allIndices = [];
  let vertexOffset = 0;

  for (const mesh of gltf.meshes || []) {
    for (const primitive of mesh.primitives || []) {
      if (primitive.attributes.POSITION === undefined) continue;

      const posAccessor = gltf.accessors[primitive.attributes.POSITION];
      const posBufferView = gltf.bufferViews[posAccessor.bufferView];
      const posByteOffset = binBufferOffset + (posBufferView.byteOffset || 0) + (posAccessor.byteOffset || 0);
      const posFloatCount = posAccessor.count * 3;

      const positions = new Float32Array(arrayBuffer, posByteOffset, posFloatCount);

      for (let i = 0; i < positions.length; i++) {
        allPositions.push(positions[i]);
      }

      if (primitive.indices !== undefined) {
        const idxAccessor = gltf.accessors[primitive.indices];
        const idxBufferView = gltf.bufferViews[idxAccessor.bufferView];
        const idxByteOffset = binBufferOffset + (idxBufferView.byteOffset || 0) + (idxAccessor.byteOffset || 0);

        if (idxAccessor.componentType === 5123) {
          const indices = new Uint16Array(arrayBuffer, idxByteOffset, idxAccessor.count);
          for (let i = 0; i < indices.length; i++) {
            allIndices.push(indices[i] + vertexOffset);
          }
        } else if (idxAccessor.componentType === 5125) {
          const indices = new Uint32Array(arrayBuffer, idxByteOffset, idxAccessor.count);
          for (let i = 0; i < indices.length; i++) {
            allIndices.push(indices[i] + vertexOffset);
          }
        } else if (idxAccessor.componentType === 5121) {
          const indices = new Uint8Array(arrayBuffer, idxByteOffset, idxAccessor.count);
          for (let i = 0; i < indices.length; i++) {
            allIndices.push(indices[i] + vertexOffset);
          }
        }
      } else {
        for (let i = 0; i < posAccessor.count; i++) {
          allIndices.push(i + vertexOffset);
        }
      }

      vertexOffset += posAccessor.count;
    }
  }

  return { positions: allPositions, indices: allIndices };
}

function convertGeometryToOBJ(geometry) {
  let output = '# Exported by Meshy Downloader\n';
  const pos = geometry.positions;
  const idx = geometry.indices;

  for (let i = 0; i < pos.length; i += 3) {
    output += `v ${pos[i]} ${pos[i + 1]} ${pos[i + 2]}\n`;
  }

  for (let i = 0; i < idx.length; i += 3) {
    output += `f ${idx[i] + 1} ${idx[i + 1] + 1} ${idx[i + 2] + 1}\n`;
  }

  return new Blob([output], { type: 'text/plain' });
}

function convertGeometryToSTL(geometry) {
  const pos = geometry.positions;
  const idx = geometry.indices;
  const triangleCount = idx.length / 3;

  const bufferSize = 84 + triangleCount * 50;
  const buffer = new ArrayBuffer(bufferSize);
  const view = new DataView(buffer);

  for (let i = 0; i < 80; i++) view.setUint8(i, 32);
  view.setUint32(80, triangleCount, true);

  let offset = 84;

  for (let i = 0; i < idx.length; i += 3) {
    const i1 = idx[i] * 3;
    const i2 = idx[i + 1] * 3;
    const i3 = idx[i + 2] * 3;

    view.setFloat32(offset, 0, true); offset += 4;
    view.setFloat32(offset, 0, true); offset += 4;
    view.setFloat32(offset, 0, true); offset += 4;

    view.setFloat32(offset, pos[i1], true); offset += 4;
    view.setFloat32(offset, pos[i1 + 1], true); offset += 4;
    view.setFloat32(offset, pos[i1 + 2], true); offset += 4;

    view.setFloat32(offset, pos[i2], true); offset += 4;
    view.setFloat32(offset, pos[i2 + 1], true); offset += 4;
    view.setFloat32(offset, pos[i2 + 2], true); offset += 4;

    view.setFloat32(offset, pos[i3], true); offset += 4;
    view.setFloat32(offset, pos[i3 + 1], true); offset += 4;
    view.setFloat32(offset, pos[i3 + 2], true); offset += 4;

    view.setUint16(offset, 0, true); offset += 2;
  }

  return new Blob([buffer], { type: 'application/octet-stream' });
}

function triggerDownload(blob, filename) {
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
}

// Handle messages from background
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'decryptAndDownload') {
    console.log('[Meshy DL] Received decrypt request:', request.requestId);
    
    const payload = (request.parts && request.parts.length > 0) ? request.parts : request.modelUrl;
    const targetFormat = request.targetFormat || 'glb';
    
    decryptAndDownload(payload, request.filename, request.requestId, targetFormat);
    sendResponse({ success: true });
  }
});