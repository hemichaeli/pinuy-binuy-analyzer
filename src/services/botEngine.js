/**
 * QUANTUM Bot Engine
 * WhatsApp conversation flow: Hebrew + Russian
 * Handles: consultations, appraiser visits, signing ceremonies
 */

const pool = require('../db/pool');
const inforuService = require('./inforuService');

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
    ceremonyConfirm: (date, time, location, rep) =>
      `✅ *הפגישה נקבעה!*\n\n📅 ${date}\n⏰ ${String(time).substring(0,5)}\n📍 ${location}\n👤 נציג: ${rep}\n\nתקבל/י תזכורת יום לפני ו-2 שעות לפני. להתראות! 👋`,
    ceremonyDeclined: `תודה שעדכנת אותנו. נציג שלנו ייצור איתך קשר בהקדם.`,
    ceremonyMaybe: `מובן. נחזור אליך קרוב לתאריך הכנס לאישור סופי.`,
    meetingIntro: (name, type) => `שלום ${name} 👋\nQUANTUM כאן.\n\nנשמח לתאם *${type}* עבור דירתך.\n\nמתי נוח לך?`,
    selectDate: (dates) => {
      let msg = `בחר/י תאריך מועדף:\n\n`;
      dates.forEach((d, i) => { msg += `${i + 1}️⃣ ${d.label}\n`; });
      return msg;
    },
    selectTime: (slots) => {
      let msg = `בחר/י שעה:\n\n`;
      slots.forEach((s, i) => { msg += `${i + 1}️⃣ ${String(s.time).substring(0,5)}\n`; });
      return msg;
    },
    meetingConfirm: (type, date, time, rep) =>
      `✅ *${type} נקבעה!*\n\n📅 ${date}\n⏰ ${String(time).substring(0,5)}\n👤 ${rep}\n\nתקבל/י תזכורת יום לפני. להתראות! 👋`,
    noSlots: `כרגע אין חלונות זמן פנויים. נציג שלנו ייצור איתך קשר בהקדם.`,
    invalidChoice: `לא הבנתי את הבחירה. אנא הקלד/י את המספר המתאים.`,
    error: `אירעה שגיאה טכנית. אנא נסה/י שוב מאוחר יותר.`,
    reminder24h: (name, campaign) =>
      `שלום ${name} 👋 QUANTUM כאן.\nעדיין לא קיבלנו ממך תשובה לגבי *${campaign}*.\nענה/י *1* ונתאם עכשיו.`,
    botFollowup: (name, campaign) =>
      `שלום ${name} 👋 QUANTUM שוב.\nזו ההזדמנות האחרונה לתאם את *${campaign}*.\nענה/י *1* ונסגור מיד.`,
    preMeeting24h: (name, type, date, time) =>
      `שלום ${name} 👋\nתזכורת: *${type}* מחר\n📅 ${date} ⏰ ${time}\n\nלביטול/שינוי - ענה/י 0.`,
    preMeeting2h: (name, type, time) =>
      `שלום ${name} 👋\nבעוד כ-2 שעות: *${type}* ב-⏰ ${time}\n\nנתראה! 🤝`
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
    ceremonyConfirm: (date, time, location, rep) =>
      `✅ *Встреча назначена!*\n\n📅 ${date}\n⏰ ${String(time).substring(0,5)}\n📍 ${location}\n👤 Представитель: ${rep}\n\nНапомним за сутки и за 2 часа. До встречи! 👋`,
    ceremonyDeclined: `Спасибо за уведомление. Наш представитель свяжется с вами в ближайшее время.`,
    ceremonyMaybe: `Понятно. Мы свяжемся с вами ближе к дате церемонии.`,
    meetingIntro: (name, type) => `Здравствуйте, ${name} 👋\nQUANTUM на связи.\n\nГотовы записать вас на *${type}*.\n\nКогда удобно?`,
    selectDate: (dates) => {
      let msg = `Выберите дату:\n\n`;
      dates.forEach((d, i) => { msg += `${i + 1}️⃣ ${d.label}\n`; });
      return msg;
    },
    selectTime: (slots) => {
      let msg = `Выберите время:\n\n`;
      slots.forEach((s, i) => { msg += `${i + 1}️⃣ ${String(s.time).substring(0,5)}\n`; });
      return msg;
    },
    meetingConfirm: (type, date, time, rep) =>
      `✅ *${type} назначена!*\n\n📅 ${date}\n⏰ ${String(time).substring(0,5)}\n👤 ${rep}\n\nНапомним за сутки. До встречи! 👋`,
    noSlots: `Свободных слотов нет. Наш представитель свяжется с вами в ближайшее время.`,
    invalidChoice: `Не понял выбор. Пожалуйста, введите номер из предложенных.`,
    error: `Произошла техническая ошибка. Попробуйте позже.`,
    reminder24h: (name, campaign) =>
      `Здравствуйте, ${name} 👋 QUANTUM на связи.\nМы ещё не получили ваш ответ по *${campaign}*.\nНажмите *1* для записи.`,
    botFollowup: (name, campaign) =>
      `Здравствуйте, ${name} 👋 QUANTUM снова.\nПоследний шанс записаться на *${campaign}*.\nНажмите *1* прямо сейчас.`,
    preMeeting24h: (name, type, date, time) =>
      `Здравствуйте, ${name} 👋\nНапоминание: *${type}* завтра\n📅 ${date} ⏰ ${time}\n\nДля отмены/переноса - ответьте 0.`,
    preMeeting2h: (name, type, time) =>
      `Здравствуйте, ${name} 👋\nЧерез ~2 часа: *${type}* в ⏰ ${time}\n\nДо встречи! 🤝`
  }
};

const MEETING_TYPE_LABELS = {
  he: { consultation:'פגישת ייעוץ', physical:'פגישה פיזית במשרד', appraiser:'ביקור שמאי', surveyor:'ביקור מודד', signing_ceremony:'כנס חתימות' },
  ru: { consultation:'Консультация', physical:'Встреча в офисе', appraiser:'Визит оценщика', surveyor:'Визит геодезиста', signing_ceremony:'Церемония подписания' }
};

class BotEngine {
  async handleIncoming(phone, messageText, campaignId) {
    try {
      const session = await this.getOrCreateSession(phone, campaignId);
      const reply = await this.processState(session, messageText.trim());
      await this.saveSession(session);
      return reply;
    } catch (err) {
      console.error('[BotEngine] Error:', err);
      return null;
    }
  }

  async getOrCreateSession(phone, campaignId) {
    const res = await pool.query(
      `SELECT * FROM bot_sessions WHERE phone=$1 AND zoho_campaign_id=$2`,
      [phone, campaignId]
    );
    if (res.rows.length > 0) {
      const s = res.rows[0];
      s.context = typeof s.context === 'string' ? JSON.parse(s.context) : (s.context || {});
      return s;
    }
    const ins = await pool.query(
      `INSERT INTO bot_sessions (phone, zoho_campaign_id, language, state, context)
       VALUES ($1,$2,'he','confirm_identity','{}') RETURNING *`,
      [phone, campaignId]
    );
    const s = ins.rows[0];
    s.context = {};
    return s;
  }

  async processState(session, msg) {
    const lang = session.language || 'he';
    const S = STRINGS[lang];
    const ctx = session.context;
    const state = session.state;

    if (state === 'confirm_identity') {
      if (msg === '1') {
        const config = await this.getCampaignConfig(session.zoho_campaign_id);
        ctx.config = config;
        if (config.meeting_type === 'signing_ceremony') {
          const ceremony = await this.getActiveCeremony(session.zoho_campaign_id);
          if (!ceremony) return S.noSlots;
          ctx.ceremony = ceremony;
          session.state = 'ceremony_confirm_attendance';
          return S.ceremonyIntro(ctx.contactName || '', ceremony);
        } else {
          const dates = await this.getAvailableDates(session.zoho_campaign_id);
          if (!dates.length) return S.noSlots;
          ctx.availableDates = dates;
          session.state = 'meeting_select_date';
          const typeLabel = (MEETING_TYPE_LABELS[lang] || MEETING_TYPE_LABELS.he)[config.meeting_type] || config.meeting_type;
          return S.meetingIntro(ctx.contactName || '', typeLabel) + '\n\n' + S.selectDate(dates);
        }
      } else if (msg === '2') {
        session.state = 'closed';
        return S.wrongPerson;
      }
      return S.invalidChoice;
    }

    if (state === 'ceremony_confirm_attendance') {
      if (msg === '1') {
        const slots = await this.getCeremonySlots(ctx.ceremony.id);
        if (!slots.length) return S.noSlots;
        ctx.availableSlots = slots;
        session.state = 'ceremony_select_slot';
        return S.ceremonySelectSlot(slots);
      } else if (msg === '2') {
        session.state = 'ceremony_declined';
        return S.ceremonyDeclined;
      } else if (msg === '3') {
        session.state = 'ceremony_maybe';
        return S.ceremonyMaybe;
      }
      return S.invalidChoice;
    }

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
      await this.scheduleReminders(session, `${chosen.slot_date} ${chosen.time}`, ctx.ceremony);
      session.state = 'confirmed';
      return S.ceremonyConfirm(chosen.dateStr, chosen.time, ctx.ceremony.location, chosen.repName || '');
    }

    if (state === 'meeting_select_date') {
      const idx = parseInt(msg) - 1;
      const dates = ctx.availableDates || [];
      if (isNaN(idx) || idx < 0 || idx >= dates.length) return S.invalidChoice;
      ctx.selectedDate = dates[idx];
      const times = await this.getSlotsForDate(session.zoho_campaign_id, dates[idx].date);
      if (!times.length) return S.noSlots;
      ctx.availableTimes = times;
      session.state = 'meeting_select_time';
      return S.selectTime(times);
    }

    if (state === 'meeting_select_time') {
      const idx = parseInt(msg) - 1;
      const times = ctx.availableTimes || [];
      if (isNaN(idx) || idx < 0 || idx >= times.length) return S.invalidChoice;
      const chosen = times[idx];
      const locked = await this.lockMeetingSlot(chosen.id, session);
      if (!locked) {
        const fresh = await this.getSlotsForDate(session.zoho_campaign_id, ctx.selectedDate.date);
        ctx.availableTimes = fresh;
        return S.ceremonySlotTaken + '\n' + S.selectTime(fresh);
      }
      await this.scheduleReminders(session, chosen.slot_datetime, null);
      session.state = 'confirmed';
      const typeLabel = (MEETING_TYPE_LABELS[lang] || MEETING_TYPE_LABELS.he)[ctx.config?.meeting_type] || '';
      return S.meetingConfirm(typeLabel, ctx.selectedDate.label, chosen.time, chosen.repName || '');
    }

    return S.error;
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

  async getAvailableDates(campaignId) {
    const res = await pool.query(
      `SELECT DISTINCT DATE(slot_datetime) AS date,
              TO_CHAR(DATE(slot_datetime),'Day DD/MM') AS label
       FROM meeting_slots
       WHERE campaign_id=$1 AND status='open' AND slot_datetime > NOW()
       ORDER BY date LIMIT 5`,
      [campaignId]
    );
    return res.rows;
  }

  async getSlotsForDate(campaignId, date) {
    const res = await pool.query(
      `SELECT id, slot_datetime, TO_CHAR(slot_datetime,'HH24:MI') AS time,
              representative_name AS "repName"
       FROM meeting_slots
       WHERE campaign_id=$1 AND DATE(slot_datetime)=$2 AND status='open'
       ORDER BY slot_datetime LIMIT 10`,
      [campaignId, date]
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

  async scheduleReminders(session, meetingDatetime, ceremony) {
    const config = await this.getCampaignConfig(session.zoho_campaign_id);
    const pre24h = config.pre_meeting_reminder_hours || 24;
    const pre2h = config.morning_reminder_hours || 2;
    const meetingDate = new Date(meetingDatetime);
    const now = new Date();
    const reminders = [
      { type: 'pre_meeting_24h', at: new Date(meetingDate.getTime() - pre24h * 3600000) },
      { type: 'pre_meeting_2h',  at: new Date(meetingDate.getTime() - pre2h * 3600000) }
    ];
    for (const r of reminders) {
      if (r.at > now) {
        await pool.query(
          `INSERT INTO reminder_queue (phone, zoho_contact_id, zoho_campaign_id, reminder_type, scheduled_at, payload)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [session.phone, session.zoho_contact_id, session.zoho_campaign_id, r.type, r.at,
           JSON.stringify({ meetingDatetime, language: session.language })]
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
       WHERE phone=$3 AND zoho_campaign_id=$4`,
      [session.state, JSON.stringify(session.context), session.phone, session.zoho_campaign_id]
    );
  }
}

module.exports = new BotEngine();
