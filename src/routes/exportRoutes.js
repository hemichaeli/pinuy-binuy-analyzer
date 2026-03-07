/**
 * QUANTUM Export Routes - v4.73.0
 * CSV + Excel export for Leads, Complexes, Ads, Messages
 * Uses ExcelJS for Excel and built-in stream for CSV
 * Schema facts (verified from schema.sql + whatsappRoutes.js):
 *   - leads: table "website_leads"
 *   - complexes: planned_units, existing_units, developer_strength, addresses
 *   - whatsapp_messages: id, conversation_id, direction, message, created_at (NO status/phone cols)
 *   - whatsapp_conversations: id, phone, status, source
 *   - ads: listings table (asking_price, address, city) or facebook_ads
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

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
  return '\uFEFF' + lines.join('\r\n');
}

async function buildExcel(sheetName, columns, rows) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'QUANTUM';
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName, { views: [{ rightToLeft: true }] });
  ws.columns = columns.map((c) => ({ header: c.label, key: c.key, width: c.width || 18 }));
  ws.getRow(1).eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a1a2e' } };
    cell.font = { bold: true, color: { argb: 'FFFFD700' }, size: 12 };
    cell.alignment = { horizontal: 'center', vertical: 'middle', readingOrder: 'rightToLeft' };
    cell.border = { bottom: { style: 'medium', color: { argb: 'FFFFD700' } } };
  });
  ws.getRow(1).height = 28;
  rows.forEach((row, i) => {
    const r = ws.addRow(row);
    r.eachCell((cell) => {
      cell.alignment = { readingOrder: 'rightToLeft', vertical: 'middle' };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: i % 2 === 0 ? 'FFF8F8FF' : 'FFEFEFFF' } };
    });
    r.height = 22;
  });
  ws.autoFilter = { from: 'A1', to: { row: 1, column: columns.length } };
  return wb;
}

async function sendExport(res, format, sheetName, columns, rows, filename) {
  const now = new Date().toISOString().slice(0, 10);
  const safeFilename = `QUANTUM_${filename}_${now}`;
  if (format === 'csv') {
    const csv = toCSV(columns.map((c) => c.key), rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.csv"`);
    return res.send(csv);
  }
  const wb = await buildExcel(sheetName, columns, rows);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/export/leads  (table: website_leads)
// ══════════════════════════════════════════════════════════════════════════════
router.get('/leads', async (req, res) => {
  try {
    const { format = 'xlsx', status, source, limit = 5000 } = req.query;
    let query = `SELECT id, name, email, phone, status, source, user_type, notes, is_urgent, created_at FROM website_leads`;
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
      { key: 'email', label: 'אימייל', width: 25 },
      { key: 'phone', label: 'טלפון', width: 15 },
      { key: 'status', label: 'סטטוס', width: 14 },
      { key: 'source', label: 'מקור', width: 14 },
      { key: 'user_type', label: 'סוג משתמש', width: 14 },
      { key: 'notes', label: 'הערות', width: 30 },
      { key: 'is_urgent', label: 'דחוף?', width: 8 },
      { key: 'created_at', label: 'תאריך יצירה', width: 18 },
    ];
    const mapped = rows.map((r) => ({
      ...r,
      is_urgent: r.is_urgent ? 'כן' : 'לא',
      created_at: r.created_at ? new Date(r.created_at).toLocaleDateString('he-IL') : '',
    }));
    await sendExport(res, format, 'לידים', columns, mapped, 'Leads');
  } catch (err) {
    console.error('Export leads error:', err);
    res.status(500).json({ error: 'שגיאה בייצוא לידים', details: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/export/complexes  (table: complexes)
// ══════════════════════════════════════════════════════════════════════════════
router.get('/complexes', async (req, res) => {
  try {
    const { format = 'xlsx', city, min_iai, status, limit = 5000 } = req.query;
    let query = `SELECT id, name, city, neighborhood, addresses, status,
                        planned_units, existing_units, iai_score,
                        developer, developer_strength, plan_number, created_at
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
      { key: 'neighborhood', label: 'שכונה', width: 18 },
      { key: 'addresses', label: 'כתובות', width: 30 },
      { key: 'status', label: 'סטטוס', width: 15 },
      { key: 'planned_units', label: 'יחידות מתוכנן', width: 14 },
      { key: 'existing_units', label: 'יחידות קיים', width: 14 },
      { key: 'iai_score', label: 'IAI', width: 10 },
      { key: 'developer', label: 'יזם', width: 20 },
      { key: 'developer_strength', label: 'חוזק יזם', width: 12 },
      { key: 'plan_number', label: 'מספר תכנית', width: 14 },
      { key: 'created_at', label: 'תאריך', width: 14 },
    ];
    const mapped = rows.map((r) => ({
      ...r,
      iai_score: r.iai_score ? parseFloat(r.iai_score).toFixed(1) : '',
      created_at: r.created_at ? new Date(r.created_at).toLocaleDateString('he-IL') : '',
    }));
    await sendExport(res, format, 'מתחמים', columns, mapped, 'Complexes');
  } catch (err) {
    console.error('Export complexes error:', err);
    res.status(500).json({ error: 'שגיאה בייצוא מתחמים', details: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/export/messages
// whatsapp_messages: id, conversation_id, direction, message, created_at
// whatsapp_conversations: id, phone, source, status
// ══════════════════════════════════════════════════════════════════════════════
router.get('/messages', async (req, res) => {
  try {
    const { format = 'xlsx', direction, limit = 2000 } = req.query;
    let query = `SELECT wm.id, wc.phone, wm.direction, wm.message,
                        wc.source, wc.status as conv_status, wm.created_at
                 FROM whatsapp_messages wm
                 LEFT JOIN whatsapp_conversations wc ON wc.id = wm.conversation_id`;
    const params = [];
    if (direction) { params.push(direction); query += ` WHERE wm.direction = $1`; }
    query += ` ORDER BY wm.created_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));
    const { rows } = await pool.query(query, params);
    const columns = [
      { key: 'id', label: 'מזהה', width: 8 },
      { key: 'phone', label: 'טלפון', width: 16 },
      { key: 'direction', label: 'כיוון', width: 10 },
      { key: 'message', label: 'הודעה', width: 40 },
      { key: 'source', label: 'מקור', width: 14 },
      { key: 'conv_status', label: 'סטטוס שיחה', width: 12 },
      { key: 'created_at', label: 'תאריך', width: 18 },
    ];
    const mapped = rows.map((r) => ({
      ...r,
      direction: r.direction === 'incoming' ? 'נכנס' : 'יוצא',
      created_at: r.created_at ? new Date(r.created_at).toLocaleString('he-IL') : '',
    }));
    await sendExport(res, format, 'הודעות', columns, mapped, 'Messages');
  } catch (err) {
    console.error('Export messages error:', err);
    res.status(500).json({ error: 'שגיאה בייצוא הודעות', details: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/export/ads
// Tries facebook_ads, then listings (asking_price, address), graceful empty fallback
// ══════════════════════════════════════════════════════════════════════════════
router.get('/ads', async (req, res) => {
  try {
    const { format = 'xlsx', city, limit = 2000 } = req.query;
    let rows = [];
    try {
      let q = `SELECT id, title, price, city, neighborhood as address, source, status, created_at FROM facebook_ads`;
      const p = [];
      if (city) { p.push(`%${city}%`); q += ` WHERE city ILIKE $1`; }
      q += ` ORDER BY created_at DESC LIMIT ${parseInt(limit)}`;
      const result = await pool.query(q, p);
      rows = result.rows;
    } catch {
      try {
        let q = `SELECT id, asking_price as price, address, city, source, is_active as status, created_at FROM listings`;
        const p = [];
        if (city) { p.push(`%${city}%`); q += ` WHERE city ILIKE $1`; }
        q += ` ORDER BY created_at DESC LIMIT ${parseInt(limit)}`;
        const result = await pool.query(q, p);
        rows = result.rows.map(r => ({ ...r, title: r.address || 'מודעה' }));
      } catch {
        rows = [];
      }
    }
    const columns = [
      { key: 'id', label: 'מזהה', width: 8 },
      { key: 'title', label: 'כותרת', width: 30 },
      { key: 'price', label: 'מחיר', width: 14 },
      { key: 'city', label: 'עיר', width: 15 },
      { key: 'address', label: 'כתובת', width: 25 },
      { key: 'source', label: 'מקור', width: 12 },
      { key: 'status', label: 'סטטוס', width: 12 },
      { key: 'created_at', label: 'תאריך', width: 16 },
    ];
    const mapped = rows.map((r) => ({
      ...r,
      price: r.price ? parseInt(r.price).toLocaleString('he-IL') + ' \u20aa' : '',
      created_at: r.created_at ? new Date(r.created_at).toLocaleDateString('he-IL') : '',
    }));
    await sendExport(res, format, 'מודעות', columns, mapped, 'Ads');
  } catch (err) {
    console.error('Export ads error:', err);
    res.status(500).json({ error: 'שגיאה בייצוא מודעות', details: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/export/full-report
// ══════════════════════════════════════════════════════════════════════════════
router.get('/full-report', async (req, res) => {
  try {
    const { format = 'xlsx' } = req.query;
    if (format === 'csv') return res.status(400).json({ error: 'Full report requires Excel format' });

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'QUANTUM';
    wb.created = new Date();
    const hStyle = {
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a1a2e' } },
      font: { bold: true, color: { argb: 'FFFFD700' }, size: 11 },
      alignment: { horizontal: 'center', readingOrder: 'rightToLeft', vertical: 'middle' },
    };
    const applyHeader = (ws, cols) => {
      ws.columns = cols.map((c) => ({ header: c.label, key: c.key, width: c.width || 16 }));
      ws.getRow(1).eachCell((cell) => Object.assign(cell, hStyle));
      ws.getRow(1).height = 26;
      ws.autoFilter = { from: 'A1', to: { row: 1, column: cols.length } };
      ws.views = [{ rightToLeft: true }];
    };

    // Sheet 1: Top Complexes
    {
      const ws = wb.addWorksheet('\u{1F3C6} \u05de\u05ea\u05d7\u05de\u05d9\u05dd \u05de\u05d5\u05d1\u05d9\u05dc\u05d9\u05dd');
      const cols = [
        { key: 'rank', label: '#', width: 5 },
        { key: 'name', label: '\u05e9\u05dd \u05de\u05ea\u05d7\u05dd', width: 24 },
        { key: 'city', label: '\u05e2\u05d9\u05e8', width: 14 },
        { key: 'iai_score', label: 'IAI', width: 10 },
        { key: 'planned_units', label: '\u05d9\u05d7\u05d9\u05d3\u05d5\u05ea', width: 12 },
        { key: 'status', label: '\u05e1\u05d8\u05d0\u05d8\u05d5\u05e1', width: 15 },
        { key: 'developer', label: '\u05d9\u05d6\u05dd', width: 20 },
      ];
      applyHeader(ws, cols);
      const { rows } = await pool.query(`SELECT name, city, iai_score, planned_units, status, developer FROM complexes WHERE iai_score IS NOT NULL ORDER BY iai_score DESC LIMIT 100`);
      rows.forEach((r, i) => {
        const row = ws.addRow({ rank: i + 1, ...r, iai_score: r.iai_score ? parseFloat(r.iai_score).toFixed(1) : '' });
        row.eachCell((cell) => {
          cell.alignment = { readingOrder: 'rightToLeft', vertical: 'middle' };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: i % 2 === 0 ? 'FFF8F8FF' : 'FFEFEFFF' } };
        });
        row.height = 20;
      });
    }

    // Sheet 2: Leads
    {
      const ws = wb.addWorksheet('\u{1F465} \u05dc\u05d9\u05d3\u05d9\u05dd');
      const cols = [
        { key: 'name', label: '\u05e9\u05dd', width: 20 },
        { key: 'email', label: '\u05d0\u05d9\u05de\u05d9\u05d9\u05dc', width: 24 },
        { key: 'phone', label: '\u05d8\u05dc\u05e4\u05d5\u05df', width: 15 },
        { key: 'status', label: '\u05e1\u05d8\u05d0\u05d8\u05d5\u05e1', width: 14 },
        { key: 'source', label: '\u05de\u05e7\u05d5\u05e8', width: 14 },
        { key: 'notes', label: '\u05d4\u05e2\u05e8\u05d5\u05ea', width: 28 },
        { key: 'created_at', label: '\u05ea\u05d0\u05e8\u05d9\u05da', width: 14 },
      ];
      applyHeader(ws, cols);
      const { rows } = await pool.query(`SELECT name, email, phone, status, source, notes, created_at FROM website_leads ORDER BY created_at DESC LIMIT 500`);
      rows.forEach((r, i) => {
        const row = ws.addRow({ ...r, created_at: r.created_at ? new Date(r.created_at).toLocaleDateString('he-IL') : '' });
        row.eachCell((cell) => {
          cell.alignment = { readingOrder: 'rightToLeft', vertical: 'middle' };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: i % 2 === 0 ? 'FFF8F8FF' : 'FFEFEFFF' } };
        });
        row.height = 20;
      });
    }

    // Sheet 3: Summary
    {
      const ws = wb.addWorksheet('\u{1F4CA} \u05e1\u05d9\u05db\u05d5\u05dd');
      ws.views = [{ rightToLeft: true }];
      ws.getColumn('A').width = 30;
      ws.getColumn('B').width = 20;
      const titleRow = ws.addRow(['QUANTUM - \u05d3\u05d5\u05d7 \u05de\u05dc\u05d0', new Date().toLocaleDateString('he-IL')]);
      titleRow.getCell(1).font = { bold: true, size: 16, color: { argb: 'FF1a1a2e' } };
      titleRow.height = 32;
      ws.addRow([]);
      const stats = await pool.query(`SELECT (SELECT COUNT(*) FROM complexes) as tc, (SELECT COUNT(*) FROM complexes WHERE iai_score >= 70) as hc, (SELECT COUNT(*) FROM website_leads) as tl, (SELECT COUNT(*) FROM website_leads WHERE status = 'qualified') as ql, (SELECT COUNT(*) FROM whatsapp_messages WHERE created_at > NOW() - INTERVAL '30 days') as m30`);
      const s = stats.rows[0];
      const statRows = [
        ['\u05e1\u05d4"\u05db \u05de\u05ea\u05d7\u05de\u05d9\u05dd', s.tc],
        ['\u05de\u05ea\u05d7\u05de\u05d9\u05dd \u05d7\u05de\u05d9\u05dd (IAI 70+)', s.hc],
        ['\u05e1\u05d4"\u05db \u05dc\u05d9\u05d3\u05d9\u05dd', s.tl],
        ['\u05dc\u05d9\u05d3\u05d9\u05dd \u05de\u05d5\u05e1\u05de\u05db\u05d9\u05dd', s.ql],
        ['\u05d4\u05d5\u05d3\u05e2\u05d5\u05ea \u05d1-30 \u05d9\u05d5\u05dd', s.m30],
        ['\u05ea\u05d0\u05e8\u05d9\u05da \u05d4\u05e4\u05e7\u05d4', new Date().toLocaleDateString('he-IL')],
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
// GET /api/export/info
// ══════════════════════════════════════════════════════════════════════════════
router.get('/info', (req, res) => {
  res.json({
    version: '4.73.0',
    exports: [
      { endpoint: '/api/export/leads', formats: ['xlsx', 'csv'], filters: ['status', 'source', 'limit'] },
      { endpoint: '/api/export/complexes', formats: ['xlsx', 'csv'], filters: ['city', 'min_iai', 'status', 'limit'] },
      { endpoint: '/api/export/messages', formats: ['xlsx', 'csv'], filters: ['direction', 'limit'] },
      { endpoint: '/api/export/ads', formats: ['xlsx', 'csv'], filters: ['city', 'limit'] },
      { endpoint: '/api/export/full-report', formats: ['xlsx'], filters: [] },
    ],
    usage: 'Add ?format=csv for CSV output, default is Excel'
  });
});

module.exports = router;
