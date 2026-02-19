/**
 * Trello API Service for QUANTUM Lead Management
 * Creates cards in specific lists with proper labeling
 * 
 * Lists:
 *   - משקיעים (Investors)
 *   - מוכרים (Sellers)  
 *   - צור קשר (Contact Us)
 *   - התראות מערכת (System Notifications)
 * 
 * Labels (priority-based):
 *   - Urgent (red)      - highest value leads
 *   - Important (orange) - medium value leads
 *   - (no label)        - standard leads
 */

const { logger } = require('./logger');

const TRELLO_API_BASE = 'https://api.trello.com/1';
const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const TRELLO_BOARD_ID = process.env.TRELLO_BOARD_ID;

// Cache for list and label IDs
let listCache = {};
let labelCache = {};
let cacheTimestamp = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function trelloRequest(endpoint, method = 'GET', body = null) {
  if (!TRELLO_API_KEY || !TRELLO_TOKEN) {
    throw new Error('Trello API credentials not configured (TRELLO_API_KEY / TRELLO_TOKEN)');
  }

  const separator = endpoint.includes('?') ? '&' : '?';
  const url = `${TRELLO_API_BASE}${endpoint}${separator}key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;

  const options = {
    method,
    headers: { 'Accept': 'application/json' },
  };

  if (body && method !== 'GET') {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Trello API ${method} ${endpoint} failed: ${response.status} - ${text}`);
  }

  return response.json();
}

async function loadBoardData() {
  if (Date.now() - cacheTimestamp < CACHE_TTL && Object.keys(listCache).length > 0) {
    return;
  }

  if (!TRELLO_BOARD_ID) {
    throw new Error('TRELLO_BOARD_ID not configured');
  }

  const lists = await trelloRequest(`/boards/${TRELLO_BOARD_ID}/lists`);
  listCache = {};
  for (const list of lists) {
    listCache[list.name] = list.id;
  }

  const labels = await trelloRequest(`/boards/${TRELLO_BOARD_ID}/labels`);
  labelCache = {};
  for (const label of labels) {
    if (label.name) {
      labelCache[label.name] = label.id;
      labelCache[label.name.toLowerCase()] = label.id;
    }
  }

  cacheTimestamp = Date.now();
  logger.info('Trello board data cached', {
    lists: Object.keys(listCache),
    labels: Object.keys(labelCache).filter(k => k === k.toLowerCase())
  });
}

async function getListId(listName) {
  await loadBoardData();
  if (listCache[listName]) return listCache[listName];
  const match = Object.entries(listCache).find(([name]) =>
    name.includes(listName) || listName.includes(name)
  );
  if (match) return match[1];
  throw new Error(`Trello list "${listName}" not found. Available: ${Object.keys(listCache).join(', ')}`);
}

async function getLabelId(labelName) {
  await loadBoardData();
  if (labelCache[labelName]) return labelCache[labelName];
  if (labelCache[labelName.toLowerCase()]) return labelCache[labelName.toLowerCase()];
  const match = Object.entries(labelCache).find(([name]) =>
    name.toLowerCase().includes(labelName.toLowerCase()) ||
    labelName.toLowerCase().includes(name.toLowerCase())
  );
  if (match) return match[1];
  return null;
}

/**
 * Determine lead priority: 'urgent' | 'important' | 'none' 
 * Based on lead type and form data
 */
function getLeadPriority(userType, data) {
  if (userType === 'investor') {
    if (data.budget === '5m+') return 'urgent';
    if (data.hasMultipleInvestments === true && data.budget === '2m-5m') return 'urgent';
    if (data.budget === '2m-5m') return 'important';
    if (data.hasMultipleInvestments === true) return 'important';
    if ((data.areas || []).length >= 3) return 'important';
    return 'none';
  }

  if (userType === 'owner') {
    if (data.propertyType === 'building' || data.propertyType === 'commercial') return 'urgent';
    if (data.status === 'project' && data.hasMultipleProperties === true) return 'urgent';
    if (data.status === 'project') return 'important';
    if (data.hasMultipleProperties === true) return 'important';
    if (data.purpose === 'offer') return 'important';
    return 'none';
  }

  // Contact form leads have no priority by default
  return 'none';
}

/**
 * Get the Trello label name for a priority level.
 * Returns null for standard leads (no label).
 */
function getPriorityLabelName(priority) {
  switch (priority) {
    case 'urgent': return 'Urgent';
    case 'important': return 'Important';
    default: return null;
  }
}

async function createCard({ listName, title, description, labels = [], priority = 'none' }) {
  try {
    const listId = await getListId(listName);

    const cardData = {
      name: title,
      desc: description,
      idList: listId,
      pos: priority === 'urgent' ? 'top' : 'bottom',
    };

    const labelIds = [];

    // Add priority label only for urgent/important
    const priorityLabelName = getPriorityLabelName(priority);
    if (priorityLabelName) {
      const priorityLabelId = await getLabelId(priorityLabelName);
      if (priorityLabelId) {
        labelIds.push(priorityLabelId);
        logger.info(`Trello label: "${priorityLabelName}" applied to "${title}"`);
      }
    }

    // Add any extra labels
    for (const label of labels) {
      const labelId = await getLabelId(label);
      if (labelId && !labelIds.includes(labelId)) labelIds.push(labelId);
    }

    if (labelIds.length > 0) {
      cardData.idLabels = labelIds.join(',');
    }

    const card = await trelloRequest('/cards', 'POST', cardData);

    logger.info(`Trello card created: "${title}" in list "${listName}"`, {
      cardId: card.id, listId, priority, label: priorityLabelName || 'none', url: card.shortUrl
    });

    return { success: true, cardId: card.id, url: card.shortUrl, listName, priority };
  } catch (err) {
    logger.error(`Failed to create Trello card: ${err.message}`, { listName, title });
    return { success: false, error: err.message, listName, title };
  }
}

function extractFormData(lead) {
  const raw = lead.form_data || lead.formData;
  if (!raw) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return raw;
}

async function createInvestorCard(lead) {
  const { name, email, phone } = lead;
  const data = extractFormData(lead);

  const budgetMap = { '1-2m': '1-2 מיליון ₪', '1m-2m': '1-2 מיליון ₪', '2-5m': '2-5 מיליון ₪', '2m-5m': '2-5 מיליון ₪', '5m+': '5 מיליון ₪ ומעלה' };
  const horizonMap = { 'short': 'טווח קצר (1-3 שנים)', 'long': 'טווח ארוך (3+ שנים)' };
  const areaMap = { 'center': 'מרכז', 'sharon': 'השרון', 'north': 'צפון', 'south': 'דרום', 'jerusalem': 'ירושלים', 'haifa': 'חיפה והקריות' };

  const areas = (data.areas || []).map(a => areaMap[a] || a).join(', ');
  const budget = budgetMap[data.budget] || data.budget || 'לא צוין';
  const horizon = horizonMap[data.horizon || data.investmentHorizon] || data.horizon || data.investmentHorizon || 'לא צוין';
  const priority = getLeadPriority('investor', data);
  const priorityEmoji = priority === 'urgent' ? '🚨 ' : priority === 'important' ? '⚡ ' : '';

  const title = `${priorityEmoji}🏢 משקיע: ${name}`;
  const description = [
    `## פרטי משקיע חדש`, ``,
    `**שם:** ${name}`, `**טלפון:** ${phone}`, `**אימייל:** ${email}`, ``,
    `---`, ``,
    `**תקציב:** ${budget}`, `**אזורי עניין:** ${areas || 'לא צוינו'}`,
    `**אופק השקעה:** ${horizon}`,
    `**מספר נכסים:** ${data.hasMultipleInvestments ? 'כן' : 'לא'}`, ``,
    `---`, `*נכנס: ${new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}*`
  ].join('\n');

  return createCard({ listName: 'משקיעים', title, description, priority });
}

async function createSellerCard(lead) {
  const { name, email, phone } = lead;
  const data = extractFormData(lead);

  const propertyTypeMap = { 'residential': 'דירת מגורים', 'building': 'בניין שלם', 'commercial': 'נכס מסחרי' };
  const purposeMap = { 'rights': 'בדיקת זכויות', 'offer': 'רכישה מהירה', 'management': 'ניהול' };
  const statusMap = { 'project': 'יש פרויקט התחדשות', 'no-info': 'אין מידע תכנוני' };

  const addresses = (data.addresses || []).map(a => `${a.street} ${a.buildingNumber}, ${a.city}`).join('\n  - ');
  const propertyType = propertyTypeMap[data.propertyType] || data.propertyType || 'לא צוין';
  const purpose = purposeMap[data.purpose] || data.purpose || 'לא צוין';
  const status = statusMap[data.status] || data.status || 'לא צוין';
  const priority = getLeadPriority('owner', data);
  const priorityEmoji = priority === 'urgent' ? '🚨 ' : priority === 'important' ? '⚡ ' : '';

  const title = `${priorityEmoji}🏠 מוכר: ${name} - ${(data.addresses || [])[0]?.city || 'עיר לא צוינה'}`;
  const description = [
    `## פרטי מוכר חדש`, ``,
    `**שם:** ${name}`, `**טלפון:** ${phone}`, `**אימייל:** ${email}`, ``,
    `---`, ``,
    `**כתובות:**`, `  - ${addresses || 'לא צוינה'}`, ``,
    `**סוג נכס:** ${propertyType}`, `**מטרה:** ${purpose}`,
    `**סטטוס תכנוני:** ${status}`,
    `**מספר נכסים:** ${data.hasMultipleProperties ? 'כן' : 'נכס אחד'}`, ``,
    `---`, `*נכנס: ${new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}*`
  ].join('\n');

  return createCard({ listName: 'מוכרים', title, description, priority });
}

async function createContactCard(lead) {
  const { name, email, phone } = lead;
  const data = extractFormData(lead);
  const message = data.message || data.notes || '';
  const subject = data.subject || '';

  const title = `📩 ${name}${subject ? ' - ' + subject : ''}`;
  const description = [
    `## פנייה חדשה - צור קשר`, ``,
    `**שם:** ${name}`,
    `**טלפון:** ${phone}`,
    `**אימייל:** ${email}`, ``,
    `---`, ``,
    message ? `**הודעה:**\n${message}` : '*ללא הודעה*', ``,
    `---`, `*נכנס: ${new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}*`
  ].join('\n');

  return createCard({ listName: 'צור קשר', title, description });
}

async function createNotificationCard(title, message) {
  return createCard({
    listName: 'התראות מערכת',
    title: `📬 ${title}`,
    description: [message, '', `---`, `*${new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}*`].join('\n')
  });
}

function isConfigured() {
  return !!(TRELLO_API_KEY && TRELLO_TOKEN && TRELLO_BOARD_ID);
}

async function getStatus() {
  if (!isConfigured()) {
    return {
      configured: false,
      missing: [
        !TRELLO_API_KEY && 'TRELLO_API_KEY',
        !TRELLO_TOKEN && 'TRELLO_TOKEN',
        !TRELLO_BOARD_ID && 'TRELLO_BOARD_ID'
      ].filter(Boolean)
    };
  }
  try {
    await loadBoardData();
    return { configured: true, boardId: TRELLO_BOARD_ID, lists: Object.keys(listCache), labels: Object.entries(labelCache).filter(([k]) => k !== k.toLowerCase() || !labelCache[k.charAt(0).toUpperCase() + k.slice(1)]).map(([name, id]) => ({ name, id })) };
  } catch (err) {
    return { configured: true, error: err.message };
  }
}

module.exports = {
  createCard, createInvestorCard, createSellerCard, createContactCard, createNotificationCard,
  isConfigured, getStatus, loadBoardData, getListId, getLabelId, getLeadPriority
};
