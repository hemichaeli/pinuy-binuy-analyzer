/**
 * yad2 Messenger Service - Puppeteer-based messaging
 * Sends messages to yad2 sellers via browser automation
 * Checks inbox for replies
 */

const puppeteer = require('puppeteer');
const { logger } = require('./logger');

const YAD2_BASE = 'https://www.yad2.co.il';
const YAD2_LOGIN_URL = `${YAD2_BASE}/login`;
const YAD2_INBOX_URL = `${YAD2_BASE}/my-messages`;

// Browser instance (reuse across calls)
let browser = null;
let page = null;
let isLoggedIn = false;

/**
 * Get or create browser instance
 */
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  
  logger.info('yad2Messenger: Launching browser...');
  browser = await puppeteer.launch({
    headless: 'new',
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
    await page.waitForTimeout(2000);
    
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
        || await page.$('a[href*="email"]')
        || await page.$('button:has-text("דואר אלקטרוני")');
      if (emailLoginBtn) {
        await emailLoginBtn.click();
        await page.waitForTimeout(1500);
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
    const submitSelectors = [
      'button[type="submit"]',
      'button[data-test="submit"]',
      'button:has-text("התחבר")',
      'button:has-text("כניסה")'
    ];
    
    for (const sel of submitSelectors) {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        break;
      }
    }
    
    await page.waitForTimeout(5000);
    
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
    await page.waitForTimeout(2000);
    
    // Look for "send message" / "שלח הודעה" button
    const msgBtnSelectors = [
      'button[data-test="send-message"]',
      'button:has-text("שלח הודעה")',
      'button:has-text("יצירת קשר")',
      'a:has-text("שלח הודעה")',
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
      } catch (e) { /* selector not valid, try next */ }
    }
    
    // If no dedicated button, try clicking on the contact area
    if (!msgBtn) {
      // Try XPath for Hebrew text
      const [xpathBtn] = await page.$x("//button[contains(., 'שלח הודעה')]");
      if (xpathBtn) msgBtn = xpathBtn;
    }
    
    if (!msgBtn) {
      // Try finding any chat/message textarea directly
      const textarea = await page.$('textarea[placeholder*="הודעה"]') || await page.$('textarea');
      if (textarea) {
        await textarea.type(messageText, { delay: 30 });
        
        // Find send button
        const sendBtn = await page.$('button[type="submit"]') 
          || await page.$('button:has-text("שלח")')
          || await page.$('button[class*="send"]');
        
        if (sendBtn) {
          await sendBtn.click();
          await page.waitForTimeout(3000);
          return { 
            success: true, 
            status: 'sent',
            message: 'Message sent successfully'
          };
        }
      }
      
      throw new Error('Message button/textarea not found on listing page');
    }
    
    await msgBtn.click();
    await page.waitForTimeout(2000);
    
    // Type message in textarea
    const textareaSelectors = [
      'textarea[placeholder*="הודעה"]',
      'textarea[name="message"]',
      'textarea',
      'div[contenteditable="true"]',
      'input[type="text"][placeholder*="הודעה"]'
    ];
    
    let textarea = null;
    for (const sel of textareaSelectors) {
      textarea = await page.$(sel);
      if (textarea) break;
    }
    
    if (!textarea) {
      throw new Error('Message textarea not found after clicking contact button');
    }
    
    await textarea.click();
    await textarea.type(messageText, { delay: 30 });
    await page.waitForTimeout(500);
    
    // Click send
    const sendSelectors = [
      'button[type="submit"]',
      'button:has-text("שלח")',
      'button[class*="send"]',
      'button[data-test="send"]',
      'button[aria-label="שלח"]'
    ];
    
    let sendBtn = null;
    for (const sel of sendSelectors) {
      try {
        sendBtn = await page.$(sel);
        if (sendBtn) break;
      } catch (e) { /* try next */ }
    }
    
    if (!sendBtn) {
      const [xpathSend] = await page.$x("//button[contains(., 'שלח')]");
      if (xpathSend) sendBtn = xpathSend;
    }
    
    if (!sendBtn) {
      throw new Error('Send button not found');
    }
    
    await sendBtn.click();
    await page.waitForTimeout(3000);
    
    // Check for success indicators
    const errorEl = await page.$('[class*="error"]');
    if (errorEl) {
      const errorText = await page.evaluate(el => el.textContent, errorEl);
      if (errorText && errorText.length > 0) {
        throw new Error(`yad2 error: ${errorText}`);
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
    await page.waitForTimeout(3000);
    
    // Extract conversations from inbox
    const conversations = await page.evaluate(() => {
      const items = [];
      // Try various selectors for message list items
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
    
    // Filter for unread/new messages
    const newReplies = [];
    for (const conv of conversations) {
      if (conv.hasUnread && conv.href) {
        // Navigate to conversation to read the reply
        try {
          await page.goto(conv.href, { waitUntil: 'networkidle2', timeout: 20000 });
          await page.waitForTimeout(2000);
          
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
          
          // Get the last incoming message
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
    browserRunning: browser !== null && browser.isConnected(),
    isLoggedIn,
    hasCredentials: !!(process.env.YAD2_EMAIL && process.env.YAD2_PASSWORD)
  };
}

module.exports = {
  login,
  sendMessage,
  checkReplies,
  cleanup,
  getStatus
};
