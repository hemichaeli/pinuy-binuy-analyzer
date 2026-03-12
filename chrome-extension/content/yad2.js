// Yad2.co.il Content Script - Phone Extractor
(function() {
  'use strict';
  
  const SOURCE = 'yad2';
  let scraped = false;
  
  function getListingId() {
    // Yad2 URLs: /item/XXXXX or /realestate/forsale/item/XXXXX
    const match = window.location.pathname.match(/\/item\/([a-zA-Z0-9]+)/);
    return match ? match[1] : null;
  }
  
  function extractListingData() {
    const data = {
      source: SOURCE,
      url: window.location.href,
      source_listing_id: getListingId()
    };
    
    // Price - Yad2 uses data-testid or specific class names
    const priceEl = document.querySelector('[data-testid="price"], .price, [class*="price"]');
    if (priceEl) {
      const priceText = priceEl.textContent.replace(/[^\d]/g, '');
      if (priceText.length > 4) data.price = parseInt(priceText);
    }
    
    // Rooms
    const roomsEl = document.querySelector('[data-testid="rooms"], [class*="rooms"]');
    if (roomsEl) {
      const match = roomsEl.textContent.match(/(\d+(?:\.\d+)?)/);
      if (match) data.rooms = parseFloat(match[1]);
    }
    
    // Area
    const areaEl = document.querySelector('[data-testid="area"], [class*="area"]');
    if (areaEl) {
      const match = areaEl.textContent.match(/(\d+)/);
      if (match) data.area = parseInt(match[1]);
    }
    
    // Floor
    const floorEl = document.querySelector('[data-testid="floor"], [class*="floor"]');
    if (floorEl) {
      const match = floorEl.textContent.match(/(\d+)/);
      if (match) data.floor = parseInt(match[1]);
    }
    
    // Address
    const addressEl = document.querySelector('[data-testid="address"], [class*="address"]');
    if (addressEl) data.address = addressEl.textContent.trim();
    
    // City
    const cityEl = document.querySelector('[data-testid="city"], [class*="city"]');
    if (cityEl) data.city = cityEl.textContent.trim();
    
    // Title
    const titleEl = document.querySelector('h1');
    if (titleEl) data.title = titleEl.textContent.trim();
    
    // Description
    const descEl = document.querySelector('[data-testid="description"], [class*="description"]');
    if (descEl) data.description = descEl.textContent.trim().substring(0, 500);
    
    return data;
  }
  
  // Intercept API calls for phone reveal
  function interceptPhoneAPI() {
    const listingId = getListingId();
    if (!listingId) return;
    
    const origFetch = window.fetch;
    window.fetch = function(url, options) {
      const urlStr = typeof url === 'string' ? url : (url.url || '');
      return origFetch.apply(this, arguments).then(response => {
        // Yad2 phone endpoints
        if (urlStr.includes('/phone') || urlStr.includes('contact') || urlStr.includes('seller')) {
          response.clone().json().then(data => {
            // Try various phone field names
            const phone = data.phone || data.phoneNumber || data.contact_phone || 
                          data.seller_phone || data.data?.phone;
            const name = data.name || data.contact_name || data.seller_name || 
                         data.data?.name;
            if (phone) {
              console.log('[YAD2] Phone intercepted:', phone);
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
    
    // XHR intercept
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
      this._url = url;
      return origOpen.apply(this, [method, url, ...args]);
    };
    
    XMLHttpRequest.prototype.send = function(...args) {
      this.addEventListener('load', function() {
        if (this._url && (this._url.includes('/phone') || this._url.includes('contact'))) {
          try {
            const data = JSON.parse(this.responseText);
            const phone = data.phone || data.phoneNumber || data.contact_phone;
            if (phone) {
              console.log('[YAD2] Phone intercepted (XHR):', phone);
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
          } catch(e) {}
        }
      });
      return origSend.apply(this, args);
    };
  }
  
  function autoRevealPhone() {
    // Yad2 phone reveal buttons
    const selectors = [
      '[data-testid="phone-button"]',
      '[class*="phone-button"]',
      '[class*="phoneButton"]',
      'button[class*="phone"]',
      '[class*="show-phone"]',
      '[class*="showPhone"]',
      'button[class*="contact"]'
    ];
    
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn && !btn.dataset.clicked) {
        btn.dataset.clicked = 'true';
        console.log('[YAD2] Auto-clicking phone button:', sel);
        btn.click();
        break;
      }
    }
  }
  
  function checkVisiblePhone() {
    const listingId = getListingId();
    if (!listingId) return;
    
    const phoneRegex = /0[5-9]\d[-\s]?\d{3}[-\s]?\d{4}|0[2-4]\d[-\s]?\d{3}[-\s]?\d{4}/g;
    const pageText = document.body.innerText;
    const phones = pageText.match(phoneRegex);
    
    if (phones && phones.length > 0) {
      const phone = phones[0].replace(/\s/g, '-');
      console.log('[YAD2] Phone found on page:', phone);
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
  
  function init() {
    const listingId = getListingId();
    if (!listingId) return;
    
    console.log('[YAD2] Initializing for listing:', listingId);
    interceptPhoneAPI();
    
    setTimeout(() => {
      checkVisiblePhone();
      autoRevealPhone();
      sendListingData();
    }, 2000);
    
    setTimeout(() => {
      checkVisiblePhone();
      autoRevealPhone();
    }, 4000);
  }
  
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'AUTO_SCRAPE') {
      scraped = false;
      init();
    }
  });
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  
})();
