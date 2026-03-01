/**
 * Enhanced INFORU WhatsApp Webhook Handler with Lead Management
 * v2.0 - Saves leads to database, integrates with Trello, supports multi-language
 */

const express = require('express');
const router = express.Router();
const { logger } = require('../services/logger');
const pool = require('../db/pool');

// Lead Management Service
class LeadManager {
  static async saveOrUpdateLead(phone, message, botResponse, intelligence = {}) {
    try {
      // Check if lead exists
      const existingLead = await pool.query(
        'SELECT id, raw_data FROM leads WHERE phone = $1 AND source = $2',
        [phone, 'whatsapp_webhook']
      );

      const leadData = {
        phone,
        source: 'whatsapp_webhook',
        last_message: message,
        last_response: botResponse,
        user_type: intelligence.userType || 'unknown',
        sales_stage: intelligence.salesStage || 'initial',
        confidence: intelligence.confidence || 5,
        broker_status: intelligence.brokerStatus || 'unknown',
        satisfaction_level: intelligence.satisfaction || 'unknown',
        updated_at: new Date().toISOString()
      };

      if (existingLead.rows.length > 0) {
        // Update existing lead
        const currentData = existingLead.rows[0].raw_data || {};
        const mergedData = { ...currentData, ...leadData };

        await pool.query(`
          UPDATE leads SET 
            user_type = $2, 
            status = $3, 
            raw_data = $4, 
            updated_at = NOW()
          WHERE phone = $1 AND source = 'whatsapp_webhook'
        `, [phone, leadData.user_type, leadData.sales_stage, JSON.stringify(mergedData)]);

        logger.info('📝 Lead updated', { phone, stage: leadData.sales_stage });
        return existingLead.rows[0].id;
      } else {
        // Create new lead
        const newLead = await pool.query(`
          INSERT INTO leads (
            source, phone, user_type, status, raw_data, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
          RETURNING id
        `, [
          'whatsapp_webhook', 
          phone, 
          leadData.user_type, 
          leadData.sales_stage, 
          JSON.stringify(leadData)
        ]);

        logger.info('🆕 New lead created', { phone, leadId: newLead.rows[0].id });
        return newLead.rows[0].id;
      }
    } catch (error) {
      logger.error('❌ Lead save failed', { error: error.message, phone });
      return null;
    }
  }

  static async getLeadStats() {
    try {
      const stats = await pool.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'initial') as new_leads,
          COUNT(*) FILTER (WHERE status = 'qualifying') as qualifying,
          COUNT(*) FILTER (WHERE status = 'presenting') as presenting,
          COUNT(*) FILTER (WHERE status = 'closing') as closing,
          COUNT(*) FILTER (WHERE user_type = 'seller') as sellers,
          COUNT(*) FILTER (WHERE user_type = 'buyer') as buyers,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as today
        FROM leads 
        WHERE source = 'whatsapp_webhook'
      `);
      return stats.rows[0];
    } catch (error) {
      logger.error('❌ Stats query failed', { error: error.message });
      return null;
    }
  }
}

// Intelligence Analyzer - extracts lead intelligence from conversation
class IntelligenceAnalyzer {
  static analyzeConversation(message, botResponse) {
    const intelligence = {
      userType: 'unknown',
      salesStage: 'initial',
      confidence: 5,
      brokerStatus: 'unknown',
      satisfaction: 'unknown',
      language: 'hebrew'
    };

    // Language detection
    if (/[a-zA-Z]/.test(message) && !/[א-ת]/.test(message)) {
      intelligence.language = 'english';
    } else if (/[ا-ي]/.test(message)) {
      intelligence.language = 'arabic';
    } else if (/[а-я]/.test(message)) {
      intelligence.language = 'russian';
    }

    // User type detection
    if (message.includes('למכירה') || message.includes('מוכר') || message.includes('למכור')) {
      intelligence.userType = 'seller';
      intelligence.confidence = 8;
    } else if (message.includes('לקנות') || message.includes('קונה') || message.includes('לקנייה')) {
      intelligence.userType = 'buyer';
      intelligence.confidence = 8;
    }

    // Broker status detection
    if (message.includes('מתווך') || message.includes('סוכן')) {
      intelligence.brokerStatus = 'has_broker';
      if (message.includes('לא מרוצה') || message.includes('לא עובד') || message.includes('איטי')) {
        intelligence.satisfaction = 'low';
        intelligence.confidence = 9;
      }
    } else if (message.includes('בלי מתווך') || message.includes('ללא') || message.includes('עדיין לא')) {
      intelligence.brokerStatus = 'no_broker';
      intelligence.confidence = 9;
    }

    // Sales stage detection
    if (botResponse.includes('איך קוראים לך')) {
      intelligence.salesStage = 'qualifying';
    } else if (botResponse.includes('יתרון גדול') || botResponse.includes('מעולה')) {
      intelligence.salesStage = 'presenting';
    } else if (botResponse.includes('פגישה') || botResponse.includes('התקשרות')) {
      intelligence.salesStage = 'closing';
    }

    return intelligence;
  }
}

// Trello Integration Service
class TrelloService {
  static async createCardForHotLead(leadId, phone, intelligence) {
    try {
      // Only create Trello card for high-confidence leads
      if (intelligence.confidence < 7) return;

      const cardData = {
        name: `🔥 Lead חם - ${phone}`,
        desc: `**סוג:** ${intelligence.userType}\n**שלב:** ${intelligence.salesStage}\n**מתווך:** ${intelligence.brokerStatus}\n**ביטחון:** ${intelligence.confidence}/10\n**זמן:** ${new Date().toLocaleString('he-IL')}`,
        pos: 'top'
      };

      // Create Trello card (using existing trello service)
      const trelloService = require('../services/trelloService');
      await trelloService.createCard('LEADS חמים', cardData.name, cardData.desc);
      
      logger.info('🎯 Trello card created for hot lead', { leadId, phone, confidence: intelligence.confidence });
    } catch (error) {
      logger.error('❌ Trello card creation failed', { error: error.message, leadId });
    }
  }
}

// Multi-language Response Service
class MultiLanguageService {
  static getResponse(message, language = 'hebrew') {
    const responses = {
      hebrew: {
        greeting: 'שלום! אני מ-QUANTUM 👋 איך קוראים לך?',
        seller_no_broker: 'מעולה! יש לך יתרון גדול - תוכל לבחור את הטובים ביותר מההתחלה',
        seller_has_broker: 'איך אתה מרגיש עם ההתקדמות עד כה?',
        buyer_greeting: 'מחפש דירה? אנחנו מתמחים במציאת הנכס המושלם',
        closing: 'בוא נקבע שיחה קצרה לראות איך אנחנו יכולים לעזור לך'
      },
      english: {
        greeting: 'Hello! I\'m from QUANTUM 👋 What\'s your name?',
        seller_no_broker: 'Great! You have a big advantage - you can choose the best from the start',
        seller_has_broker: 'How do you feel about the progress so far?',
        buyer_greeting: 'Looking for an apartment? We specialize in finding the perfect property',
        closing: 'Let\'s schedule a quick call to see how we can help you'
      },
      arabic: {
        greeting: 'مرحبا! أنا من QUANTUM 👋 ما اسمك؟',
        seller_no_broker: 'ممتاز! لديك ميزة كبيرة - يمكنك اختيار الأفضل من البداية',
        seller_has_broker: 'كيف تشعر بالتقدم حتى الآن؟',
        buyer_greeting: 'تبحث عن شقة؟ نحن متخصصون في العثور على العقار المثالي',
        closing: 'دعنا نحدد مكالمة سريعة لنرى كيف يمكننا مساعدتك'
      }
    };

    return responses[language] || responses.hebrew;
  }

  static async generateResponse(message, intelligence) {
    const templates = this.getResponse(message, intelligence.language);
    
    // Simple response logic based on intelligence
    if (intelligence.userType === 'seller' && intelligence.brokerStatus === 'no_broker') {
      return templates.seller_no_broker;
    } else if (intelligence.userType === 'seller' && intelligence.brokerStatus === 'has_broker') {
      return templates.seller_has_broker;
    } else if (intelligence.userType === 'buyer') {
      return templates.buyer_greeting;
    } else if (intelligence.confidence >= 8) {
      return templates.closing;
    } else {
      return templates.greeting;
    }
  }
}

// Enhanced AI Call with Intelligence
async function callClaudeWithIntelligence(systemPrompt, userPrompt, intelligence) {
  const axios = require('axios');
  
  const enhancedPrompt = `${systemPrompt}

CONTEXT:
- User Type: ${intelligence.userType}
- Language: ${intelligence.language}
- Broker Status: ${intelligence.brokerStatus}
- Sales Stage: ${intelligence.salesStage}
- Confidence: ${intelligence.confidence}/10

USER MESSAGE: ${userPrompt}`;
  
  const response = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    system: enhancedPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  }, {
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    timeout: 12000
  });
  
  return response.data.content[0].text;
}

// Enhanced Sales System Prompt
const ENHANCED_SALES_SYSTEM_PROMPT = `אתה QUANTUM Sales AI - המתווך הדיגיטלי החכם ביותר בישראל.
מומחה בפינוי-בינוי ואיכות מכירות מעולה.

INTELLIGENCE SYSTEM:
- זהה את סוג הלקוח (קונה/מוכר) 
- בדוק מצב התיווך הנוכחי
- התאם את האסטרטגיה לשפה ולרמת הביטחון
- הובל לפגישה או התקשרות

RESPONSE RULES:
- השתמש בשפה של הלקוח (עברית/אנגלית/ערבית)
- אם אין מתווך - הדגש את היתרון
- אם יש מתווך - בדוק שביעות רצון
- אם ביטחון גבוה (8+) - הובל לסגירה
- תמיד היה חם, מקצועי ותומך

היה קצר וישיר.`;

// ===========================================
// MAIN WEBHOOK HANDLER - ENHANCED VERSION
// ===========================================

router.post('/whatsapp/webhook', async (req, res) => {
  try {
    logger.info('📥 Enhanced WhatsApp webhook received', { body: req.body });
    
    const messageData = req.body;
    const phone = messageData.phone || messageData.from;
    const message = messageData.message || messageData.text || messageData.body;
    
    if (!phone || !message) {
      return res.status(400).json({ error: 'Missing phone or message' });
    }
    
    logger.info('🧠 Processing with intelligence analysis', { phone, message: message.substring(0, 50) });
    
    // Step 1: Analyze conversation for intelligence
    let intelligence = IntelligenceAnalyzer.analyzeConversation(message, '');
    
    // Step 2: Generate AI response with intelligence context
    const aiResponse = await callClaudeWithIntelligence(ENHANCED_SALES_SYSTEM_PROMPT, message, intelligence);
    
    // Step 3: Re-analyze with bot response for better intelligence
    intelligence = IntelligenceAnalyzer.analyzeConversation(message, aiResponse);
    
    // Step 4: Save/update lead in database
    const leadId = await LeadManager.saveOrUpdateLead(phone, message, aiResponse, intelligence);
    
    // Step 5: Create Trello card for hot leads
    if (leadId && intelligence.confidence >= 7) {
      await TrelloService.createCardForHotLead(leadId, phone, intelligence);
    }
    
    // Step 6: Send response via INFORU
    const axios = require('axios');
    const auth = Buffer.from('hemichaeli:4e9d8256-b2da-4d95-9540-63e940aadc9a').toString('base64');
    
    await axios.post('https://capi.inforu.co.il/api/v2/WhatsApp/SendWhatsAppChat', {
      Data: { Message: aiResponse, Phone: phone }
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`
      }
    });
    
    logger.info('✅ Enhanced response sent', { 
      phone, 
      leadId,
      userType: intelligence.userType,
      confidence: intelligence.confidence,
      language: intelligence.language,
      responseLength: aiResponse.length
    });
    
    res.json({ 
      success: true, 
      processed: true,
      leadId,
      intelligence: {
        userType: intelligence.userType,
        salesStage: intelligence.salesStage,
        confidence: intelligence.confidence,
        language: intelligence.language
      }
    });
    
  } catch (error) {
    logger.error('❌ Enhanced webhook error', { error: error.message });
    res.status(500).json({ error: 'Processing failed' });
  }
});

// Manual trigger - also enhanced
router.post('/whatsapp/trigger', async (req, res) => {
  try {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
      return res.status(400).json({ error: 'Phone and message required' });
    }
    
    // Use same enhanced logic as webhook
    let intelligence = IntelligenceAnalyzer.analyzeConversation(message, '');
    const aiResponse = await callClaudeWithIntelligence(ENHANCED_SALES_SYSTEM_PROMPT, message, intelligence);
    intelligence = IntelligenceAnalyzer.analyzeConversation(message, aiResponse);
    
    const leadId = await LeadManager.saveOrUpdateLead(phone, message, aiResponse, intelligence);
    
    if (leadId && intelligence.confidence >= 7) {
      await TrelloService.createCardForHotLead(leadId, phone, intelligence);
    }
    
    const axios = require('axios');
    const auth = Buffer.from('hemichaeli:4e9d8256-b2da-4d95-9540-63e940aadc9a').toString('base64');
    
    const result = await axios.post('https://capi.inforu.co.il/api/v2/WhatsApp/SendWhatsAppChat', {
      Data: { Message: aiResponse, Phone: phone }
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`
      }
    });
    
    res.json({ 
      success: true, 
      aiResponse, 
      leadId,
      intelligence,
      inforuResult: result.data 
    });
    
  } catch (error) {
    logger.error('Enhanced trigger error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Lead stats endpoint
router.get('/whatsapp/stats', async (req, res) => {
  try {
    const stats = await LeadManager.getLeadStats();
    res.json({ success: true, stats });
  } catch (error) {
    logger.error('Stats error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;