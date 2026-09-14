// content.js

// ===== TOKEN EXTRACTION FROM COOKIES =====
function extractTokenFromCookies() {
  let token = null;
  try {
    const cookies = document.cookie.split(';');
    let authTokenPart0 = null;
    let authTokenPart1 = null;

    for (let cookie of cookies) {
      const separator = cookie.indexOf('=');
      if (separator < 0) continue;
      const name = cookie.slice(0, separator);
      const value = cookie.slice(separator + 1);
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

function findAccessToken(value) {
  if (!value || typeof value !== 'object') return '';
  if (typeof value.access_token === 'string') return value.access_token;
  for (const child of Object.values(value)) {
    const token = findAccessToken(child);
    if (token) return token;
  }
  return '';
}

function extractTokenFromStorage() {
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index) || '';
      const value = localStorage.getItem(key);
      if (!value || (!key.includes('auth') && !key.includes('token') && !key.includes('supabase'))) continue;
      try {
        const token = findAccessToken(JSON.parse(value));
        if (token) return token;
      } catch (error) {
        // Ignore non-JSON storage entries.
      }
    }
  } catch (error) {
    console.warn('[Meshy DL] Could not inspect local session storage');
  }
  return '';
}

function extractCurrentToken() {
  return extractTokenFromCookies() || extractTokenFromStorage();
}

function saveToken(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 4096) return;
  return chrome.runtime.sendMessage({ action: 'saveToken', token }).catch(() => {});
}

setTimeout(() => {
  const token = extractCurrentToken();
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
    if (!auth.hostname || !auth.signature || (typeof auth.timestamp !== 'number' && typeof auth.timestamp !== 'string')) return;
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

async function restoreWasmAuth() {
  if (wasmAuth) return;

  const stored = await chrome.storage.session.get('meshy_wasm_auth');
  const auth = stored.meshy_wasm_auth;
  if (auth?.hostname && auth?.signature && Number.isFinite(Number(auth.timestamp))) {
    wasmAuth = auth;
  }
}

function initDecryptWorker() {
  return new Promise((resolve, reject) => {
    if (decryptWorker) decryptWorker.terminate();
    decryptWorker = null;
    workerReady = false;

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
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 4) return false;
  const bytes = new Uint8Array(buffer, 0, 4);
  return bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46;
}

async function fetchModelBuffer(url) {
  const parsedUrl = new URL(url);
  const isApiDownload = parsedUrl.hostname === 'api.meshy.ai';
  const requestOptions = { credentials: 'omit', cache: 'no-store' };

  if (isApiDownload) {
    const stored = await chrome.storage.local.get('meshy_token');
    if (stored.meshy_token) {
      requestOptions.headers = { Authorization: `Bearer ${stored.meshy_token}` };
    }
  }

  // API model proxies may require the bearer token; public CDN URLs must stay
  // credential-free to avoid a rejected CORS preflight.
  const response = await fetch(parsedUrl.href, requestOptions);
  if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
  return response.arrayBuffer();
}

function safeFilename(value, fallback = 'modelo') {
  const normalized = String(value || fallback).replace(/[^a-zA-Z0-9._-]/g, '_');
  return normalized.replace(/^\.+/, '').slice(0, 100) || fallback;
}

function processWithWorker(inputBuffer, mode = 'default') {
  const id = ++opCounter;
  return new Promise((resolve, reject) => {
    pendingOps[id] = { resolve, reject };
    decryptWorker.postMessage({ id, type: 'process', mode, data: inputBuffer }, [inputBuffer]);
  });
}

function describeBuffer(data) {
  const buffer = ensureArrayBuffer(data);
  if (!(buffer instanceof ArrayBuffer)) return 'respuesta no binaria';
  const bytes = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
  const signature = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(' ');
  return `${buffer.byteLength} bytes (firma: ${signature || 'vacía'})`;
}

async function decryptAndDownload(modelInput, filename, requestId, targetFormat = 'glb', partCount = 0) {
  try {
    await restoreWasmAuth();

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
      if (!isGlbBuffer(rawBuffer)) {
        if (!decryptWorker || !workerReady) await initDecryptWorker();
        chrome.runtime.sendMessage({ action: 'decryptStatus', requestId, status: `decrypting (${i + 1}/${parts.length})` });
        const originalBuffer = rawBuffer.slice(0);
        rawBuffer = await processWithWorker(rawBuffer, 'default');

        // Textured/postprocessed models use Meshy's texture-editor decoder.
        // Keep the normal route first for older model versions.
        if (!isGlbBuffer(rawBuffer)) {
          rawBuffer = await processWithWorker(originalBuffer, 'texture-editor');
        }
      }

      const glbData = ensureArrayBuffer(rawBuffer);
      await processAndSaveBlob(glbData, targetFormat, currentFilename, partCount);
    }

    chrome.runtime.sendMessage({ action: 'decryptStatus', requestId, status: 'done' });
  } catch (err) {
    console.error('[Meshy DL] Error general:', err);
    chrome.runtime.sendMessage({ action: 'decryptStatus', requestId, status: 'error', error: err.message });
    alert('Error al descargar: ' + err.message);
  }
}

// ===== CONVERSION & DOWNLOAD UTILS =====
async function processAndSaveBlob(glbData, targetFormat, currentFilename, partCount = 0) {
  const buffer = ensureArrayBuffer(glbData);
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 4) {
    throw new Error(`Meshy devolvió una respuesta inválida: ${describeBuffer(buffer)}.`);
  }
  if (!isGlbBuffer(buffer)) {
    throw new Error(`Meshy no devolvió un GLB después del descifrado: ${describeBuffer(buffer)}.`);
  }

  if (targetFormat === 'glb') {
    triggerDownload(new Blob([buffer], { type: 'model/gltf-binary' }), currentFilename);
    return;
  }

  try {
    const meshCount = getGLBMeshCount(buffer);
    const shouldSplit = meshCount > 1;
    if (shouldSplit) {
      const extension = targetFormat === 'obj' ? '.obj' : '.stl';
      const baseName = currentFilename.replace(/\.(obj|stl)$/i, '');
      let savedParts = 0;
      for (let meshIndex = 0; meshIndex < meshCount; meshIndex++) {
        const meshGeometry = parseGLBGeometry(buffer, meshIndex);
        if (meshGeometry.positions.length > 0) {
          const partName = `${baseName}_parte_${meshIndex + 1}${extension}`;
          const partBlob = targetFormat === 'obj'
            ? convertGeometryToOBJ(meshGeometry)
            : convertGeometryToSTL(meshGeometry);
          triggerDownload(partBlob, partName);
          savedParts++;
        }
      }
      if (savedParts > 0) return;
    }

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

function getGLBMeshCount(inputBuffer) {
  const arrayBuffer = ensureArrayBuffer(inputBuffer);
  const dataView = new DataView(arrayBuffer);
  const jsonChunkLength = dataView.getUint32(12, true);
  const jsonBytes = new Uint8Array(arrayBuffer, 20, jsonChunkLength);
  const gltf = JSON.parse(new TextDecoder('utf-8').decode(jsonBytes));
  return (gltf.meshes || []).reduce((count, mesh) => count + (mesh.primitives || [])
    .filter(primitive => primitive.attributes?.POSITION !== undefined).length, 0);
}

function getComponentSize(componentType) {
  if (componentType === 5120 || componentType === 5121) return 1;
  if (componentType === 5122 || componentType === 5123) return 2;
  if (componentType === 5125 || componentType === 5126) return 4;
  throw new Error('Tipo de componente glTF no compatible.');
}

function readComponent(dataView, offset, componentType) {
  if (componentType === 5120) return dataView.getInt8(offset);
  if (componentType === 5121) return dataView.getUint8(offset);
  if (componentType === 5122) return dataView.getInt16(offset, true);
  if (componentType === 5123) return dataView.getUint16(offset, true);
  if (componentType === 5125) return dataView.getUint32(offset, true);
  return dataView.getFloat32(offset, true);
}

function parseGLBGeometry(inputBuffer, selectedMeshIndex = null) {
  const arrayBuffer = ensureArrayBuffer(inputBuffer);
  const dataView = new DataView(arrayBuffer);
  if (arrayBuffer.byteLength < 20) throw new Error('El archivo GLB está incompleto.');

  if (!isGlbBuffer(arrayBuffer)) throw new Error('El archivo no es un GLB válido.');
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

  let geometryIndex = 0;
  for (let meshIndex = 0; meshIndex < (gltf.meshes || []).length; meshIndex++) {
    const mesh = gltf.meshes[meshIndex];
    for (const primitive of mesh.primitives || []) {
      if (primitive.attributes.POSITION === undefined) continue;
      const currentGeometryIndex = geometryIndex++;
      if (selectedMeshIndex !== null && currentGeometryIndex !== selectedMeshIndex) continue;
      if (primitive.mode !== undefined && primitive.mode !== 4) continue;

      const posAccessor = gltf.accessors[primitive.attributes.POSITION];
      const posBufferView = posAccessor ? gltf.bufferViews[posAccessor.bufferView] : null;
      if (!posAccessor || !posBufferView || posAccessor.type !== 'VEC3'
        || ![5120, 5121, 5122, 5123, 5125, 5126].includes(posAccessor.componentType)) {
        throw new Error('El modelo contiene posiciones incompatibles.');
      }

      const positionComponentSize = getComponentSize(posAccessor.componentType);
      const positionElementSize = positionComponentSize * 3;
      const posStride = posBufferView.byteStride || positionElementSize;
      const posStart = binBufferOffset + (posBufferView.byteOffset || 0) + (posAccessor.byteOffset || 0);
      const posEnd = posStart + (posAccessor.count - 1) * posStride + positionElementSize;
      if (posStart < binBufferOffset || posEnd > binBufferEnd) throw new Error('Posiciones fuera de rango.');
      for (let i = 0; i < posAccessor.count; i++) {
        const offset = posStart + i * posStride;
        allPositions.push(
          readComponent(dataView, offset, posAccessor.componentType),
          readComponent(dataView, offset + positionComponentSize, posAccessor.componentType),
          readComponent(dataView, offset + positionComponentSize * 2, posAccessor.componentType)
        );
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
  if (request.action === 'ping') {
    sendResponse({ success: true });
    return;
  }

  if (request.action === 'decryptAndDownload') {
    console.log('[Meshy DL] Received decrypt request:', request.requestId);
    
    const payload = (request.parts && request.parts.length > 0) ? request.parts : request.modelUrl;
    const targetFormat = request.targetFormat || 'glb';
    const partCount = Number(request.partCount) || 0;
    
    decryptAndDownload(payload, request.filename, request.requestId, targetFormat, partCount);
    sendResponse({ success: true });
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action !== 'refreshToken') return;
  const token = extractCurrentToken();
  if (!token) {
    sendResponse({ success: false });
    return;
  }
  saveToken(token).then(() => sendResponse({ success: true }));
  return true;
});