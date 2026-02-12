/**
 * Israeli & Jewish Holidays - Scan Skip Days
 * 
 * These are days when the daily scan should NOT run.
 * Includes: Shabbat (auto), Friday (auto), and Jewish/Israeli holidays.
 * 
 * Format: 'YYYY-MM-DD' (Gregorian dates)
 * 
 * To add custom skip days, set env var:
 *   EXTRA_SKIP_DATES=2026-03-15,2026-06-01
 * 
 * Updated for Hebrew years 5786-5787 (2026-2027)
 */

// Hebrew year 5786 holidays (remaining in 2026)
const HOLIDAYS_5786 = [
  // תענית אסתר + פורים
  { date: '2026-03-16', name: 'תענית אסתר', nameEn: 'Fast of Esther' },
  { date: '2026-03-17', name: 'פורים', nameEn: 'Purim' },
  { date: '2026-03-18', name: 'שושן פורים', nameEn: 'Shushan Purim' },
  
  // פסח
  { date: '2026-04-02', name: 'ערב פסח', nameEn: 'Erev Pesach' },
  { date: '2026-04-03', name: 'פסח - יום א׳', nameEn: 'Pesach Day 1' },
  { date: '2026-04-04', name: 'פסח - חול המועד', nameEn: 'Pesach Chol HaMoed' },
  { date: '2026-04-05', name: 'פסח - חול המועד', nameEn: 'Pesach Chol HaMoed' },
  { date: '2026-04-06', name: 'פסח - חול המועד', nameEn: 'Pesach Chol HaMoed' },
  { date: '2026-04-07', name: 'פסח - חול המועד', nameEn: 'Pesach Chol HaMoed' },
  { date: '2026-04-08', name: 'פסח - חול המועד', nameEn: 'Pesach Chol HaMoed' },
  { date: '2026-04-09', name: 'פסח - יום ז׳', nameEn: 'Pesach Day 7' },
  
  // ימי זיכרון + עצמאות
  { date: '2026-04-22', name: 'יום השואה', nameEn: 'Yom HaShoah' },
  { date: '2026-04-29', name: 'יום הזיכרון', nameEn: 'Yom HaZikaron' },
  { date: '2026-04-30', name: 'יום העצמאות', nameEn: 'Yom HaAtzmaut' },

  // שבועות
  { date: '2026-05-22', name: 'ערב שבועות', nameEn: 'Erev Shavuot' },
  { date: '2026-05-23', name: 'שבועות', nameEn: 'Shavuot' },

  // ט׳ באב
  { date: '2026-07-23', name: 'תשעה באב', nameEn: 'Tisha B\'Av' },
];

// Hebrew year 5787 holidays (Sept 2026 - 2027)
const HOLIDAYS_5787 = [
  // ראש השנה + יום כיפור
  { date: '2026-09-11', name: 'ערב ראש השנה', nameEn: 'Erev Rosh Hashana' },
  { date: '2026-09-12', name: 'ראש השנה א׳', nameEn: 'Rosh Hashana Day 1' },
  { date: '2026-09-13', name: 'ראש השנה ב׳', nameEn: 'Rosh Hashana Day 2' },
  { date: '2026-09-20', name: 'ערב יום כיפור', nameEn: 'Erev Yom Kippur' },
  { date: '2026-09-21', name: 'יום כיפור', nameEn: 'Yom Kippur' },
  
  // סוכות + שמחת תורה
  { date: '2026-09-25', name: 'ערב סוכות', nameEn: 'Erev Sukkot' },
  { date: '2026-09-26', name: 'סוכות - יום א׳', nameEn: 'Sukkot Day 1' },
  { date: '2026-09-27', name: 'סוכות - חול המועד', nameEn: 'Sukkot Chol HaMoed' },
  { date: '2026-09-28', name: 'סוכות - חול המועד', nameEn: 'Sukkot Chol HaMoed' },
  { date: '2026-09-29', name: 'סוכות - חול המועד', nameEn: 'Sukkot Chol HaMoed' },
  { date: '2026-09-30', name: 'סוכות - חול המועד', nameEn: 'Sukkot Chol HaMoed' },
  { date: '2026-10-01', name: 'הושענא רבה', nameEn: 'Hoshana Raba' },
  { date: '2026-10-02', name: 'שמיני עצרת', nameEn: 'Shemini Atzeret' },
  { date: '2026-10-03', name: 'שמחת תורה', nameEn: 'Simchat Torah' },
  
  // חנוכה (partial - some businesses operate)
  // Not included as scan-skip days

  // פורים 5787
  { date: '2027-03-04', name: 'תענית אסתר', nameEn: 'Fast of Esther' },
  { date: '2027-03-05', name: 'פורים', nameEn: 'Purim' },
  { date: '2027-03-06', name: 'שושן פורים', nameEn: 'Shushan Purim' },
  
  // פסח 5787
  { date: '2027-03-22', name: 'ערב פסח', nameEn: 'Erev Pesach' },
  { date: '2027-03-23', name: 'פסח - יום א׳', nameEn: 'Pesach Day 1' },
  { date: '2027-03-24', name: 'פסח - חול המועד', nameEn: 'Pesach Chol HaMoed' },
  { date: '2027-03-25', name: 'פסח - חול המועד', nameEn: 'Pesach Chol HaMoed' },
  { date: '2027-03-26', name: 'פסח - חול המועד', nameEn: 'Pesach Chol HaMoed' },
  { date: '2027-03-27', name: 'פסח - חול המועד', nameEn: 'Pesach Chol HaMoed' },
  { date: '2027-03-28', name: 'פסח - חול המועד', nameEn: 'Pesach Chol HaMoed' },
  { date: '2027-03-29', name: 'פסח - יום ז׳', nameEn: 'Pesach Day 7' },
  
  // ימי זיכרון + עצמאות 5787
  { date: '2027-04-11', name: 'יום השואה', nameEn: 'Yom HaShoah' },
  { date: '2027-04-18', name: 'יום הזיכרון', nameEn: 'Yom HaZikaron' },
  { date: '2027-04-19', name: 'יום העצמאות', nameEn: 'Yom HaAtzmaut' },
  
  // שבועות 5787
  { date: '2027-05-11', name: 'ערב שבועות', nameEn: 'Erev Shavuot' },
  { date: '2027-05-12', name: 'שבועות', nameEn: 'Shavuot' },
  
  // ט׳ באב 5787
  { date: '2027-07-12', name: 'תשעה באב', nameEn: 'Tisha B\'Av' },
];

const ALL_HOLIDAYS = [...HOLIDAYS_5786, ...HOLIDAYS_5787];

/**
 * Check if a given date is an Israeli holiday
 * @param {Date} date - Date to check (in Israel timezone)
 * @returns {{ isHoliday: boolean, name?: string, nameEn?: string }}
 */
function isHoliday(date) {
  // Format date to YYYY-MM-DD in Israel timezone
  const israelDate = date.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  
  const holiday = ALL_HOLIDAYS.find(h => h.date === israelDate);
  if (holiday) {
    return { isHoliday: true, name: holiday.name, nameEn: holiday.nameEn };
  }
  
  // Check env var for extra skip dates
  const extraDates = process.env.EXTRA_SKIP_DATES;
  if (extraDates) {
    const extras = extraDates.split(',').map(d => d.trim());
    if (extras.includes(israelDate)) {
      return { isHoliday: true, name: 'יום מיוחד', nameEn: 'Custom skip day' };
    }
  }
  
  return { isHoliday: false };
}

/**
 * Check if a given date is Friday or Saturday (Israeli weekend)
 * @param {Date} date
 * @returns {{ isWeekend: boolean, day?: string }}
 */
function isWeekend(date) {
  // Get day of week in Israel timezone
  const dayName = date.toLocaleDateString('en-US', { 
    timeZone: 'Asia/Jerusalem', 
    weekday: 'long' 
  });
  
  if (dayName === 'Friday') return { isWeekend: true, day: 'יום שישי (Friday)' };
  if (dayName === 'Saturday') return { isWeekend: true, day: 'שבת (Saturday)' };
  return { isWeekend: false };
}

/**
 * Check if scan should be skipped today
 * @param {Date} [date] - Date to check (defaults to now)
 * @returns {{ shouldSkip: boolean, reason?: string, reasonHe?: string }}
 */
function shouldSkipToday(date = new Date()) {
  const weekend = isWeekend(date);
  if (weekend.isWeekend) {
    return { 
      shouldSkip: true, 
      reason: `Weekend: ${weekend.day}`,
      reasonHe: `סוף שבוע: ${weekend.day}`
    };
  }
  
  const holiday = isHoliday(date);
  if (holiday.isHoliday) {
    return { 
      shouldSkip: true, 
      reason: `Holiday: ${holiday.nameEn} (${holiday.name})`,
      reasonHe: `חג: ${holiday.name}`
    };
  }
  
  return { shouldSkip: false };
}

/**
 * Get next upcoming holidays (for status display)
 * @param {number} count - How many to return
 * @returns {Array}
 */
function getUpcomingHolidays(count = 5) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  return ALL_HOLIDAYS
    .filter(h => h.date >= today)
    .slice(0, count);
}

module.exports = {
  ALL_HOLIDAYS,
  isHoliday,
  isWeekend,
  shouldSkipToday,
  getUpcomingHolidays
};
