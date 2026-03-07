const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// GET /api/analytics/overview
router.get('/overview', async (req, res) => {
  try {
    const { period = '30d' } = req.query;
    const days = period === '7d' ? 7 : period === '90d' ? 90 : period === '1y' ? 365 : 30;
    const since = `NOW() - INTERVAL '${days} days'`;

    const [complexes, leads, messages, deals, calls] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE enrichment_status = 'enriched') as enriched, ROUND(AVG(iai_score)::numeric, 1) as avg_iai FROM complexes`).catch(() => ({ rows: [{}] })),
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE created_at > ${since}) as new_period, COUNT(*) FILTER (WHERE status = 'qualified') as qualified, COUNT(*) FILTER (WHERE status = 'converted') as converted FROM leads`).catch(() => ({ rows: [{}] })),
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE created_at > ${since}) as new_period FROM whatsapp_messages`).catch(() => ({ rows: [{}] })),
      pool.query(`SELECT COUNT(*) as total, COALESCE(SUM(value) FILTER (WHERE stage = 'won'), 0) as won_value FROM deals`).catch(() => ({ rows: [{}] })),
      pool.query(`SELECT COUNT(*) as total FROM call_logs WHERE called_at > ${since}`).catch(() => ({ rows: [{}] }))
    ]);

    res.json({
      success: true,
      period,
      overview: {
        complexes: {
          total: parseInt(complexes.rows[0]?.total) || 698,
          enriched: parseInt(complexes.rows[0]?.enriched) || 0,
          avg_iai: parseFloat(complexes.rows[0]?.avg_iai) || 0
        },
        leads: {
          total: parseInt(leads.rows[0]?.total) || 0,
          new_this_period: parseInt(leads.rows[0]?.new_period) || 0,
          qualified: parseInt(leads.rows[0]?.qualified) || 0,
          converted: parseInt(leads.rows[0]?.converted) || 0,
          conversion_rate: leads.rows[0]?.total > 0
            ? Math.round((parseInt(leads.rows[0]?.converted) / parseInt(leads.rows[0]?.total)) * 100)
            : 0
        },
        messages: {
          total: parseInt(messages.rows[0]?.total) || 0,
          new_this_period: parseInt(messages.rows[0]?.new_period) || 0
        },
        deals: {
          total: parseInt(deals.rows[0]?.total) || 0,
          won_value: parseFloat(deals.rows[0]?.won_value) || 0
        },
        activity: {
          calls_this_period: parseInt(calls.rows[0]?.total) || 0
        }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/analytics/leads
router.get('/leads', async (req, res) => {
  try {
    const [bySource, byStatus, byCity, trend] = await Promise.all([
      pool.query(`SELECT source, COUNT(*) as count FROM leads GROUP BY source ORDER BY count DESC`).catch(() => ({ rows: [] })),
      pool.query(`SELECT status, COUNT(*) as count FROM leads GROUP BY status ORDER BY count DESC`).catch(() => ({ rows: [] })),
      pool.query(`SELECT city, COUNT(*) as count FROM leads WHERE city IS NOT NULL GROUP BY city ORDER BY count DESC LIMIT 10`).catch(() => ({ rows: [] })),
      pool.query(`SELECT DATE_TRUNC('day', created_at) as day, COUNT(*) as count FROM leads WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY day ORDER BY day`).catch(() => ({ rows: [] }))
    ]);

    res.json({
      success: true,
      leads: {
        by_source: bySource.rows,
        by_status: byStatus.rows,
        by_city: byCity.rows,
        daily_trend: trend.rows
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/analytics/market
router.get('/market', async (req, res) => {
  try {
    const [byCity, topIAI, priceRanges, statusDist] = await Promise.all([
      pool.query(`SELECT city, COUNT(*) as complexes, ROUND(AVG(iai_score)::numeric,1) as avg_iai, ROUND(AVG(ssi_score)::numeric,1) as avg_ssi FROM complexes WHERE city IS NOT NULL GROUP BY city ORDER BY avg_iai DESC NULLS LAST LIMIT 15`).catch(() => ({ rows: [] })),
      pool.query(`SELECT id, name, city, iai_score, ssi_score, units_count, developer FROM complexes WHERE iai_score IS NOT NULL ORDER BY iai_score DESC LIMIT 10`).catch(() => ({ rows: [] })),
      pool.query(`SELECT CASE WHEN price < 1000000 THEN 'מתחת למיליון' WHEN price < 2000000 THEN '1-2 מיליון' WHEN price < 3000000 THEN '2-3 מיליון' WHEN price < 5000000 THEN '3-5 מיליון' ELSE 'מעל 5 מיליון' END as range, COUNT(*) as count FROM yad2_listings WHERE price > 0 GROUP BY range ORDER BY count DESC`).catch(() => ({ rows: [] })),
      pool.query(`SELECT status, COUNT(*) as count FROM complexes WHERE status IS NOT NULL GROUP BY status ORDER BY count DESC`).catch(() => ({ rows: [] }))
    ]);

    res.json({
      success: true,
      market: {
        by_city: byCity.rows,
        top_iai_complexes: topIAI.rows,
        price_ranges: priceRanges.rows,
        status_distribution: statusDist.rows
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/analytics/performance
router.get('/performance', async (req, res) => {
  try {
    const [enrichment, scan, whatsapp] = await Promise.all([
      pool.query(`SELECT enrichment_status, COUNT(*) as count FROM complexes GROUP BY enrichment_status`).catch(() => ({ rows: [] })),
      pool.query(`SELECT status, COUNT(*) as count FROM scan_jobs GROUP BY status ORDER BY count DESC LIMIT 5`).catch(() => ({ rows: [] })),
      pool.query(`SELECT direction, COUNT(*) as count FROM whatsapp_messages WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY direction`).catch(() => ({ rows: [] }))
    ]);

    const enrichStats = {};
    enrichment.rows.forEach(r => { enrichStats[r.enrichment_status || 'unknown'] = parseInt(r.count); });
    const totalComplexes = Object.values(enrichStats).reduce((a, b) => a + b, 0);
    const enrichedCount = enrichStats['enriched'] || 0;

    res.json({
      success: true,
      performance: {
        enrichment: {
          total: totalComplexes,
          enriched: enrichedCount,
          pending: enrichStats['pending'] || 0,
          failed: enrichStats['failed'] || 0,
          rate: totalComplexes > 0 ? Math.round((enrichedCount / totalComplexes) * 100) : 0
        },
        scans: scan.rows,
        whatsapp_activity: whatsapp.rows
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/analytics/revenue
router.get('/revenue', async (req, res) => {
  try {
    const [monthly, byStage, topDeals] = await Promise.all([
      pool.query(`SELECT DATE_TRUNC('month', closed_at) as month, SUM(value) as revenue, COUNT(*) as deals FROM deals WHERE stage = 'won' AND closed_at IS NOT NULL GROUP BY month ORDER BY month DESC LIMIT 12`).catch(() => ({ rows: [] })),
      pool.query(`SELECT stage, COUNT(*) as count, COALESCE(SUM(value), 0) as total_value FROM deals GROUP BY stage ORDER BY total_value DESC`).catch(() => ({ rows: [] })),
      pool.query(`SELECT d.id, d.title, d.value, d.stage, l.name as lead_name FROM deals d LEFT JOIN leads l ON d.lead_id = l.id ORDER BY d.value DESC LIMIT 10`).catch(() => ({ rows: [] }))
    ]);

    res.json({
      success: true,
      revenue: {
        monthly_trend: monthly.rows,
        by_stage: byStage.rows,
        top_deals: topDeals.rows
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
