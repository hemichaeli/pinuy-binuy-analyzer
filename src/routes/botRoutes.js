/**
 * GET /api/bot/leads-ui - WhatsApp leads dashboard (HTML)
 */
router.get('/leads-ui', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/bot-leads.html'));
});
