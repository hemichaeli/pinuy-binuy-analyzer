// Madlan.co.il Content Script - Phone Extractor
(function() {
  'use strict';
  
  const SOURCE = 'madlan';
  let scraped = false;
  
  function getListingId() {
    const match = window.location.pathname.match(/\/listing\/([^\/\?]+)/);
    return match ? match[1] : null;
  }
  
  function interceptPhoneAPI() {
    const origFetch = window.fetch;
    window.fetch = function(url, options) {
      const urlStr = typeof url === 'string' ? url : (url.url || '');
      return origFetch.apply(this, arguments).then(response => {
        if (urlStr.includes('phone') || urlStr.includes('contact') || urlStr.includes('seller')) {
          response.clone().json().then(data => {
            // Madlan GraphQL or REST response
            const phone = data.phone || data.phoneNumber || 
                          data.data?.listing?.phone || 
                          data.data?.contact?.phone;
            const name = data.name || data.data?.listing?.contactName;
            if (phone) {
              console.log('[MADLAN] Phone intercepted:', phone);
              chrome.runtime.sendMessage({
                type: 'PHONE_FOUND',
                data: {
                  source: SOURCE,
                  source_listing_id: getListingId(),
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
  
  function autoRevealPhone() {
    const selectors = [
      '[class*="phone-button"]',
      '[class*="phoneButton"]',
      '[class*="contact-button"]',
      'button[class*="phone"]',
      '[data-testid*="phone"]'
    ];
    
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn && !btn.dataset.clicked) {
        btn.dataset.clicked = 'true';
        console.log('[MADLAN] Auto-clicking phone button');
        btn.click();
        break;
      }
    }
    
    // Also try Hebrew text buttons
    const btns = document.querySelectorAll('button');
    for (const btn of btns) {
      const text = btn.textContent.trim();
      if ((text.includes('טלפון') || text.includes('הצג') || text.includes('חייג')) && !btn.dataset.clicked) {
        btn.dataset.clicked = 'true';
        btn.click();
        break;
      }
    }
  }
  
  function checkVisiblePhone() {
    const listingId = getListingId();
    if (!listingId) return;
    
    const phoneRegex = /0[5-9]\d[-\s]?\d{3}[-\s]?\d{4}|0[2-4]\d[-\s]?\d{3}[-\s]?\d{4}/g;
    const phones = document.body.innerText.match(phoneRegex);
    
    if (phones && phones.length > 0) {
      const phone = phones[0].replace(/\s/g, '-');
      chrome.runtime.sendMessage({
        type: 'PHONE_FOUND',
        data: { source: SOURCE, source_listing_id: listingId, url: window.location.href, phone }
      });
    }
  }
  
  function extractAndSendListing() {
    const listingId = getListingId();
    if (!listingId || scraped) return;
    scraped = true;
    
    const data = { source: SOURCE, url: window.location.href, source_listing_id: listingId };
    
    const priceEl = document.querySelector('[class*="price"]');
    if (priceEl) {
      const p = priceEl.textContent.replace(/[^\d]/g, '');
      if (p.length > 4) data.price = parseInt(p);
    }
    
    const h1 = document.querySelector('h1');
    if (h1) data.title = h1.textContent.trim();
    
    chrome.runtime.sendMessage({ type: 'LISTING_FOUND', data });
  }
  
  function init() {
    if (!getListingId()) return;
    interceptPhoneAPI();
    
    setTimeout(() => {
      checkVisiblePhone();
      autoRevealPhone();
      extractAndSendListing();
    }, 2000);
    
    setTimeout(() => { checkVisiblePhone(); autoRevealPhone(); }, 4000);
  }
  
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'AUTO_SCRAPE') { scraped = false; init(); }
  });
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
