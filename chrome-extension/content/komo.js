// Komo.co.il Content Script - Phone Extractor
// Komo has a phone reveal API: /api/modaotService/showPhoneDetails/post/{listingId}

(function() {
  'use strict';
  
  const SOURCE = 'komo';
  let scraped = false;
  
  // Extract listing ID from URL
  function getListingId() {
    const match = window.location.pathname.match(/\/item\/(\d+)/);
    return match ? match[1] : null;
  }
  
  // Extract listing data from the page
  function extractListingData() {
    const data = {
      source: SOURCE,
      url: window.location.href,
      source_listing_id: getListingId()
    };
    
    // Price
    const priceEl = document.querySelector('[class*="price"]');
    if (priceEl) {
      const priceText = priceEl.textContent.replace(/[^\d]/g, '');
      if (priceText) data.price = parseInt(priceText);
    }
    
    // Rooms
    const roomsEl = document.querySelector('[class*="rooms"]');
    if (roomsEl) {
      const roomsMatch = roomsEl.textContent.match(/(\d+(?:\.\d+)?)/);
      if (roomsMatch) data.rooms = parseFloat(roomsMatch[1]);
    }
    
    // Area
    const areaEl = document.querySelector('[class*="area"], [class*="size"]');
    if (areaEl) {
      const areaMatch = areaEl.textContent.match(/(\d+)/);
      if (areaMatch) data.area = parseInt(areaMatch[1]);
    }
    
    // Floor
    const floorEl = document.querySelector('[class*="floor"]');
    if (floorEl) {
      const floorMatch = floorEl.textContent.match(/(\d+)/);
      if (floorMatch) data.floor = parseInt(floorMatch[1]);
    }
    
    // Address/City
    const addressEl = document.querySelector('[class*="address"], [class*="location"]');
    if (addressEl) data.address = addressEl.textContent.trim();
    
    // Description
    const descEl = document.querySelector('[class*="description"], [class*="content"]');
    if (descEl) data.description = descEl.textContent.trim().substring(0, 500);
    
    // Title
    const titleEl = document.querySelector('h1, [class*="title"]');
    if (titleEl) data.title = titleEl.textContent.trim();
    
    return data;
  }
  
  // Intercept the phone reveal API call
  function interceptPhoneAPI() {
    const listingId = getListingId();
    if (!listingId) return;
    
    // Override XMLHttpRequest to catch phone API calls
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
      this._url = url;
      return origOpen.apply(this, [method, url, ...args]);
    };
    
    XMLHttpRequest.prototype.send = function(...args) {
      this.addEventListener('load', function() {
        if (this._url && this._url.includes('showPhoneDetails')) {
          try {
            const data = JSON.parse(this.responseText);
            const phone = data.phone || data.phoneNumber || data.contactPhone;
            const name = data.name || data.contactName || data.sellerName;
            if (phone) {
              console.log('[KOMO] Phone intercepted:', phone);
              chrome.runtime.sendMessage({
                type: 'PHONE_FOUND',
                data: {
                  source: SOURCE,
                  source_listing_id: listingId,
                  url: window.location.href,
                  phone: phone,
                  contact_name: name || null
                }
              });
            }
          } catch(e) {}
        }
      });
      return origSend.apply(this, args);
    };
    
    // Also intercept fetch
    const origFetch = window.fetch;
    window.fetch = function(url, options) {
      const urlStr = typeof url === 'string' ? url : url.url;
      return origFetch.apply(this, arguments).then(response => {
        if (urlStr && urlStr.includes('showPhoneDetails')) {
          response.clone().json().then(data => {
            const phone = data.phone || data.phoneNumber || data.contactPhone;
            const name = data.name || data.contactName || data.sellerName;
            if (phone) {
              console.log('[KOMO] Phone intercepted (fetch):', phone);
              chrome.runtime.sendMessage({
                type: 'PHONE_FOUND',
                data: {
                  source: SOURCE,
                  source_listing_id: listingId,
                  url: window.location.href,
                  phone: phone,
                  contact_name: name || null
                }
              });
            }
          }).catch(() => {});
        }
        return response;
      });
    };
  }
  
  // Auto-click the phone reveal button
  function autoRevealPhone() {
    const phoneBtn = document.querySelector(
      '[class*="phone-btn"], [class*="phoneBtn"], [class*="show-phone"], ' +
      '[class*="showPhone"], button[class*="phone"], [data-action="phone"]'
    );
    if (phoneBtn && !phoneBtn.dataset.clicked) {
      phoneBtn.dataset.clicked = 'true';
      console.log('[KOMO] Auto-clicking phone reveal button');
      phoneBtn.click();
    }
  }
  
  // Check if phone is already visible on page
  function checkVisiblePhone() {
    const listingId = getListingId();
    if (!listingId) return;
    
    // Look for Israeli phone patterns
    const phoneRegex = /0[5-9]\d[-\s]?\d{3}[-\s]?\d{4}|0[2-4]\d[-\s]?\d{3}[-\s]?\d{4}/g;
    const pageText = document.body.innerText;
    const phones = pageText.match(phoneRegex);
    
    if (phones && phones.length > 0) {
      const phone = phones[0].replace(/\s/g, '-');
      console.log('[KOMO] Phone found on page:', phone);
      chrome.runtime.sendMessage({
        type: 'PHONE_FOUND',
        data: {
          source: SOURCE,
          source_listing_id: listingId,
          url: window.location.href,
          phone: phone
        }
      });
    }
  }
  
  // Also send listing data to be inserted/updated
  function sendListingData() {
    const listingId = getListingId();
    if (!listingId || scraped) return;
    scraped = true;
    
    const listing = extractListingData();
    if (listing.source_listing_id) {
      chrome.runtime.sendMessage({
        type: 'LISTING_FOUND',
        data: listing
      });
    }
  }
  
  // Main init
  function init() {
    const listingId = getListingId();
    if (!listingId) return; // Only run on listing pages
    
    console.log('[KOMO] Initializing phone extractor for listing:', listingId);
    
    interceptPhoneAPI();
    
    // Wait for page to fully load
    setTimeout(() => {
      checkVisiblePhone();
      autoRevealPhone();
      sendListingData();
    }, 1500);
    
    // Try again after dynamic content loads
    setTimeout(() => {
      checkVisiblePhone();
      autoRevealPhone();
    }, 3000);
  }
  
  // Handle message from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'AUTO_SCRAPE') {
      scraped = false;
      init();
    }
  });
  
  // Run on page load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  
})();
