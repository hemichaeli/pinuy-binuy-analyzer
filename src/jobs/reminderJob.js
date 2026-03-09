/**
 * QUANTUM Reminder Job
 * Runs every minute, processes reminder_queue
 * Types: reminder_24h, bot_followup_48h, pre_meeting_24h, pre_meeting_2h, reschedule_call
 */

const pool = require('../db/pool');
const inforuService = require('../services/inforuService');
const zoho = require('../services/zohoSchedulingService');
const { logger } = require('../services/logger');
const axios = require('axios');

const STRINGS = {
  he: {
    reminder_24h: (name, campaign) =>
      `שלום ${name} 👋\nQUANTUM כאן.\n\nעדיין לא קיבלנו ממך תשובה לגבי *${campaign}*.\nענה/י *1* ונתאם עכשיו.`,
    bot_followup_48h: (name, campaign) =>
      `שלום ${name} 👋\nQUANTUM שוב.\n\nזו ההזדמנות האחרונה לתאם את *${campaign}*.\nענה/י *1* ונסגור מיד.`,
    pre_meeting_24h: (name, type, date, time) =>
      `שלום ${name} 👋\n*תזכורת:* ${type} מחר\n📅 ${date} ⏰ ${time}\n\nלביטול/שינוי - ענה/י 0.`,
    pre_meeting_2h: (name, type, time) =>
      `שלום ${name} 👋\nבעוד כ-2 שעות: *${type}* ב-⏰ ${time}\n\nנתראה! 🤝`
  },
  ru: {
    reminder_24h: (name, campaign) =>
      `Здравствуйте, ${name} 👋\nQUANTUM на связи.\n\nМы ещё не получили ваш ответ по *${campaign}*.\nНажмите *1* для записи.`,
    bot_followup_48h: (name, campaign) =>
      `Здравствуйте, ${name} 👋\nQUANTUM снова.\n\nПоследний шанс записаться на *${campaign}*.\nНажмите *1* прямо сейчас.`,
    pre_meeting_24h: (name, type, date, time) =>
      `Здравствуйте, ${name} 👋\n*Напоминание:* ${type} завтра\n📅 ${date} ⏰ ${time}\n\nДля отмены/переноса - ответьте 0.`,
    pre_meeting_2h: (name, type, time) =>
      `Здравствуйте, ${name} 👋\nЧерез ~2 часа: *${type}* в ⏰ ${time}\n\nДо встречи! 🤝`
  }
};

async function processReminderQueue() {
  const now = new Date();
  const res = await pool.query(
    `SELECT rq.*, csc.meeting_type, csc.reminder_delay_hours, csc.bot_followup_delay_hours
     FROM reminder_queue rq
     LEFT JOIN campaign_schedule_config csc ON rq.zoho_campaign_id = csc.zoho_campaign_id
     WHERE rq.status='pending' AND rq.scheduled_at <= $1
     ORDER BY rq.scheduled_at ASC LIMIT 50`,
    [now]
  );

  for (const reminder of res.rows) {
    try {
      await processOne(reminder);
    } catch (err) {
      logger.error(`[ReminderJob] Failed id=${reminder.id}:`, err.message);
      await pool.query(`UPDATE reminder_queue SET status='failed' WHERE id=$1`, [reminder.id]);
    }
  }
}

async function processOne(reminder) {
  const { id, phone, reminder_type, payload, zoho_campaign_id, zoho_contact_id } = reminder;
  const data = (typeof payload === 'string' ? JSON.parse(payload) : payload) || {};
  const lang = data.language || data.lang || 'he';
  const S = STRINGS[lang] || STRINGS.he;
  const contactName = data.contactName || data.name || '';
  const campaignName = data.campaignName || zoho_campaign_id;

  let message = null;

  switch (reminder_type) {

    case 'reminder_24h':
      message = S.reminder_24h(contactName, campaignName);
      zoho.markNoAnswer(zoho_campaign_id, zoho_contact_id, 24).catch(() => {});
      break;

    case 'bot_followup_48h':
      message = S.bot_followup_48h(contactName, campaignName);
      zoho.markNoAnswer(zoho_campaign_id, zoho_contact_id, 48).catch(() => {});
      await pool.query(
        `UPDATE bot_sessions SET state='confirm_identity', context='{}' WHERE phone=$1 AND zoho_campaign_id=$2`,
        [phone, zoho_campaign_id]
      );
      break;

    case 'pre_meeting_24h':
      message = S.pre_meeting_24h(contactName, data.meetingType || '', data.meetingDate || '', data.meetingTime || '');
      break;

    case 'pre_meeting_2h':
      message = S.pre_meeting_2h(contactName, data.meetingType || '', data.meetingTime || '');
      break;

    case 'reschedule_call':
      await handleRescheduleCall(reminder, data);
      break;

    default:
      logger.warn(`[ReminderJob] Unknown type: ${reminder_type}`);
  }

  if (message) {
    await inforuService.sendWhatsApp(phone, message);
    zoho.logIncomingMessage({
      campaignId: zoho_campaign_id,
      contactId: zoho_contact_id,
      phone,
      messageContent: message,
      direction: 'יוצאת',
      subject: `תזכורת - ${reminder_type}`
    }).catch(() => {});
  }

  await pool.query(`UPDATE reminder_queue SET status='sent', sent_at=NOW() WHERE id=$1`, [id]);
}

// ── Reschedule call via Vapi ──────────────────────────────────────────────────
// Called 2h after WA offer was sent with no reply.
// Checks the reschedule_request is still pending before calling.

async function handleRescheduleCall(reminder, data) {
  const { phone, zoho_campaign_id } = reminder;
  const { reschedule_request_id, lang, name, origTime, propTime, propDate } = data;

  // Verify request is still pending (user may have replied by now)
  if (reschedule_request_id) {
    const reqRes = await pool.query(
      `SELECT status FROM reschedule_requests WHERE id=$1`,
      [reschedule_request_id]
    );
    if (reqRes.rows.length && reqRes.rows[0].status !== 'pending') {
      logger.info(`[ReminderJob] reschedule_call skipped — req #${reschedule_request_id} already ${reqRes.rows[0].status}`);
      return;
    }
  }

  const apiKey = process.env.VAPI_API_KEY;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  const assistantId = process.env.VAPI_ASSISTANT_RESCHEDULE || process.env.VAPI_ASSISTANT_APPOINTMENT || process.env.VAPI_ASSISTANT_REMINDER;

  if (!apiKey || !phoneNumberId || !assistantId) {
    logger.warn(`[ReminderJob] reschedule_call: Vapi not configured (VAPI_API_KEY/PHONE_NUMBER_ID/VAPI_ASSISTANT_RESCHEDULE). Skipping call for ${phone}`);
    return;
  }

  // Normalize phone to international format
  const normalized = phone.replace(/\D/g, '');
  const intlPhone = normalized.startsWith('972') ? `+${normalized}` : normalized.startsWith('0') ? `+972${normalized.slice(1)}` : `+${normalized}`;

  const systemPromptOverride = lang === 'ru'
    ? `Вы представитель QUANTUM. Имя клиента: ${name || 'клиент'}.
Вы позвонили, потому что предложили перенести встречу.
Текущее время: ${origTime}. Предложенное: ${propTime} (${propDate}).
Спросите: "Хотите перенести встречу на ${propTime}? Нажмите 1 — да, 2 — нет".
Язык: русский. Разговор короткий, до 1 минуты.`
    : `אתה נציג QUANTUM. שם הלקוח: ${name || 'שלום'}.
התקשרת כי הצעת לשנות פגישה.
המועד הנוכחי: ${origTime}. הצעת: ${propTime} (${propDate}).
שאל: "האם תרצה לעבור ל-${propTime}? ענה 1 - כן, 2 - לא".
שפה: עברית. שיחה קצרה, עד דקה.`;

  try {
    const resp = await axios.post('https://api.vapi.ai/call/phone', {
      phoneNumberId,
      assistantId,
      customer: { number: intlPhone, name: name || undefined },
      assistantOverrides: {
        firstMessage: lang === 'ru'
          ? `Здравствуйте${name ? `, ${name}` : ''}! Это QUANTUM. Я звоню по поводу переноса встречи на ${propTime}. Удобно говорить?`
          : `שלום${name ? ` ${name}` : ''}! כאן QUANTUM. אני מתקשר לגבי העברת הפגישה ל-${propTime}. נוח לדבר?`,
        model: {
          messages: [{ role: 'system', content: systemPromptOverride }]
        },
        metadata: {
          reschedule_request_id,
          campaign_id: zoho_campaign_id,
          quantum_source: 'reschedule_vapi_fallback'
        }
      }
    }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    });

    logger.info(`[ReminderJob] Vapi reschedule call initiated: ${resp.data?.id} to ${intlPhone} for req #${reschedule_request_id}`);

    // Log call in vapi_calls if table exists
    pool.query(
      `INSERT INTO vapi_calls (call_id, phone, agent_type, status, metadata, created_at)
       VALUES ($1, $2, 'reschedule_call', 'initiated', $3, NOW())
       ON CONFLICT (call_id) DO NOTHING`,
      [resp.data?.id, phone, JSON.stringify({ reschedule_request_id, campaign_id: zoho_campaign_id })]
    ).catch(() => {});

  } catch (err) {
    logger.error(`[ReminderJob] Vapi reschedule call failed for ${intlPhone}: ${err.response?.data?.message || err.message}`);
    // Don't throw — we still mark the reminder as sent so it doesn't retry endlessly
  }
}

module.exports = { processReminderQueue };
