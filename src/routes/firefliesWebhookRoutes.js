/**
 * Fireflies.ai Webhook Handler for QUANTUM
 * 
 * Receives POST from Fireflies when a meeting is completed.
 * Creates a Trello card in "התראות מערכת" with meeting summary + action items.
 * 
 * Fireflies webhook events:
 *   - Transcription completed
 *   - Meeting uploaded  
 * 
 * Setup in Fireflies:
 *   Settings -> Integrations -> Webhooks -> Add webhook
 *   URL: https://pinuy-binuy-analyzer-production.up.railway.app/api/fireflies/webhook
 */

const express = require('express');
const router = express.Router();
const { logger } = require('../services/logger');
const trelloService = require('../services/trelloService');

/**
 * POST /webhook - Receive Fireflies event
 */
router.post('/webhook', async (req, res) => {
  // Respond immediately (Fireflies expects fast response)
  res.json({ received: true });

  try {
    const payload = req.body;
    logger.info('Fireflies webhook received', {
      event: payload.event_type || payload.type || 'unknown',
      meeting: payload.title || payload.meetingId || 'unknown'
    });

    await handleFirefliesEvent(payload);

  } catch (err) {
    logger.error('Fireflies webhook error:', err.message);
  }
});

/**
 * Process Fireflies event and create Trello card
 */
async function handleFirefliesEvent(payload) {
  // Fireflies sends different payload structures - handle both
  const eventType = payload.event_type || payload.type || 'TranscriptReady';
  const title = payload.title || payload.meetingTitle || 'פגישה ללא שם';
  const meetingId = payload.meetingId || payload.id || '';
  
  // Date
  const rawDate = payload.date || payload.startTime || payload.created_at;
  const meetingDate = rawDate
    ? new Date(rawDate).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short' })
    : new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short' });

  // Participants
  const participants = (payload.participants || payload.attendees || [])
    .map(p => p.displayName || p.name || p.email || p)
    .filter(Boolean)
    .join(', ');

  // Duration
  const durationMin = payload.duration
    ? Math.round(payload.duration / 60)
    : payload.durationMinutes || null;

  // Summary
  const summary = payload.summary?.overview
    || payload.summary
    || payload.transcript_summary
    || '';

  // Action items
  const actionItems = (
    payload.action_items ||
    payload.summary?.action_items ||
    payload.summary?.tasks ||
    []
  ).slice(0, 8); // Max 8 items

  // Key decisions / keywords
  const keywords = (payload.keywords || payload.topics || []).slice(0, 5).join(', ');

  // Build Trello card
  const cardTitle = `🎙️ פגישה: ${title} - ${meetingDate}`;

  const descLines = [
    `## 🎙️ סיכום פגישה חדש מ-Fireflies`,
    ``,
    `**פגישה:** ${title}`,
    `**תאריך:** ${meetingDate}`,
    durationMin ? `**משך:** ${durationMin} דקות` : null,
    participants ? `**משתתפים:** ${participants}` : null,
    meetingId ? `**ID:** ${meetingId}` : null,
    ``,
    `---`,
    ``,
  ];

  if (summary) {
    descLines.push(`## 📝 סיכום`);
    descLines.push(summary.substring(0, 800));
    descLines.push(``);
  }

  if (actionItems.length > 0) {
    descLines.push(`## ✅ משימות ופעולות`);
    actionItems.forEach((item, i) => {
      const text = item.text || item.description || item.task || String(item);
      const assignee = item.assignee || item.owner || '';
      descLines.push(`${i + 1}. ${text}${assignee ? ` (${assignee})` : ''}`);
    });
    descLines.push(``);
  }

  if (keywords) {
    descLines.push(`**נושאים עיקריים:** ${keywords}`);
    descLines.push(``);
  }

  // Add Fireflies link if available
  const fireflyUrl = payload.url || payload.meetingUrl || payload.fireflies_url || '';
  if (fireflyUrl) {
    descLines.push(`[🔗 פתח ב-Fireflies](${fireflyUrl})`);
    descLines.push(``);
  }

  descLines.push(`---`);
  descLines.push(`*נכנס: ${new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}*`);

  const description = descLines.filter(l => l !== null).join('\n');

  // Determine urgency (if action items exist -> important)
  const priority = actionItems.length > 0 ? 'important' : 'none';

  const result = await trelloService.createCard({
    listName: 'התראות מערכת',
    title: cardTitle,
    description,
    priority
  });

  if (result.success) {
    logger.info(`Fireflies -> Trello card created: "${cardTitle}"`, { cardId: result.cardId, url: result.url });
  } else {
    logger.error(`Fireflies -> Trello FAILED: ${result.error}`);
  }

  return result;
}

/**
 * GET /health - Check webhook status
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    webhook_url: 'https://pinuy-binuy-analyzer-production.up.railway.app/api/fireflies/webhook',
    trello_configured: trelloService.isConfigured(),
    instructions: 'Set this URL in Fireflies: Settings -> Integrations -> Webhooks'
  });
});

/**
 * POST /test - Simulate a Fireflies event (dev testing)
 */
router.post('/test', async (req, res) => {
  try {
    const testPayload = req.body.payload || {
      event_type: 'TranscriptReady',
      title: 'פגישת QUANTUM - לקוח פוטנציאלי',
      date: new Date().toISOString(),
      duration: 1800,
      participants: [
        { displayName: 'הלקוח שלי' },
        { displayName: 'נציג QUANTUM' }
      ],
      summary: {
        overview: 'פגישת היכרות עם משקיע מעוניין בפינוי-בינוי בתל אביב. הלקוח מחפש נכס עם פוטנציאל תשואה גבוה.',
        action_items: [
          { text: 'לשלוח רשימת מתחמים בת"א', assignee: 'QUANTUM' },
          { text: 'לתאם פגישה נוספת תוך שבוע', assignee: 'שני הצדדים' }
        ]
      },
      keywords: ['פינוי-בינוי', 'תל אביב', 'השקעה', 'תשואה']
    };

    const { createCard } = trelloService;
    const result = await handleFirefliesEvent(testPayload);

    res.json({
      success: true,
      message: 'Test event processed',
      trello: result,
      payload_used: testPayload
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
