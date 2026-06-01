// background.js
// Open a new tab when the extension icon is clicked

chrome.action.onClicked.addListener(async (tab) => {
  // If a viewer.html tab is already open, activate it
  const query = { url: chrome.runtime.getURL('viewer.html') };
  const existing = await chrome.tabs.query(query);

  if (existing.length > 0) {
    // Switch to existing tab
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
    return;
  }

  // Create a new tab
  await chrome.tabs.create({
    url: chrome.runtime.getURL('viewer.html')
  });
});
