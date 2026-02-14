/**
 * yad2 Messenger Service - Puppeteer-based messaging
 * Sends messages to yad2 sellers via browser automation
 * Checks inbox for replies
 * Uses puppeteer-core with system Chromium
 */

const puppeteer = require('puppeteer-core');
const { logger } = require('./logger');

const YAD2_BASE = 'https://www.yad2.co.il';
const YAD2_LOGIN_URL = `${YAD2_BASE}/login`;
const YAD2_INBOX_URL = `${YAD2_BASE}/my-messages`;

// Chromium path - set by Dockerfile/nixpacks env var
const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH 
  || process.env.CHROMIUM_PATH 
  || '/usr/bin/chromium'
  || '/usr/bin/chromium-browser';

// Browser instance (reuse across calls)
let browser = null;
let page = null;
let isLoggedIn = false;

/**
 * Get or create browser instance
 */
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  
  logger.info('yad2Messenger: Launching browser...', { chromiumPath: CHROMIUM_PATH });
  browser = await puppeteer.launch({
    headless: 'new',
    executablePath: CHROMIUM_PATH,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--single-process',
      '--no-zygote',
      '--lang=he-IL'
    ],
    defaultViewport: { width: 1280, height: 900 }
  });
  
  page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'he-IL,he;q=0.9' });
  isLoggedIn = false;
  
  return browser;
}

/**
 * Login to yad2
 */
async function login() {
  const email = process.env.YAD2_EMAIL;
  const password = process.env.YAD2_PASSWORD;
  
  if (!email || !password) {
    throw new Error('YAD2_EMAIL and YAD2_PASSWORD env vars required');
  }
  
  await getBrowser();
  logger.info('yad2Messenger: Logging in...');
  
  try {
    await page.goto(YAD2_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
    
    // Try multiple login form selectors (yad2 changes their UI)
    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[placeholder*="מייל"]',
      'input[placeholder*="email"]',
      '#email',
      'input[data-test="email"]'
    ];
    
    let emailInput = null;
    for (const sel of emailSelectors) {
      emailInput = await page.$(sel);
      if (emailInput) break;
    }
    
    if (!emailInput) {
      // Maybe there's a "login with email" button first
      const emailLoginBtn = await page.$('button[data-test="email-login"]') 
        || await page.$('a[href*="email"]');
      if (emailLoginBtn) {
        await emailLoginBtn.click();
        await new Promise(r => setTimeout(r, 1500));
        for (const sel of emailSelectors) {
          emailInput = await page.$(sel);
          if (emailInput) break;
        }
      }
    }
    
    if (!emailInput) {
      const html = await page.content();
      logger.error('yad2Messenger: Login form not found', { html: html.substring(0, 500) });
      throw new Error('Login form not found - yad2 may have changed their UI');
    }
    
    await emailInput.type(email, { delay: 50 });
    
    const passwordSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      '#password'
    ];
    
    let passwordInput = null;
    for (const sel of passwordSelectors) {
      passwordInput = await page.$(sel);
      if (passwordInput) break;
    }
    
    if (passwordInput) {
      await passwordInput.type(password, { delay: 50 });
    }
    
    // Click submit
    const submitBtn = await page.$('button[type="submit"]') || await page.$('button[data-test="submit"]');
    if (submitBtn) {
      await submitBtn.click();
    }
    
    await new Promise(r => setTimeout(r, 5000));
    
    // Verify login success
    const currentUrl = page.url();
    const cookies = await page.cookies();
    const hasAuthCookie = cookies.some(c => c.name.includes('token') || c.name.includes('session') || c.name.includes('auth'));
    
    if (hasAuthCookie || !currentUrl.includes('login')) {
      isLoggedIn = true;
      logger.info('yad2Messenger: Login successful');
      return { success: true };
    }
    
    throw new Error('Login verification failed - may need CAPTCHA or 2FA');
  } catch (err) {
    logger.error('yad2Messenger: Login failed', { error: err.message });
    isLoggedIn = false;
    throw err;
  }
}

/**
 * Send a message to a yad2 listing
 * @param {string} listingUrl - yad2 item URL
 * @param {string} messageText - Message to send
 * @returns {Object} Result with status
 */
async function sendMessage(listingUrl, messageText) {
  if (!isLoggedIn) {
    await login();
  }
  
  logger.info('yad2Messenger: Sending message', { url: listingUrl });
  
  try {
    // Navigate to listing page
    await page.goto(listingUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
    
    // Look for contact/message button
    const msgBtnSelectors = [
      'button[data-test="send-message"]',
      '[class*="contact"] button',
      '[class*="message"] button',
      'button[class*="chat"]',
      'button[class*="contact"]'
    ];
    
    let msgBtn = null;
    for (const sel of msgBtnSelectors) {
      try {
        msgBtn = await page.$(sel);
        if (msgBtn) break;
      } catch (e) { /* selector not valid */ }
    }
    
    // Try XPath for Hebrew text buttons
    if (!msgBtn) {
      const xpathBtns = await page.$x("//button[contains(., 'שלח הודעה')] | //button[contains(., 'יצירת קשר')] | //a[contains(., 'שלח הודעה')]");
      if (xpathBtns.length > 0) msgBtn = xpathBtns[0];
    }
    
    // Check if textarea is already visible (some layouts show it directly)
    let textarea = await page.$('textarea[placeholder*="הודעה"]') || await page.$('textarea');
    
    if (!textarea && msgBtn) {
      await msgBtn.click();
      await new Promise(r => setTimeout(r, 2000));
      textarea = await page.$('textarea[placeholder*="הודעה"]') || await page.$('textarea') || await page.$('div[contenteditable="true"]');
    }
    
    if (!textarea) {
      throw new Error('Message textarea not found on listing page');
    }
    
    await textarea.click();
    await textarea.type(messageText, { delay: 30 });
    await new Promise(r => setTimeout(r, 500));
    
    // Click send
    let sendBtn = await page.$('button[type="submit"]') || await page.$('button[class*="send"]') || await page.$('button[data-test="send"]');
    
    if (!sendBtn) {
      const xpathSend = await page.$x("//button[contains(., 'שלח')]");
      if (xpathSend.length > 0) sendBtn = xpathSend[0];
    }
    
    if (!sendBtn) {
      throw new Error('Send button not found');
    }
    
    await sendBtn.click();
    await new Promise(r => setTimeout(r, 3000));
    
    // Check for errors
    const errorEl = await page.$('[class*="error"]');
    if (errorEl) {
      const errorText = await page.evaluate(el => el.textContent, errorEl);
      if (errorText && errorText.trim().length > 0) {
        throw new Error(`yad2 error: ${errorText.trim()}`);
      }
    }
    
    logger.info('yad2Messenger: Message sent successfully', { url: listingUrl });
    return { 
      success: true, 
      status: 'sent',
      message: 'Message sent successfully',
      timestamp: new Date().toISOString()
    };
    
  } catch (err) {
    logger.error('yad2Messenger: Send failed', { url: listingUrl, error: err.message });
    return { 
      success: false, 
      status: 'failed',
      error: err.message 
    };
  }
}

/**
 * Check inbox for replies to our messages
 * @returns {Array} List of new messages
 */
async function checkReplies() {
  if (!isLoggedIn) {
    await login();
  }
  
  logger.info('yad2Messenger: Checking inbox for replies...');
  
  try {
    await page.goto(YAD2_INBOX_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));
    
    // Extract conversations from inbox
    const conversations = await page.evaluate(() => {
      const items = [];
      const selectors = [
        '[class*="conversation"]',
        '[class*="message-item"]',
        '[class*="chat-item"]',
        '[class*="inbox"] li',
        '[class*="messages-list"] > div'
      ];
      
      for (const sel of selectors) {
        const elements = document.querySelectorAll(sel);
        if (elements.length > 0) {
          elements.forEach(el => {
            const text = el.textContent || '';
            const link = el.querySelector('a');
            items.push({
              text: text.substring(0, 300),
              href: link ? link.href : null,
              hasUnread: el.classList.contains('unread') || el.querySelector('[class*="unread"]') !== null
            });
          });
          break;
        }
      }
      return items;
    });
    
    logger.info(`yad2Messenger: Found ${conversations.length} conversations`);
    
    // Read unread conversations
    const newReplies = [];
    for (const conv of conversations) {
      if (conv.hasUnread && conv.href) {
        try {
          await page.goto(conv.href, { waitUntil: 'networkidle2', timeout: 20000 });
          await new Promise(r => setTimeout(r, 2000));
          
          const messages = await page.evaluate(() => {
            const msgs = [];
            const msgElements = document.querySelectorAll('[class*="message"]');
            msgElements.forEach(el => {
              const isIncoming = el.classList.contains('incoming') 
                || el.classList.contains('received')
                || !el.classList.contains('sent');
              msgs.push({
                text: el.textContent?.substring(0, 500) || '',
                incoming: isIncoming
              });
            });
            return msgs;
          });
          
          const lastIncoming = messages.reverse().find(m => m.incoming);
          if (lastIncoming) {
            newReplies.push({
              conversation_url: conv.href,
              preview: conv.text.substring(0, 100),
              reply_text: lastIncoming.text,
              timestamp: new Date().toISOString()
            });
          }
        } catch (e) {
          logger.warn('yad2Messenger: Failed to read conversation', { href: conv.href, error: e.message });
        }
      }
    }
    
    return {
      success: true,
      total_conversations: conversations.length,
      new_replies: newReplies
    };
    
  } catch (err) {
    logger.error('yad2Messenger: Check replies failed', { error: err.message });
    return { success: false, error: err.message, new_replies: [] };
  }
}

/**
 * Close browser and cleanup
 */
async function cleanup() {
  if (browser) {
    try {
      await browser.close();
    } catch (e) { /* ignore */ }
    browser = null;
    page = null;
    isLoggedIn = false;
  }
}

/**
 * Get login status
 */
function getStatus() {
  return {
    browserRunning: browser !== null && (browser.isConnected ? browser.isConnected() : false),
    isLoggedIn,
    hasCredentials: !!(process.env.YAD2_EMAIL && process.env.YAD2_PASSWORD),
    chromiumPath: CHROMIUM_PATH
  };
}

module.exports = {
  login,
  sendMessage,
  checkReplies,
  cleanup,
  getStatus
};
