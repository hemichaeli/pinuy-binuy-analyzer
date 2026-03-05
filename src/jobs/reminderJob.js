/**
 * QUANTUM Reminder Job
 * Runs every minute, processes reminder_queue
 * Updates Zoho CRM status on no-answer events
 */

const pool = require('../db/pool');
const inforuService = require('../services/inforuService');
const zoho = require('../services/zohoSchedulingService');
const { logger } = require('../services/logger');

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
  const lang = data.language || 'he';
  const S = STRINGS[lang] || STRINGS.he;
  const contactName = data.contactName || '';
  const campaignName = data.campaignName || zoho_campaign_id;

  let message = null;

  switch (reminder_type) {

    case 'reminder_24h':
      message = S.reminder_24h(contactName, campaignName);
      // Update Zoho: no answer after 24h
      zoho.markNoAnswer(zoho_campaign_id, zoho_contact_id, 24).catch(() => {});
      break;

    case 'bot_followup_48h':
      message = S.bot_followup_48h(contactName, campaignName);
      // Update Zoho: no answer after 48h
      zoho.markNoAnswer(zoho_campaign_id, zoho_contact_id, 48).catch(() => {});
      // Reset session so bot flow restarts fresh
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

    default:
      logger.warn(`[ReminderJob] Unknown type: ${reminder_type}`);
  }

  if (message) {
    await inforuService.sendWhatsApp(phone, message);
    // Log outgoing reminder in Zoho
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

module.exports = { processReminderQueue };
