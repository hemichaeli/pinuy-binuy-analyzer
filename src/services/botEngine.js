/**
 * QUANTUM Bot Engine v2
 * Fixes:
 *  1. NULL campaignId SQL bug (IS NOT DISTINCT FROM)
 *  2. Combined date+time slot selection (1 step instead of 2)
 *  3. Google Calendar link in confirmation
 *  4. Graceful handling of confirmed/closed states
 */

const pool = require('../db/pool');
const inforuService = require('./inforuService');
const zoho = require('./zohoSchedulingService');
const { logger } = require('./logger');

// ── Google Calendar link builder ──────────────────────────────
function buildGCalLink(title, datetimeStr, durationMins = 45, location = '') {
  try {
    const start = new Date(datetimeStr);
    const end = new Date(start.getTime() + durationMins * 60000);
    const fmt = (d) => d.toISOString().replace(/[-:.]/g, '').substring(0, 15) + 'Z';
    const base = 'https://calendar.google.com/calendar/render?action=TEMPLATE';
    const params = `&text=${encodeURIComponent(title)}&dates=${fmt(start)}/${fmt(end)}&location=${encodeURIComponent(location)}&sf=true`;
    return base + params;
  } catch (e) {
    return null;
  }
}

const STRINGS = {
  he: {
    confirmIdentity: (name) => `שלום ${name} 👋\nאני הבוט של QUANTUM.\n\nרק לאימות - האם אתה/את ${name}?\n1️⃣ כן\n2️⃣ לא, מדובר בטעות`,
    wrongPerson: `מצטערים על הבלבול. נשמח אם תעביר/י את ההודעה לבעל הדירה הרשום. תודה 🙏`,
    ceremonyIntro: (name, ceremony) =>
      `${name}, כנס החתימות לפרויקט *${ceremony.projectName}* יתקיים ב:\n📅 ${ceremony.dateStr}\n📍 ${ceremony.location}\n\nנשמח לראותך! האם תוכל/י להגיע?\n1️⃣ כן, אגיע\n2️⃣ לא אוכל להגיע\n3️⃣ עדיין לא יודע/ת`,
    ceremonySelectSlot: (slots) => {
      let msg = `מעולה! בחר/י שעה נוחה:\n\n`;
      slots.forEach((s, i) => { msg += `${i + 1}️⃣ ${String(s.time).substring(0,5)}\n`; });
      return msg;
    },
    ceremonySlotTaken: `השעה שבחרת כבר תפוסה 😔 אנא בחר/י שעה אחרת:`,
    ceremonyConfirm: (date, time, location, rep, gcalLink) => {
      let msg = `✅ *ביקור שמאי נקבע!*\n\n📅 ${date}\n⏰ ${String(time).substring(0,5)}\n📍 ${location}\n👤 נציג: ${rep}\n\nתקבל/י תזכורת יום לפני. להתראות! 👋`;
      if (gcalLink) msg += `\n\n📆 הוסף ליומן: ${gcalLink}`;
      return msg;
    },
    ceremonyDeclined: `תודה שעדכנת אותנו. נציג שלנו ייצור איתך קשר בהקדם.`,
    ceremonyMaybe: `מובן. נחזור אליך קרוב לתאריך הכנס לאישור סופי.`,
    meetingIntro: (name, type) => `שלום ${name} 👋\nQUANTUM כאן.\n\nנשמח לתאם *${type}* עבור דירתך.\n\nבחר/י מועד נוח:`,
    selectSlot: (slots) => {
      let msg = `\n\n`;
      slots.forEach((s, i) => {
        const dayName = (s.day_name || '').trim();
        msg += `${i + 1}️⃣ ${dayName} ${s.date_str} ⏰ ${s.time} — ${s.rep_name || ''}\n`;
      });
      return msg;
    },
    meetingConfirm: (type, date, time, rep, gcalLink) => {
      let msg = `✅ *${type} נקבעה!*\n\n📅 ${date}\n⏰ ${String(time).substring(0,5)}\n👤 ${rep}\n\nתקבל/י תזכורת יום לפני. להתראות! 👋`;
      if (gcalLink) msg += `\n\n📆 הוסף ליומן: ${gcalLink}`;
      return msg;
    },
    alreadyConfirmed: (date, time) => `✅ הפגישה שלך כבר נקבעה ל-${date} ⏰ ${time}.\n\nלשינויים - פנה/י ישירות לנציג QUANTUM.`,
    noSlots: `כרגע אין חלונות זמן פנויים. נציג שלנו ייצור איתך קשר בהקדם.`,
    invalidChoice: `לא הבנתי את הבחירה. אנא הקלד/י את המספר המתאים.`,
    error: `אירעה שגיאה טכנית. אנא נסה/י שוב מאוחר יותר.`
  },
  ru: {
    confirmIdentity: (name) => `Здравствуйте, ${name} 👋\nЯ бот QUANTUM.\n\nДля подтверждения - вы ${name}?\n1️⃣ Да\n2️⃣ Нет, это ошибка`,
    wrongPerson: `Извините за беспокойство. Пожалуйста, передайте сообщение зарегистрированному владельцу квартиры. Спасибо 🙏`,
    ceremonyIntro: (name, ceremony) =>
      `${name}, церемония подписания проекта *${ceremony.projectName}*:\n📅 ${ceremony.dateStr}\n📍 ${ceremony.location}\n\nСможете прийти?\n1️⃣ Да, приду\n2️⃣ Не смогу\n3️⃣ Ещё не знаю`,
    ceremonySelectSlot: (slots) => {
      let msg = `Отлично! Выберите удобное время:\n\n`;
      slots.forEach((s, i) => { msg += `${i + 1}️⃣ ${String(s.time).substring(0,5)}\n`; });
      return msg;
    },
    ceremonySlotTaken: `Это время уже занято 😔 Пожалуйста, выберите другое:`,
    ceremonyConfirm: (date, time, location, rep, gcalLink) => {
      let msg = `✅ *Встреча назначена!*\n\n📅 ${date}\n⏰ ${String(time).substring(0,5)}\n📍 ${location}\n👤 Представитель: ${rep}\n\nНапомним за сутки. До встречи! 👋`;
      if (gcalLink) msg += `\n\n📆 Добавить в календарь: ${gcalLink}`;
      return msg;
    },
    ceremonyDeclined: `Спасибо за уведомление. Наш представитель свяжется с вами в ближайшее время.`,
    ceremonyMaybe: `Понятно. Мы свяжемся с вами ближе к дате церемонии.`,
    meetingIntro: (name, type) => `Здравствуйте, ${name} 👋\nQUANTUM на связи.\n\nГотовы записать вас на *${type}*.\n\nВыберите удобное время:`,
    selectSlot: (slots) => {
      let msg = `\n\n`;
      slots.forEach((s, i) => {
        const dayName = (s.day_name || '').trim();
        msg += `${i + 1}️⃣ ${dayName} ${s.date_str} ⏰ ${s.time} — ${s.rep_name || ''}\n`;
      });
      return msg;
    },
    meetingConfirm: (type, date, time, rep, gcalLink) => {
      let msg = `✅ *${type} назначена!*\n\n📅 ${date}\n⏰ ${String(time).substring(0,5)}\n👤 ${rep}\n\nНапомним за сутки. До встречи! 👋`;
      if (gcalLink) msg += `\n\n📆 Добавить в календарь: ${gcalLink}`;
      return msg;
    },
    alreadyConfirmed: (date, time) => `✅ Встреча уже назначена на ${date} ⏰ ${time}.\n\nДля изменений — обратитесь к представителю QUANTUM.`,
    noSlots: `Свободных слотов нет. Наш представитель свяжется с вами в ближайшее время.`,
    invalidChoice: `Не понял выбор. Пожалуйста, введите номер из предложенных.`,
    error: `Произошла техническая ошибка. Попробуйте позже.`
  }
};

const MEETING_TYPE_LABELS = {
  he: { consultation:'פגישת ייעוץ', physical:'פגישה פיזית במשרד', appraiser:'ביקור שמאי', surveyor:'ביקור מודד', signing_ceremony:'כנס חתימות' },
  ru: { consultation:'Консультация', physical:'Встреча в офисе', appraiser:'Визит оценщика', surveyor:'Визит геодезиста', signing_ceremony:'Церемония подписания' }
};

const DAY_NAMES_HE = { Sunday:'ראשון', Monday:'שני', Tuesday:'שלישי', Wednesday:'רביעי', Thursday:'חמישי', Friday:'שישי', Saturday:'שבת' };
const DAY_NAMES_RU = { Sunday:'Воскресенье', Monday:'Понедельник', Tuesday:'Вторник', Wednesday:'Среда', Thursday:'Четверг', Friday:'Пятница', Saturday:'Суббота' };

class BotEngine {

  // ── ENTRY POINT ──────────────────────────────────────────────
  async handleIncoming(phone, messageText, campaignId) {
    try {
      const session = await this.getOrCreateSession(phone, campaignId);
      this._zohoLog(session, messageText, 'נכנסת').catch(() => {});
      const reply = await this.processState(session, messageText.trim());
      await this.saveSession(session);
      if (reply) this._zohoLog(session, reply, 'יוצאת').catch(() => {});
      return reply;
    } catch (err) {
      logger.error('[BotEngine] Error:', err);
      return null;
    }
  }

  // ── SESSION ───────────────────────────────────────────────────
  // FIX: Use IS NOT DISTINCT FROM to handle NULL campaignId correctly
  async getOrCreateSession(phone, campaignId) {
    const res = await pool.query(
      `SELECT * FROM bot_sessions WHERE phone=$1 AND zoho_campaign_id IS NOT DISTINCT FROM $2`,
      [phone, campaignId]
    );
    if (res.rows.length > 0) {
      const s = res.rows[0];
      s.context = typeof s.context === 'string' ? JSON.parse(s.context) : (s.context || {});
      return s;
    }

    let contactId = null, contactName = '', lang = 'he';
    try {
      const contact = await zoho.findContactByPhone(phone);
      if (contact) {
        contactId = contact.id;
        contactName = contact.Full_Name || '';
        if (contact.Language === 'Russian' || contact.Language === 'ru') lang = 'ru';
      }
    } catch (e) {
      logger.warn('[BotEngine] Zoho contact lookup failed:', e.message);
    }

    const ins = await pool.query(
      `INSERT INTO bot_sessions (phone, zoho_contact_id, zoho_campaign_id, language, state, context)
       VALUES ($1,$2,$3,$4,'confirm_identity',$5) RETURNING *`,
      [phone, contactId, campaignId, lang, JSON.stringify({ contactName })]
    );
    const s = ins.rows[0];
    s.context = { contactName };
    this._zohoStatus(s, 'bot_sent').catch(() => {});

    // Send identity confirmation immediately
    const confirmMsg = STRINGS[lang].confirmIdentity(contactName || 'שלום');
    await inforuService.sendWhatsApp(phone, confirmMsg);

    return s;
  }

  // ── STATE MACHINE ─────────────────────────────────────────────
  async processState(session, msg) {
    const lang = session.language || 'he';
    const S = STRINGS[lang];
    const ctx = session.context;
    const state = session.state;

    // ── ALREADY CONFIRMED / CLOSED ───────────────────────────────
    if (state === 'confirmed') {
      const slot = ctx.confirmedSlot || {};
      const dateStr = slot.dateStr || slot.date_str || '';
      const time = String(slot.time || '').substring(0, 5);
      return S.alreadyConfirmed(dateStr, time);
    }
    if (state === 'closed' || state === 'ceremony_declined' || state === 'ceremony_maybe') {
      return null; // Silent - no reply needed
    }

    // ── CONFIRM IDENTITY ────────────────────────────────────────
    if (state === 'confirm_identity') {
      if (msg === '1') {
        this._zohoStatus(session, 'answered').catch(() => {});
        const config = await this.getCampaignConfig(session.zoho_campaign_id);
        ctx.config = config;

        if (config.meeting_type === 'signing_ceremony') {
          const ceremony = await this.getActiveCeremony(session.zoho_campaign_id);
          if (!ceremony) return S.noSlots;
          ctx.ceremony = ceremony;
          session.state = 'ceremony_confirm_attendance';
          return S.ceremonyIntro(ctx.contactName || '', ceremony);
        } else {
          // FIX: Combine date+time into one selection step
          const slots = await this.getAllAvailableSlots(session.zoho_campaign_id);
          if (!slots.length) return S.noSlots;
          ctx.availableSlots = slots;
          session.state = 'meeting_select_slot';
          const typeLabel = (MEETING_TYPE_LABELS[lang] || MEETING_TYPE_LABELS.he)[config.meeting_type] || config.meeting_type;
          return S.meetingIntro(ctx.contactName || '', typeLabel) + S.selectSlot(slots);
        }
      } else if (msg === '2') {
        session.state = 'closed';
        this._zohoStatus(session, 'answered', 'לא זוהה כבעל הדירה').catch(() => {});
        return S.wrongPerson;
      }
      // Resend identity question on invalid input
      return S.confirmIdentity(ctx.contactName || 'שלום');
    }

    // ── CEREMONY: CONFIRM ATTENDANCE ────────────────────────────
    if (state === 'ceremony_confirm_attendance') {
      if (msg === '1') {
        this._zohoStatus(session, 'answered', 'אישר הגעה לכנס - בוחר שעה').catch(() => {});
        const slots = await this.getCeremonySlots(ctx.ceremony.id);
        if (!slots.length) return S.noSlots;
        ctx.availableSlots = slots;
        session.state = 'ceremony_select_slot';
        return S.ceremonySelectSlot(slots);
      } else if (msg === '2') {
        session.state = 'ceremony_declined';
        this._zohoStatus(session, 'declined', 'סירב להגיע לכנס חתימות').catch(() => {});
        return S.ceremonyDeclined;
      } else if (msg === '3') {
        session.state = 'ceremony_maybe';
        this._zohoStatus(session, 'maybe', 'לא בטוח אם יגיע').catch(() => {});
        return S.ceremonyMaybe;
      }
      return S.invalidChoice;
    }

    // ── CEREMONY: SELECT SLOT ────────────────────────────────────
    if (state === 'ceremony_select_slot') {
      const idx = parseInt(msg) - 1;
      const slots = ctx.availableSlots || [];
      if (isNaN(idx) || idx < 0 || idx >= slots.length) return S.invalidChoice;

      const chosen = slots[idx];
      const locked = await this.lockSlot(chosen.slot_id, session);
      if (!locked) {
        const fresh = await this.getCeremonySlots(ctx.ceremony.id);
        ctx.availableSlots = fresh;
        return S.ceremonySlotTaken + '\n' + S.ceremonySelectSlot(fresh);
      }

      ctx.confirmedSlot = chosen;
      session.state = 'confirmed';

      const meetingDt = `${chosen.slot_date} ${chosen.time}`;
      const typeLabel = (MEETING_TYPE_LABELS[lang] || MEETING_TYPE_LABELS.he)['signing_ceremony'];
      const gcalLink = buildGCalLink(
        `QUANTUM - ${typeLabel}`,
        meetingDt, 30,
        ctx.ceremony.location || ''
      );

      this._zohoStatus(session, 'confirmed',
        `אישר כנס חתימות: ${chosen.dateStr} ${String(chosen.time).substring(0,5)}`).catch(() => {});
      this._zohoActivity(session, 'signing_ceremony', meetingDt, chosen).catch(() => {});
      await this.scheduleReminders(session, meetingDt);

      return S.ceremonyConfirm(chosen.dateStr, chosen.time, ctx.ceremony.location, chosen.repName || '', gcalLink);
    }

    // ── MEETING: SELECT COMBINED SLOT (date+time in one step) ───
    if (state === 'meeting_select_slot') {
      const idx = parseInt(msg) - 1;
      const slots = ctx.availableSlots || [];
      if (isNaN(idx) || idx < 0 || idx >= slots.length) {
        return S.invalidChoice + '\n' + S.selectSlot(slots);
      }

      const chosen = slots[idx];
      const locked = await this.lockMeetingSlot(chosen.id, session);
      if (!locked) {
        const fresh = await this.getAllAvailableSlots(session.zoho_campaign_id);
        if (!fresh.length) return S.noSlots;
        ctx.availableSlots = fresh;
        return S.ceremonySlotTaken + S.selectSlot(fresh);
      }

      session.state = 'confirmed';
      ctx.confirmedSlot = chosen;

      const typeLabel = (MEETING_TYPE_LABELS[lang] || MEETING_TYPE_LABELS.he)[ctx.config?.meeting_type] || '';
      const gcalTitle = `QUANTUM - ${typeLabel}`;
      const gcalLink = buildGCalLink(gcalTitle, chosen.slot_datetime, 45, '');

      this._zohoStatus(session, 'confirmed',
        `אישר ${typeLabel}: ${chosen.date_str} ${chosen.time}`).catch(() => {});
      this._zohoActivity(session, ctx.config?.meeting_type, chosen.slot_datetime, chosen).catch(() => {});
      await this.scheduleReminders(session, chosen.slot_datetime);

      return S.meetingConfirm(typeLabel, `${chosen.day_name_he || ''} ${chosen.date_str}`, chosen.time, chosen.rep_name || '', gcalLink);
    }

    return S.error;
  }

  // ── ZOHO HELPERS ──────────────────────────────────────────────
  async _zohoStatus(session, status, notes = '') {
    try {
      await zoho.updateCampaignContactStatus(session.zoho_campaign_id, session.zoho_contact_id, status, notes);
    } catch (e) { logger.warn('[BotEngine] Zoho status update failed:', e.message); }
  }

  async _zohoLog(session, content, direction) {
    try {
      await zoho.logIncomingMessage({
        campaignId: session.zoho_campaign_id,
        contactId: session.zoho_contact_id,
        contactName: session.context?.contactName || '',
        phone: session.phone,
        messageContent: content,
        direction,
        subject: `BOT - ${session.state}`
      });
    } catch (e) { logger.warn('[BotEngine] Zoho message log failed:', e.message); }
  }

  async _zohoActivity(session, meetingType, meetingDatetime, slotData) {
    try {
      await zoho.createMeetingActivity({
        contactId: session.zoho_contact_id,
        campaignId: session.zoho_campaign_id,
        meetingType,
        meetingDatetime,
        representativeName: slotData?.rep_name || slotData?.repName || '',
        location: session.context?.ceremony?.location || ''
      });
    } catch (e) { logger.warn('[BotEngine] Zoho activity creation failed:', e.message); }
  }

  // ── DB HELPERS ────────────────────────────────────────────────
  // FIX: New combined slots query (date+time+rep in one step)
  async getAllAvailableSlots(campaignId) {
    const res = await pool.query(
      `SELECT id, slot_datetime,
              TO_CHAR(slot_datetime AT TIME ZONE 'Asia/Jerusalem', 'Day') AS day_name,
              TO_CHAR(slot_datetime AT TIME ZONE 'Asia/Jerusalem', 'DD/MM') AS date_str,
              TO_CHAR(slot_datetime AT TIME ZONE 'Asia/Jerusalem', 'HH24:MI') AS time,
              representative_name AS rep_name
       FROM meeting_slots
       WHERE campaign_id=$1 AND status='open' AND slot_datetime > NOW()
       ORDER BY slot_datetime LIMIT 8`,
      [campaignId]
    );
    // Add Hebrew day names
    return res.rows.map(r => ({
      ...r,
      day_name: (r.day_name || '').trim(),
      day_name_he: DAY_NAMES_HE[(r.day_name || '').trim()] || (r.day_name || '').trim()
    }));
  }

  async lockSlot(slotId, session) {
    const res = await pool.query(
      `UPDATE ceremony_slots SET status='confirmed', reserved_at=NOW(),
       contact_phone=$1, zoho_contact_id=$2
       WHERE id=$3 AND status='open' RETURNING id`,
      [session.phone, session.zoho_contact_id, slotId]
    );
    return res.rows.length > 0;
  }

  async lockMeetingSlot(slotId, session) {
    const res = await pool.query(
      `UPDATE meeting_slots SET status='confirmed', reserved_at=NOW(),
       contact_phone=$1, zoho_contact_id=$2
       WHERE id=$3 AND status='open' RETURNING id`,
      [session.phone, session.zoho_contact_id, slotId]
    );
    return res.rows.length > 0;
  }

  async getCeremonySlots(ceremonyId) {
    const res = await pool.query(
      `SELECT cs.id AS slot_id, cs.slot_time AS time, cs.slot_date,
              TO_CHAR(cs.slot_date,'DD/MM/YYYY') AS "dateStr",
              cst.representative_name AS "repName"
       FROM ceremony_slots cs
       JOIN ceremony_stations cst ON cs.station_id = cst.id
       WHERE cs.ceremony_id=$1 AND cs.status='open'
       ORDER BY cs.slot_time LIMIT 20`,
      [ceremonyId]
    );
    return res.rows;
  }

  async getActiveCeremony(campaignId) {
    const res = await pool.query(
      `SELECT sc.*, p.name AS "projectName", TO_CHAR(sc.ceremony_date,'DD/MM/YYYY') AS "dateStr"
       FROM signing_ceremonies sc
       JOIN projects p ON sc.project_id = p.id
       WHERE sc.zoho_campaign_id=$1 AND sc.status='scheduled' AND sc.ceremony_date >= CURRENT_DATE
       ORDER BY sc.ceremony_date LIMIT 1`,
      [campaignId]
    );
    return res.rows[0] || null;
  }

  async getCampaignConfig(campaignId) {
    const res = await pool.query(
      `SELECT * FROM campaign_schedule_config WHERE zoho_campaign_id=$1`,
      [campaignId]
    );
    return res.rows[0] || {};
  }

  async scheduleReminders(session, meetingDatetime) {
    const config = await this.getCampaignConfig(session.zoho_campaign_id);
    const pre24h = config.pre_meeting_reminder_hours || 24;
    const pre2h = config.morning_reminder_hours || 2;
    const meetingDate = new Date(meetingDatetime);
    const now = new Date();

    for (const r of [
      { type: 'pre_meeting_24h', at: new Date(meetingDate.getTime() - pre24h * 3600000) },
      { type: 'pre_meeting_2h',  at: new Date(meetingDate.getTime() - pre2h * 3600000) }
    ]) {
      if (r.at > now) {
        await pool.query(
          `INSERT INTO reminder_queue (phone, zoho_contact_id, zoho_campaign_id, reminder_type, scheduled_at, payload)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [session.phone, session.zoho_contact_id, session.zoho_campaign_id, r.type, r.at,
           JSON.stringify({ meetingDatetime, language: session.language,
             contactName: session.context?.contactName || '' })]
        );
      }
    }
  }

  async scheduleFollowupSequence(phone, campaignId, contactId, config) {
    const delay1 = config.reminder_delay_hours || 24;
    const delay2 = config.bot_followup_delay_hours || 48;
    const now = new Date();
    await pool.query(
      `INSERT INTO reminder_queue (phone, zoho_contact_id, zoho_campaign_id, reminder_type, scheduled_at)
       VALUES ($1,$2,$3,'reminder_24h',$4), ($1,$2,$3,'bot_followup_48h',$5) ON CONFLICT DO NOTHING`,
      [phone, contactId, campaignId,
       new Date(now.getTime() + delay1 * 3600000),
       new Date(now.getTime() + delay2 * 3600000)]
    );
  }

  async saveSession(session) {
    await pool.query(
      `UPDATE bot_sessions SET state=$1, context=$2, last_message_at=NOW()
       WHERE phone=$3 AND zoho_campaign_id IS NOT DISTINCT FROM $4`,
      [session.state, JSON.stringify(session.context), session.phone, session.zoho_campaign_id]
    );
  }
}

module.exports = new BotEngine();
