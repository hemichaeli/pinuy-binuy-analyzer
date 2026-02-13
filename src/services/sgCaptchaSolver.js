/**
 * SiteGround PoW CAPTCHA Solver
 * 
 * SiteGround uses Proof-of-Work challenge (SHA1 with leading zero bits).
 * This is NOT a visual CAPTCHA - it's a computational puzzle that browsers
 * solve via Web Workers. We replicate the same computation server-side.
 * 
 * Flow:
 * 1. Request site -> get 202 + meta redirect to sgcaptcha
 * 2. Fetch challenge page -> extract sgchallenge string
 * 3. Solve PoW: find nonce where SHA1(challenge+nonce) has N leading zero bits
 * 4. Submit solution -> get session cookie (_I_)
 * 5. Use cookie for all subsequent requests
 */

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { logger } = require('./logger');

class SgCaptchaSolver {
  constructor() {
    this.cookies = {};
    this.lastSolveTime = null;
    this.sessionValid = false;
  }

  /**
   * Solve a SiteGround PoW challenge
   * @param {string} challengeStr - e.g. "20:timestamp:hex:hash:"
   * @returns {{ solution: string, elapsed: number, hashes: number } | null}
   */
  solvePow(challengeStr) {
    const complexity = parseInt(challengeStr.split(':')[0]);
    const challengeBytes = Buffer.from(challengeStr, 'utf-8');
    const mask = complexity >= 32 ? 0 : (0xFFFFFFFF << (32 - complexity)) >>> 0;
    
    let counter = 0;
    const start = Date.now();
    const maxAttempts = 50000000;
    
    while (counter < maxAttempts) {
      let numBytes = 1;
      if (counter > 16777215) numBytes = 4;
      else if (counter > 65535) numBytes = 3;
      else if (counter > 255) numBytes = 2;
      
      const counterBuf = Buffer.alloc(numBytes);
      let temp = counter;
      for (let i = numBytes - 1; i >= 0; i--) {
        counterBuf[i] = temp & 0xff;
        temp >>>= 8;
      }
      
      const combined = Buffer.concat([challengeBytes, counterBuf]);
      const hash = crypto.createHash('sha1').update(combined).digest();
      const firstWord = hash.readUInt32BE(0);
      
      if ((firstWord & mask) === 0) {
        return {
          solution: combined.toString('base64'),
          elapsed: Date.now() - start,
          hashes: counter
        };
      }
      counter++;
    }
    
    return null;
  }

  /**
   * HTTP request with cookie support
   */
  httpRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const mod = parsed.protocol === 'https:' ? https : http;
      
      const cookieStr = Object.entries(this.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
      
      const reqOptions = {
        method: options.method || 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
          ...(cookieStr ? { 'Cookie': cookieStr } : {}),
          ...(options.headers || {})
        },
        timeout: options.timeout || 20000
      };
      
      if (options.body) {
        reqOptions.headers['Content-Type'] = options.contentType || 'application/x-www-form-urlencoded';
        reqOptions.headers['Content-Length'] = Buffer.byteLength(options.body);
      }
      
      const req = mod.request(url, reqOptions, (res) => {
        // Parse and store cookies
        const setCookies = res.headers['set-cookie'] || [];
        for (const cookie of setCookies) {
          const match = cookie.match(/^([^=]+)=([^;]*)/);
          if (match) this.cookies[match[1]] = match[2];
        }
        
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body
        }));
      });
      
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  /**
   * Follow redirect chain (up to maxRedirects)
   */
  async httpRequestFollow(url, options = {}, maxRedirects = 5) {
    let currentUrl = url;
    for (let i = 0; i < maxRedirects; i++) {
      const res = await this.httpRequest(currentUrl, options);
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        currentUrl = new URL(res.headers.location, currentUrl).href;
        options = { ...options, method: 'GET', body: undefined };
        continue;
      }
      return res;
    }
    throw new Error('Too many redirects');
  }

  /**
   * Bypass SiteGround CAPTCHA for a given base URL
   */
  async bypassCaptcha(baseUrl = 'https://konesisrael.co.il') {
    try {
      logger.info('SG-CAPTCHA: Step 1 - Initial request...');
      const initial = await this.httpRequest(baseUrl + '/');
      
      const metaMatch = initial.body.match(/content="0;([^"]+)"/);
      if (!metaMatch) {
        if (initial.status === 200 && !initial.headers['sg-captcha']) {
          logger.info('SG-CAPTCHA: No captcha needed');
          this.sessionValid = true;
          return true;
        }
        return false;
      }
      
      logger.info('SG-CAPTCHA: Step 2 - Fetching challenge...');
      const captchaUrl = new URL(metaMatch[1], baseUrl).href;
      const challengePage = await this.httpRequest(captchaUrl);
      
      const sgMatch = challengePage.body.match(/sgchallenge="([^"]+)"/);
      const submitMatch = challengePage.body.match(/sgsubmit_url="([^"]+)"/);
      
      if (!sgMatch) return false;
      
      const challenge = sgMatch[1];
      const submitUrl = submitMatch ? submitMatch[1] : '/.well-known/sgcaptcha/?r=%2F';
      logger.info(`SG-CAPTCHA: Challenge (complexity=${parseInt(challenge.split(':')[0])})`);
      
      logger.info('SG-CAPTCHA: Step 3 - Solving PoW...');
      const sol = this.solvePow(challenge);
      if (!sol) return false;
      logger.info(`SG-CAPTCHA: Solved in ${sol.elapsed}ms (${sol.hashes} hashes)`);
      
      logger.info('SG-CAPTCHA: Step 4 - Submitting...');
      const sep = submitUrl.includes('?') ? '&' : '?';
      const solUrl = `${baseUrl}${submitUrl}${sep}sol=${encodeURIComponent(sol.solution)}&s=${sol.elapsed}:${sol.hashes}`;
      
      await this.httpRequestFollow(solUrl);
      
      if (this.cookies['_I_']) {
        logger.info('SG-CAPTCHA: Session established!');
        this.sessionValid = true;
        this.lastSolveTime = Date.now();
        return true;
      }
      
      return false;
    } catch (error) {
      logger.error(`SG-CAPTCHA: ${error.message}`);
      return false;
    }
  }

  /**
   * Login to WordPress with credentials
   */
  async wpLogin(email, password, baseUrl = 'https://konesisrael.co.il') {
    try {
      if (!this.sessionValid) {
        const bypassed = await this.bypassCaptcha(baseUrl);
        if (!bypassed) return false;
      }
      
      logger.info('WP-LOGIN: Submitting credentials...');
      this.cookies['wordpress_test_cookie'] = 'WP+Cookie+check';
      
      const loginBody = [
        `log=${encodeURIComponent(email)}`,
        `pwd=${encodeURIComponent(password)}`,
        'wp-submit=Log+In',
        `redirect_to=${encodeURIComponent(baseUrl + '/')}`,
        'testcookie=1'
      ].join('&');
      
      const result = await this.httpRequest(`${baseUrl}/wp-login.php`, {
        method: 'POST',
        body: loginBody,
        contentType: 'application/x-www-form-urlencoded'
      });
      
      const hasWpCookie = Object.keys(this.cookies).some(k => 
        k.startsWith('wordpress_logged_in') || k.startsWith('wordpress_sec')
      );
      
      if (hasWpCookie || result.status === 302) {
        logger.info('WP-LOGIN: Success!');
        if (result.headers.location) {
          await this.httpRequestFollow(new URL(result.headers.location, baseUrl).href);
        }
        return true;
      }
      
      const errorMatch = result.body.match(/id="login_error"[^>]*>(.*?)<\/div/s);
      if (errorMatch) logger.error(`WP-LOGIN: ${errorMatch[1].replace(/<[^>]+>/g, '').trim()}`);
      
      return false;
    } catch (error) {
      logger.error(`WP-LOGIN: ${error.message}`);
      return false;
    }
  }

  /**
   * Fetch page with active session (re-solves CAPTCHA if needed)
   */
  async fetchPage(url) {
    try {
      const res = await this.httpRequest(url);
      if (res.body.includes('sgchallenge') || res.headers['sg-captcha']) {
        logger.info('SG-CAPTCHA: Re-solving...');
        this.sessionValid = false;
        const bypassed = await this.bypassCaptcha(new URL(url).origin);
        if (!bypassed) return null;
        return await this.httpRequest(url);
      }
      return res;
    } catch (error) {
      logger.error(`Fetch error: ${error.message}`);
      return null;
    }
  }

  getStatus() {
    return {
      sessionValid: this.sessionValid,
      lastSolveTime: this.lastSolveTime ? new Date(this.lastSolveTime).toISOString() : null,
      cookieCount: Object.keys(this.cookies).length,
      hasSgCookie: !!this.cookies['_I_'],
      hasWpCookie: Object.keys(this.cookies).some(k => k.startsWith('wordpress_logged_in'))
    };
  }

  resetSession() {
    this.cookies = {};
    this.sessionValid = false;
    this.lastSolveTime = null;
  }
}

module.exports = new SgCaptchaSolver();
