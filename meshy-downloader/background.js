// background.js

let wasmAuth = null;
let tasksCache = [];

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'saveToken') {
    chrome.storage.local.set({ meshy_token: request.token });
  }

  if (request.action === 'saveWasmAuth') {
    wasmAuth = request.auth;
    console.log('✓ WASM auth credentials stored in background');
  }

  if (request.action === 'getTasks') {
    getTasks().then(tasks => {
      tasksCache = tasks;
      sendResponse({ success: true, tasks: tasks });
    }).catch(error => {
      console.error('Error getTasks:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (request.action === 'downloadModel') {
    downloadModel(request.taskId, request.modelUrl, request.filename, request.parts, request.targetFormat);
  }

  if (request.action === 'downloadTexture') {
    downloadTexture(request.taskId, request.textureUrl, request.filename);
  }

  if (request.action === 'downloadAllTextures') {
    downloadAllTextures(request.taskId, request.textures, request.taskName);
  }
});

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

        while (hasMore) {
          const url = `https://api.meshy.ai/web/v2/tasks/?sortBy=-created_at&pageNum=${pageNum}&pageSize=${pageSize}`;
          const response = await fetch(url, { method: 'GET', headers });

          if (!response.ok) {
            throw new Error(`Error API: ${response.status} - ${response.statusText}`);
          }

          const data = await response.json();
          let tasksList = extractTasksList(data);

          if (tasksList.length === 0) {
            hasMore = false;
          } else {
            allRootTasks = allRootTasks.concat(tasksList);
            hasMore = tasksList.length >= pageSize;
            pageNum++;
          }
        }

        allRootTasks = allRootTasks.filter(t => !t.rootId || t.rootId === t.id);

        const finalTasks = await Promise.all(allRootTasks.map(async (rootTask) => {
          try {
            const relatedUrl = `https://api.meshy.ai/web/v2/tasks/${rootTask.id}/related?sortBy=-created_at&pageNum=1&pageSize=20`;
            const relRes = await fetch(relatedUrl, { method: 'GET', headers });

            if (relRes.ok) {
              const relData = await relRes.json();
              const relatedTasks = extractTasksList(relData);

              if (relatedTasks.length > 0) {
                const bestTask = relatedTasks.find(t => t.phase === 'texture' && t.status === 'SUCCEEDED')
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

function mapTask(task, rootTask) {
  const prompt = task.args?.draft?.prompt || task.args?.texture?.prompt || task.prompt || rootTask?.args?.draft?.prompt || '';
  const texSet = task.result?.texture?.textureUrls?.[0] || {};
  
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

  const modelUrl = task.result?.texture?.modelUrl || task.result?.generate?.modelUrl || task.result?.draft?.modelUrl || task.result?.stylize?.modelUrl || task.model_url || task.modelUrl || '';

  return {
    id: task.id,
    title: task.name || prompt || 'Modelo 3D',
    status: task.status,
    modelUrl: modelUrl,
    parts: parts,
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

async function downloadModel(taskId, modelUrl, filename, parts, targetFormat = 'obj') {
  const hasParts = parts && Array.isArray(parts) && parts.length > 0;
  
  // Siempre enviamos al content.js para desencriptar el buffer del worker y procesar a OBJ/STL
  const tabs = await chrome.tabs.query({ url: ['https://meshy.ai/*', 'https://www.meshy.ai/*'] });
  if (tabs.length === 0) {
    console.error('No meshy.ai tab found for download/conversion');
    return;
  }

  const ext = targetFormat === 'stl' ? '.stl' : (targetFormat === 'glb' ? '.glb' : '.obj');
  const baseFilename = filename ? filename.replace(/\.(meshy|glb|obj|stl)$/i, '') : 'modelo';
  const outFilename = `${baseFilename}${ext}`;

  chrome.tabs.sendMessage(tabs[0].id, {
    action: 'decryptAndDownload',
    modelUrl: modelUrl,
    parts: hasParts ? parts : null,
    filename: outFilename,
    targetFormat: targetFormat, // 'obj' o 'stl'
    requestId: taskId
  });
}

function downloadTexture(taskId, textureUrl, filename) {
  chrome.downloads.download({
    url: textureUrl,
    filename: `meshy_models/${filename || taskId}_texture.png`,
    saveAs: true
  });
}

function downloadAllTextures(taskId, textures, taskName) {
  const safeName = (taskName || taskId).replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
  const maps = [
    { url: textures.colorMapUrl, suffix: 'color' },
    { url: textures.metallicMapUrl, suffix: 'metallic' },
    { url: textures.roughnessMapUrl, suffix: 'roughness' },
    { url: textures.normalMapUrl, suffix: 'normal' }
  ];

  maps.forEach(({ url, suffix }) => {
    if (url) {
      chrome.downloads.download({
        url: url,
        filename: `meshy_models/${safeName}_${suffix}.png`,
        saveAs: false
      });
    }
  });
}