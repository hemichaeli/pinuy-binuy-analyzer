/**
 * QUANTUM Export Routes - v4.61.0
 * CSV + Excel export for Leads, Complexes, Ads, Messages
 * Uses ExcelJS for Excel and built-in stream for CSV
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// ─── Helper: Build CSV string from rows ───────────────────────────────────────
function toCSV(headers, rows) {
  const escape = (val) => {
    if (val === null || val === undefined) return '';
    const s = String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h] ?? row[h.toLowerCase()])).join(','));
  }
  return '\uFEFF' + lines.join('\r\n'); // BOM for Hebrew Excel
}

// ─── Helper: Build XLSX using ExcelJS ────────────────────────────────────────
async function buildExcel(sheetName, columns, rows) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'QUANTUM';
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName, { views: [{ rightToLeft: true }] });

  ws.columns = columns.map((c) => ({
    header: c.label,
    key: c.key,
    width: c.width || 18,
  }));

  // Header style
  ws.getRow(1).eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a1a2e' } };
    cell.font = { bold: true, color: { argb: 'FFFFD700' }, size: 12 };
    cell.alignment = { horizontal: 'center', vertical: 'middle', readingOrder: 'rightToLeft' };
    cell.border = {
      bottom: { style: 'medium', color: { argb: 'FFFFD700' } },
    };
  });
  ws.getRow(1).height = 28;

  rows.forEach((row, i) => {
    const r = ws.addRow(row);
    r.eachCell((cell) => {
      cell.alignment = { readingOrder: 'rightToLeft', vertical: 'middle' };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: i % 2 === 0 ? 'FFF8F8FF' : 'FFEFEFFF' },
      };
    });
    r.height = 22;
  });

  // Auto-filter
  ws.autoFilter = { from: 'A1', to: { row: 1, column: columns.length } };

  return wb;
}

// ─── Respond helper ──────────────────────────────────────────────────────────
async function sendExport(res, format, sheetName, columns, rows, filename) {
  const now = new Date().toISOString().slice(0, 10);
  const safeFilename = `QUANTUM_${filename}_${now}`;

  if (format === 'csv') {
    const headers = columns.map((c) => c.key);
    const csv = toCSV(headers, rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.csv"`);
    return res.send(csv);
  }

  // Excel
  const wb = await buildExcel(sheetName, columns, rows);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/export/leads?format=xlsx|csv&status=...&source=...
// ══════════════════════════════════════════════════════════════════════════════
router.get('/leads', async (req, res) => {
  try {
    const { format = 'xlsx', status, source, limit = 5000 } = req.query;
    let query = `SELECT id, name, phone, email, status, source, budget_min, budget_max,
                        preferred_city, notes, created_at, updated_at
                 FROM leads`;
    const params = [];
    const conditions = [];
    if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
    if (source) { params.push(source); conditions.push(`source = $${params.length}`); }
    if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));

    const { rows } = await pool.query(query, params);

    const columns = [
      { key: 'id', label: 'מזהה', width: 8 },
      { key: 'name', label: 'שם', width: 20 },
      { key: 'phone', label: 'טלפון', width: 15 },
      { key: 'email', label: 'אימייל', width: 25 },
      { key: 'status', label: 'סטטוס', width: 14 },
      { key: 'source', label: 'מקור', width: 14 },
      { key: 'budget_min', label: 'תקציב מינימום', width: 16 },
      { key: 'budget_max', label: 'תקציב מקסימום', width: 16 },
      { key: 'preferred_city', label: 'עיר מועדפת', width: 18 },
      { key: 'notes', label: 'הערות', width: 30 },
      { key: 'created_at', label: 'תאריך יצירה', width: 18 },
    ];

    const mapped = rows.map((r) => ({
      ...r,
      created_at: r.created_at ? new Date(r.created_at).toLocaleDateString('he-IL') : '',
      updated_at: r.updated_at ? new Date(r.updated_at).toLocaleDateString('he-IL') : '',
    }));

    await sendExport(res, format, 'לידים', columns, mapped, 'Leads');
  } catch (err) {
    console.error('Export leads error:', err);
    res.status(500).json({ error: 'שגיאה בייצוא לידים', details: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/export/complexes?format=xlsx|csv&city=...&min_iai=...
// ══════════════════════════════════════════════════════════════════════════════
router.get('/complexes', async (req, res) => {
  try {
    const { format = 'xlsx', city, min_iai, status, limit = 5000 } = req.query;
    let query = `SELECT id, name, city, address, status,
                        existing_units, planned_units, floors_existing, floors_planned,
                        iai_score, ssi_score, developer, committee_stage,
                        price_per_sqm, premium_percent, notes, created_at
                 FROM complexes`;
    const params = [];
    const conditions = [];
    if (city) { params.push(`%${city}%`); conditions.push(`city ILIKE $${params.length}`); }
    if (min_iai) { params.push(parseFloat(min_iai)); conditions.push(`iai_score >= $${params.length}`); }
    if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
    if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
    query += ` ORDER BY COALESCE(iai_score, 0) DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));

    const { rows } = await pool.query(query, params);

    const columns = [
      { key: 'id', label: 'מזהה', width: 8 },
      { key: 'name', label: 'שם מתחם', width: 25 },
      { key: 'city', label: 'עיר', width: 15 },
      { key: 'address', label: 'כתובת', width: 25 },
      { key: 'status', label: 'סטטוס', width: 15 },
      { key: 'existing_units', label: 'יחידות קיימות', width: 14 },
      { key: 'planned_units', label: 'יחידות מתוכננות', width: 16 },
      { key: 'floors_existing', label: 'קומות קיים', width: 12 },
      { key: 'floors_planned', label: 'קומות מתוכנן', width: 14 },
      { key: 'iai_score', label: 'IAI', width: 10 },
      { key: 'ssi_score', label: 'SSI', width: 10 },
      { key: 'developer', label: 'יזם', width: 20 },
      { key: 'committee_stage', label: 'שלב ועדה', width: 16 },
      { key: 'price_per_sqm', label: 'מחיר למ"ר', width: 14 },
      { key: 'premium_percent', label: 'פרמיה %', width: 12 },
      { key: 'notes', label: 'הערות', width: 30 },
      { key: 'created_at', label: 'תאריך', width: 14 },
    ];

    const mapped = rows.map((r) => ({
      ...r,
      iai_score: r.iai_score ? parseFloat(r.iai_score).toFixed(1) : '',
      ssi_score: r.ssi_score ? parseFloat(r.ssi_score).toFixed(1) : '',
      price_per_sqm: r.price_per_sqm ? parseInt(r.price_per_sqm).toLocaleString('he-IL') : '',
      premium_percent: r.premium_percent ? parseFloat(r.premium_percent).toFixed(1) + '%' : '',
      created_at: r.created_at ? new Date(r.created_at).toLocaleDateString('he-IL') : '',
    }));

    await sendExport(res, format, 'מתחמים', columns, mapped, 'Complexes');
  } catch (err) {
    console.error('Export complexes error:', err);
    res.status(500).json({ error: 'שגיאה בייצוא מתחמים', details: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/export/messages?format=xlsx|csv&channel=...&limit=...
// ══════════════════════════════════════════════════════════════════════════════
router.get('/messages', async (req, res) => {
  try {
    const { format = 'xlsx', channel, direction, limit = 2000 } = req.query;
    let query = `SELECT id, phone_number, contact_name, message_text, channel,
                        direction, status, is_lead, lead_id, created_at
                 FROM whatsapp_messages`;
    const params = [];
    const conditions = [];
    if (channel) { params.push(channel); conditions.push(`channel = $${params.length}`); }
    if (direction) { params.push(direction); conditions.push(`direction = $${params.length}`); }
    if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));

    const { rows } = await pool.query(query, params);

    const columns = [
      { key: 'id', label: 'מזהה', width: 8 },
      { key: 'phone_number', label: 'טלפון', width: 16 },
      { key: 'contact_name', label: 'שם', width: 20 },
      { key: 'channel', label: 'ערוץ', width: 12 },
      { key: 'direction', label: 'כיוון', width: 10 },
      { key: 'message_text', label: 'הודעה', width: 40 },
      { key: 'status', label: 'סטטוס', width: 12 },
      { key: 'is_lead', label: 'ליד?', width: 8 },
      { key: 'created_at', label: 'תאריך', width: 18 },
    ];

    const mapped = rows.map((r) => ({
      ...r,
      is_lead: r.is_lead ? 'כן' : 'לא',
      direction: r.direction === 'inbound' ? 'נכנס' : 'יוצא',
      created_at: r.created_at ? new Date(r.created_at).toLocaleString('he-IL') : '',
    }));

    await sendExport(res, format, 'הודעות', columns, mapped, 'Messages');
  } catch (err) {
    console.error('Export messages error:', err);
    res.status(500).json({ error: 'שגיאה בייצוא הודעות', details: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/export/ads?format=xlsx|csv
// ══════════════════════════════════════════════════════════════════════════════
router.get('/ads', async (req, res) => {
  try {
    const { format = 'xlsx', city, limit = 2000 } = req.query;

    // Try facebook_ads table first, fallback to yad2_listings
    let rows = [];
    try {
      let q = `SELECT id, title, description, price, city, neighborhood,
                      rooms, size_sqm, phone, source, status, created_at
               FROM facebook_ads`;
      const params = [];
      if (city) { params.push(`%${city}%`); q += ` WHERE city ILIKE $1`; }
      q += ` ORDER BY created_at DESC LIMIT ${parseInt(limit)}`;
      const result = await pool.query(q, params);
      rows = result.rows;
    } catch {
      // fallback
      const q = `SELECT id, title, price, city, neighborhood, rooms, size_sqm,
                        phone, source, created_at
                 FROM yad2_listings
                 ORDER BY created_at DESC LIMIT ${parseInt(limit)}`;
      const result = await pool.query(q);
      rows = result.rows;
    }

    const columns = [
      { key: 'id', label: 'מזהה', width: 8 },
      { key: 'title', label: 'כותרת', width: 30 },
      { key: 'price', label: 'מחיר', width: 14 },
      { key: 'city', label: 'עיר', width: 15 },
      { key: 'neighborhood', label: 'שכונה', width: 18 },
      { key: 'rooms', label: 'חדרים', width: 8 },
      { key: 'size_sqm', label: 'מ"ר', width: 8 },
      { key: 'phone', label: 'טלפון', width: 15 },
      { key: 'source', label: 'מקור', width: 12 },
      { key: 'status', label: 'סטטוס', width: 12 },
      { key: 'created_at', label: 'תאריך', width: 16 },
    ];

    const mapped = rows.map((r) => ({
      ...r,
      price: r.price ? parseInt(r.price).toLocaleString('he-IL') + ' ₪' : '',
      created_at: r.created_at ? new Date(r.created_at).toLocaleDateString('he-IL') : '',
    }));

    await sendExport(res, format, 'מודעות', columns, mapped, 'Ads');
  } catch (err) {
    console.error('Export ads error:', err);
    res.status(500).json({ error: 'שגיאה בייצוא מודעות', details: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/export/full-report?format=xlsx  (multi-sheet summary)
// ══════════════════════════════════════════════════════════════════════════════
router.get('/full-report', async (req, res) => {
  try {
    const { format = 'xlsx' } = req.query;
    if (format === 'csv') {
      return res.status(400).json({ error: 'Full report requires Excel format' });
    }

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'QUANTUM';
    wb.created = new Date();

    const headerStyle = {
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a1a2e' } },
      font: { bold: true, color: { argb: 'FFFFD700' }, size: 11 },
      alignment: { horizontal: 'center', readingOrder: 'rightToLeft', vertical: 'middle' },
    };

    const applyHeader = (ws, cols) => {
      ws.columns = cols.map((c) => ({ header: c.label, key: c.key, width: c.width || 16 }));
      ws.getRow(1).eachCell((cell) => Object.assign(cell, headerStyle));
      ws.getRow(1).height = 26;
      ws.autoFilter = { from: 'A1', to: { row: 1, column: cols.length } };
      ws.views = [{ rightToLeft: true }];
    };

    // Sheet 1: Top Complexes by IAI
    {
      const ws = wb.addWorksheet('🏆 מתחמים מובילים');
      const cols = [
        { key: 'rank', label: '#', width: 5 },
        { key: 'name', label: 'שם מתחם', width: 24 },
        { key: 'city', label: 'עיר', width: 14 },
        { key: 'iai_score', label: 'IAI', width: 10 },
        { key: 'planned_units', label: 'יחידות מתוכנן', width: 15 },
        { key: 'status', label: 'סטטוס', width: 15 },
        { key: 'developer', label: 'יזם', width: 20 },
      ];
      applyHeader(ws, cols);
      const { rows } = await pool.query(
        `SELECT name, city, iai_score, planned_units, status, developer
         FROM complexes WHERE iai_score IS NOT NULL
         ORDER BY iai_score DESC LIMIT 100`
      );
      rows.forEach((r, i) => {
        const row = ws.addRow({ rank: i + 1, ...r, iai_score: r.iai_score ? parseFloat(r.iai_score).toFixed(1) : '' });
        row.eachCell((cell) => {
          cell.alignment = { readingOrder: 'rightToLeft', vertical: 'middle' };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: i % 2 === 0 ? 'FFF8F8FF' : 'FFEFEFFF' } };
        });
        row.height = 20;
      });
    }

    // Sheet 2: Leads Summary
    {
      const ws = wb.addWorksheet('👥 לידים');
      const cols = [
        { key: 'name', label: 'שם', width: 20 },
        { key: 'phone', label: 'טלפון', width: 15 },
        { key: 'status', label: 'סטטוס', width: 14 },
        { key: 'source', label: 'מקור', width: 14 },
        { key: 'budget_min', label: 'תקציב מינימום', width: 16 },
        { key: 'budget_max', label: 'תקציב מקסימום', width: 16 },
        { key: 'preferred_city', label: 'עיר מועדפת', width: 18 },
        { key: 'created_at', label: 'תאריך', width: 14 },
      ];
      applyHeader(ws, cols);
      const { rows } = await pool.query(
        `SELECT name, phone, status, source, budget_min, budget_max, preferred_city, created_at
         FROM leads ORDER BY created_at DESC LIMIT 500`
      );
      rows.forEach((r, i) => {
        const row = ws.addRow({ ...r, created_at: r.created_at ? new Date(r.created_at).toLocaleDateString('he-IL') : '' });
        row.eachCell((cell) => {
          cell.alignment = { readingOrder: 'rightToLeft', vertical: 'middle' };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: i % 2 === 0 ? 'FFF8F8FF' : 'FFEFEFFF' } };
        });
        row.height = 20;
      });
    }

    // Sheet 3: Stats Summary
    {
      const ws = wb.addWorksheet('📊 סיכום');
      ws.views = [{ rightToLeft: true }];
      ws.getColumn('A').width = 30;
      ws.getColumn('B').width = 20;

      const titleRow = ws.addRow(['QUANTUM - דוח מלא', new Date().toLocaleDateString('he-IL')]);
      titleRow.getCell(1).font = { bold: true, size: 16, color: { argb: 'FF1a1a2e' } };
      titleRow.height = 32;
      ws.addRow([]);

      const stats = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM complexes) as total_complexes,
          (SELECT COUNT(*) FROM complexes WHERE iai_score >= 70) as hot_complexes,
          (SELECT COUNT(*) FROM leads) as total_leads,
          (SELECT COUNT(*) FROM leads WHERE status = 'qualified') as qualified_leads,
          (SELECT COUNT(*) FROM whatsapp_messages WHERE created_at > NOW() - INTERVAL '30 days') as messages_30d
      `);
      const s = stats.rows[0];

      const statRows = [
        ['סה"כ מתחמים', s.total_complexes],
        ['מתחמים חמים (IAI 70+)', s.hot_complexes],
        ['סה"כ לידים', s.total_leads],
        ['לידים מוסמכים', s.qualified_leads],
        ['הודעות ב-30 יום', s.messages_30d],
        ['תאריך הפקה', new Date().toLocaleDateString('he-IL')],
      ];

      statRows.forEach(([label, value], i) => {
        const row = ws.addRow([label, value]);
        row.getCell(1).font = { bold: true };
        row.getCell(2).alignment = { horizontal: 'center' };
        row.eachCell((cell) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: i % 2 === 0 ? 'FFF0F0FF' : 'FFFFFFFF' } };
          cell.border = { bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } } };
        });
        row.height = 24;
      });
    }

    const now = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="QUANTUM_FullReport_${now}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Export full report error:', err);
    res.status(500).json({ error: 'שגיאה בהפקת דוח מלא', details: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/export/info - list available exports
// ══════════════════════════════════════════════════════════════════════════════
router.get('/info', (req, res) => {
  res.json({
    exports: [
      { endpoint: '/api/export/leads', formats: ['xlsx', 'csv'], filters: ['status', 'source', 'limit'], description: 'ייצוא לידים' },
      { endpoint: '/api/export/complexes', formats: ['xlsx', 'csv'], filters: ['city', 'min_iai', 'status', 'limit'], description: 'ייצוא מתחמים' },
      { endpoint: '/api/export/messages', formats: ['xlsx', 'csv'], filters: ['channel', 'direction', 'limit'], description: 'ייצוא הודעות' },
      { endpoint: '/api/export/ads', formats: ['xlsx', 'csv'], filters: ['city', 'limit'], description: 'ייצוא מודעות' },
      { endpoint: '/api/export/full-report', formats: ['xlsx'], filters: [], description: 'דוח מלא רב-גיליוני' },
    ],
    usage: 'הוסף ?format=csv לקבלת CSV, ברירת מחדל Excel'
  });
});

module.exports = router;
