/********************************************************************
  * options.js – Local Media Viewer (Manifest V3)
 ********************************************************************/

const DB_NAME = 'local-file-viewer-db';
const STORE_NAME = 'handles';
const DEFAULT_KEY = 'defaultFolder';

function t(id, ...args) {
  return chrome.i18n.getMessage(id, args);
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const msg = t(key);
    if (msg) el.textContent = msg;
  });
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    const key = el.getAttribute('data-i18n-html');
    const msg = t(key);
    if (msg) el.innerHTML = msg;
  });
  const titleEl = document.querySelector('title[data-i18n]');
  if (titleEl) {
    const msg = t(titleEl.getAttribute('data-i18n'));
    if (msg) document.title = msg;
  }
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveDefaultFolderHandle(handle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(handle, DEFAULT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getDefaultFolderHandle() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(DEFAULT_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function clearDefaultFolderHandle() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(DEFAULT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function updateDefaultFolderDisplay() {
  const el = document.getElementById('defaultFolderPath');
  try {
    const handle = await getDefaultFolderHandle();
    if (handle) {
      el.textContent = handle.name || t('unknownName');
      el.style.color = '#000';
    } else {
      el.textContent = t('notSet');
      el.style.color = '#999';
    }
  } catch (e) {
    console.warn('Failed to read default folder', e);
    el.textContent = t('loadError');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  applyI18n();
  const result = await chrome.storage.sync.get({
    hidePatterns: ['(^|/)\\..*'],
    slideshowInterval: 3,
    slideshowOrder: 'ascending',
    showFilename: true
  });

  document.getElementById('hidePatterns').value = result.hidePatterns.join('\n');
  document.getElementById('slideshowInterval').value = result.slideshowInterval;
  document.getElementById('showFilename').checked = result.showFilename;

  const orderRadios = document.querySelectorAll('input[name="slideshowOrder"]');
  orderRadios.forEach(radio => {
    if (radio.value === result.slideshowOrder) {
      radio.checked = true;
    }
  });

  await updateDefaultFolderDisplay();
});

document.getElementById('saveBtn').addEventListener('click', async () => {
  const patterns = document.getElementById('hidePatterns').value
    .split('\n')
    .map(p => p.trim())
    .filter(p => p !== '');

  const slideshowInterval = parseInt(document.getElementById('slideshowInterval').value, 10);
  const slideshowOrder = document.querySelector('input[name="slideshowOrder"]:checked').value;
  const showFilename = document.getElementById('showFilename').checked;

  await chrome.storage.sync.set({
    hidePatterns: patterns,
    slideshowInterval: isNaN(slideshowInterval) || slideshowInterval < 1 ? 3 : slideshowInterval,
    slideshowOrder: slideshowOrder,
    showFilename: showFilename
  });

  if (chrome.tabs) {
    const tab = await chrome.tabs.getCurrent();
    if (tab) chrome.tabs.remove(tab.id);
  } else {
    window.close();
  }
});

document.getElementById('setDefaultFolderBtn').addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({ id: 'default-folder-picker', mode: 'read' });
    if (handle.requestPermission) {
      await handle.requestPermission({ mode: 'read' });
    }
    await saveDefaultFolderHandle(handle);
    await updateDefaultFolderDisplay();
    alert(t('alertFolderSet', handle.name));
  } catch (e) {
    console.warn('Default folder selection cancelled', e);
  }
});

document.getElementById('clearDefaultFolderBtn').addEventListener('click', async () => {
  await clearDefaultFolderHandle();
  await updateDefaultFolderDisplay();
  alert(t('alertFolderCleared'));
});
