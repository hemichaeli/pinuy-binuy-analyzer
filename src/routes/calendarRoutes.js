/**
 * QUANTUM Google Calendar Management Routes
 *
 * GET  /api/scheduling/calendar/status           - Check if GCal is configured
 * GET  /api/scheduling/calendar/test?calendarId= - Test access to a specific calendar
 * POST /api/scheduling/calendar/set-project      - Set google_calendar_id on a project
 * GET  /api/scheduling/calendar/projects         - List projects + their calendar IDs
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

// ── STATUS ────────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  const configured = gcalService?.isConfigured() || false;
  const email = process.env.GOOGLE_SA_EMAIL || process.env.GOOGLE_CLIENT_EMAIL || null;

  // List projects with calendars configured
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

// ── TEST ACCESS ───────────────────────────────────────────────
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

// ── SET PROJECT CALENDAR ──────────────────────────────────────
router.post('/set-project', async (req, res) => {
  const { projectId, calendarId } = req.body;
  if (!projectId || !calendarId) {
    return res.status(400).json({ error: 'projectId and calendarId required' });
  }

  try {
    // Optional: test access before saving
    let accessOk = false;
    if (gcalService?.testCalendarAccess) {
      const test = await gcalService.testCalendarAccess(calendarId);
      accessOk = test.ok;
      if (!test.ok) {
        logger.warn(`[CalendarRoutes] Calendar ${calendarId} access failed: ${test.error}`);
      }
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

// ── LIST PROJECTS ─────────────────────────────────────────────
router.get('/projects', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, google_calendar_id, zoho_calendar_id
       FROM projects ORDER BY name`
    );
    res.json({
      projects: r.rows,
      service_account: process.env.GOOGLE_SA_EMAIL || process.env.GOOGLE_CLIENT_EMAIL || 'not configured',
      hint: 'To activate: share your Google Calendar with the service_account email (editor access), then POST /set-project with {projectId, calendarId}'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CREATE TEST EVENT ─────────────────────────────────────────
router.post('/test-event', async (req, res) => {
  const { calendarId } = req.body;
  if (!calendarId) return res.status(400).json({ error: 'calendarId required' });

  if (!gcalService?.isConfigured()) {
    return res.status(503).json({ ok: false, error: 'Google Calendar not configured' });
  }

  // Create a test event 1 hour from now
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

module.exports = router;
