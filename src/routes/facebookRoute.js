const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// Facebook Marketing API integration
router.get('/sync', async (req, res) => {
    try {
        console.log('🔍 Facebook Ads Sync - Starting...');
        
        // TODO: Add Facebook Marketing API credentials
        const FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN;
        const FACEBOOK_AD_ACCOUNT_ID = process.env.FACEBOOK_AD_ACCOUNT_ID;
        
        if (!FACEBOOK_ACCESS_TOKEN || !FACEBOOK_AD_ACCOUNT_ID) {
            return res.status(400).json({
                success: false,
                error: 'Facebook API credentials missing',
                message: 'נדרש להגדיר FACEBOOK_ACCESS_TOKEN ו-FACEBOOK_AD_ACCOUNT_ID',
                setup_instructions: {
                    step1: 'נגש ל-https://developers.facebook.com',
                    step2: 'יצר Facebook App חדש',
                    step3: 'הוסף Marketing API permissions',
                    step4: 'קבל Access Token',
                    step5: 'הוסף המשתנים ל-Railway environment variables'
                }
            });
        }
        
        // Facebook Marketing API call
        const facebookApiUrl = `https://graph.facebook.com/v18.0/act_${FACEBOOK_AD_ACCOUNT_ID}/ads`;
        const params = new URLSearchParams({
            access_token: FACEBOOK_ACCESS_TOKEN,
            fields: 'id,name,status,effective_status,campaign{name},adset{name},insights{impressions,clicks,ctr,spend,actions}',
            limit: 100
        });
        
        console.log('📘 Calling Facebook Marketing API...');
        
        const response = await fetch(`${facebookApiUrl}?${params}`);
        
        if (!response.ok) {
            throw new Error(`Facebook API error: ${response.status} ${response.statusText}`);
        }
        
        const facebookData = await response.json();
        
        console.log(`📊 Facebook returned ${facebookData.data?.length || 0} ads`);
        
        // Save to database
        const savedAds = [];
        
        for (const ad of facebookData.data || []) {
            try {
                const insights = ad.insights?.data?.[0] || {};
                const leadActions = insights.actions?.find(action => 
                    action.action_type === 'lead' || 
                    action.action_type === 'contact' ||
                    action.action_type === 'complete_registration'
                ) || { value: '0' };
                
                const adData = {
                    facebook_ad_id: ad.id,
                    ad_name: ad.name,
                    campaign_name: ad.campaign?.name || 'Unknown Campaign',
                    adset_name: ad.adset?.name || 'Unknown Adset',
                    status: ad.effective_status || ad.status,
                    impressions: parseInt(insights.impressions) || 0,
                    clicks: parseInt(insights.clicks) || 0,
                    ctr: parseFloat(insights.ctr) || 0,
                    spend: parseFloat(insights.spend) || 0,
                    leads: parseInt(leadActions.value) || 0,
                    cost_per_lead: 0,
                    last_updated: new Date()
                };
                
                // Calculate cost per lead
                if (adData.leads > 0) {
                    adData.cost_per_lead = adData.spend / adData.leads;
                }
                
                // Insert or update in database
                const upsertQuery = `
                    INSERT INTO facebook_ads (
                        facebook_ad_id, ad_name, campaign_name, adset_name, status,
                        impressions, clicks, ctr, spend, leads, cost_per_lead, last_updated
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                    ON CONFLICT (facebook_ad_id) 
                    DO UPDATE SET
                        ad_name = EXCLUDED.ad_name,
                        campaign_name = EXCLUDED.campaign_name,
                        adset_name = EXCLUDED.adset_name,
                        status = EXCLUDED.status,
                        impressions = EXCLUDED.impressions,
                        clicks = EXCLUDED.clicks,
                        ctr = EXCLUDED.ctr,
                        spend = EXCLUDED.spend,
                        leads = EXCLUDED.leads,
                        cost_per_lead = EXCLUDED.cost_per_lead,
                        last_updated = EXCLUDED.last_updated
                `;
                
                await pool.query(upsertQuery, [
                    adData.facebook_ad_id, adData.ad_name, adData.campaign_name, 
                    adData.adset_name, adData.status, adData.impressions, 
                    adData.clicks, adData.ctr, adData.spend, adData.leads, 
                    adData.cost_per_lead, adData.last_updated
                ]);
                
                savedAds.push(adData);
                
            } catch (adError) {
                console.error(`❌ Error processing ad ${ad.id}:`, adError);
            }
        }
        
        console.log(`✅ Facebook Ads Sync Complete: ${savedAds.length} ads saved`);
        
        res.json({
            success: true,
            message: `Facebook Ads sync completed successfully`,
            summary: {
                total_ads_fetched: facebookData.data?.length || 0,
                ads_saved: savedAds.length,
                total_impressions: savedAds.reduce((sum, ad) => sum + ad.impressions, 0),
                total_clicks: savedAds.reduce((sum, ad) => sum + ad.clicks, 0),
                total_spend: savedAds.reduce((sum, ad) => sum + ad.spend, 0),
                total_leads: savedAds.reduce((sum, ad) => sum + ad.leads, 0)
            },
            ads: savedAds.slice(0, 10) // Return first 10 for preview
        });
        
    } catch (error) {
        console.error('❌ Facebook Ads Sync Error:', error);
        res.status(500).json({
            success: false,
            error: 'Facebook Ads sync failed',
            details: error.message,
            troubleshooting: [
                'בדוק שה-Facebook Access Token תקף',
                'בדוק שה-Ad Account ID נכון',
                'בדוק שיש הרשאות למכתבת Marketing API',
                'בדוק שה-Facebook App מאושר'
            ]
        });
    }
});

// Get Facebook ads from database
router.get('/ads', async (req, res) => {
    try {
        const { 
            campaign, status, minSpend, maxSpend, minLeads, maxLeads,
            sortBy, sortOrder, page = 1, limit = 50 
        } = req.query;
        
        let query = `
            SELECT 
                id, facebook_ad_id, ad_name, campaign_name, adset_name, status,
                impressions, clicks, ctr, spend, leads, cost_per_lead, last_updated
            FROM facebook_ads 
            WHERE 1=1
        `;
        
        const params = [];
        let paramCount = 1;
        
        // Apply filters
        if (campaign && campaign.trim()) {
            query += ` AND campaign_name ILIKE $${paramCount}`;
            params.push(`%${campaign.trim()}%`);
            paramCount++;
        }
        
        if (status) {
            query += ` AND status = $${paramCount}`;
            params.push(status);
            paramCount++;
        }
        
        if (minSpend && !isNaN(minSpend)) {
            query += ` AND spend >= $${paramCount}`;
            params.push(parseFloat(minSpend));
            paramCount++;
        }
        
        if (maxSpend && !isNaN(maxSpend)) {
            query += ` AND spend <= $${paramCount}`;
            params.push(parseFloat(maxSpend));
            paramCount++;
        }
        
        if (minLeads && !isNaN(minLeads)) {
            query += ` AND leads >= $${paramCount}`;
            params.push(parseInt(minLeads));
            paramCount++;
        }
        
        if (maxLeads && !isNaN(maxLeads)) {
            query += ` AND leads <= $${paramCount}`;
            params.push(parseInt(maxLeads));
            paramCount++;
        }
        
        // Add sorting
        const validSortFields = ['ad_name', 'campaign_name', 'impressions', 'clicks', 'spend', 'leads', 'cost_per_lead', 'last_updated'];
        const sortField = validSortFields.includes(sortBy) ? sortBy : 'last_updated';
        const order = sortOrder === 'asc' ? 'ASC' : 'DESC';
        
        // Add pagination
        const offset = (parseInt(page) - 1) * parseInt(limit);
        query += ` ORDER BY ${sortField} ${order} LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
        params.push(parseInt(limit), offset);
        
        console.log('[Facebook Ads API] Query:', query);
        console.log('[Facebook Ads API] Params:', params);
        
        const result = await pool.query(query, params);
        
        // Get total count for pagination
        let countQuery = 'SELECT COUNT(*) as total FROM facebook_ads WHERE 1=1';
        const countResult = await pool.query(countQuery);
        const totalCount = parseInt(countResult.rows[0]?.total) || 0;
        
        console.log(`[Facebook Ads API] Returning ${result.rows.length} ads out of ${totalCount} total`);
        
        res.json({
            success: true,
            data: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: totalCount,
                hasMore: (offset + result.rows.length) < totalCount
            }
        });
        
    } catch (error) {
        console.error('[Facebook Ads API] Error:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to fetch Facebook ads', 
            details: error.message 
        });
    }
});

// Facebook campaign performance analysis
router.get('/campaigns', async (req, res) => {
    try {
        const query = `
            SELECT 
                campaign_name,
                COUNT(*) as total_ads,
                SUM(impressions) as total_impressions,
                SUM(clicks) as total_clicks,
                ROUND(AVG(ctr), 2) as avg_ctr,
                SUM(spend) as total_spend,
                SUM(leads) as total_leads,
                ROUND(CASE WHEN SUM(leads) > 0 THEN SUM(spend) / SUM(leads) ELSE 0 END, 2) as avg_cost_per_lead
            FROM facebook_ads 
            GROUP BY campaign_name
            ORDER BY total_spend DESC
        `;
        
        const result = await pool.query(query);
        
        res.json({
            success: true,
            data: result.rows
        });
        
    } catch (error) {
        console.error('[Facebook Campaigns API] Error:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to fetch Facebook campaigns', 
            details: error.message 
        });
    }
});

// Create Facebook ad webhook for real-time updates
router.post('/webhook', async (req, res) => {
    try {
        console.log('📘 Facebook Webhook received:', req.body);
        
        // Verify Facebook webhook
        if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN) {
            console.log('✅ Facebook webhook verified');
            return res.status(200).send(req.query['hub.challenge']);
        }
        
        // Process webhook data
        const body = req.body;
        
        if (body.object === 'application') {
            body.entry.forEach(async (entry) => {
                const changes = entry.changes || [];
                
                for (const change of changes) {
                    if (change.field === 'leadgen') {
                        console.log('📋 New lead from Facebook:', change.value);
                        
                        // Save lead to database
                        try {
                            await pool.query(
                                `INSERT INTO leads (name, phone, email, source, facebook_lead_id, created_at) 
                                 VALUES ($1, $2, $3, 'facebook', $4, $5)`,
                                [
                                    change.value.form_name || 'Facebook Lead',
                                    change.value.phone || '',
                                    change.value.email || '',
                                    change.value.leadgen_id,
                                    new Date()
                                ]
                            );
                            
                            console.log('✅ Facebook lead saved to database');
                            
                        } catch (dbError) {
                            console.error('❌ Error saving Facebook lead:', dbError);
                        }
                    }
                }
            });
        }
        
        res.status(200).send('OK');
        
    } catch (error) {
        console.error('❌ Facebook Webhook Error:', error);
        res.status(500).send('Webhook Error');
    }
});

module.exports = router;