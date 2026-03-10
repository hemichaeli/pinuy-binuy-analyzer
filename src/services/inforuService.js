const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

/**
 * INFORU SMS + WhatsApp Service for QUANTUM
 * SMS: UAPI XML endpoint
 * WhatsApp: CAPI v2 REST endpoint
 *
 * Per-project credentials:
 *   Pass options.credentials = { username, password } to any send function
 *   to override the global INFORU_USERNAME / INFORU_PASSWORD env vars.
 *   Used when each מיזם (project) has its own יזם (developer) with a
 *   separate INFORU WhatsApp sender account.
 */

const INFORU_XML_URL = 'https://uapi.inforu.co.il/SendMessageXml.ashx';
const INFORU_CAPI_BASE = 'https://capi.inforu.co.il/api/v2';
const DEFAULT_SENDER = '037572229';

// --- SMS Templates (free-text) ---
const SMS_TEMPLATES = {
  seller_initial: {
    name: 'פנייה ראשונית למוכר',
    template: `שלום {name},\nראיתי שיש לך נכס למכירה ב{address}, {city}.\nאני מ