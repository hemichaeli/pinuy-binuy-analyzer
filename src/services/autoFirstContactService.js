// autoFirstContactService.js
// Issue #3 — שליחת הודעת WhatsApp ראשונה אוטומטית לכל מפרסם חדש
// P0 - דחוף ביותר
// Cron: כל 30 דקות

const cron = require('node-cron');
const pool = require('../db/pool');
const axios = require('axios');

const INFORU_USERNAME = process.env.INFORU_USERNAME || 'hemichaeli';
const INFORU_TOKEN = process.env.INFORU_TOKEN || '95452ace-07cf-48be-8671-a197c15d3c17';
const INFORU_BUSINESS_LINE = process.env.INFORU_BUSINESS_LINE || '037572229';
const INFORU_API_URL = 'https://capi.inforu.co.il/api/v2/WhatsApp/SendWhatsAppChat';

// בנה הודעה ראשונה לפי סוג מקור וכתובת הנכס
function buildFirstMessage(listing, source) {
    const location = listing.address || listing.city || 'האזור שלך';
    const city = listing.city || '';

    if (source === 'facebook') {
        return `שלום! ראינו את המודעה שלך ב-${location}${city ? ` (${city})` : ''}.

אנחנו QUANTUM – משרד תיווך המתמחה בפינוי-בינוי ויש לנו קונים רציניים שמחפשים נכסים בדיוק באזור שלך.

האם תרצה לשמוע יותר? אנחנו מטפלים בהכל ובצורה מקצועית.`;
    }

    // יד2 default
    return `שלום! ראינו את המודעה שלך ביד2 ב${location}${city ? `, ${city}` : ''}.

אנחנו QUANTUM – משרד תיווך המתמחה בעסקאות פינוי-בינוי. יש לנו קונים מאומתים שמחפשים נכסים בדיוק באזור זה.

האם תרצה לשמוע על האפשרויות? נשמח לסייע.`;
}

// שלח הודעת WhatsApp דרך INFORU CAPI
async function sendWhatsApp(phone, message) {
    try {
        // נקה ועצב מספר טלפון
        let cleanPhone = phone.replace(/[^0-9]/g, '');
        if (cleanPhone.startsWith('0')) cleanPhone = '972' + cleanPhone.substring(1);
        if (!cleanPhone.startsWith('972')) cleanPhone = '972' + cleanPhone;

        const payload = {
            Data: {
                Message: message,
                Recipients: [{ Phone: cleanPhone }]
            },
            Settings: {
                BusinessLine: INFORU_BUSINESS_LINE
            },
            Authentication: {
                Username: INFORU_USERNAME,
                ApiToken: INFORU_TOKEN
            }
        };

        const response = await axios.post(INFORU_API_URL, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
        });

        return { success: response.data?.Status === 'SUCCESS' || response.status === 200, data: response.data };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// שמור הודעה יוצאת ב-DB
async function saveOutgoingMessage(phone, message, listingId, source) {
    try {
        // נסה לשמור ב-whatsapp_messages
        await pool.query(
            `INSERT INTO whatsapp_messages (phone, message, direction, message_type, created_at)
             VALUES ($1, $2, 'outgoing', 'text', NOW())
             ON CONFLICT DO NOTHING`,
            [phone, message]
        ).catch(() => null);

        // נסה לשמור ב-listing_messages
        if (listingId) {
            await pool.query(
                `INSERT INTO listing_messages (listing_id, message_text, direction, status, created_at)
                 VALUES ($1, $2, 'outgoing', 'sent', NOW())`,
                [listingId, message]
            ).catch(() => null);
        }

        // עדכן/צור whatsapp_conversation
        await pool.query(
            `INSERT INTO whatsapp_conversations (phone, status, updated_at)
             VALUES ($1, 'active', NOW())
             ON CONFLICT (phone) DO UPDATE SET updated_at = NOW()`,
            [phone]
        ).catch(() => null);

    } catch (err) {
        console.warn('[AutoFirstContact] saveOutgoingMessage error:', err.message);
    }
}

// עבד מודעות יד2 חדשות שלא פנינו אליהן
async function processYad2() {
    let contacted = 0, skipped = 0, failed = 0;

    try {
        const result = await pool.query(`
            SELECT id, phone, address, city, contact_name
            FROM listings
            WHERE contact_status IS NULL
              AND phone IS NOT NULL AND phone != ''
              AND is_active = TRUE
              AND created_at > NOW() - INTERVAL '2 hours'
              AND source = 'yad2'
            LIMIT 20
        `);

        for (const listing of result.rows) {
            try {
                const message = buildFirstMessage(listing, 'yad2');
                const result = await sendWhatsApp(listing.phone, message);

                if (result.success) {
                    await pool.query(
                        `UPDATE listings
                         SET contact_status = 'contacted',
                             contact_attempts = COALESCE(contact_attempts, 0) + 1,
                             last_contact_at = NOW(),
                             message_status = 'sent'
                         WHERE id = $1`,
                        [listing.id]
                    );
                    await saveOutgoingMessage(listing.phone, message, listing.id, 'yad2');
                    contacted++;
                    console.log(`[AutoFirstContact] ✅ Yad2 contacted: ${listing.phone} (${listing.address})`);
                } else {
                    await pool.query(
                        `UPDATE listings
                         SET contact_attempts = COALESCE(contact_attempts, 0) + 1,
                             last_contact_at = NOW()
                         WHERE id = $1`,
                        [listing.id]
                    );
                    failed++;
                    console.warn(`[AutoFirstContact] ❌ Yad2 failed: ${listing.phone} — ${result.error}`);
                }

                // המתן 3 שניות בין הודעות
                await new Promise(r => setTimeout(r, 3000));
            } catch (e) {
                failed++;
                console.warn(`[AutoFirstContact] Error processing listing ${listing.id}:`, e.message);
            }
        }
    } catch (e) {
        console.error('[AutoFirstContact] processYad2 DB error:', e.message);
    }

    return { contacted, skipped, failed };
}

// עבד מודעות פייסבוק חדשות שלא פנינו אליהן
async function processFacebook() {
    let contacted = 0, skipped = 0, failed = 0;

    // בדוק אם טבלת facebook_ads קיימת
    try {
        const tableCheck = await pool.query(
            `SELECT table_name FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'facebook_ads'`
        );
        if (tableCheck.rows.length === 0) {
            console.log('[AutoFirstContact] facebook_ads table not found, skipping');
            return { contacted: 0, skipped: 0, failed: 0 };
        }

        const result = await pool.query(`
            SELECT id, phone, address, city, contact_name
            FROM facebook_ads
            WHERE contact_status IS NULL
              AND phone IS NOT NULL AND phone != ''
              AND is_active = TRUE
              AND created_at > NOW() - INTERVAL '2 hours'
            LIMIT 20
        `).catch(() => ({ rows: [] }));

        for (const ad of result.rows) {
            try {
                const message = buildFirstMessage(ad, 'facebook');
                const sendResult = await sendWhatsApp(ad.phone, message);

                if (sendResult.success) {
                    await pool.query(
                        `UPDATE facebook_ads
                         SET contact_status = 'contacted',
                             contact_attempts = COALESCE(contact_attempts, 0) + 1,
                             last_contact_at = NOW()
                         WHERE id = $1`,
                        [ad.id]
                    );
                    await saveOutgoingMessage(ad.phone, message, null, 'facebook');
                    contacted++;
                    console.log(`[AutoFirstContact] ✅ Facebook contacted: ${ad.phone}`);
                } else {
                    failed++;
                    console.warn(`[AutoFirstContact] ❌ Facebook failed: ${ad.phone} — ${sendResult.error}`);
                }

                await new Promise(r => setTimeout(r, 3000));
            } catch (e) {
                failed++;
                console.warn(`[AutoFirstContact] Error processing fb ad ${ad.id}:`, e.message);
            }
        }
    } catch (e) {
        console.error('[AutoFirstContact] processFacebook DB error:', e.message);
    }

    return { contacted, skipped, failed };
}

// הפעל את שתי הפעולות
async function runAutoFirstContact() {
    console.log('[AutoFirstContact] Starting auto first contact run...');
    const yad2 = await processYad2();
    const fb = await processFacebook();
    const total = { contacted: yad2.contacted + fb.contacted, failed: yad2.failed + fb.failed };
    console.log(`[AutoFirstContact] Done — contacted: ${total.contacted}, failed: ${total.failed}`);
    return total;
}

// הגדר Cron כל 30 דקות
function startAutoFirstContactCron() {
    console.log('[AutoFirstContact] Scheduling cron: every 30 minutes');
    cron.schedule('*/30 * * * *', async () => {
        try {
            await runAutoFirstContact();
        } catch (err) {
            console.error('[AutoFirstContact] Cron error:', err.message);
        }
    });
}

module.exports = { startAutoFirstContactCron, runAutoFirstContact };
