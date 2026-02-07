require('dotenv').config();
const pool = require('./pool');

// Premium ranges by status (from methodology)
const PREMIUM_BY_STATUS = {
  construction: { min: 90, max: 100 },
  approved: { min: 50, max: 70 },
  deposited: { min: 35, max: 50 },
  pre_deposit: { min: 20, max: 35 },
  declared: { min: 5, max: 15 },
  planning: { min: 0, max: 10 },
  unknown: { min: 0, max: 0 },
};

// Developer strength mapping
const STRONG_DEVS = ['שיכון ובינוי', 'אפריקה ישראל', 'אאורה', 'דוניץ', 'אלעד', 'קרסו', 'אשדר', 'אלקטרה'];
const MEDIUM_DEVS = ['ICR', 'בוני התיכון', 'רסקו', 'אלמוג', 'תדהר', 'גבאי', 'קבוצת גבאי', 'אזורים', 'קבוצת לוזון', 'ענב', 'יובלים', 'רוטשטיין'];

function getDevStrength(developer) {
  if (!developer || developer === '-') return 'unknown';
  for (const d of STRONG_DEVS) {
    if (developer.includes(d)) return 'strong';
  }
  for (const d of MEDIUM_DEVS) {
    if (developer.includes(d)) return 'medium';
  }
  return 'weak';
}

// All 92 projects data
const ALL_PROJECTS = [
  // ========== RISHON LEZION (11) ==========
  { slug: 'rl_ramat_eliyahu', name: 'רמת אליהו', city: 'ראשון לציון', region: 'גוש דן ומרכז', addresses: 'שכונת רמת אליהו כולה - דרך יצחק רבין (צפון), דרך מנחם בגין (דרום)', existing_units: 2600, planned_units: 7200, developer: 'שיכון ובינוי', status: 'construction' },
  { slug: 'rl_rotschild', name: 'רוטשילד', city: 'ראשון לציון', region: 'גוש דן ומרכז', addresses: 'רחובות תומר, השקד, השקמה, רוטשילד', existing_units: 276, planned_units: 900, developer: 'ICR', status: 'planning' },
  { slug: 'rl_kiryat_omanim', name: 'קריית האמנים', city: 'ראשון לציון', region: 'גוש דן ומרכז', addresses: 'מרכז העיר ראשון לציון', planned_units: 1386, developer: 'דוניץ-אלעד', status: 'construction' },
  { slug: 'rl_nachalat_yehuda', name: 'נחלת יהודה', city: 'ראשון לציון', region: 'גוש דן ומרכז', addresses: 'שכונת נחלת יהודה, אזור אצטדיון ישן', existing_units: 214, planned_units: 800, developer: 'קבוצת לוזון', status: 'approved', approval_date: '2021-01-01' },
  { slug: 'rl_jabotinsky', name: "ז'בוטינסקי-ולפסון-התומר", city: 'ראשון לציון', region: 'גוש דן ומרכז', addresses: "רחוב ז'בוטינסקי", planned_units: 254, status: 'planning' },
  { slug: 'rl_bonei_hatichon', name: 'בוני התיכון', city: 'ראשון לציון', region: 'גוש דן ומרכז', existing_units: 353, planned_units: 1100, developer: 'בוני התיכון', status: 'planning' },
  { slug: 'rl_jerusalem_bethlehem', name: 'ירושלים-בית לחם', city: 'ראשון לציון', region: 'גוש דן ומרכז', addresses: 'רחוב ירושלים, רחוב בית לחם', existing_units: 136, planned_units: 450, developer: 'צרפתי צבי ובניו', status: 'pre_deposit' },
  { slug: 'rl_jerusalem_st', name: 'רחוב ירושלים', city: 'ראשון לציון', region: 'גוש דן ומרכז', addresses: 'רחוב ירושלים', planned_units: 350, status: 'planning' },
  { slug: 'rl_dganya', name: 'דגניה', city: 'ראשון לציון', region: 'גוש דן ומרכז', addresses: 'שכונת דגניה', existing_units: 58, planned_units: 290, developer: 'רסקו', status: 'approved', approval_date: '2014-01-01' },
  { slug: 'rl_osishkin', name: 'אוסישקין', city: 'ראשון לציון', region: 'גוש דן ומרכז', addresses: 'רחוב אוסישקין', existing_units: 41, planned_units: 140, developer: 'מנוס אוסישקין + רויאל גרדן', status: 'planning' },
  { slug: 'rl_bst', name: 'מתחם BST', city: 'ראשון לציון', region: 'גוש דן ומרכז', planned_units: 256, developer: 'קבוצת BST', status: 'planning' },

  // ========== HOLON (16) ==========
  { slug: 'hl_dov_hoz', name: 'דב הוז (תמל/2045)', city: 'חולון', region: 'גוש דן ומרכז', addresses: 'שד\' דב הוז, המעפילים, מבצע סיני, גבעתי - 91 דונם, 148 בניינים', existing_units: 1069, planned_units: 3217, developer: 'הרשות הממשלתית', status: 'deposited', deposit_date: '2025-06-01', area_dunam: 91 },
  { slug: 'hl_har_hatzofim', name: 'הר הצופים', city: 'חולון', region: 'גוש דן ומרכז', addresses: 'שכונת הר הצופים, צפון חולון - 72 דונם', existing_units: 651, planned_units: 2084, developer: 'בוני התיכון', status: 'pre_deposit', area_dunam: 72 },
  { slug: 'hl_rabi_akiva', name: "רבי עקיבא (רסקו ג')", city: 'חולון', region: 'גוש דן ומרכז', addresses: 'רחוב רבי עקיבא פינת בר כוכבא - 23 דונם', existing_units: 157, planned_units: 492, developer: 'ICR', status: 'deposited', deposit_date: '2025-07-01', area_dunam: 23 },
  { slug: 'hl_shankar', name: 'שנקר (אגרובנק)', city: 'חולון', region: 'גוש דן ומרכז', addresses: 'רחוב שנקר 10-14', existing_units: 46, planned_units: 168, developer: 'קרסו נדל"ן', status: 'declared' },
  { slug: 'hl_maapilim', name: 'המעפילים (גרין)', city: 'חולון', region: 'גוש דן ומרכז', addresses: 'רחוב המעפילים, רחוב הראל', existing_units: 36, planned_units: 155, developer: 'אלמוג פינוי בינוי', status: 'declared' },
  { slug: 'hl_kugel', name: 'קוגל', city: 'חולון', region: 'גוש דן ומרכז', addresses: 'שדרות קוגל, כניסה לעיר', planned_units: 350, status: 'pre_deposit' },
  { slug: 'hl_histadrut', name: 'ההסתדרות', city: 'חולון', region: 'גוש דן ומרכז', addresses: 'רחוב ההסתדרות', existing_units: 116, planned_units: 350, status: 'planning' },
  { slug: 'hl_sharet', name: 'שרת', city: 'חולון', region: 'גוש דן ומרכז', addresses: 'רחוב שרת - 15.2 דונם', planned_units: 204, developer: 'RMA + צמח המרמן', status: 'planning', area_dunam: 15.2 },
  { slug: 'hl_agrobank', name: 'אגרובנק (תמ"א 38)', city: 'חולון', region: 'גוש דן ומרכז', addresses: 'שכונת אגרובנק', existing_units: 130, planned_units: 430, developer: 'לוינסקי עופר + קבוצת יחד', status: 'planning' },
  { slug: 'hl_shankar_maoz', name: 'שנקר (מעוז דניאל)', city: 'חולון', region: 'גוש דן ומרכז', addresses: 'רחוב שנקר', existing_units: 25, planned_units: 78, developer: 'מעוז דניאל', status: 'planning' },
  { slug: 'hl_tel_giborim', name: 'תל גיבורים', city: 'חולון', region: 'גוש דן ומרכז', addresses: 'שכונת תל גיבורים', status: 'planning' },
  { slug: 'hl_yoseftal', name: 'יוספטל', city: 'חולון', region: 'גוש דן ומרכז', addresses: 'שכונת יוספטל', status: 'planning' },
  { slug: 'hl_mivtza_sinai', name: 'מבצע סיני', city: 'חולון', region: 'גוש דן ומרכז', addresses: 'שכונת מבצע סיני', status: 'planning' },
  { slug: 'hl_jesse_cohen', name: "ג'סי כהן", city: 'חולון', region: 'גוש דן ומרכז', addresses: "שכונת ג'סי כהן", status: 'planning' },
  { slug: 'hl_fichman', name: 'פיכמן', city: 'חולון', region: 'גוש דן ומרכז', addresses: 'רחוב פיכמן', status: 'planning' },
  { slug: 'hl_sokolov', name: 'סוקולוב וכיכר ויצמן', city: 'חולון', region: 'גוש דן ומרכז', addresses: 'רחוב סוקולוב, כיכר ויצמן', status: 'planning' },

  // ========== RAMAT GAN (19) ==========
  { slug: 'rg_aba_hillel_rashi', name: 'אבא הלל-רש"י-ארניה', city: 'רמת גן', region: 'גוש דן ומרכז', addresses: 'רחוב אבא הלל, רחוב רש"י, רחוב ארניה - 9.6 דונם', existing_units: 161, planned_units: 467, developer: 'אפריקה ישראל + אב גד', status: 'deposited', deposit_date: '2024-09-01', area_dunam: 9.6 },
  { slug: 'rg_aba_hillel_herut', name: 'אבא הלל-חירות-התקווה', city: 'רמת גן', region: 'גוש דן ומרכז', addresses: 'רחוב אבא הלל, רחוב חירות, רחוב התקווה, רחוב הגפן - 3.7-4 דונם', existing_units: 72, planned_units: 202, developer: 'רוטשטיין נדל"ן', status: 'deposited', deposit_date: '2023-01-01', area_dunam: 3.85 },
  { slug: 'rg_aba_hillel_rokach', name: 'אבא הלל-רוקח-חירות', city: 'רמת גן', region: 'גוש דן ומרכז', addresses: 'רחוב אבא הלל, רחוב רוקח, רחוב חירות, רחוב הגפן - 3.1 דונם', existing_units: 30, planned_units: 145, developer: 'צליח-רוטשילד מימון', status: 'deposited', area_dunam: 3.1 },
  { slug: 'rg_aba_hillel_104', name: 'אבא הלל 104-114 וחרות', city: 'רמת גן', region: 'גוש דן ומרכז', addresses: 'רחוב אבא הלל 104-114, רחוב חרות - 5.5 דונם', planned_units: 308, status: 'pre_deposit', area_dunam: 5.5 },
  { slug: 'rg_aba_hillel_46', name: 'אבא הלל 46-48 והדקלים', city: 'רמת גן', region: 'גוש דן ומרכז', addresses: 'רחוב אבא הלל 46-48, רחוב הדקלים', existing_units: 33, planned_units: 100, developer: 'ים סוף (פפושדו)', status: 'approved', approval_date: '2020-07-01' },
  { slug: 'rg_rashi_32', name: 'רש"י 32-40, אבא הלל 136', city: 'רמת גן', region: 'גוש דן ומרכז', addresses: 'רחוב רש"י 32-40, רחוב אבא הלל 136', planned_units: 200, developer: 'ICR', status: 'approved' },
  { slug: 'rg_rav_landers', name: 'הרב לנדרס (רמת עמידר)', city: 'רמת גן', region: 'גוש דן ומרכז', addresses: 'רחוב הרב לנדרס, צפון רמת עמידר - 13.4 דונם', existing_units: 184, planned_units: 600, developer: 'MY TOWN (קבוצת גבאי)', status: 'pre_deposit', area_dunam: 13.4 },
  { slug: 'rg_rav_levin', name: 'הרב לוין 13-16 (רמת עמידר)', city: 'רמת גן', region: 'גוש דן ומרכז', addresses: 'רחוב הרב לוין 13-16, שכונת עמידר', existing_units: 64, developer: 'אנגל אינווסט', status: 'planning' },
  { slug: 'rg_moshe_dayan', name: 'משה דיין 38-40 (בילויים)', city: 'רמת גן', region: 'גוש דן ומרכז', addresses: 'רחוב משה דיין 38-40, שכונת בילויים', existing_units: 24, planned_units: 76, developer: 'אנגל אינווסט', status: 'planning' },
  { slug: 'rg_hamatmid', name: 'המתמיד 23-19', city: 'רמת גן', region: 'גוש דן ומרכז', addresses: 'רחוב המתמיד 19-23, פינת ארלוזורוב', existing_units: 90, planned_units: 185, developer: 'ים סוף (פפושדו)', status: 'construction' },
  { slug: 'rg_jabotinsky_kaplan', name: "ז'בוטינסקי-קפלן", city: 'רמת גן', region: 'גוש דן ומרכז', addresses: "רחוב ז'בוטינסקי פינת קפלן", existing_units: 48, planned_units: 192, developer: 'גרופית', status: 'pre_deposit' },
  { slug: 'rg_jabotinsky_19', name: "ז'בוטינסקי 19", city: 'רמת גן', region: 'גוש דן ומרכז', addresses: "רחוב ז'בוטינסקי 19", developer: 'קטה יזמות', status: 'pre_deposit' },
  { slug: 'rg_jabotinsky_39', name: "ז'בוטינסקי 39-41", city: 'רמת גן', region: 'גוש דן ומרכז', addresses: "רחוב ז'בוטינסקי 39-41", planned_units: 99, status: 'deposited' },
  { slug: 'rg_mishmar_hayarden', name: 'משמר הירדן-ראש פינה-מטולה', city: 'רמת גן', region: 'גוש דן ומרכז', addresses: 'רחוב משמר הירדן, רחוב ראש פינה, רחוב מטולה', planned_units: 224, status: 'deposited' },
  { slug: 'rg_uziel', name: 'עוזיאל', city: 'רמת גן', region: 'גוש דן ומרכז', addresses: 'רחוב עוזיאל', existing_units: 42, planned_units: 152, status: 'construction' },
  { slug: 'rg_tirtza', name: 'תרצה-מולכו-ירושלים', city: 'רמת גן', region: 'גוש דן ומרכז', addresses: 'פינת רחוב תרצה, רחוב מולכו, שדרות ירושלים - 1.9 דונם', existing_units: 35, planned_units: 125, status: 'pre_deposit', area_dunam: 1.9 },
  { slug: 'rg_hashikma', name: 'רמת השקמה - שלם', city: 'רמת גן', region: 'גוש דן ומרכז', addresses: 'בין רחוב שלם לדרך הטייסים', existing_units: 86, planned_units: 263, developer: 'תדהר / יורו אפ', status: 'pre_deposit' },
  { slug: 'rg_hara', name: 'מתחם הראה', city: 'רמת גן', region: 'גוש דן ומרכז', addresses: 'שכונת הגפן', planned_units: 650, status: 'planning' },
  { slug: 'rg_maapilim', name: 'מתחם המעפילים', city: 'רמת גן', region: 'גוש דן ומרכז', planned_units: 450, status: 'planning' },

  // ========== BAT YAM (4) ==========
  { slug: 'by_yoseftal', name: 'יוספטל פינת הרב קוקיס', city: 'בת ים', region: 'גוש דן ומרכז', addresses: 'רחוב יוספטל פינת רחוב הרב קוקיס - 300 מ\' מהחוף', existing_units: 57, planned_units: 171, developer: 'ICR', status: 'pre_deposit' },
  { slug: 'by_eilat', name: 'אילת 1-9 (רמת יוסף)', city: 'בת ים', region: 'גוש דן ומרכז', addresses: 'רחוב אילת 1-9, שכונת רמת יוסף', existing_units: 192, planned_units: 700, developer: 'גבאי', status: 'approved', approval_date: '2021-10-01' },
  { slug: 'by_rav_maimon', name: 'הרב מימון 2-8', city: 'בת ים', region: 'גוש דן ומרכז', addresses: 'רחוב הרב מימון 2-8', planned_units: 448, developer: 'בוני התיכון', status: 'deposited' },
  { slug: 'by_dalia', name: 'מתחם דליה', city: 'בת ים', region: 'גוש דן ומרכז', planned_units: 780, status: 'pre_deposit' },

  // ========== GIVATAYIM (1) ==========
  { slug: 'gv_lev', name: 'לב גבעתיים', city: 'גבעתיים', region: 'גוש דן ומרכז', planned_units: 333, developer: 'ICR', status: 'approved' },

  // ========== TEL AVIV (4) ==========
  { slug: 'ta_yefet', name: 'יפת, יפו', city: 'תל אביב-יפו', region: 'גוש דן ומרכז', addresses: 'רחוב יפת, יפו', planned_units: 273, status: 'pre_deposit' },
  { slug: 'ta_neve_eliezer', name: 'נווה אליעזר', city: 'תל אביב-יפו', region: 'גוש דן ומרכז', addresses: 'שכונת נווה אליעזר, דרום תל אביב', planned_units: 315, status: 'pre_deposit' },
  { slug: 'ta_nachal_habasor', name: 'נחל הבשור', city: 'תל אביב-יפו', region: 'גוש דן ומרכז', addresses: 'רחוב נחל הבשור', status: 'deposited', deposit_date: '2024-05-01' },
  { slug: 'ta_ramat_aviv', name: "רמת אביב ג' - אחימאיר", city: 'תל אביב-יפו', region: 'גוש דן ומרכז', addresses: 'רחוב אחימאיר', existing_units: 144, planned_units: 290, developer: 'אאורה', status: 'planning' },

  // ========== RAMAT HASHARON (3) ==========
  { slug: 'rs_reines', name: 'מתחם ריינס (שכונת מורשה)', city: 'רמת השרון', region: 'גוש דן ומרכז', addresses: 'רחוב ריינס, שכונת מורשה', status: 'pre_deposit' },
  { slug: 'rs_lev', name: 'הלב העירוני', city: 'רמת השרון', region: 'גוש דן ומרכז', addresses: 'צומת סוקולוב-ויצמן-ביאליק - 22 דונם', planned_units: 800, status: 'pre_deposit', area_dunam: 22 },
  { slug: 'rs_eilat', name: 'מתחם אילת', city: 'רמת השרון', region: 'גוש דן ומרכז', addresses: 'רחוב אילת', planned_units: 720, developer: 'אאורה', status: 'deposited' },

  // ========== HOD HASHARON (2) ==========
  { slug: 'hh_kineret', name: 'מתחם כנרת (מגדיאל)', city: 'הוד השרון', region: 'גוש דן ומרכז', addresses: 'רחוב כנרת 15-19, שכונת מגדיאל', existing_units: 36, planned_units: 113, developer: 'ינוב', status: 'pre_deposit' },
  { slug: 'hh_hadarim', name: 'מתחם הדרים', city: 'הוד השרון', region: 'גוש דן ומרכז', addresses: 'רחוב התחייה, רחוב הדרים, רחוב מרחביה', existing_units: 68, planned_units: 196, developer: 'יובלים', status: 'pre_deposit' },

  // ========== PETAH TIKVA (5) ==========
  { slug: 'pt_katznelson', name: 'כצנלסון', city: 'פתח תקווה', region: 'גוש דן ומרכז', addresses: 'רחוב כצנלסון', existing_units: 90, planned_units: 314, developer: 'ב.ס.ר / אורבניקה', status: 'pre_deposit' },
  { slug: 'pt_jabotinsky', name: "ז'בוטינסקי 19", city: 'פתח תקווה', region: 'גוש דן ומרכז', addresses: "רחוב ז'בוטינסקי 19", developer: 'קטה יזמות', status: 'planning' },
  { slug: 'pt_jabotinsky_kaplan', name: "ז'בוטינסקי-קפלן", city: 'פתח תקווה', region: 'גוש דן ומרכז', addresses: "רחוב ז'בוטינסקי פינת קפלן", existing_units: 48, planned_units: 192, developer: 'גרופית', status: 'planning' },
  { slug: 'pt_ramat_verber', name: 'רמת ורבר (17 מתחמים)', city: 'פתח תקווה', region: 'גוש דן ומרכז', addresses: 'שכונת רמת ורבר', planned_units: 3954, status: 'pre_deposit' },
  { slug: 'pt_tzahal', name: 'צה"ל', city: 'פתח תקווה', region: 'גוש דן ומרכז', addresses: 'רחוב צה"ל', planned_units: 360, developer: 'יובלים', status: 'planning' },

  // ========== HERZLIYA (2) ==========
  { slug: 'hz_rabi_akiva', name: 'רבי עקיבא', city: 'הרצליה', region: 'גוש דן ומרכז', addresses: 'רחוב רבי עקיבא', existing_units: 56, planned_units: 170, developer: 'ICR', status: 'pre_deposit' },
  { slug: 'hz_hakuzari', name: 'הכוזרי-מאז"ה', city: 'הרצליה', region: 'גוש דן ומרכז', addresses: 'בין רחוב הכוזרי לרחוב מאז"ה - 8 דונם', existing_units: 66, planned_units: 204, status: 'planning', area_dunam: 8 },

  // ========== YEHUD (2) ==========
  { slug: 'yh_kdoshei_mitzraim', name: 'קדושי מצרים (אזורים)', city: 'יהוד-מונוסון', region: 'גוש דן ומרכז', addresses: 'רחוב קדושי מצרים 17-23', existing_units: 56, planned_units: 190, developer: 'אזורים', status: 'pre_deposit' },
  { slug: 'yh_katav', name: '3 מתחמים (כתב)', city: 'יהוד-מונוסון', region: 'גוש דן ומרכז', addresses: 'רחוב קדושי מצרים, רחוב ביאקובסקי, רחוב הרצל', planned_units: 1150, developer: 'כתב', status: 'pre_deposit' },

  // ========== NETANYA (12) ==========
  { slug: 'nt_naot_shaked', name: 'נאות שקד (בן צבי-שמורק)', city: 'נתניה', region: 'שרון', addresses: 'רחוב בן צבי, רחוב שמורק, רחוב ארליך, רחוב גרינבוים - 30 דונם', existing_units: 392, planned_units: 1558, developer: 'אאורה', status: 'approved', approval_date: '2023-11-01', area_dunam: 30 },
  { slug: 'nt_nachum', name: 'מתחם נחום (רמת ידין)', city: 'נתניה', region: 'שרון', addresses: 'שכונת רמת ידין - 24.5 דונם', existing_units: 264, planned_units: 1129, developer: 'ענב נדל"ן', status: 'approved', area_dunam: 24.5 },
  { slug: 'nt_korczak', name: 'קורצ\'אק (קריית נורדאו)', city: 'נתניה', region: 'שרון', addresses: 'רחוב יאנוש קורצ\'אק, קריית נורדאו', existing_units: 302, planned_units: 1148, status: 'pre_deposit' },
  { slug: 'nt_zalman', name: 'זלמן שניאור 9-15', city: 'נתניה', region: 'שרון', addresses: 'רחוב זלמן שניאור 9-15', planned_units: 672, status: 'construction' },
  { slug: 'nt_sela', name: 'מתחם סלע', city: 'נתניה', region: 'שרון', addresses: 'שכונת סלע - 12.8 דונם', existing_units: 116, planned_units: 464, developer: 'קבוצת גבאי', status: 'approved', area_dunam: 12.8 },
  { slug: 'nt_katznelson', name: 'קצנלסון 1-11 (קריית נורדאו)', city: 'נתניה', region: 'שרון', addresses: 'רחוב קצנלסון 1-11, קריית נורדאו', existing_units: 96, planned_units: 384, status: 'construction' },
  { slug: 'nt_ort_darca', name: 'אורט דרכא (נורדאו)', city: 'נתניה', region: 'שרון', addresses: 'שכונת נורדאו', planned_units: 350, status: 'pre_deposit' },
  { slug: 'nt_hadar_sanz', name: 'הדר-סנז\' (קריית סנז)', city: 'נתניה', region: 'שרון', addresses: 'רחוב הדר, שכונת קריית סנז', planned_units: 300, status: 'pre_deposit' },
  { slug: 'nt_neve_itamar', name: 'נווה איתמר', city: 'נתניה', region: 'שרון', addresses: 'שכונת נווה איתמר', planned_units: 260, status: 'pre_deposit' },
  { slug: 'nt_poleg', name: 'פולג (קליי)', city: 'נתניה', region: 'שרון', addresses: 'אזור פולג', planned_units: 230, status: 'planning' },
  { slug: 'nt_ben_ami', name: 'בן עמי', city: 'נתניה', region: 'שרון', addresses: 'רחוב בן עמי', planned_units: 200, status: 'planning' },
  { slug: 'nt_other', name: 'מתחמים נוספים', city: 'נתניה', region: 'שרון', planned_units: 325, status: 'planning' },

  // ========== ASHDOD (14) ==========
  { slug: 'as_maapilim', name: 'המעפילים-הרצל (רובע ב\')', city: 'אשדוד', region: 'דרום', addresses: 'הרצל, המעפילים, ז\'בוטינסקי, יצחק הנשיא', planned_units: 2160, developer: 'אפריקה ישראל + גבאי', status: 'approved' },
  { slug: 'as_rav_maimon', name: 'הרב מימון-בורוכוב (רובע ב\')', city: 'אשדוד', region: 'דרום', addresses: 'הרב מימון, בורוכוב, ויצמן, יצחק הנשיא', planned_units: 1431, developer: 'ספיר/סופרין', status: 'deposited', deposit_date: '2025-05-01' },
  { slug: 'as_hanasi_herzl', name: 'הנשיא-הרצל (רובע א\')', city: 'אשדוד', region: 'דרום', addresses: 'הרצל, הנשיא', planned_units: 1140, developer: 'אביסרור', status: 'pre_deposit' },
  { slug: 'as_sinai', name: 'סיני-יצחק הנשיא', city: 'אשדוד', region: 'דרום', addresses: 'סיני פינת יצחק הנשיא', planned_units: 1025, developer: 'אביסרור', status: 'pre_deposit' },
  { slug: 'as_harotem', name: 'הרותם-הנורית (רובע ח\')', city: 'אשדוד', region: 'דרום', addresses: 'הרותם, הנורית, שד\' הפרחים', planned_units: 1436, status: 'pre_deposit' },
  { slug: 'as_dalet', name: 'רובע ד\' (6 מתחמים)', city: 'אשדוד', region: 'דרום', addresses: 'רובע ד\'', planned_units: 1580, status: 'pre_deposit' },
  { slug: 'as_gimel', name: 'רובע ג\' (אורט)', city: 'אשדוד', region: 'דרום', addresses: 'רובע ג\'', planned_units: 850, status: 'pre_deposit' },
  { slug: 'as_heh', name: 'רובע ה\'', city: 'אשדוד', region: 'דרום', addresses: 'רובע ה\'', planned_units: 600, status: 'planning' },
  { slug: 'as_zayin', name: 'רובע ז\'', city: 'אשדוד', region: 'דרום', addresses: 'רובע ז\'', planned_units: 450, status: 'planning' },
  { slug: 'as_rambam', name: 'רמב"ם (רובע א\')', city: 'אשדוד', region: 'דרום', addresses: 'רחוב רמב"ם', planned_units: 380, status: 'approved' },
  { slug: 'as_bialik', name: 'ביאליק (רובע ב\')', city: 'אשדוד', region: 'דרום', addresses: 'רחוב ביאליק', planned_units: 310, status: 'approved' },
  { slug: 'as_yud_alef', name: 'רובע י"א', city: 'אשדוד', region: 'דרום', addresses: 'רובע י"א', planned_units: 275, status: 'planning' },
  { slug: 'as_rogozin', name: 'רוגוזין', city: 'אשדוד', region: 'דרום', addresses: 'רחוב רוגוזין', planned_units: 220, status: 'pre_deposit' },
  { slug: 'as_hashoftim', name: 'השופטים', city: 'אשדוד', region: 'דרום', addresses: 'רחוב השופטים', planned_units: 160, status: 'planning' },

  // ========== HAIFA AREA (23) ==========
  // Kiryat Eliezer
  { slug: 'hf_rotschild', name: 'רוטשילד (קריית אליעזר)', city: 'חיפה', region: 'חיפה', addresses: 'רוטשילד 22-34', planned_units: 760, developer: 'דוניץ-אלעד', status: 'approved' },
  { slug: 'hf_hachotrim', name: 'החותרים (קריית אליעזר)', city: 'חיפה', region: 'חיפה', addresses: 'אלנבי, רוטשילד, החותרים, דרור', planned_units: 503, developer: 'דוניץ-אלעד', status: 'deposited', deposit_date: '2025-11-01' },
  { slug: 'hf_hagana_yoav', name: 'הגנה/יואב (קריית אליעזר)', city: 'חיפה', region: 'חיפה', addresses: 'פינת הגנה ויואב', planned_units: 474, developer: 'קרדן נדל"ן', status: 'deposited', deposit_date: '2024-07-01' },
  { slug: 'hf_mitcham_11', name: 'מתחם 11 (קריית אליעזר)', city: 'חיפה', region: 'חיפה', addresses: 'גדנ"ע 2-8, צה"ל 33-45, אלנבי 132-150, עמל 22-33', planned_units: 667, developer: 'אלמוגים החזקות', status: 'pre_deposit' },
  { slug: 'hf_mitcham_12', name: 'מתחם 12 (קריית אליעזר)', city: 'חיפה', region: 'חיפה', addresses: 'בין אלנבי לצה"ל', planned_units: 970, developer: 'רייק נדל"ן', status: 'pre_deposit' },
  { slug: 'hf_mitcham_13', name: 'מתחם 13 (קריית אליעזר)', city: 'חיפה', region: 'חיפה', addresses: 'גדנ"ע, נח"ל, צה"ל', planned_units: 950, status: 'pre_deposit' },
  // Kiryat Eliyahu
  { slug: 'hf_yafo_ta', name: 'יפו-תל אביב (קריית אליהו)', city: 'חיפה', region: 'חיפה', addresses: 'יפו 147-155א, רודנר 3-15, ת"א 28-44א', planned_units: 760, status: 'pre_deposit' },
  // Kiryat Shprintzak
  { slug: 'hf_struma', name: 'סטרומה (קריית שפרינצק)', city: 'חיפה', region: 'חיפה', addresses: 'שכונת קריית שפרינצק - 65 דונם', existing_units: 557, planned_units: 2407, developer: 'ICR', status: 'pre_deposit', area_dunam: 65 },
  // Hadar
  { slug: 'hf_masada', name: 'מסדה', city: 'חיפה', region: 'חיפה', addresses: 'רחוב מסדה, הדר', planned_units: 450, status: 'pre_deposit' },
  { slug: 'hf_herzl_hadar', name: 'הרצל (הדר)', city: 'חיפה', region: 'חיפה', addresses: 'רחוב הרצל, הדר', planned_units: 380, status: 'planning' },
  // Neve Shaanan
  { slug: 'hf_neve_shaanan', name: 'נווה שאנן', city: 'חיפה', region: 'חיפה', addresses: 'שכונת נווה שאנן', planned_units: 520, status: 'planning' },
  // Haifa Bay
  { slug: 'hf_check_post', name: 'צ\'ק פוסט', city: 'חיפה', region: 'חיפה', addresses: 'אזור צ\'ק פוסט', planned_units: 600, status: 'planning' },
  // Yehoshafat
  { slug: 'hf_yehoshafat', name: 'יהושפט המלך', city: 'חיפה', region: 'חיפה', addresses: 'רחוב יהושפט המלך - 12.7 דונם, 7 מבני שיכון', existing_units: 102, planned_units: 361, developer: 'א.פ.י נתיב פיתוח', status: 'pre_deposit', area_dunam: 12.7 },
  { slug: 'hf_azorim', name: 'אזורים', city: 'חיפה', region: 'חיפה', addresses: 'חיפה', planned_units: 1000, developer: 'אזורים', status: 'pre_deposit' },
  // Bat Galim
  { slug: 'hf_bat_galim', name: 'תוכנית כוללת בת גלים', city: 'חיפה', region: 'חיפה', addresses: 'שכונת בת גלים - 31 דונם', existing_units: 178, planned_units: 725, status: 'approved', area_dunam: 31 },
  { slug: 'hf_aliya2_20', name: 'העלייה השנייה 20', city: 'חיפה', region: 'חיפה', addresses: 'רחוב העלייה השנייה 20', existing_units: 82, planned_units: 309, developer: 'קרסו נדל"ן + א.ד. חבצלת', status: 'planning' },
  // Shaar HaAliya
  { slug: 'hf_saadia', name: 'סעדיה-פז', city: 'חיפה', region: 'חיפה', addresses: 'רחוב אצ"ל, אנקוה, ברוך הכהן, סעדיה פז', existing_units: 184, planned_units: 800, developer: 'נקסט אורבן', status: 'planning' },
  { slug: 'hf_yetziat_europa', name: 'יציאת אירופה', city: 'חיפה', region: 'חיפה', planned_units: 126, status: 'planning' },
  // Kiryat Haim
  { slug: 'hf_khaim_west', name: 'קריית חיים מערבית', city: 'חיפה', region: 'חיפה', addresses: 'שכונות טרומן, דגניה, ורבורג', existing_units: 2100, planned_units: 6600, status: 'planning' },
  { slug: 'hf_dganya_khaim', name: 'דגניה (קריית חיים)', city: 'חיפה', region: 'חיפה', addresses: 'רחוב דגניה 57-69', existing_units: 140, planned_units: 630, developer: 'אלמוגים + W GROUP', status: 'planning' },
  // Additional Haifa
  { slug: 'hf_ramat_vizhnitz', name: 'רמת ויז\'ניץ', city: 'חיפה', region: 'חיפה', planned_units: 400, status: 'planning' },
  { slug: 'hf_kiryat_haim_east', name: 'קריית חיים מזרחית', city: 'חיפה', region: 'חיפה', planned_units: 350, status: 'planning' },
  { slug: 'hf_neve_david', name: 'נווה דוד', city: 'חיפה', region: 'חיפה', planned_units: 300, status: 'planning' },

  // ========== OTHER CITIES ==========
  // Nesher
  { slug: 'ns_central', name: 'מתחם מרכזי', city: 'נשר', region: 'חיפה', planned_units: 1900, status: 'planning' },
  // Krayot
  { slug: 'kr_yoseftal', name: 'יוספטל צפון (ק/440)', city: 'קריות', region: 'חיפה', addresses: 'רחוב יוספטל (חלק צפוני)', existing_units: 88, planned_units: 449, status: 'planning' },
  // Hadera
  { slug: 'hd_eli_cohen', name: 'שכונת אלי כהן', city: 'חדרה', region: 'שרון', addresses: 'שכונת אלי כהן', status: 'planning' },
  // Jerusalem
  { slug: 'jr_gonen', name: 'מעגלי יבנה (גוננים)', city: 'ירושלים', region: 'ירושלים', addresses: 'שכונת גוננים', developer: 'אשדר / הרשות להתחדשות', status: 'planning' },
  { slug: 'jr_armon', name: 'ארמון הנציב', city: 'ירושלים', region: 'ירושלים', addresses: 'שכונת ארמון הנציב', planned_units: 950, developer: 'מידר', status: 'planning' },
  { slug: 'jr_katamonim', name: 'קטמונים', city: 'ירושלים', region: 'ירושלים', addresses: 'שכונת קטמונים', planned_units: 287, developer: 'בית ירושלמי', status: 'planning' },
  // Beer Sheva
  { slug: 'bs_bgu', name: 'ליד אונ\' בן גוריון וסורוקה', city: 'באר שבע', region: 'דרום', addresses: 'סמוך לאוניברסיטת בן גוריון ובית החולים סורוקה', planned_units: 870, developer: 'אלקטרה / אפריקה / ב.ס.ר', status: 'planning' },
  // Beer Yaakov
  { slug: 'bya_herzl', name: 'מתחם הרצל', city: 'באר יעקב', region: 'דרום', addresses: 'רחוב הרצל', existing_units: 449, planned_units: 1880, developer: 'אלמוג / ענב', status: 'pre_deposit' },
  // Yavne
  { slug: 'yv_center', name: 'מרכז יבנה', city: 'יבנה', region: 'דרום', addresses: 'מרכז העיר', planned_units: 480, developer: 'בוני התיכון', status: 'planning' },
  { slug: 'yv_gefen', name: 'מתחם גפן-שלי', city: 'יבנה', region: 'דרום', planned_units: 200, developer: 'גפן מגורים / דני שלי', status: 'planning' },
  // Lod
  { slug: 'ld_central', name: 'מתחם מרכזי', city: 'לוד', region: 'גוש דן ומרכז', planned_units: 184, developer: 'קטה גרופ', status: 'planning' },
];

async function seed() {
  console.log(`Seeding ${ALL_PROJECTS.length} projects...`);
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Clear existing data
    await client.query('DELETE FROM alerts');
    await client.query('DELETE FROM scan_logs');
    await client.query('DELETE FROM benchmarks');
    await client.query('DELETE FROM listings');
    await client.query('DELETE FROM transactions');
    await client.query('DELETE FROM buildings');
    await client.query('DELETE FROM complexes');
    
    let inserted = 0;
    
    for (const p of ALL_PROJECTS) {
      const premiums = PREMIUM_BY_STATUS[p.status] || PREMIUM_BY_STATUS.unknown;
      const devStrength = getDevStrength(p.developer);
      const multiplier = (p.existing_units && p.planned_units) 
        ? (p.planned_units / p.existing_units).toFixed(2) 
        : null;
      
      await client.query(
        `INSERT INTO complexes (
          slug, name, city, region, neighborhood, addresses,
          plan_number, status, declaration_date, submission_date, deposit_date, approval_date,
          num_buildings, existing_units, planned_units, multiplier, area_dunam,
          developer, developer_strength, signature_percent,
          theoretical_premium_min, theoretical_premium_max
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [
          p.slug, p.name, p.city, p.region, p.neighborhood || null, p.addresses || null,
          p.plan_number || null, p.status, p.declaration_date || null, p.submission_date || null,
          p.deposit_date || null, p.approval_date || null,
          p.num_buildings || null, p.existing_units || null, p.planned_units || null,
          multiplier, p.area_dunam || null,
          p.developer || null, devStrength, p.signature_percent || null,
          premiums.min, premiums.max
        ]
      );
      inserted++;
    }
    
    await client.query('COMMIT');
    console.log(`Successfully seeded ${inserted} projects!`);
    
    // Print summary
    const statusCounts = await client.query(
      `SELECT status, COUNT(*) as count, SUM(COALESCE(planned_units, 0)) as total_units 
       FROM complexes GROUP BY status ORDER BY count DESC`
    );
    console.log('\nSummary by status:');
    for (const row of statusCounts.rows) {
      console.log(`  ${row.status}: ${row.count} projects, ${row.total_units} units`);
    }
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  seed().catch(() => process.exit(1));
}

module.exports = { seed, ALL_PROJECTS };
