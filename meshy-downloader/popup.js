const loadTasksButton = document.getElementById('loadTasks');
const statusDiv = document.getElementById('status');
const tasksList = document.getElementById('tasksList');
const formatSelect = document.getElementById('formatSelect');

loadTasksButton.addEventListener('click', loadTasks);

chrome.runtime.onMessage.addListener((request) => {
  if (request.action !== 'decryptStatus') return;

  const button = document.querySelector(`[data-id="${CSS.escape(String(request.requestId))}"]`);
  if (!button) return;

  if (request.status.startsWith('fetching')) {
    setButtonState(button, '📥', request.status);
  } else if (request.status.startsWith('decrypting')) {
    setButtonState(button, '🔓', request.status);
  } else if (request.status === 'done') {
    setButtonState(button, '✅', 'Completado');
  } else if (request.status === 'error') {
    setButtonState(button, '❌', 'Error');
    button.title = request.error || 'La descarga falló';
    button.disabled = false;
  }
});

function setStatus(icon, message, state = '') {
  statusDiv.replaceChildren();
  const iconElement = document.createElement('span');
  iconElement.className = 'status-icon';
  iconElement.textContent = icon;
  iconElement.setAttribute('aria-hidden', 'true');
  const textElement = document.createElement('span');
  textElement.className = 'status-text';
  textElement.textContent = message;
  statusDiv.append(iconElement, textElement);
  statusDiv.className = `status-box ${state}`.trim();
}

function setButtonState(button, icon, text) {
  const iconElement = button.querySelector('.download-icon');
  const textElement = button.querySelector('.download-text');
  if (iconElement) iconElement.textContent = icon;
  if (textElement) textElement.textContent = text;
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function loadTasks() {
  loadTasksButton.disabled = true;
  setStatus('⏳', 'Cargando tus modelos...', 'loading');
  tasksList.replaceChildren();

  try {
    const response = await sendMessage({ action: 'getTasks' });
    if (!response?.success) throw new Error(response?.error || 'No se encontraron modelos.');

    setStatus('✓', `${response.tasks.length} modelo(s) encontrado(s)`, 'success');
    displayTasks(response.tasks);
  } catch (error) {
    setStatus('❌', error.message || 'No se pudieron cargar los modelos.', 'error');
  } finally {
    loadTasksButton.disabled = false;
  }
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function createIcon(text) {
  const icon = createElement('span', 'download-icon', text);
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

function isSafeImageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['api.meshy.ai', 'assets.meshy.ai', 'cdn.meshy.ai'].includes(url.hostname);
  } catch (error) {
    return false;
  }
}

function displayTasks(tasks) {
  tasksList.replaceChildren();

  tasks.forEach((task) => {
    const card = createElement('article', 'task-card');
    const header = createElement('div', 'task-header');

    if (isSafeImageUrl(task.imageUrl)) {
      const image = createElement('img', 'task-image');
      image.src = task.imageUrl;
      image.alt = 'Vista previa del modelo';
      image.loading = 'lazy';
      header.appendChild(image);
    }

    const headerContent = createElement('div', 'task-header-content');
    const title = task.prompt && task.prompt.length < 25 ? task.prompt : (task.title || 'Modelo 3D');
    headerContent.appendChild(createElement('h2', 'task-title', title));
    headerContent.appendChild(createElement('span', `status-badge ${String(task.status || '').toLowerCase()}`, task.status || 'Desconocido'));
    header.appendChild(headerContent);
    card.appendChild(header);

    const meta = createElement('div', 'task-meta');
    if (task.faceCount || task.vertexCount || task.triangleCount) {
      const values = [
        task.faceCount ? `${Number(task.faceCount).toLocaleString('es-ES')} caras` : '',
        task.vertexCount ? `${Number(task.vertexCount).toLocaleString('es-ES')} vértices` : ''
      ].filter(Boolean).join(', ');
      addMeta(meta, 'Polígonos:', values);
    }
    addMeta(meta, 'ID:', `${String(task.id).slice(0, 12)}...`);
    const date = task.createdAt ? new Date(task.createdAt).toLocaleDateString('es-ES', { year: 'numeric', month: 'short', day: 'numeric' }) : 'Sin fecha';
    addMeta(meta, 'Fecha:', date);
    card.appendChild(meta);

    const actions = createElement('div', 'task-actions');
    const modelButton = createElement('button', 'btn-download');
    modelButton.type = 'button';
    modelButton.dataset.id = String(task.id);
    const partCount = task.parts?.length || task.partCount || 0;
    const downloadLabel = partCount > 1
      ? `Descargar modelo cortado (${partCount} partes)`
      : `Descargar ${formatSelect.value.toUpperCase()}`;
    modelButton.append(createIcon('⬇️'), createElement('span', 'download-text', downloadLabel));
    modelButton.addEventListener('click', () => downloadModel(task, modelButton));
    actions.appendChild(modelButton);

    const textureUrls = Object.values(task.textures || {}).filter(Boolean);
    if (textureUrls.length) {
      const textureButton = createElement('button', 'btn-download-texture');
      textureButton.type = 'button';
      textureButton.append(createIcon('🖼️'), createElement('span', 'download-text', `Descargar texturas (${textureUrls.length})`));
      textureButton.addEventListener('click', () => downloadTextures(task, textureButton));
      actions.appendChild(textureButton);
    }
    card.appendChild(actions);
    tasksList.appendChild(card);
  });
}

function addMeta(parent, label, value) {
  const item = createElement('div', 'meta-item');
  item.append(createElement('span', 'meta-label', label), createElement('span', 'meta-value', value));
  parent.appendChild(item);
}

async function downloadModel(task, button) {
  setButtonState(button, '⏳', 'Iniciando...');
  button.disabled = true;
  try {
    const response = await sendMessage({
      action: 'downloadModel',
      taskId: task.id,
      modelUrl: task.modelUrl,
      filename: `meshy_${task.id}`,
      parts: task.parts?.length ? task.parts : null,
      partCount: task.partCount,
      targetFormat: formatSelect.value,
      modelUrls: task.modelUrls
    });
    if (!response?.success) throw new Error(response?.error || 'No se pudo iniciar la descarga.');
  } catch (error) {
    setButtonState(button, '❌', 'Error');
    button.title = error.message;
    if (error.message.includes('Ctrl+F5')) {
      setStatus('↻', 'Recarga Meshy con Ctrl+F5 y vuelve a intentarlo.', 'error');
    }
    button.disabled = false;
  }
}

async function downloadTextures(task, button) {
  setButtonState(button, '⏳', 'Descargando...');
  button.disabled = true;
  try {
    const response = await sendMessage({ action: 'downloadAllTextures', taskId: task.id, textures: task.textures, taskName: task.title });
    if (!response?.success) throw new Error(response?.error || 'No se pudieron descargar las texturas.');
    setButtonState(button, '✅', 'Completado');
  } catch (error) {
    setButtonState(button, '❌', 'Error');
    button.title = error.message;
    button.disabled = false;
  }
}
