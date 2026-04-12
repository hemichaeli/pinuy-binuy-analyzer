router.get('/api/stats', async (req, res) => {
    try {
        const PILOT_IDS = [250, 205, 1077, 64, 122, 458, 1240, 769];
        const [complexes, listings, opportunities, messages, leads, deals, kones, pilot] = await Promise.all([
            pool.query('SELECT COUNT(*) as total FROM complexes'),
            pool.query('SELECT COUNT(*) as total FROM listings WHERE is_active = TRUE'),
            pool.query('SELECT COUNT(*) as total FROM complexes WHERE iai_score > 75'),
            pool.query("SELECT COUNT(*) as total FROM whatsapp_conversations WHERE status = 'active'").catch(() => ({ rows: [{ total: 0 }] })),
            pool.query("SELECT COUNT(*) as total FROM website_leads WHERE status IN ('contacted','qualified')"),
            pool.query("SELECT COUNT(*) as total FROM listings WHERE deal_status IN ('תיווך','סגור')"),
            pool.query('SELECT COUNT(*) as total FROM kones_assets').catch(() => ({ rows: [{ total: 0 }] })),
            pool.query(`
                SELECT
                    COUNT(DISTINCT l.phone) FILTER (WHERE l.message_status = 'נשלחה') as wa_sent,
                    COUNT(DISTINCT l.phone) FILTER (WHERE l.last_reply_at IS NOT NULL) as replied,
                    COUNT(DISTINCT l.id) FILTER (WHERE l.message_status = 'נשלחה') as total_sent
                FROM listings l
                WHERE l.complex_id = ANY($1) AND l.is_active = TRUE
            `, [PILOT_IDS]).catch(() => ({ rows: [{ wa_sent: 0, replied: 0, total_sent: 0 }] }))
        ]);
        res.json({ success: true, data: {
            totalComplexes: parseInt(complexes.rows[0]?.total) || 0,
            newListings: parseInt(listings.rows[0]?.total) || 0,
            hotOpportunities: parseInt(opportunities.rows[0]?.total) || 0,
            activeMessages: parseInt(messages.rows[0]?.total) || 0,
            qualifiedLeads: parseInt(leads.rows[0]?.total) || 0,
            closedDeals: parseInt(deals.rows[0]?.total) || 0,
            konesCount: parseInt(kones.rows[0]?.total) || 0,
            pilotWaSent: parseInt(pilot.rows[0]?.wa_sent) || 0,
            pilotReplied: parseInt(pilot.rows[0]?.replied) || 0
        }});
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

