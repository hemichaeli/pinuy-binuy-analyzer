/**
 * QUANTUM Calendar Management Routes
 *
 * Google Calendar:
 * GET  /api/scheduling/calendar/status              - Check GCal config
 * GET  /api/scheduling/calendar/test?calendarId=    - Test GCal access
 * POST /api/scheduling/calendar/set-project         - Set google_calendar_id on project
 * POST /api/scheduling/calendar/test-event          - Create a test GCal event
 *
 * Zoho Calendar:
 * GET  /api/scheduling/calendar/zoho/status         - Check Zoho Calendar config
 * GET  /api/scheduling/calendar/zoho/list           - List available Zoho calendars
 * POST /api/scheduling/calendar/zoho/set-project    - Set zoho_calendar_id on project
 * GET  /api/scheduling/calendar/zoho/test?calendarId= - Test Zoho Calendar access
 *
 * Shared:
 * GET  /api/scheduling/calendar/projects            - List projects + both calendar IDs
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

let gcalService;
try {
  gcalService = require('../services/googleCalendarService');
} catch (e) {
  logger.warn('[CalendarRoutes] googleCalendarService not available:', e.message);
}

let zcalService;
try {
  zcalService = require('../services/zohoCalendarService');
} catch (e) {
  logger.warn('[CalendarRoutes] zohoCalendarService not available:', e.message);
}

// ════════════════════════════════════════════════════════════
// GOOGLE CALENDAR
// ════════════════════════════════════════════════════════════

router.get('/status', async (req, res) => {
  const configured = gcalService?.isConfigured() || false;
  const email = process.env.GOOGLE_SA_EMAIL || process.env.GOOGLE_CLIENT_EMAIL || null;

  let projects = [];
  try {
    const r = await pool.query(
      `SELECT id, name, google_calendar_id
       FROM projects
       WHERE google_calendar_id IS NOT NULL AND google_calendar_id != ''
       ORDER BY name`
    );
    projects = r.rows;
  } catch (e) { /* ok */ }

  res.json({
    configured,
    service_account: email,
    projects_with_calendar: projects.length,
    projects,
    setup_hint: configured
      ? null
      : 'Set GOOGLE_SA_EMAIL and GOOGLE_SA_PRIVATE_KEY on Railway, then share your calendar with the service account email'
  });
});

router.get('/test', async (req, res) => {
  const { calendarId } = req.query;
  if (!calendarId) {
    return res.status(400).json({ error: 'calendarId query param required. Example: ?calendarId=primary' });
  }

  if (!gcalService?.isConfigured()) {
    return res.status(503).json({
      ok: false,
      error: 'Google Calendar not configured. Set GOOGLE_SA_EMAIL + GOOGLE_SA_PRIVATE_KEY on Railway.'
    });
  }

  const result = await gcalService.testCalendarAccess(calendarId);
  res.json(result);
});

router.post('/set-project', async (req, res) => {
  const { projectId, calendarId } = req.body;
  if (!projectId || !calendarId) {
    return res.status(400).json({ error: 'projectId and calendarId required' });
  }

  try {
    let accessOk = false;
    if (gcalService?.testCalendarAccess) {
      const test = await gcalService.testCalendarAccess(calendarId);
      accessOk = test.ok;
    }

    await pool.query(
      `UPDATE projects SET google_calendar_id = $1 WHERE id = $2`,
      [calendarId, projectId]
    );

    const proj = await pool.query(
      `SELECT id, name, google_calendar_id FROM projects WHERE id = $1`,
      [projectId]
    );

    res.json({
      success: true,
      project: proj.rows[0],
      calendar_accessible: accessOk,
      warning: !accessOk ? `Could not verify access to calendar "${calendarId}". Make sure you shared the calendar with ${process.env.GOOGLE_SA_EMAIL || process.env.GOOGLE_CLIENT_EMAIL}` : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/test-event', async (req, res) => {
  const { calendarId } = req.body;
  if (!calendarId) return res.status(400).json({ error: 'calendarId required' });

  if (!gcalService?.isConfigured()) {
    return res.status(503).json({ ok: false, error: 'Google Calendar not configured' });
  }

  const start = new Date(Date.now() + 60 * 60 * 1000);
  const eventId = await gcalService.createEvent(calendarId, {
    title: '🧪 QUANTUM - בדיקת חיבור לוח שנה',
    startDatetime: start.toISOString(),
    durationMins: 15,
    description: 'Test event created by QUANTUM system. Can be deleted.'
  });

  if (eventId) {
    res.json({ ok: true, eventId, calendarId, message: 'Test event created successfully!' });
  } else {
    res.json({ ok: false, calendarId, message: 'Failed to create event - check service account permissions' });
  }
});

// ════════════════════════════════════════════════════════════
// ZOHO CALENDAR
// ════════════════════════════════════════════════════════════

// GET /zoho/status
router.get('/zoho/status', async (req, res) => {
  const configured = zcalService?.isConfigured() || false;

  let projects = [];
  try {
    const r = await pool.query(
      `SELECT id, name, zoho_calendar_id
       FROM projects
       WHERE zoho_calendar_id IS NOT NULL AND zoho_calendar_id != ''
       ORDER BY name`
    );
    projects = r.rows;
  } catch (e) { /* ok */ }

  res.json({
    configured,
    projects_with_zoho_calendar: projects.length,
    projects,
    setup_hint: configured
      ? null
      : 'ZOHO_CLIENT_ID + ZOHO_REFRESH_TOKEN must be set on Railway. Scope: ZohoCalendar.event.ALL'
  });
});

// GET /zoho/list  - list all calendars in the Zoho account
router.get('/zoho/list', async (req, res) => {
  if (!zcalService?.isConfigured()) {
    return res.status(503).json({ ok: false, error: 'Zoho Calendar not configured' });
  }

  try {
    const result = await zcalService.listCalendars();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /zoho/test?calendarId=xxx
router.get('/zoho/test', async (req, res) => {
  const { calendarId } = req.query;
  if (!calendarId) {
    return res.status(400).json({ error: 'calendarId query param required' });
  }

  if (!zcalService?.isConfigured()) {
    return res.status(503).json({ ok: false, error: 'Zoho Calendar not configured' });
  }

  try {
    const result = await zcalService.testCalendarAccess(calendarId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /zoho/set-project  { projectId, calendarId }
router.post('/zoho/set-project', async (req, res) => {
  const { projectId, calendarId } = req.body;
  if (!projectId || !calendarId) {
    return res.status(400).json({ error: 'projectId and calendarId required' });
  }

  try {
    // Test access first (non-blocking - warn but still save)
    let accessOk = false;
    if (zcalService?.testCalendarAccess) {
      try {
        const test = await zcalService.testCalendarAccess(calendarId);
        accessOk = test.ok;
      } catch (e) { /* ok */ }
    }

    await pool.query(
      `UPDATE projects SET zoho_calendar_id = $1 WHERE id = $2`,
      [calendarId, projectId]
    );

    const proj = await pool.query(
      `SELECT id, name, zoho_calendar_id FROM projects WHERE id = $1`,
      [projectId]
    );

    res.json({
      success: true,
      project: proj.rows[0],
      calendar_accessible: accessOk,
      warning: !accessOk
        ? `Could not verify access to Zoho Calendar "${calendarId}". Saved anyway - verify manually.`
        : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /zoho/test-event  { calendarId }
router.post('/zoho/test-event', async (req, res) => {
  const { calendarId } = req.body;
  if (!calendarId) return res.status(400).json({ error: 'calendarId required' });

  if (!zcalService?.isConfigured()) {
    return res.status(503).json({ ok: false, error: 'Zoho Calendar not configured' });
  }

  try {
    const start = new Date(Date.now() + 60 * 60 * 1000);
    const uid = await zcalService.createEvent(calendarId, {
      title: '🧪 QUANTUM - בדיקת לוח שנה Zoho',
      startDatetime: start.toISOString(),
      durationMins: 15,
      description: 'Test event created by QUANTUM system. Can be deleted.'
    });

    if (uid) {
      res.json({ ok: true, uid, calendarId, message: 'Zoho Calendar test event created!' });
    } else {
      res.json({ ok: false, calendarId, message: 'Failed to create event - check Zoho OAuth token and scope' });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// SHARED
// ════════════════════════════════════════════════════════════

router.get('/projects', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, google_calendar_id, zoho_calendar_id
       FROM projects ORDER BY name`
    );
    res.json({
      projects: r.rows,
      google_service_account: process.env.GOOGLE_SA_EMAIL || process.env.GOOGLE_CLIENT_EMAIL || 'not configured',
      zoho_configured: zcalService?.isConfigured() || false,
      hint: 'Google: share calendar with service_account email. Zoho: POST /zoho/set-project {projectId, calendarId}'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
