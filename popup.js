document.getElementById('open').onclick = async () => { const [tab] = await chrome.tabs.query({active:true,currentWindow:true}); if (tab?.id) chrome.tabs.sendMessage(tab.id, {type:'open'}); window.close(); };
document.getElementById('options').onclick = () => chrome.runtime.openOptionsPage();
