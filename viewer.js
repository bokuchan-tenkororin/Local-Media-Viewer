/********************************************************************
 * viewer.js – Local File Viewer (Manifest V3)
 ********************************************************************/


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
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    const msg = t(key);
    if (msg) { el.title = msg; el.setAttribute('aria-label', msg); }
  });
  const titleEl = document.querySelector('title[data-i18n]');
  if (titleEl) document.title = t(titleEl.getAttribute('data-i18n'));
}

let cachedHideRegexes = null;
let currentRootDirectoryHandle = null;
let selectedNode = null;
let currentObjectURL = null;

// 
let currentImageFolderHandle = null; // 
let currentImageFileList = []; //  ()
let currentImageIndex = -1; // currentImageFileList 

// 
let slideshowIntervalId = null;
let slideshowRunning = false;
let slideshowOptions = { interval: 3, order: 'ascending', showFilename: true }; // 
let slideshowImageSequence = []; //  ()
let slideshowCurrentSequenceIndex = -1; // slideshowImageSequence 

// 
let currentSubtitleTrack = null;
let subtitleEnabled = true;
let subtitleSize = 'medium';
let subtitleVttUrl = null;

//  IndexedDB
const DB_NAME = 'local-file-viewer-db';
const STORE_NAME = 'handles';
const DEFAULT_KEY = 'defaultFolder';

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

async function getDefaultFolderHandle() {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(DEFAULT_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('Failed to get default folder handle', e);
    return null;
  }
}

async function ensurePermission(handle) {
  if (!handle) return false;
  try {
    const opts = { mode: 'read' };
    let perm = await handle.queryPermission(opts);
    if (perm === 'granted') return true;
    perm = await handle.requestPermission(opts);
    return perm === 'granted';
  } catch (e) {
    console.warn('Permission check failed', e);
    return false;
  }
}

async function tryLoadDefaultFolder() {
  if (currentRootDirectoryHandle) return;
  const handle = await getDefaultFolderHandle();
  if (!handle) {
    console.log('No default folder set');
    return;
  }
  const ok = await ensurePermission(handle);
  if (!ok) {
    console.warn('Permission denied for default folder');
    displayContent(`<h1>${t('extensionName')}</h1><p>${t('defaultFolderPermissionNeeded')}</p>`);
    return;
  }
  await buildTreeFromDirectoryHandle(handle);
}


// DOM
const imageNavigation = document.getElementById('imageNavigation');
const prevImageBtn = document.getElementById('prevImageBtn');
const nextImageBtn = document.getElementById('nextImageBtn');
const slideshowBtn = document.getElementById('slideshowBtn');

async function getHideRegexes() {
  if (cachedHideRegexes) return cachedHideRegexes;
  const { hidePatterns = ['(^|/)\\..*'] } = await chrome.storage.sync.get({ hidePatterns: ['(^|/)\\..*'] });
  cachedHideRegexes = hidePatterns
   .map(pat => {
      try { return new RegExp(pat); }
      catch (e) { console.warn('Invalid hide pattern ignored:', pat, e); return null; }
    })
   .filter(re => re);
  return cachedHideRegexes;
}

/**
 * スライドショーオプションをストレージから読み込む
 */
async function loadSlideshowOptions() {
  const result = await chrome.storage.sync.get({
    slideshowInterval: 3,
    slideshowOrder: 'ascending',
    showFilename: true
  });
  slideshowOptions.interval = result.slideshowInterval;
  slideshowOptions.order = result.slideshowOrder;
  slideshowOptions.showFilename = result.showFilename;
  console.log('Slideshow options loaded:', slideshowOptions);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') {
    if (changes.hidePatterns) {
      console.info('hidePatterns changed – clearing RegExp cache');
      cachedHideRegexes = null;
      if (currentRootDirectoryHandle) {
        buildTreeFromDirectoryHandle(currentRootDirectoryHandle);
      }
    }
    if (changes.slideshowInterval || changes.slideshowOrder || changes.showFilename) {
      console.info('Slideshow options changed – reloading');
      loadSlideshowOptions();
      // 
      if (slideshowRunning) {
        stopSlideshow();
        // 
        setTimeout(startSlideshow, 100);
      }
    }
  }
});

const treeRoot = document.getElementById('treeRoot');
const mainContent = document.getElementById('mainContent');

/**
 * ディレクトリハンドルからツリーのルートを構築し、最初のレベルの子要素をロードします。
 * @param {FileSystemDirectoryHandle} dirHandle
 */
async function buildTreeFromDirectoryHandle(dirHandle) {
  currentRootDirectoryHandle = dirHandle;
  imageNavigation.style.display = 'none';
  slideshowBtn.style.visibility = 'hidden';
  if (slideshowRunning) stopSlideshow();

  treeRoot.innerHTML = '';
  displayContent(`<h1>${t('extensionName')}</h1><p>${t('selectFromTree')}</p>`);
  selectedNode = null;

  const rootLi = document.createElement('li');
  rootLi.entry = dirHandle;
  rootLi.setAttribute('data-path', '/');
  rootLi.classList.add('folder', 'expanded');
  rootLi.setAttribute('data-loaded', 'true');

  const itemDiv = document.createElement('div');
  itemDiv.classList.add('tree-item');
  rootLi.appendChild(itemDiv);

  const toggle = document.createElement('span');
  toggle.classList.add('toggle');
  itemDiv.appendChild(toggle);

  const nameSpan = document.createElement('span');
  nameSpan.classList.add('name');
  nameSpan.textContent = dirHandle.name || t('rootName');
  itemDiv.appendChild(nameSpan);

  const rootUl = document.createElement('ul');
  rootLi.appendChild(rootUl);
  treeRoot.appendChild(rootLi);

  // 
  try {
    await loadChildren(rootUl, dirHandle, '/');
  console.log("[viewer] root children loaded, ul child count", rootUl.children.length);
  } catch (e) {
    console.error('loadChildren failed for root', e);
    displayContent(`<h1>${t('errorTitle')||'Error'}</h1><p>${t('folderLoadFailed')||'Failed to load folder'}: ${e.message}</p>`);
    rootUl.innerHTML = `<li style="color:red;">${t('loadError')||'Load error'}</li>`;
  }

  // 
  try {
    let hasChild = false;
    for await (const _ of dirHandle.values()) { hasChild = true; break; }
    rootLi.setAttribute('data-has-children', String(hasChild));
  } catch (e) {
    console.warn('Could not check children', e);
    rootLi.setAttribute('data-has-children', 'false');
  }

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const childUl = rootLi.querySelector('ul');
    if (childUl && rootLi.getAttribute('data-has-children') === 'true') {
      toggleNode(rootLi, childUl, dirHandle, '/');
    }
  });
  nameSpan.addEventListener('click', (e) => {
    e.stopPropagation();
    handleNodeClick(rootLi, e);
  });
}


/**
 * 指定ディレクトリの子要素をロードしてツリーに追加
 * @param {HTMLUListElement} parentUl
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string} currentPath
 */
async function loadChildren(parentUl, dirHandle, currentPath) {
  console.log("[viewer] loadChildren start", currentPath, dirHandle.name, "kind", dirHandle.kind);
  const hideRegexes = await getHideRegexes();
  console.log("[viewer] hideRegexes", hideRegexes.map(r=>r.toString()));
  const children = [];

  for await (const entry of dirHandle.values()) {
    console.log("[viewer] raw entry", entry.name, entry.kind);
    const name = entry.name;
    const entryPath = `${currentPath === '/'? '' : currentPath}/${name}`; // 

    if (hideRegexes.some(re => re.test(name) || re.test(entryPath))) {
      console.debug('Entry hidden by pattern', entryPath);
      continue;
    }
    children.push(entry);
  }

  // 
  console.log("[viewer] children after filter", children.length);
  children.sort((a, b) => {
    const aIsDir = a.kind === 'directory'? 0 : 1;
    const bIsDir = b.kind === 'directory'? 0 : 1;
    if (aIsDir!== bIsDir) return aIsDir - bIsDir;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });

  for (const entry of children) {
    const name = entry.name;
    const entryPath = `${currentPath === '/'? '' : currentPath}/${name}`; // 

    const li = document.createElement('li');
    li.entry = entry;
    li.setAttribute('data-path', entryPath);
    li.setAttribute('data-kind', entry.kind);

    if (entry.kind === 'directory') {
      li.classList.add('folder', 'collapsed');
      li.setAttribute('data-loaded', 'false');

      const itemDiv = document.createElement('div');
      itemDiv.classList.add('tree-item');
      li.appendChild(itemDiv);

      const toggle = document.createElement('span');
      toggle.classList.add('toggle');
      itemDiv.appendChild(toggle);

      const nameSpan = document.createElement('span');
      nameSpan.classList.add('name');
      nameSpan.textContent = name;
      itemDiv.appendChild(nameSpan);

      const childUl = document.createElement('ul');
      li.appendChild(childUl);

      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const ul = li.querySelector('ul');
        if (ul && li.getAttribute('data-has-children') === 'true') {
          toggleNode(li, ul, entry, li.getAttribute('data-path'));
        }
      });
      nameSpan.addEventListener('click', (e) => { // : 
        e.stopPropagation();
        handleNodeClick(li, e);
      });

      try {
        const iterator = entry.values();
        const { value } = await iterator.next();
        li.setAttribute('data-has-children', String(!!value));
      } catch (e) {
        console.warn('Could not check children for', entry.name, e);
        li.setAttribute('data-has-children', 'false');
      }

    } else { // file
      li.classList.add('file');
      li.setAttribute('data-has-children', 'false');

      const itemDiv = document.createElement('div');
      itemDiv.classList.add('tree-item');
      li.appendChild(itemDiv);

      const toggle = document.createElement('span');
      toggle.classList.add('toggle');
      itemDiv.appendChild(toggle);

      const nameSpan = document.createElement('span');
      nameSpan.classList.add('name');
      nameSpan.textContent = name;
      itemDiv.appendChild(nameSpan);

      li.addEventListener('click', (e) => {
        e.stopPropagation();
        handleNodeClick(li, e);
      });
    }

    parentUl.appendChild(li);
  }
}

/**
 * ノードクリック時の処理（ハイライト、開閉、ファイル表示）
 * @param {HTMLLIElement} li
 * @param {Event} event
 */
async function handleNodeClick(li, event) {
  console.log('handleNodeClick →', li.entry.name, 'prev selected:', selectedNode?.entry?.name);

  //  
  if (selectedNode && selectedNode!== li) {
    selectedNode.classList.remove('selected');
    console.log('Removed selected from:', selectedNode.entry.name);
  }

  //   selected 
  if (selectedNode!== li) {
    li.classList.add('selected');
    selectedNode = li;
    console.log('Added selected to:', li.entry.name);
  }

  const entry = li.entry;

  if (entry.kind === 'directory') {
    //  
    const childUl = li.querySelector('ul');
    if (childUl && li.getAttribute('data-has-children') === 'true') {
      await toggleNode(li, childUl, entry, li.getAttribute('data-path'));
    }
    //  
    displayContent(`<h3>${entry.name}</h3><p>${t('folderSelected')||'Folder selected.'}</p><p>${t('pathLabel')||'Path'}: <code>${li.getAttribute('data-path')}</code></p>`);
    // 
    imageNavigation.style.display = 'none';
    slideshowBtn.style.visibility = 'hidden';
    if (slideshowRunning) stopSlideshow();
  } else if (entry.kind === 'file') {
    await displayFileContent(entry);
  }
}

/**
 * フォルダの開閉切替
 */
async function toggleNode(li, childUl, dirHandle, path) {
  if (li.getAttribute('data-has-children') === 'false') return;

  if (li.classList.contains('collapsed')) {
    // 
    const parentUl = li.parentElement;
    if (parentUl) {
      for (const sib of parentUl.children) {
        if (sib!== li && sib.classList.contains('folder') && sib.classList.contains('expanded')) {
          sib.classList.remove('expanded');
          sib.classList.add('collapsed');
        }
      }
    }

    if (li.getAttribute('data-loaded') === 'false') {
      childUl.innerHTML = '';
      await loadChildren(childUl, dirHandle, path);
      li.setAttribute('data-loaded', 'true');
    }
    li.classList.remove('collapsed');
    li.classList.add('expanded');
  } else {
    li.classList.remove('expanded');
    li.classList.add('collapsed');
  }
}

/**
 * 指定ディレクトリ内の画像ファイルを取得し、名前でソートして返す
 * @param {FileSystemDirectoryHandle} dirHandle
 * @returns {Promise<FileSystemFileHandle[]>} 画像ファイルのリスト
 */
async function getImagesInDirectory(dirHandle) {
  const hideRegexes = await getHideRegexes();
  console.log("[viewer] hideRegexes", hideRegexes.map(r=>r.toString()));
  const imageFiles = [];
  console.log('getImagesInDirectory: Scanning directory:', dirHandle.name);
  for await (const entry of dirHandle.values()) {
    console.log("[viewer] raw entry", entry.name, entry.kind);
    if (entry.kind === 'file') {
      const name = entry.name;
      const fileNameLower = name.toLowerCase();

      // 
      if (hideRegexes.some(re => re.test(name))) {
        console.debug('getImagesInDirectory: Hidden by pattern:', name);
        continue;
      }

      // 
      if (fileNameLower.endsWith('.jpg') || fileNameLower.endsWith('.jpeg') ||
          fileNameLower.endsWith('.png') || fileNameLower.endsWith('.gif') ||
          fileNameLower.endsWith('.webp') || fileNameLower.endsWith('.svg') ||
          fileNameLower.endsWith('.bmp')) {
        imageFiles.push(entry);
        console.debug('getImagesInDirectory: Found image file:', name);
      } else {
        console.debug('getImagesInDirectory: Skipped non-image file:', name);
      }
    } else {
      console.debug('getImagesInDirectory: Skipped non-file entry:', entry.name);
    }
  }
  // 
  imageFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  console.log('getImagesInDirectory: Finished scanning. Found %d image files.', imageFiles.length);
  return imageFiles;
}

/**
 * ファイル内容の表示（画像・動画・テキスト）
 */

/**
 * SRT を VTT に変換
 */
function srtToVtt(srt) {
  let vtt = 'WEBVTT\n\n';
  const blocks = srt.trim().replace(/\r/g, '').split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.length >= 2) {
      let idx = 0;
      if (/^\d+$/.test(lines[0].trim())) idx = 1;
      const timeLine = lines[idx] || '';
      const timeVtt = timeLine.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
      const text = lines.slice(idx + 1).join('\n');
      if (timeVtt.includes('-->')) {
        vtt += timeVtt + '\n' + text + '\n\n';
      }
    }
  }
  return vtt;
}

/**
 * 字幕サイズを適用
 */
function applySubtitleSize() {
  let sizePx = '24px';
  if (subtitleSize === 'small') sizePx = '16px';
  else if (subtitleSize === 'large') sizePx = '32px';
  let styleEl = document.getElementById('subtitleStyle');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'subtitleStyle';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = `video::cue { font-size: ${sizePx}; background: rgba(0,0,0,0.6); }`;
}

async function displayFileContent(fileHandle, options = {}) {
  console.log('displayFileContent started for:', fileHandle.name);
  mainContent.innerHTML = t('loading')||'Loading...';
  const toolbar = document.querySelector('.toolbar');
  // 
  if (toolbar) toolbar.style.display = 'flex';
  mainContent.style.padding = '24px';
  imageNavigation.style.display = 'none';
  slideshowBtn.style.visibility = 'hidden';
  if (slideshowRunning &&!options.keepSlideshow) stopSlideshow();

  if (currentObjectURL) {
    URL.revokeObjectURL(currentObjectURL);
    currentObjectURL = null;
  }

  try {
    const file = await fileHandle.getFile();
    const mime = file.type;
    const name = file.name;

    if (mime.startsWith('image/')) {
      const url = URL.createObjectURL(file);
      const filenameHtml = slideshowOptions.showFilename? `<h3>${name}</h3>` : '';
      mainContent.innerHTML = `${filenameHtml}<div class="media-container"><img src="${url}" alt="${name}" id="currentMedia"></div>`;
      currentObjectURL = url;
      if (toolbar) toolbar.style.display = 'none';
      mainContent.style.padding = '0';

      const imgEl = document.getElementById('currentMedia');
      if (imgEl) {
        const applyOrientation = () => {
          if (imgEl.naturalWidth >= imgEl.naturalHeight) {
            imgEl.classList.add('landscape');
            imgEl.classList.remove('portrait');
          } else {
            imgEl.classList.add('portrait');
            imgEl.classList.remove('landscape');
          }
        };
        imgEl.onload = applyOrientation;
        if (imgEl.complete) applyOrientation();
      }

      // 
      const parentFolderLi = selectedNode? selectedNode.parentElement.closest('li.folder') : null;
      if (parentFolderLi && parentFolderLi.entry.kind === 'directory') {
          currentImageFolderHandle = parentFolderLi.entry;
          currentImageFileList = await getImagesInDirectory(currentImageFolderHandle);
          currentImageIndex = currentImageFileList.findIndex(entry => entry.name === fileHandle.name);

          if (currentImageFileList.length > 1) { // 
              imageNavigation.style.display = 'flex';
              slideshowBtn.style.visibility = 'visible';
          } else {
              imageNavigation.style.display = 'none';
              slideshowBtn.style.visibility = 'hidden';
          }
      } else {
          currentImageFolderHandle = null;
          currentImageFileList = [];
          currentImageIndex = -1;
          imageNavigation.style.display = 'none';
          slideshowBtn.style.visibility = 'hidden';
      }
      console.log('displayFileContent finished (image). currentImageFileList.length:', currentImageFileList.length, 'slideshowBtn visibility:', slideshowBtn.style.visibility);

    } else if (mime.startsWith('video/')) {
      const url = URL.createObjectURL(file);
      const filenameHtml = slideshowOptions.showFilename? `<h3>${name}</h3>` : '';
      mainContent.innerHTML = `${filenameHtml}<div class="media-container"><video id="currentMedia" controls autoplay src="${url}"></video></div>`;
      currentObjectURL = url;
      if (toolbar) toolbar.style.display = 'none';
      mainContent.style.padding = '0';

      const videoEl = document.getElementById('currentMedia');
      if (videoEl) {
        const applyOrientation = () => {
          if (videoEl.videoWidth >= videoEl.videoHeight) {
            videoEl.classList.add('landscape');
            videoEl.classList.remove('portrait');
          } else {
            videoEl.classList.add('portrait');
            videoEl.classList.remove('landscape');
          }
        };
        videoEl.onloadedmetadata = applyOrientation;
        if (videoEl.readyState >= 1) applyOrientation();
        videoEl.muted = false;
        videoEl.volume = 1.0;
        applySubtitleSize();
      }
      //  .srt 
      (async () => {
        try {
          const parentFolderLi = selectedNode ? selectedNode.parentElement.closest('li.folder') : null;
          const folderHandle = parentFolderLi ? parentFolderLi.entry : null;
          if (folderHandle && videoEl) {
            const baseName = name.replace(/\.[^.]+$/, '');
            const srtName = baseName + '.srt';
            try {
              const srtHandle = await folderHandle.getFileHandle(srtName);
              const srtFile = await srtHandle.getFile();
              const srtText = await srtFile.text();
              const vttText = srtToVtt(srtText);
              if (subtitleVttUrl) URL.revokeObjectURL(subtitleVttUrl);
              const blob = new Blob([vttText], { type: 'text/vtt' });
              subtitleVttUrl = URL.createObjectURL(blob);
              videoEl.querySelectorAll('track').forEach(t => t.remove());
              const track = document.createElement('track');
              track.kind = 'subtitles';
              track.label = t('japanese')||'Japanese';
              track.srclang = 'ja';
              track.src = subtitleVttUrl;
              track.default = true;
              track.addEventListener('load', () => {
                const tt = videoEl.textTracks[0];
                if (tt) tt.mode = 'showing';
              });
              videoEl.appendChild(track);
              currentSubtitleTrack = track;
              setTimeout(() => {
                const tt = videoEl.textTracks[0];
                if (tt) tt.mode = 'showing';
              }, 300);
              console.log('自動字幕読込:', srtName);
            } catch (e) {
              console.log('同名の字幕ファイルなし');
            }
          }
        } catch (e) {
          console.warn('自動字幕読込エラー', e);
        }
      })();
      console.log('displayFileContent finished (video)');
    } else if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') {
      const txt = await file.text();
      mainContent.innerHTML = `<h3>${name}</h3><pre>${escapeHTML(txt)}</pre>`;
      console.log('displayFileContent finished (text)');
    } else {
      mainContent.innerHTML = `<h3>${name}</h3><p>${t('cannotPreview')||'This file type'} (${mime}) ${t('cannotPreviewSuffix')||'cannot be previewed.'}</p><p>${t('sizeLabel')||'Size'}: ${file.size} ${t('bytes')||'bytes'}</p>`;
      console.log('displayFileContent finished (unpreviewable)');
    }
  } catch (e) {
    console.error('Failed to read file in displayFileContent:', e);
    mainContent.innerHTML = `<h3>${fileHandle.name}</h3><p>${t('fileLoadError')||'Error loading file'}: ${e.message}</p>`;
  }
}

/**
 * HTML 文字列をメイン領域へ表示（前の ObjectURL は解放）
 */
function displayContent(html) {
  const toolbar = document.querySelector('.toolbar');
  if (toolbar) toolbar.style.display = 'flex';
  mainContent.style.padding = '24px';
  if (currentObjectURL) {
    URL.revokeObjectURL(currentObjectURL);
    currentObjectURL = null;
  }
  mainContent.innerHTML = html;
}

/**
 * エスケープユーティリティ
 */
function escapeHTML(str) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(str));
  return d.innerHTML;
}

/**
 * 配列をシャッフルするユーティリティ関数
 */
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

/**
 * スライドショーを開始する
 */
async function startSlideshow() {
  console.log('startSlideshow: Entry. currentImageFileList.length:', currentImageFileList.length, 'slideshowRunning:', slideshowRunning);

  if (!currentImageFileList || currentImageFileList.length <= 1) {
    console.warn('startSlideshow: Aborting. フォルダ内に2枚以上の画像ファイルが必要です。currentImageFileList.length:', currentImageFileList.length);
    stopSlideshow();
    return;
  }

  if (slideshowRunning) {
    console.log('startSlideshow: Slideshow already running, stopping existing one.');
    stopSlideshow();
  }

  slideshowRunning = true;
  slideshowBtn.textContent = t('slideshowStop');
  slideshowBtn.classList.add('active');
  slideshowBtn.style.visibility = 'visible';

  // 
  if (selectedNode) {
    selectedNode.classList.remove('selected');
  }

  // 
  let tempSequence = [];
  if (slideshowOptions.order === 'random') {
    tempSequence = shuffleArray([...currentImageFileList]);
  } else if (slideshowOptions.order === 'descending') {
    tempSequence = [...currentImageFileList].reverse();
  } else { // ascending ()
    tempSequence = [...currentImageFileList];
  }

  // 
  slideshowImageSequence = tempSequence;

  console.log('startSlideshow: slideshowImageSequence ASSIGNED. Type:', typeof slideshowImageSequence, 'Is Array:', Array.isArray(slideshowImageSequence), 'Length:', slideshowImageSequence.length, 'Content (first 5 names):', slideshowImageSequence.slice(0, 5).map(f => f.name));

  if (!Array.isArray(slideshowImageSequence) || slideshowImageSequence.length === 0) {
    console.error('startSlideshow: CRITICAL ERROR - slideshowImageSequence is unexpectedly empty or not an Array after population! currentImageFileList.length:', currentImageFileList.length);
    stopSlideshow();
    return;
  }

  // 
  const currentFileHandle = selectedNode?.entry;
  if (currentFileHandle) {
    slideshowCurrentSequenceIndex = slideshowImageSequence.findIndex(
      entry => entry.name === currentFileHandle.name
    );
    if (slideshowCurrentSequenceIndex === -1) {
      console.warn('startSlideshow: Current image not found in sequence, starting from 0. Selected file:', currentFileHandle.name);
      slideshowCurrentSequenceIndex = 0;
    }
  } else {
    console.warn('startSlideshow: No selected file, starting sequence from 0.');
    slideshowCurrentSequenceIndex = 0;
  }
  console.log('startSlideshow: Initial slideshowCurrentSequenceIndex:', slideshowCurrentSequenceIndex);

  console.log('startSlideshow: VERIFYING slideshowImageSequence BEFORE navigateSlideshowImage(0) call. Type:', typeof slideshowImageSequence, 'Is Array:', Array.isArray(slideshowImageSequence), 'Length:', slideshowImageSequence.length);
  if (!Array.isArray(slideshowImageSequence) || slideshowImageSequence.length === 0) {
      console.error('startSlideshow: IMMEDIATE CRITICAL ERROR - slideshowImageSequence is empty or not an Array JUST BEFORE navigateSlideshowImage(0)!');
      stopSlideshow();
      return;
  }

  console.log('startSlideshow: Calling navigateSlideshowImage(0) for first image...');
  await navigateSlideshowImage(0); // This should display the first image in the sequence
  console.log('startSlideshow: First image navigated. Setting up interval.');

  slideshowIntervalId = setInterval(async () => {
    console.log('startSlideshow: Interval triggered, calling navigateSlideshowImage(1)...');
    await navigateSlideshowImage(1);
  }, slideshowOptions.interval * 1000);

  console.log('startSlideshow: Slideshow fully started. Interval ID:', slideshowIntervalId);
}

/**
 * スライドショーを停止する
 */
function stopSlideshow() {
  console.log('stopSlideshow called.');
  if (slideshowIntervalId) {
    clearInterval(slideshowIntervalId);
    slideshowIntervalId = null;
  }
  slideshowRunning = false;
  slideshowBtn.textContent = t('slideshowBtn');
  slideshowBtn.classList.remove('active');
  // 
  if (!currentImageFileList || currentImageFileList.length <= 1) {
    slideshowBtn.style.visibility = 'hidden';
  } else {
    slideshowBtn.style.visibility = 'visible';
  }

  // 
  if (currentImageFileList && currentImageIndex >= 0 && currentImageFolderHandle) {
    const handle = currentImageFileList[currentImageIndex];
    const folderLis = document.querySelectorAll('li.folder');
    let folderLi = null;
    for (const fl of folderLis) {
      if (fl.entry && fl.entry.name === currentImageFolderHandle.name) {
        folderLi = fl;
        break;
      }
    }
    if (folderLi) {
      const fileLis = folderLi.querySelectorAll('li.file');
      let targetLi = null;
      for (const li of fileLis) {
        if (li.entry && li.entry.name === handle.name) {
          targetLi = li;
          break;
        }
      }
      if (targetLi) {
        if (selectedNode && selectedNode !== targetLi) {
          selectedNode.classList.remove('selected');
        }
        targetLi.classList.add('selected');
        selectedNode = targetLi;
        targetLi.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }

  slideshowImageSequence = []; // 
  slideshowCurrentSequenceIndex = -1;
  console.log('stopSlideshow finished.');
}

/**
 * スライドショーの次の画像に移動して表示する
 * @param {number} direction - 進行方向 (通常は 1)
 */
async function navigateSlideshowImage(direction) {
  console.log('navigateSlideshowImage called with direction:', direction, 'currentSequenceIndex:', slideshowCurrentSequenceIndex, 'slideshowImageSequence.length:', (slideshowImageSequence? slideshowImageSequence.length : 'null/undefined'), 'Is Array:', Array.isArray(slideshowImageSequence));
  if (!Array.isArray(slideshowImageSequence) || slideshowImageSequence.length === 0) {
    console.warn('navigateSlideshowImage: スライドショーシーケンスが空のため停止します。');
    stopSlideshow();
    return;
  }

  let nextIndex = slideshowCurrentSequenceIndex + direction;

  // 
  if (nextIndex < 0) {
    nextIndex = slideshowImageSequence.length - 1;
  } else if (nextIndex >= slideshowImageSequence.length) {
    nextIndex = 0;
  }

  const nextImageHandle = slideshowImageSequence[nextIndex];
  if (nextImageHandle) {
    slideshowCurrentSequenceIndex = nextIndex;
    //  currentImageIndex 
//  currentImageIndex 
    currentImageIndex = currentImageFileList.findIndex(entry => entry.name === nextImageHandle.name);

    await displayFileContent(nextImageHandle, { keepSlideshow: true }); // 
    console.log('navigateSlideshowImage: Navigated to image:', nextImageHandle.name, 'currentImageIndex for manual:', currentImageIndex);
  } else {
    console.warn('navigateSlideshowImage: 次の画像が見つかりませんでした。スライドショーを停止します。');
    stopSlideshow();
  }
}

/**
 * ツリー上のファイル選択状態を更新（フォルダ内検索）
 */
function updateTreeSelectionForHandle(handle) {
  if (!currentImageFolderHandle) return;
  // LI
  const folderLis = document.querySelectorAll('li.folder');
  let folderLi = null;
  for (const fl of folderLis) {
    if (fl.entry && fl.entry.name === currentImageFolderHandle.name) {
      folderLi = fl;
      break;
    }
  }
  if (!folderLi) return;
  const fileLis = folderLi.querySelectorAll('li.file');
  let targetLi = null;
  for (const li of fileLis) {
    if (li.entry && li.entry.name === handle.name) {
      targetLi = li;
      break;
    }
  }
  if (targetLi) {
    if (selectedNode && selectedNode !== targetLi) {
      selectedNode.classList.remove('selected');
    }
    targetLi.classList.add('selected');
    selectedNode = targetLi;
    targetLi.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

/* 画像ナビゲーション関数 */
async function navigateImage(direction) {
  console.log('navigateImage (manual) called with direction:', direction);
  if (slideshowRunning) {
    stopSlideshow(); // 
    console.log('navigateImage: Slideshow stopped due to manual navigation.');
  }
  if (!currentImageFileList || currentImageFileList.length === 0) return;

  let newIndex = currentImageIndex + direction;

  // 
  if (newIndex < 0) {
    newIndex = currentImageFileList.length - 1;
  } else if (newIndex >= currentImageFileList.length) {
    newIndex = 0;
  }

  const newImageHandle = currentImageFileList[newIndex];
  if (newImageHandle) {
    currentImageIndex = newIndex;
    //  currentImageIndex 
    await displayFileContent(newImageHandle);
    updateTreeSelectionForHandle(newImageHandle);
    console.log('navigateImage: Manual navigation to image:', newImageHandle.name);
  }
}

/* ---------- UI ハンドラ ---------- */
document.addEventListener('DOMContentLoaded', async () => {
  applyI18n();
  // 
  await loadSlideshowOptions();
  applySubtitleSize();

  // 
  await tryLoadDefaultFolder();

  // 
  prevImageBtn.addEventListener('click', () => navigateImage(-1));
  nextImageBtn.addEventListener('click', () => navigateImage(1));

  // 
  slideshowBtn.addEventListener('click', () => {
    console.log('Slideshow button clicked. slideshowRunning:', slideshowRunning);
    if (slideshowRunning) {
      stopSlideshow();
    } else {
      startSlideshow();
    }
  });

  document.getElementById('chooseFolderBtn')?.addEventListener('click', async () => {
    console.log('Choose Folder button clicked.');
    try {
      const dirHandle = await window.showDirectoryPicker();
      await buildTreeFromDirectoryHandle(dirHandle);
    } catch (e) {
      console.warn('Folder selection cancelled or failed', e);
      treeRoot.innerHTML = '';
      currentRootDirectoryHandle = null;
      displayContent(`<h1>${t('extensionName')}</h1><p>${t('selectFromTree')}</p>`);
      selectedNode = null;
      // 
      imageNavigation.style.display = 'none';
      slideshowBtn.style.visibility = 'hidden';
      if (slideshowRunning) stopSlideshow();
    }
  });
});

/* メモリリーク防止 */
window.addEventListener('beforeunload', () => {
  if (currentObjectURL) {
    URL.revokeObjectURL(currentObjectURL);
    currentObjectURL = null;
  }
  if (slideshowRunning) {
    stopSlideshow();
  }
});

/* デバッグエクスポート（コンソールから呼び出せます） */
if (typeof window!== 'undefined') {
  window._viewerDebug = {
    getHideRegexes,
    buildTreeFromDirectoryHandle,
    clearCache: () => { cachedHideRegexes = null; }
  };
}