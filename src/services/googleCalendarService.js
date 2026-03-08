/**
 * QUANTUM Google Calendar Service
 *
 * Creates, updates, and deletes Google Calendar events
 * when bookings are confirmed / cancelled.
 *
 * Each project has its own Google Calendar (stored in projects.google_calendar_id).
 * Each station in a ceremony can also have its own calendar (ceremony_stations.google_calendar_id).
 *
 * Auth: Service Account JSON in GOOGLE_SERVICE_ACCOUNT_JSON env var
 *       or individual fields GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY
 *
 * Scopes required: https://www.googleapis.com/auth/calendar
 */

const { logger } = require('./logger');

// Lazy-load googleapis to avoid startup crash if not configured
let google = null;
let calendar = null;
let jwtClient = null;

function getClient() {
  if (jwtClient) return jwtClient;

  try {
    if (!google) {
      google = require('googleapis').google;
    }

    const { GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY } = process.env;

    let credentials;
    if (GOOGLE_SERVICE_ACCOUNT_JSON) {
      credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
    } else if (GOOGLE_CLIENT_EMAIL && GOOGLE_PRIVATE_KEY) {
      credentials = {
        client_email: GOOGLE_CLIENT_EMAIL,
        private_key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
      };
    } else {
      logger.warn('[GCal] No credentials configured. Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY');
      return null;
    }

    jwtClient = new google.auth.JWT(
      credentials.client_email,
      null,
      credentials.private_key,
      ['https://www.googleapis.com/auth/calendar']
    );

    calendar = google.calendar({ version: 'v3', auth: jwtClient });
    return jwtClient;
  } catch (err) {
    logger.warn('[GCal] Failed to initialize client:', err.message);
    return null;
  }
}

/**
 * Create a calendar event.
 *
 * @param {string} calendarId - Google Calendar ID (e.g. "xxx@group.calendar.google.com" or "primary")
 * @param {object} opts
 *   - title         {string}  Event title
 *   - startDatetime {string}  ISO datetime "2026-04-15T10:00:00"
 *   - durationMins  {number}  Duration in minutes (default 45)
 *   - description   {string}  Optional description
 *   - location      {string}  Optional location
 *   - attendeeEmail {string}  Optional attendee email
 * @returns {string|null} Google event ID
 */
async function createEvent(calendarId, { title, startDatetime, durationMins = 45, description = '', location = '', attendeeEmail = null }) {
  if (!getClient()) return null;
  if (!calendarId) return null;

  try {
    const start = new Date(startDatetime);
    const end = new Date(start.getTime() + durationMins * 60000);

    const event = {
      summary: title,
      description,
      location,
      start: { dateTime: start.toISOString(), timeZone: 'Asia/Jerusalem' },
      end:   { dateTime: end.toISOString(),   timeZone: 'Asia/Jerusalem' },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 60 },
          { method: 'popup', minutes: 1440 } // 24h
        ]
      }
    };

    if (attendeeEmail) {
      event.attendees = [{ email: attendeeEmail }];
    }

    const res = await calendar.events.insert({
      calendarId,
      resource: event,
      sendUpdates: attendeeEmail ? 'all' : 'none'
    });

    logger.info(`[GCal] Event created: ${res.data.id} in calendar ${calendarId}`);
    return res.data.id;
  } catch (err) {
    logger.warn(`[GCal] createEvent failed for calendar ${calendarId}:`, err.message);
    return null;
  }
}

/**
 * Delete a calendar event.
 */
async function deleteEvent(calendarId, eventId) {
  if (!getClient() || !calendarId || !eventId) return false;
  try {
    await calendar.events.delete({ calendarId, eventId });
    logger.info(`[GCal] Event deleted: ${eventId} from calendar ${calendarId}`);
    return true;
  } catch (err) {
    logger.warn(`[GCal] deleteEvent failed:`, err.message);
    return false;
  }
}

/**
 * Update an existing calendar event.
 */
async function updateEvent(calendarId, eventId, updates) {
  if (!getClient() || !calendarId || !eventId) return false;
  try {
    const res = await calendar.events.patch({
      calendarId,
      eventId,
      resource: updates
    });
    logger.info(`[GCal] Event updated: ${res.data.id}`);
    return true;
  } catch (err) {
    logger.warn(`[GCal] updateEvent failed:`, err.message);
    return false;
  }
}

/**
 * Create a booking event for a ceremony slot.
 * Resolves the correct calendar from station → project chain.
 *
 * @param {object} pool     - PostgreSQL pool
 * @param {object} slot     - ceremony slot row (has station_id, ceremony_id, slot_date, slot_time)
 * @param {string} contactName
 * @param {string} contactPhone
 * @returns {string|null}   Google event ID
 */
async function createCeremonySlotEvent(pool, slot, contactName, contactPhone) {
  if (!getClient()) return null;

  try {
    // Get station → building → ceremony → project chain for calendar IDs
    const res = await pool.query(
      `SELECT
         cst.google_calendar_id AS station_gcal,
         sc.location,
         sc.slot_duration_minutes AS duration,
         p.google_calendar_id AS project_gcal,
         p.name AS project_name,
         sc.ceremony_date,
         cst.station_number,
         cst.representative_name
       FROM ceremony_slots cs
       JOIN ceremony_stations cst ON cs.station_id = cst.id
       JOIN signing_ceremonies sc ON cs.ceremony_id = sc.id
       JOIN projects p ON sc.project_id = p.id
       WHERE cs.id = $1`,
      [slot.id]
    );

    if (!res.rows.length) return null;
    const row = res.rows[0];

    // Prefer station-level calendar, fall back to project calendar
    const calendarId = row.station_gcal || row.project_gcal;
    if (!calendarId) {
      logger.warn(`[GCal] No calendar configured for slot ${slot.id}`);
      return null;
    }

    const timeStr = (slot.slot_time || '').substring(0, 5); // "HH:MM"
    const startDatetime = `${slot.slot_date}T${timeStr}:00`;

    const eventId = await createEvent(calendarId, {
      title: `✍️ כנס חתימות - ${contactName} | ${row.project_name}`,
      startDatetime,
      durationMins: row.duration || 15,
      description: [
        `דייר: ${contactName}`,
        `טלפון: ${contactPhone}`,
        `פרויקט: ${row.project_name}`,
        `עמדה: ${row.station_number}`,
        row.representative_name ? `נציג: ${row.representative_name}` : ''
      ].filter(Boolean).join('\n'),
      location: row.location || ''
    });

    return eventId;
  } catch (err) {
    logger.warn(`[GCal] createCeremonySlotEvent failed:`, err.message);
    return null;
  }
}

/**
 * Create a booking event for a regular meeting slot.
 */
async function createMeetingSlotEvent(pool, slot, contactName, contactPhone) {
  if (!getClient()) return null;

  try {
    const res = await pool.query(
      `SELECT p.google_calendar_id, p.name AS project_name
       FROM meeting_slots ms
       LEFT JOIN projects p ON ms.project_id = p.id
       WHERE ms.id = $1`,
      [slot.id]
    );

    const row = res.rows[0];
    const calendarId = row?.google_calendar_id;
    if (!calendarId) {
      logger.warn(`[GCal] No project calendar for meeting slot ${slot.id}`);
      return null;
    }

    const MEETING_TYPE_LABELS = {
      consultation: 'פגישת ייעוץ',
      physical: 'פגישה פיזית',
      appraiser: 'ביקור שמאי',
      surveyor: 'ביקור מודד',
      signing_ceremony: 'כנס חתימות'
    };
    const typeLabel = MEETING_TYPE_LABELS[slot.meeting_type] || 'פגישה';

    const eventId = await createEvent(calendarId, {
      title: `📅 ${typeLabel} - ${contactName} | QUANTUM`,
      startDatetime: slot.slot_datetime,
      durationMins: slot.duration_minutes || 45,
      description: [
        `לקוח: ${contactName}`,
        `טלפון: ${contactPhone}`,
        slot.representative_name ? `נציג: ${slot.representative_name}` : ''
      ].filter(Boolean).join('\n'),
      location: ''
    });

    return eventId;
  } catch (err) {
    logger.warn(`[GCal] createMeetingSlotEvent failed:`, err.message);
    return null;
  }
}

/**
 * Check if calendar service is configured.
 */
function isConfigured() {
  return !!(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CLIENT_EMAIL);
}

module.exports = {
  createEvent,
  deleteEvent,
  updateEvent,
  createCeremonySlotEvent,
  createMeetingSlotEvent,
  isConfigured
};
