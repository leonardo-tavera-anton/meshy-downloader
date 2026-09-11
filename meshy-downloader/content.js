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
      if (trimmedName === 'sb-auth-auth-token.0') authTokenPart0 = value.trim();
      if (trimmedName === 'sb-auth-auth-token.1') authTokenPart1 = value.trim();
    }

    if (authTokenPart0 && authTokenPart1) {
      let part0 = authTokenPart0;
      if (part0.startsWith('base64-')) part0 = part0.substring(7);
      const combined = part0 + authTokenPart1;
      try {
        const decoded = atob(combined);
        const parsed = JSON.parse(decoded);
        if (parsed.access_token) {
          token = parsed.access_token;
          console.log('✓ TOKEN FOUND FROM COOKIES');
        }
      } catch (e) {}
    }
  } catch (e) {}
  return token;
}

function saveToken(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 4096) return;
  chrome.runtime.sendMessage({ action: 'saveToken', token }).catch(() => {});
}

setTimeout(() => {
  const token = extractTokenFromCookies();
  if (token) saveToken(token);
}, 1500);

window.addEventListener('__meshy_token__', (event) => {
  try {
    const detail = JSON.parse(event.detail);
    saveToken(detail.token);
  } catch (error) {
    console.warn('[Meshy DL] Invalid token bridge event');
  }
});


// ===== CONTENT SCRIPT: Auth Storage + Decrypt Worker =====
let wasmAuth = null;

window.addEventListener('__meshy_auth__', (e) => {
  try {
    const auth = JSON.parse(e.detail);
    if (!auth.hostname || !auth.signature || !Number.isFinite(auth.timestamp)) return;
    wasmAuth = auth;
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
      reject(new Error('Aún no se capturan las credenciales WASM. Haz clic o interactúa con el modelo 3D en Meshy para generarlas.'));
      return;
    }

    const workerUrl = window.location.origin + '/resource/decrypt/loader-worker.js';

    try {
      decryptWorker = new Worker(workerUrl);
    } catch (e) {
      reject(new Error('Worker creation failed: ' + e.message));
      return;
    }

    decryptWorker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'loaded') {
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
      } else if (msg.type === 'auth_error' || msg.type === 'error') {
        reject(new Error('Worker error: ' + (msg.error || 'auth failed')));
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

    decryptWorker.onerror = () => reject(new Error('Worker load failed'));
  });
}

function ensureArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (data instanceof Uint8Array) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  if (data && data.buffer instanceof ArrayBuffer) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  return data;
}

function isGlbBuffer(data) {
  const buffer = ensureArrayBuffer(data);
  return buffer instanceof ArrayBuffer && buffer.byteLength >= 4
    && new DataView(buffer).getUint32(0, true) === 0x46544C67;
}

async function fetchModelBuffer(url) {
  const stored = await chrome.storage.local.get('meshy_token');
  const headers = {};
  if (stored.meshy_token) headers.Authorization = `Bearer ${stored.meshy_token}`;

  const response = await fetch(url, {
    credentials: 'include',
    headers
  });
  if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
  return response.arrayBuffer();
}

function safeFilename(value, fallback = 'modelo') {
  const normalized = String(value || fallback).replace(/[^a-zA-Z0-9._-]/g, '_');
  return normalized.replace(/^\.+/, '').slice(0, 100) || fallback;
}

async function decryptAndDownload(modelInput, filename, requestId, targetFormat = 'glb') {
  try {
    await initDecryptWorker();

    const parts = Array.isArray(modelInput) ? modelInput : [{ url: modelInput, filename: filename }];

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const currentUrl = part.url || part;
      
      const ext = targetFormat === 'obj' ? '.obj' : (targetFormat === 'stl' ? '.stl' : '.glb');
      const baseName = safeFilename((part.filename || filename).replace(/\.(glb|obj|stl|meshy)$/i, ''));
      const currentFilename = parts.length > 1 ? `${baseName}_parte_${i + 1}${ext}` : `${baseName}${ext}`;

      chrome.runtime.sendMessage({ action: 'decryptStatus', requestId, status: `fetching (${i + 1}/${parts.length})` });

      let rawBuffer = await fetchModelBuffer(currentUrl);

      // Some Meshy tasks already provide a GLB. Sending it through the
      // proprietary decoder can turn a valid file into an invalid payload.
      if (!isGlbBuffer(rawBuffer) && decryptWorker && workerReady) {
        chrome.runtime.sendMessage({ action: 'decryptStatus', requestId, status: `decrypting (${i + 1}/${parts.length})` });
        const id = ++opCounter;
        rawBuffer = await new Promise((resolve, reject) => {
          pendingOps[id] = { resolve, reject };
          decryptWorker.postMessage({ id, type: 'process', data: rawBuffer }, [rawBuffer]);
        });
      }

      const glbData = ensureArrayBuffer(rawBuffer);
      await processAndSaveBlob(glbData, targetFormat, currentFilename);
    }

    chrome.runtime.sendMessage({ action: 'decryptStatus', requestId, status: 'done' });
  } catch (err) {
    console.error('[Meshy DL] Error general:', err);
    chrome.runtime.sendMessage({ action: 'decryptStatus', requestId, status: 'error', error: err.message });
    alert('Error al descargar: ' + err.message);
  }
}

// ===== CONVERSION & DOWNLOAD UTILS =====
async function processAndSaveBlob(glbData, targetFormat, currentFilename) {
  const buffer = ensureArrayBuffer(glbData);
  const view = new DataView(buffer);
  
  const magic = view.getUint32(0, true);
  if (magic !== 0x46544C67) {
    throw new Error('El archivo descargado sigue cifrado. Asegúrate de hacer clic en el modelo 3D en Meshy para generar las credenciales WASM.');
  }

  try {
    const geometry = parseGLBGeometry(buffer);

    if (!geometry || geometry.positions.length === 0) {
      throw new Error('No se pudieron extraer vértices del modelo.');
    }

    let finalBlob;
    if (targetFormat === 'obj') {
      finalBlob = convertGeometryToOBJ(geometry);
    } else if (targetFormat === 'stl') {
      finalBlob = convertGeometryToSTL(geometry);
    } else {
      finalBlob = new Blob([buffer], { type: 'model/gltf-binary' });
    }

    triggerDownload(finalBlob, currentFilename);
  } catch (e) {
    console.error('[Meshy DL] Error al procesar geometría:', e);
    throw e;
  }
}

function parseGLBGeometry(inputBuffer) {
  const arrayBuffer = ensureArrayBuffer(inputBuffer);
  const dataView = new DataView(arrayBuffer);
  if (arrayBuffer.byteLength < 20) throw new Error('El archivo GLB está incompleto.');

  const magic = dataView.getUint32(0, true);
  if (magic !== 0x46544C67) throw new Error('El archivo no es un GLB válido.');
  const version = dataView.getUint32(4, true);
  const declaredLength = dataView.getUint32(8, true);
  if (version !== 2 || declaredLength > arrayBuffer.byteLength || declaredLength < 20) {
    throw new Error('La cabecera GLB no es válida.');
  }

  const jsonChunkLength = dataView.getUint32(12, true);
  const jsonChunkType = dataView.getUint32(16, true);
  if (jsonChunkType !== 0x4E4F534A || 20 + jsonChunkLength > declaredLength) throw new Error('Estructura GLB inválida.');

  const decoder = new TextDecoder('utf-8');
  const jsonBytes = new Uint8Array(arrayBuffer, 20, jsonChunkLength);
  const gltf = JSON.parse(decoder.decode(jsonBytes));

  const binHeaderOffset = 20 + jsonChunkLength;
  if (binHeaderOffset + 8 > declaredLength) throw new Error('Offset binario fuera de rango.');

  const binChunkLength = dataView.getUint32(binHeaderOffset, true);
  const binChunkType = dataView.getUint32(binHeaderOffset + 4, true);
  if (binChunkType !== 0x004E4942) throw new Error('Bloque binario no encontrado.');

  const binBufferOffset = binHeaderOffset + 8;
  const binBufferEnd = binBufferOffset + binChunkLength;
  if (binBufferEnd > declaredLength || binBufferEnd > arrayBuffer.byteLength) throw new Error('Bloque binario fuera de rango.');

  let allPositions = [];
  let allIndices = [];
  let vertexOffset = 0;

  for (const mesh of gltf.meshes || []) {
    for (const primitive of mesh.primitives || []) {
      if (primitive.attributes.POSITION === undefined) continue;
      if (primitive.mode !== undefined && primitive.mode !== 4) continue;

      const posAccessor = gltf.accessors[primitive.attributes.POSITION];
      const posBufferView = posAccessor ? gltf.bufferViews[posAccessor.bufferView] : null;
      if (!posAccessor || !posBufferView || posAccessor.type !== 'VEC3' || posAccessor.componentType !== 5126) {
        throw new Error('El modelo contiene posiciones incompatibles.');
      }

      const posStride = posBufferView.byteStride || 12;
      const posStart = binBufferOffset + (posBufferView.byteOffset || 0) + (posAccessor.byteOffset || 0);
      const posEnd = posStart + (posAccessor.count - 1) * posStride + 12;
      if (posStart < binBufferOffset || posEnd > binBufferEnd) throw new Error('Posiciones fuera de rango.');
      for (let i = 0; i < posAccessor.count; i++) {
        const offset = posStart + i * posStride;
        allPositions.push(dataView.getFloat32(offset, true), dataView.getFloat32(offset + 4, true), dataView.getFloat32(offset + 8, true));
      }

      if (primitive.indices !== undefined) {
        const idxAccessor = gltf.accessors[primitive.indices];
        const idxBufferView = idxAccessor ? gltf.bufferViews[idxAccessor.bufferView] : null;
        if (!idxAccessor || !idxBufferView || ![5121, 5123, 5125].includes(idxAccessor.componentType)) throw new Error('Índices incompatibles.');
        if (idxAccessor.count % 3 !== 0) throw new Error('El modelo contiene una cantidad de índices inválida.');
        const componentSize = idxAccessor.componentType === 5125 ? 4 : (idxAccessor.componentType === 5123 ? 2 : 1);
        const idxStride = idxBufferView.byteStride || componentSize;
        const idxStart = binBufferOffset + (idxBufferView.byteOffset || 0) + (idxAccessor.byteOffset || 0);
        const idxEnd = idxStart + (idxAccessor.count - 1) * idxStride + componentSize;
        if (idxStart < binBufferOffset || idxEnd > binBufferEnd) throw new Error('Índices fuera de rango.');
        for (let i = 0; i < idxAccessor.count; i++) {
          const offset = idxStart + i * idxStride;
          const index = idxAccessor.componentType === 5125 ? dataView.getUint32(offset, true)
            : (idxAccessor.componentType === 5123 ? dataView.getUint16(offset, true) : dataView.getUint8(offset));
          if (index >= posAccessor.count) throw new Error('Índice de vértice fuera de rango.');
          allIndices.push(index + vertexOffset);
        }
      } else {
        if (posAccessor.count % 3 !== 0) throw new Error('El modelo contiene una cantidad de vértices inválida.');
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

  for (let i = 0; i + 2 < idx.length; i += 3) {
    output += `f ${idx[i] + 1} ${idx[i + 1] + 1} ${idx[i + 2] + 1}\n`;
  }

  return new Blob([output], { type: 'text/plain;charset=utf-8' });
}

function convertGeometryToSTL(geometry) {
  const pos = geometry.positions;
  const idx = geometry.indices;
  const triangleCount = Math.floor(idx.length / 3);

  const bufferSize = 80 + 4 + triangleCount * 50;
  const buffer = new ArrayBuffer(bufferSize);
  const view = new DataView(buffer);

  let offset = 80;
  view.setUint32(offset, triangleCount, true);
  offset += 4;

  for (let i = 0; i + 2 < idx.length; i += 3) {
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

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'decryptAndDownload') {
    console.log('[Meshy DL] Received decrypt request:', request.requestId);
    
    const payload = (request.parts && request.parts.length > 0) ? request.parts : request.modelUrl;
    const targetFormat = request.targetFormat || 'glb';
    
    decryptAndDownload(payload, request.filename, request.requestId, targetFormat);
    sendResponse({ success: true });
  }
});