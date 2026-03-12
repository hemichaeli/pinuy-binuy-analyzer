// Popup script for פינוי-בינוי Phone Collector

const log = document.getElementById('log');

function addLog(msg) {
  const time = new Date().toLocaleTimeString('he-IL');
  log.innerHTML = `[${time}] ${msg}\n` + log.innerHTML;
}

// Load stats from background
chrome.runtime.sendMessage({ type: 'GET_STATS' }, (stats) => {
  if (stats) {
    document.getElementById('sent').textContent = stats.sent || 0;
    document.getElementById('errors').textContent = stats.errors || 0;
    if (stats.lastSent) {
      const d = new Date(stats.lastSent);
      document.getElementById('lastSent').textContent = d.toLocaleTimeString('he-IL');
    }
  }
});

// Scrape current tab
document.getElementById('scrapeBtn').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'AUTO_SCRAPE' }, (response) => {
        if (chrome.runtime.lastError) {
          addLog('❌ ' + chrome.runtime.lastError.message);
        } else {
          addLog('✅ סריקה הופעלה');
        }
      });
    }
  });
});

// Open dashboard
document.getElementById('dashboardBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://pinuy-binuy-analyzer-production.up.railway.app/dashboard' });
});

addLog('תוסף פעיל - גלוש לאתרי נדל"ן לסריקה אוטומטית');
