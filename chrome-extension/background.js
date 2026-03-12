// Background Service Worker - פינוי-בינוי Phone Collector
const API_BASE = 'https://pinuy-binuy-analyzer-production.up.railway.app';

let stats = { sent: 0, errors: 0, lastSent: null };

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PHONE_FOUND') {
    handlePhoneFound(message.data).then(result => sendResponse(result));
    return true; // Keep channel open for async response
  }
  if (message.type === 'LISTING_FOUND') {
    handleListingFound(message.data).then(result => sendResponse(result));
    return true;
  }
  if (message.type === 'BULK_LISTINGS') {
    handleBulkListings(message.data).then(result => sendResponse(result));
    return true;
  }
  if (message.type === 'GET_STATS') {
    sendResponse(stats);
    return false;
  }
});

async function handlePhoneFound(data) {
  try {
    const response = await fetch(`${API_BASE}/api/dashboard/ads/update-phone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: data.phone,
        contact_name: data.contact_name || null,
        source: data.source,
        source_listing_id: data.source_listing_id || null,
        source_url: data.url || null
      })
    });
    const result = await response.json();
    if (result.updated > 0) {
      stats.sent++;
      stats.lastSent = new Date().toISOString();
      showNotification(`📞 טלפון נשמר: ${data.phone}`, `עודכן ${result.updated} מודעה`);
    }
    return { success: true, updated: result.updated };
  } catch (err) {
    stats.errors++;
    console.error('[BG] Phone send error:', err);
    return { success: false, error: err.message };
  }
}

async function handleListingFound(data) {
  try {
    const response = await fetch(`${API_BASE}/api/dashboard/ads/bulk-insert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listings: [data] })
    });
    const result = await response.json();
    return { success: true, ...result };
  } catch (err) {
    stats.errors++;
    console.error('[BG] Listing send error:', err);
    return { success: false, error: err.message };
  }
}

async function handleBulkListings(listings) {
  try {
    const response = await fetch(`${API_BASE}/api/dashboard/ads/bulk-insert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listings })
    });
    const result = await response.json();
    stats.sent += result.inserted || 0;
    stats.lastSent = new Date().toISOString();
    if ((result.inserted || 0) > 0) {
      showNotification(`✅ ${result.inserted} מודעות נוספו`, `עודכנו ${result.updated} קיימות`);
    }
    return { success: true, ...result };
  } catch (err) {
    stats.errors++;
    console.error('[BG] Bulk send error:', err);
    return { success: false, error: err.message };
  }
}

function showNotification(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: title,
    message: message
  });
}

// Auto-scrape when tab is updated
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    const url = tab.url;
    // Trigger auto-scrape on listing pages
    if (isListingPage(url)) {
      chrome.tabs.sendMessage(tabId, { type: 'AUTO_SCRAPE' }).catch(() => {});
    }
  }
});

function isListingPage(url) {
  return (
    url.includes('komo.co.il/item/') ||
    url.includes('yad2.co.il/item/') ||
    url.includes('yad1.co.il/') ||
    url.includes('homeless.co.il/') ||
    url.includes('madlan.co.il/')
  );
}
