// background.js

const API_ORIGIN = 'https://api.meshy.ai';
const ALLOWED_DOWNLOAD_HOSTS = new Set(['api.meshy.ai', 'assets.meshy.ai', 'cdn.meshy.ai']);
const MAX_TASK_PAGES = 20;
const MAX_TASKS = 500;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !request || typeof request.action !== 'string') return;

  if (request.action === 'saveToken') {
    if (isMeshySender(sender) && isValidToken(request.token)) {
      chrome.storage.local.set({ meshy_token: request.token });
    }
    return;
  }

  if (request.action === 'saveWasmAuth') {
    if (isMeshySender(sender) && isValidWasmAuth(request.auth)) {
      chrome.storage.session.set({ meshy_wasm_auth: request.auth });
    }
    return;
  }

  if (request.action === 'getTasks') {
    getTasks().then(tasks => {
      sendResponse({ success: true, tasks: tasks });
    }).catch(error => {
      console.error('Error getTasks:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (request.action === 'downloadModel') {
    downloadModel(request.taskId, request.modelUrl, request.filename, request.parts, request.targetFormat, request.modelUrls)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'downloadTexture') {
    downloadTexture(request.taskId, request.textureUrl, request.filename)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'downloadAllTextures') {
    downloadAllTextures(request.taskId, request.textures, request.taskName)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
});

function isMeshySender(sender) {
  return Boolean(sender.tab?.url && isMeshyPage(sender.tab.url));
}

function isMeshyPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'meshy.ai' || url.hostname === 'www.meshy.ai');
  } catch (error) {
    return false;
  }
}

function isValidToken(token) {
  return typeof token === 'string' && token.length >= 20 && token.length <= 4096;
}

function isValidWasmAuth(auth) {
  return auth && typeof auth.hostname === 'string' && auth.hostname.length <= 255
    && typeof auth.signature === 'string' && auth.signature.length <= 4096
    && Number.isFinite(auth.timestamp);
}

function isAllowedUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ALLOWED_DOWNLOAD_HOSTS.has(url.hostname);
  } catch (error) {
    return false;
  }
}

function safeFilename(value, fallback = 'modelo') {
  const normalized = String(value || fallback).replace(/[^a-zA-Z0-9._-]/g, '_');
  return normalized.replace(/^\.+/, '').slice(0, 100) || fallback;
}

function isDirectCdnUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (
      ['assets.meshy.ai', 'cdn.meshy.ai'].includes(url.hostname)
      || (url.hostname === 'api.meshy.ai' && url.pathname.startsWith('/misc/cdn-models/'))
    );
  } catch (error) {
    return false;
  }
}

async function getTasks() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get('meshy_token', async (result) => {
      const token = result.meshy_token;

      if (!token) {
        reject(new Error('Token no encontrado. Asegúrate de estar en meshy.ai y haber cargado la página.'));
        return;
      }

      const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      };

      try {
        let allRootTasks = [];
        let pageNum = 1;
        const pageSize = 50;
        let hasMore = true;

        while (hasMore && pageNum <= MAX_TASK_PAGES && allRootTasks.length < MAX_TASKS) {
          const url = `https://api.meshy.ai/web/v2/tasks/?sortBy=-created_at&pageNum=${pageNum}&pageSize=${pageSize}`;
          const response = await fetch(url, { method: 'GET', headers });

          if (!response.ok) {
            if (response.status === 401) await chrome.storage.local.remove('meshy_token');
            throw new Error(`Error API: ${response.status} - ${response.statusText}`);
          }

          const data = await response.json();
          let tasksList = extractTasksList(data);

          if (tasksList.length === 0) {
            hasMore = false;
          } else {
            allRootTasks = allRootTasks.concat(tasksList.slice(0, MAX_TASKS - allRootTasks.length));
            hasMore = tasksList.length >= pageSize;
            pageNum++;
          }
        }

        allRootTasks = allRootTasks.filter(t => !t.rootId || t.rootId === t.id);

        const finalTasks = await Promise.all(allRootTasks.slice(0, MAX_TASKS).map(async (rootTask) => {
          try {
            const relatedUrl = `https://api.meshy.ai/web/v2/tasks/${rootTask.id}/related?sortBy=-created_at&pageNum=1&pageSize=20`;
            const relRes = await fetch(relatedUrl, { method: 'GET', headers });

            if (relRes.ok) {
              const relData = await relRes.json();
              const relatedTasks = extractTasksList(relData);

              if (relatedTasks.length > 0) {
                const bestTask = relatedTasks.find(t => t.status === 'SUCCEEDED' && (t.part_count > 1 || t.model_urls?.glb))
                  || relatedTasks.find(t => t.phase === 'texture' && t.status === 'SUCCEEDED')
                  || relatedTasks.find(t => t.phase === 'generate' && t.status === 'SUCCEEDED')
                  || relatedTasks.find(t => t.status === 'SUCCEEDED')
                  || relatedTasks[0];

                return mapTask(bestTask, rootTask);
              }
            }
          } catch (e) {
            console.warn(`[Meshy] Failed to fetch related for ${rootTask.id}:`, e.message);
          }

          return mapTask(rootTask);
        }));

        const filteredTasks = finalTasks
          .filter(task => task.modelUrl || (task.parts && task.parts.length > 0))
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        console.log(`[Meshy] ${filteredTasks.length} downloadable models found`);
        resolve(filteredTasks);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function extractTasksList(data) {
  if (Array.isArray(data)) return data;
  if (data.result && Array.isArray(data.result)) return data.result;
  if (data.data && Array.isArray(data.data)) return data.data;
  if (data.tasks && Array.isArray(data.tasks)) return data.tasks;
  return [];
}

function getModelUrls(task) {
  const sources = [
    task?.model_urls,
    task?.result?.model_urls,
    task?.result?.generate?.model_urls,
    task?.result?.texture?.model_urls,
    task?.result?.draft?.model_urls
  ];

  return sources.find(source => source && typeof source === 'object' && (source.glb || source.gltf || source.obj || source.stl))
    || sources.find(source => source && typeof source === 'object')
    || {};
}

function mapTask(task, rootTask) {
  const prompt = task.args?.draft?.prompt || task.args?.texture?.prompt || task.prompt || rootTask?.args?.draft?.prompt || '';
  const texSet = task.result?.texture?.textureUrls?.[0] || {};
  const modelUrls = getModelUrls(task);
  const rootModelUrls = getModelUrls(rootTask);
  
  // Extraer partes ya sea en Array u Objetos clave-valor
  const rawParts = task.result?.parts || task.result?.sub_models || task.result?.split_parts || task.result?.children || task.result?.model_urls || task.parts || task.sub_models || [];
  
  let parts = [];
  if (Array.isArray(rawParts)) {
    parts = rawParts.map((p, idx) => ({
      url: p.modelUrl || p.model_url || p.url || p,
      filename: p.name ? `${p.name}.glb` : `parte_${idx + 1}.glb`
    }));
  } else if (rawParts && typeof rawParts === 'object') {
    parts = Object.entries(rawParts).map(([key, val], idx) => ({
      url: (typeof val === 'object' ? (val.modelUrl || val.model_url || val.url) : val),
      filename: `${key || 'parte_' + (idx + 1)}.glb`
    }));
  }

  const modelUrl = modelUrls.glb || modelUrls.gltf || rootModelUrls.glb || rootModelUrls.gltf || task.result?.texture?.modelUrl || task.result?.generate?.modelUrl || task.result?.draft?.modelUrl || task.result?.stylize?.modelUrl || task.model_url || task.modelUrl || '';

  return {
    id: task.id,
    title: task.name || prompt || 'Modelo 3D',
    status: task.status,
    modelUrl: modelUrl,
    modelUrls: modelUrls,
    parts: parts,
    partCount: Number(task.part_count || task.result?.part_count || rootTask?.part_count || 0),
    createdAt: task.created_at || task.createdAt,
    prompt: prompt,
    imageUrl: task.result?.previewUrl || rootTask?.result?.previewUrl || '',
    textures: {
      colorMapUrl: texSet.colorMapUrl || '',
      metallicMapUrl: texSet.metallicMapUrl || '',
      roughnessMapUrl: texSet.roughnessMapUrl || '',
      normalMapUrl: texSet.normalMapUrl || ''
    },
    quadJsonUrl: task.result?.texture?.quadJsonUrl || task.result?.generate?.quadJsonUrl || '',
    triangleCount: task.triangleCount || task.faceCount || 0,
    vertexCount: task.vertexCount || 0,
    faceCount: task.faceCount || 0
  };
}

async function downloadModel(taskId, modelUrl, filename, parts, targetFormat = 'obj', modelUrls = null) {
  const hasParts = parts && Array.isArray(parts) && parts.length > 0;
  const safeFormat = ['glb', 'obj', 'stl'].includes(targetFormat) ? targetFormat : 'glb';
  const nativeFormatUrl = modelUrls?.[safeFormat] || '';
  const candidates = hasParts ? parts.map(part => part?.url) : [modelUrl];
  if (!candidates.every(isAllowedUrl)) throw new Error('La URL del modelo no pertenece a un dominio Meshy permitido.');

  if (!hasParts && nativeFormatUrl && isAllowedUrl(nativeFormatUrl) && isDirectCdnUrl(nativeFormatUrl)) {
    const extension = safeFormat === 'glb' ? 'glb' : safeFormat;
    await chrome.downloads.download({
      url: nativeFormatUrl,
      filename: `meshy_models/${safeFilename(filename)}.${extension}`,
      saveAs: true
    });
    return;
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true, url: ['https://meshy.ai/*', 'https://www.meshy.ai/*'] });
  if (tabs.length === 0) {
    throw new Error('Abre una pestaña activa de Meshy.ai para descargar el modelo.');
  }

  const ext = safeFormat === 'stl' ? '.stl' : (safeFormat === 'glb' ? '.glb' : '.obj');
  const baseFilename = safeFilename(filename?.replace(/\.(meshy|glb|obj|stl)$/i, ''));
  const outFilename = `${baseFilename}${ext}`;

  try {
    await chrome.tabs.sendMessage(tabs[0].id, {
      action: 'decryptAndDownload',
      modelUrl: modelUrl,
      parts: hasParts ? parts : null,
      filename: outFilename,
      targetFormat: safeFormat,
      requestId: taskId
    });
  } catch (error) {
    if (error.message?.includes('Receiving end does not exist')) {
      throw new Error('Meshy necesita recargarse para conectar la extensión. Pulsa Ctrl+F5 en la pestaña de Meshy y vuelve a intentarlo.');
    }
    throw error;
  }
}

async function downloadTexture(taskId, textureUrl, filename) {
  if (!isAllowedUrl(textureUrl)) throw new Error('La URL de textura no pertenece a un dominio Meshy permitido.');
  await chrome.downloads.download({
    url: textureUrl,
    filename: `meshy_models/${safeFilename(filename || taskId)}_texture.png`,
    saveAs: true
  });
}

async function downloadAllTextures(taskId, textures, taskName) {
  if (!textures || typeof textures !== 'object') throw new Error('No hay texturas válidas para descargar.');
  const safeName = safeFilename(taskName || taskId).substring(0, 50);
  const maps = [
    { url: textures.colorMapUrl, suffix: 'color' },
    { url: textures.metallicMapUrl, suffix: 'metallic' },
    { url: textures.roughnessMapUrl, suffix: 'roughness' },
    { url: textures.normalMapUrl, suffix: 'normal' }
  ];

  const downloads = maps.filter(({ url }) => isAllowedUrl(url)).map(({ url, suffix }) => {
      return chrome.downloads.download({
        url: url,
        filename: `meshy_models/${safeName}_${suffix}.png`,
        saveAs: false
      });
  });
  if (downloads.length === 0) throw new Error('No se encontraron texturas Meshy válidas.');
  await Promise.all(downloads);
}