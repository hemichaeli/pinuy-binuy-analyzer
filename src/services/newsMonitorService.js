/**
 * News & Regulation Monitoring Service - Phase 4.5
 * מקורות: RSS חדשות, עדכוני רגולציה, ניתוח סנטימנט
 */

const { logger } = require('./logger');
const { parseString } = require('xml2js');
const { promisify } = require('util');

const parseXML = promisify(parseString);

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';

const RSS_FEEDS = {
  globes: { name: 'גלובס נדל"ן', url: 'https://www.globes.co.il/news/rss/rss.nadlan.xml', category: 'news' },
  calcalist: { name: 'כלכליסט נדל"ן', url: 'https://www.calcalist.co.il/GeneralRSS/0,16335,L-8,00.xml', category: 'news' },
  themarker: { name: 'TheMarker נדל"ן', url: 'https://www.themarker.com/cmlink/1.145', category: 'news' },
  bizportal: { name: 'Bizportal נדל"ן', url: 'https://www.bizportal.co.il/rss/realestate.xml', category: 'news' }
};

const RELEVANT_KEYWORDS = {
  pinuyBinuy: ['פינוי בינוי', 'פינוי-בינוי', 'התחדשות עירונית', 'תמ"א 38', 'תמא 38'],
  regulation: ['חוק', 'תקנות', 'רגולציה', 'משרד הבינוי', 'מס שבח', 'מס רכישה'],
  developers: ['יזם', 'קבלן', 'חברת בנייה'],
  market: ['מחירי דירות', 'שוק הנדל"ן', 'משכנתאות'],
  planning: ['ועדה מחוזית', 'ועדה מקומית', 'תב"ע', 'היתר בנייה']
};

async function searchWithPerplexity(query, context = '') {
  if (!PERPLEXITY_API_KEY) return null;
  try {
    const response = await fetch(PERPLEXITY_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.1-sonar-large-128k-online',
        messages: [{ role: 'system', content: `אתה עוזר מחקר נדל"ן ישראלי. ${context}` }, { role: 'user', content: query }],
        temperature: 0.1, max_tokens: 2000
      })
    });
    if (!response.ok) throw new Error(`Perplexity API error: ${response.status}`);
    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (err) {
    logger.error('Perplexity search failed', { error: err.message });
    return null;
  }
}

async function fetchRSSFeed(feedConfig) {
  try {
    const response = await fetch(feedConfig.url, { headers: { 'User-Agent': 'Mozilla/5.0 QUANTUM News Monitor' }, timeout: 10000 });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xml = await response.text();
    const result = await parseXML(xml);
    const items = result?.rss?.channel?.[0]?.item || [];
    return items.map(item => ({
      source: feedConfig.name, title: item.title?.[0] || '', link: item.link?.[0] || '',
      description: item.description?.[0] || '', pubDate: item.pubDate?.[0] ? new Date(item.pubDate[0]) : null, category: feedConfig.category
    }));
  } catch (err) {
    logger.warn(`RSS fetch failed for ${feedConfig.name}`, { error: err.message });
    return [];
  }
}

async function fetchAllRSSFeeds() {
  logger.info('Fetching all RSS feeds');
  const allItems = [];
  for (const [key, feed] of Object.entries(RSS_FEEDS)) {
    const items = await fetchRSSFeed(feed);
    allItems.push(...items);
    await new Promise(r => setTimeout(r, 500));
  }
  allItems.sort((a, b) => (b.pubDate || 0) - (a.pubDate || 0));
  logger.info('RSS feeds fetched', { totalItems: allItems.length });
  return allItems;
}

function filterRelevantNews(items, keywords = null) {
  const searchKeywords = keywords || [...RELEVANT_KEYWORDS.pinuyBinuy, ...RELEVANT_KEYWORDS.regulation, ...RELEVANT_KEYWORDS.planning];
  return items.filter(item => {
    const text = `${item.title} ${item.description}`.toLowerCase();
    return searchKeywords.some(kw => text.includes(kw.toLowerCase()));
  });
}

async function searchNewsForComplex(complexName, city) {
  logger.info('Searching news for complex', { complexName, city });
  const query = `חפש כתבות על פרויקט "${complexName}" ב${city}. מקורות: גלובס, כלכליסט. החזר JSON: {"found": boolean, "articles": [{"title": "", "sentiment": "positive|negative|neutral"}], "overallSentiment": ""}`;
  const result = await searchWithPerplexity(query, 'חפש חדשות עדכניות');
  try {
    const jsonMatch = result?.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {}
  return { found: !!result, rawResponse: result, searchTerms: [complexName, city] };
}

async function searchNewsForDeveloper(developerName) {
  logger.info('Searching news for developer', { developerName });
  const query = `חפש כתבות על יזם/קבלן "${developerName}" בישראל. החזר JSON: {"found": boolean, "articles": [], "reputationScore": 1-10, "redFlags": [], "positiveIndicators": []}`;
  const result = await searchWithPerplexity(query, 'התמקד בחדשות מהשנה האחרונה');
  try {
    const jsonMatch = result?.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {}
  return { found: !!result, rawResponse: result, developerName };
}

async function getRegulationUpdates() {
  logger.info('Fetching regulation updates');
  const query = `עדכונים אחרונים ברגולציה של התחדשות עירונית ופינוי בינוי בישראל? החזר JSON: {"updates": [{"title": "", "type": "law|regulation|tax", "impact": "positive|negative|neutral"}], "upcomingChanges": []}`;
  const result = await searchWithPerplexity(query, 'התמקד בעדכונים מ-2024-2026');
  try {
    const jsonMatch = result?.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {}
  return { rawResponse: result, timestamp: new Date().toISOString() };
}

async function checkTama38Updates() {
  logger.info('Checking Tama 38 updates');
  const query = `מה הסטטוס הנוכחי של תמ"א 38 בישראל? החזר JSON: {"isActive": boolean, "recentChanges": [], "activeInCities": [], "alternatives": []}`;
  const result = await searchWithPerplexity(query);
  try {
    const jsonMatch = result?.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {}
  return { rawResponse: result };
}

async function checkPinuyBinuyLaw() {
  logger.info('Checking Pinuy Binuy law updates');
  const query = `עדכונים אחרונים בחוק פינוי בינוי בישראל? החזר JSON: {"requiredMajority": "", "tenantProtections": [], "taxIncentives": [], "recentAmendments": []}`;
  const result = await searchWithPerplexity(query);
  try {
    const jsonMatch = result?.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {}
  return { rawResponse: result };
}

async function checkTaxChanges() {
  logger.info('Checking tax changes');
  const query = `שינויים אחרונים במיסוי נדל"ן בישראל? החזר JSON: {"purchaseTax": {}, "capitalGainsTax": {}, "pinuyBinuyExemptions": [], "recentChanges": []}`;
  const result = await searchWithPerplexity(query);
  try {
    const jsonMatch = result?.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {}
  return { rawResponse: result };
}

function analyzeSentiment(text) {
  const positiveTerms = ['התקדמות', 'אישור', 'הצלחה', 'צמיחה', 'עלייה', 'שיפור', 'הזדמנות'];
  const negativeTerms = ['עיכוב', 'ביטול', 'בעיה', 'משבר', 'ירידה', 'כישלון', 'התנגדות'];
  const lowerText = text.toLowerCase();
  let positiveCount = 0, negativeCount = 0;
  for (const term of positiveTerms) if (lowerText.includes(term)) positiveCount++;
  for (const term of negativeTerms) if (lowerText.includes(term)) negativeCount++;
  if (positiveCount > negativeCount + 1) return 'positive';
  if (negativeCount > positiveCount + 1) return 'negative';
  if (positiveCount > 0 || negativeCount > 0) return 'mixed';
  return 'neutral';
}

async function generateNewsAlerts(complex, pool) {
  logger.info('Generating news alerts', { complexId: complex.id });
  const alerts = [];
  try {
    const complexNews = await searchNewsForComplex(complex.name, complex.city);
    if (complexNews.found && complexNews.articles?.length > 0) {
      for (const article of complexNews.articles.slice(0, 3)) {
        if (article.sentiment === 'negative') {
          alerts.push({ type: 'negative_news', complexId: complex.id, title: `חדשות שליליות: ${complex.name}`, description: article.summary || article.title, severity: 'medium', metadata: article });
        }
      }
    }
    if (complex.developer) {
      const developerNews = await searchNewsForDeveloper(complex.developer);
      if (developerNews.redFlags?.length > 0) {
        alerts.push({ type: 'developer_warning', complexId: complex.id, title: `אזהרה על היזם: ${complex.developer}`, description: developerNews.redFlags.join(', '), severity: 'high', metadata: developerNews });
      }
    }
    if (pool && alerts.length > 0) {
      for (const alert of alerts) {
        await pool.query(`INSERT INTO alerts (complex_id, alert_type, title, description, severity, metadata) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
          [alert.complexId, alert.type, alert.title, alert.description, alert.severity, JSON.stringify(alert.metadata)]);
      }
    }
  } catch (err) {
    logger.error('News alert generation failed', { error: err.message, complexId: complex.id });
  }
  return alerts;
}

async function runDailyNewsScan(pool) {
  logger.info('Starting daily news scan');
  const results = { timestamp: new Date().toISOString(), rssArticles: 0, relevantArticles: 0, alertsGenerated: 0, regulationUpdates: null };
  try {
    const allNews = await fetchAllRSSFeeds();
    results.rssArticles = allNews.length;
    const relevantNews = filterRelevantNews(allNews);
    results.relevantArticles = relevantNews.length;
    results.regulationUpdates = await getRegulationUpdates();
    for (const article of relevantNews.slice(0, 10)) {
      const sentiment = analyzeSentiment(`${article.title} ${article.description}`);
      if (sentiment === 'negative' || sentiment === 'positive') {
        await pool.query(`INSERT INTO alerts (alert_type, title, description, severity, metadata) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [`news_${sentiment}`, article.title.substring(0, 200), article.description?.substring(0, 500), sentiment === 'negative' ? 'medium' : 'low',
           JSON.stringify({ source: article.source, link: article.link, pubDate: article.pubDate, sentiment })]);
        results.alertsGenerated++;
      }
    }
    logger.info('Daily news scan complete', results);
  } catch (err) {
    logger.error('Daily news scan failed', { error: err.message });
    results.error = err.message;
  }
  return results;
}

module.exports = {
  fetchAllRSSFeeds, filterRelevantNews, searchNewsForComplex, searchNewsForDeveloper,
  getRegulationUpdates, checkTama38Updates, checkPinuyBinuyLaw, checkTaxChanges,
  analyzeSentiment, generateNewsAlerts, runDailyNewsScan, RSS_FEEDS, RELEVANT_KEYWORDS
};
