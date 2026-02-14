/**
 * QUANTUM Dashboard - Self-contained React dashboard served as HTML
 * GET /api/dashboard/ - Full dashboard UI
 */

const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QUANTUM Intelligence Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Assistant:wght@400;600;700;800&family=DM+Serif+Display&display=swap" rel="stylesheet">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js" crossorigin></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js" crossorigin></script>
  <script src="https://cdn.jsdelivr.net/npm/recharts@2.12.7/umd/Recharts.js" crossorigin></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.9/babel.min.js"></script>
  <script>
    window.addEventListener('error', function(e) {
      if (e.target && e.target.tagName === 'SCRIPT') {
        var root = document.getElementById('root');
        if (root && !root.innerHTML.trim()) {
          root.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:16px;font-family:Assistant,sans-serif"><div style="width:48px;height:48px;background:linear-gradient(135deg,#06d6a0,#3b82f6);border-radius:12px;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:24px;color:#000">Q</div><div style="color:#ff4d6a;font-size:14px;text-align:center;direction:rtl">Error loading dashboard<br><span style="color:#8899b4;font-size:11px">Try disabling ad blocker or use a different browser</span></div><a href="/api/dashboard/" style="color:#06d6a0;font-size:12px">Retry</a></div>';
        }
      }
    }, true);
  </script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Assistant', sans-serif; background: #080c14; color: #e2e8f0; direction: rtl; }
    ::-webkit-scrollbar { width: 5px; }
    ::-webkit-scrollbar-track { background: #080c14; }
    ::-webkit-scrollbar-thumb { background: #1a2744; border-radius: 3px; }
    @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }
    @keyframes fadeUp { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel">
    const { useState, useEffect, useCallback } = React;
    const { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, PieChart, Pie } = Recharts;

    const API = "";
    const C = {
      bg: "#080c14", surface: "#0f1623", surfaceAlt: "#141d2e", border: "#1a2744", borderLight: "#243352",
      text: "#e2e8f0", muted: "#8899b4", dim: "#4a5e80",
      cyan: "#06d6a0", cyanDim: "#059669", gold: "#ffc233", goldDim: "#cc9a00",
      red: "#ff4d6a", orange: "#ff8c42", green: "#22c55e", purple: "#9f7aea", blue: "#3b82f6",
    };

    function Stat({ label, val, sub, color = C.cyan, icon }) {
      return (
        <div style={{ background: C.surface, border: "1px solid "+C.border, borderRadius: 14, padding: "18px 22px", position: "relative", overflow: "hidden", transition: "border-color 0.2s" }}
          onMouseEnter={e => e.currentTarget.style.borderColor = color + "44"}
          onMouseLeave={e => e.currentTarget.style.borderColor = C.border}>
          <div style={{ position: "absolute", top: -8, left: -4, fontSize: 56, opacity: 0.03, fontWeight: 900 }}>{icon}</div>
          <div style={{ fontSize: 11, color: C.muted, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 6, fontWeight: 600 }}>{label}</div>
          <div style={{ fontSize: 32, fontWeight: 800, color, lineHeight: 1.1, fontFamily: "'DM Serif Display', serif" }}>{val}</div>
          {sub && <div style={{ fontSize: 11, color: C.dim, marginTop: 5 }}>{sub}</div>}
        </div>
      );
    }

    function Badge({ score, type = "ssi" }) {
      if (!score && score !== 0) return <span style={{ color: C.dim }}>-</span>;
      if (type === "ssi") {
        const lvl = score >= 80 ? "critical" : score >= 60 ? "high" : score >= 40 ? "med" : "low";
        const cols = { critical: [C.red, "rgba(255,77,106,0.12)"], high: [C.orange, "rgba(255,140,66,0.12)"], med: [C.gold, "rgba(255,194,51,0.12)"], low: [C.green, "rgba(34,197,94,0.08)"] };
        const tags = { critical: "קריטי", high: "גבוה", med: "בינוני", low: "נמוך" };
        return <span style={{ background: cols[lvl][1], color: cols[lvl][0], padding: "2px 8px", borderRadius: 5, fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>{score} {tags[lvl]}</span>;
      }
      const color = score >= 70 ? C.green : score >= 50 ? C.cyan : score >= 30 ? C.gold : C.dim;
      return <span style={{ color, fontWeight: 700, fontSize: 13 }}>{score}</span>;
    }

    function Panel({ children, style }) {
      return <div style={{ background: C.surface, border: "1px solid "+C.border, borderRadius: 14, padding: 22, ...style }}>{children}</div>;
    }

    function Head({ t, s, icon }) {
      return (
        <div style={{ marginBottom: 14, display: "flex", alignItems: "baseline", gap: 8 }}>
          {icon && <span style={{ fontSize: 16, opacity: 0.6 }}>{icon}</span>}
          <div>
            <h2 style={{ fontSize: 17, fontWeight: 700, color: C.text, margin: 0, fontFamily: "'DM Serif Display', serif" }}>{t}</h2>
            {s && <p style={{ fontSize: 11, color: C.dim, margin: "2px 0 0" }}>{s}</p>}
          </div>
        </div>
      );
    }

    function Table({ data, cols, empty = "אין נתונים" }) {
      if (!data?.length) return <div style={{ color: C.dim, padding: 20, textAlign: "center", fontSize: 13 }}>{empty}</div>;
      return (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead><tr>{cols.map((c, i) => <th key={i} style={{ padding: "8px 10px", textAlign: c.a || "right", color: C.dim, fontWeight: 600, borderBottom: "1px solid "+C.border, fontSize: 10, letterSpacing: 0.5, textTransform: "uppercase", whiteSpace: "nowrap" }}>{c.h}</th>)}</tr></thead>
            <tbody>{data.map((row, i) => (
              <tr key={i} onMouseEnter={e => e.currentTarget.style.background = C.surfaceAlt} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                {cols.map((c, j) => <td key={j} style={{ padding: "9px 10px", textAlign: c.a || "right", color: C.text, whiteSpace: c.nw ? "nowrap" : "normal" }}>{c.r ? c.r(row, i) : row[c.k]}</td>)}
              </tr>
            ))}</tbody>
          </table>
        </div>
      );
    }

    function App() {
      const [d, setD] = useState(null);
      const [loading, setLoading] = useState(true);
      const [tab, setTab] = useState("overview");
      const [time, setTime] = useState(null);
      const [agg, setAgg] = useState(false);

      const load = useCallback(async () => {
        try {
          setLoading(true);
          const r = await fetch(API + "/api/ssi/dashboard-data");
          setD(await r.json());
          setTime(new Date());
        } catch (e) { console.error(e); }
        setLoading(false);
      }, []);

      useEffect(() => { load(); }, [load]);

      const runSSI = async () => {
        setAgg(true);
        try {
          await fetch(API + "/api/ssi/batch-aggregate", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"minListings":1,"limit":500}' });
          await new Promise(r => setTimeout(r, 3000));
          await load();
        } catch (e) { console.error(e); }
        setAgg(false);
      };

      if (loading && !d) return (
        <div style={{ background: C.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16 }}>
          <div style={{ width: 48, height: 48, background: "linear-gradient(135deg, "+C.cyan+", "+C.blue+")", borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900, fontSize: 24, color: "#000", fontFamily: "'DM Serif Display', serif", animation: "pulse 1.5s infinite" }}>Q</div>
          <div style={{ color: C.muted, fontSize: 13 }}>QUANTUM Intelligence</div>
        </div>
      );

      const s = d?.stats || {};
      const dist = d?.ssiDistribution || {};
      const topSSI = d?.topSSI || [];
      const topIAI = d?.topIAI || [];
      const alerts = d?.recentAlerts || [];
      const cities = d?.cityBreakdown || [];
      const ls = d?.listingStats || {};

      const pieData = [
        { name: "גבוה 60+", value: +(dist.high || 0) + +(dist.critical || 0), fill: C.red },
        { name: "בינוני 40-59", value: +(dist.medium || 0), fill: C.orange },
        { name: "נמוך 20-39", value: +(dist.low || 0), fill: C.gold },
        { name: "מזערי", value: +(dist.minimal || 0), fill: C.dim },
      ].filter(x => x.value > 0);

      const cityChart = cities.slice(0, 10).map(c => ({ name: c.city, opp: +c.opportunities, str: +c.stressed, total: +c.total }));

      const tabs = [
        { id: "overview", l: "סקירה" },
        { id: "ssi", l: "מוכרים לחוצים" },
        { id: "opp", l: "הזדמנויות" },
        { id: "cities", l: "ערים" },
        { id: "alerts", l: "התראות" },
      ];

      const goldOpp = topSSI.filter(x => x.iai_score >= 40).slice(0, 5);

      return (
        <div style={{ background: C.bg, minHeight: "100vh", color: C.text, fontFamily: "'Assistant', sans-serif", direction: "rtl" }}>
          <header style={{ borderBottom: "1px solid "+C.border, padding: "14px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(8,12,20,0.92)", backdropFilter: "blur(16px)", position: "sticky", top: 0, zIndex: 100 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ width: 36, height: 36, background: "linear-gradient(135deg, "+C.cyan+", "+C.blue+")", borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900, fontSize: 18, color: "#000", fontFamily: "'DM Serif Display', serif" }}>Q</div>
              <div>
                <span style={{ fontSize: 16, fontWeight: 800, letterSpacing: 3, fontFamily: "'DM Serif Display', serif" }}>QUANTUM</span>
                <span style={{ fontSize: 9, color: C.dim, marginRight: 10, letterSpacing: 1 }}>INTELLIGENCE</span>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <a href="/api/chat/" style={{ padding: "6px 14px", background: "transparent", border: "1px solid "+C.borderLight, borderRadius: 7, color: C.purple, fontSize: 11, fontWeight: 700, textDecoration: "none" }}>Chat AI</a>
              <button onClick={runSSI} disabled={agg}
                style={{ padding: "6px 14px", background: agg ? C.border : "transparent", border: "1px solid "+C.borderLight, borderRadius: 7, color: agg ? C.dim : C.cyan, fontSize: 11, fontWeight: 700, cursor: agg ? "default" : "pointer", fontFamily: "inherit" }}>
                {agg ? "...מחשב SSI" : "עדכון SSI"}
              </button>
              <button onClick={load}
                style={{ padding: "6px 14px", background: "transparent", border: "1px solid "+C.borderLight, borderRadius: 7, color: C.text, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                רענון
              </button>
              {time && <span style={{ fontSize: 10, color: C.dim }}>{time.toLocaleTimeString("he-IL")}</span>}
            </div>
          </header>

          <nav style={{ padding: "0 28px", borderBottom: "1px solid "+C.border, display: "flex", gap: 2 }}>
            {tabs.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                style={{ padding: "11px 18px", background: "none", border: "none", borderBottom: tab === t.id ? "2px solid "+C.cyan : "2px solid transparent", color: tab === t.id ? C.cyan : C.dim, fontSize: 12, fontWeight: tab === t.id ? 700 : 500, cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s" }}>
                {t.l}
              </button>
            ))}
          </nav>

          <main style={{ padding: "28px", maxWidth: 1360, margin: "0 auto" }}>

            {tab === "overview" && (
              <div style={{ animation: "fadeUp 0.25s ease" }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14, marginBottom: 28 }}>
                  <Stat label="מתחמים" val={s.total_complexes} sub={s.cities+" ערים"} icon="Q" color={C.cyan} />
                  <Stat label="הזדמנויות" val={s.opportunities} sub={s.excellent+" מצוינות (70+)"} icon="★" color={C.gold} />
                  <Stat label="מוכרים לחוצים" val={s.stressed_sellers} sub={s.high_stress+" ברמה גבוהה"} icon="!" color={C.red} />
                  <Stat label="מודעות" val={ls.active || "0"} sub={(ls.urgent || "0")+" דחופות"} icon="▤" color={C.green} />
                  <Stat label="כינוסים" val={d?.konesStats?.total || "0"} sub="נכסי כינוס" icon="⚖" color={C.purple} />
                  <Stat label="IAI ממוצע" val={s.avg_iai || "-"} sub="אינדקס אטרקטיביות" icon="△" color={C.blue} />
                </div>

                {goldOpp.length > 0 && (
                  <Panel style={{ marginBottom: 20, border: "1px solid "+C.gold+"22", background: "linear-gradient(135deg, "+C.surface+" 0%, rgba(255,194,51,0.03) 100%)" }}>
                    <Head t="הזדמנויות זהב" s="IAI גבוה + מוכר לחוץ = פוטנציאל מקסימלי" icon="◆" />
                    <Table data={goldOpp} cols={[
                      { h: "SSI", r: r => <Badge score={r.enhanced_ssi_score} type="ssi" />, a: "center", nw: true },
                      { h: "IAI", r: r => <Badge score={r.iai_score} type="iai" />, a: "center", nw: true },
                      { h: "מתחם", r: r => <span style={{ fontWeight: 700 }}>{(r.name || r.addresses || "").substring(0, 40)}</span> },
                      { h: "עיר", k: "city", nw: true },
                      { h: "גורמי לחץ", r: r => { const f = typeof r.ssi_enhancement_factors === "string" ? JSON.parse(r.ssi_enhancement_factors || "[]") : (r.ssi_enhancement_factors || []); return <span style={{ fontSize: 10, color: C.muted }}>{f.slice(0, 2).join(" | ")}</span>; } },
                    ]} />
                  </Panel>
                )}

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>
                  <Panel>
                    <Head t="התפלגות SSI" s="סימני מצוקה" icon="◉" />
                    <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
                      <div style={{ width: 140, height: 140 }}>
                        <ResponsiveContainer>
                          <PieChart><Pie data={pieData} dataKey="value" cx="50%" cy="50%" innerRadius={38} outerRadius={62} paddingAngle={3} strokeWidth={0}>
                            {pieData.map((e, i) => <Cell key={i} fill={e.fill} />)}
                          </Pie><Tooltip contentStyle={{ background: C.surface, border: "1px solid "+C.border, borderRadius: 8, direction: "rtl", fontSize: 11 }} /></PieChart>
                        </ResponsiveContainer>
                      </div>
                      <div style={{ flex: 1 }}>
                        {[{ l: "גבוה (60+)", v: +(dist.high || 0) + +(dist.critical || 0), c: C.red },
                          { l: "בינוני (40-59)", v: +(dist.medium || 0), c: C.orange },
                          { l: "נמוך (20-39)", v: +(dist.low || 0), c: C.gold },
                          { l: "מזערי (<20)", v: +(dist.minimal || 0), c: C.dim },
                        ].map((x, i) => (
                          <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: i < 3 ? "1px solid "+C.border+"10" : "none" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                              <div style={{ width: 8, height: 8, borderRadius: 2, background: x.c }} />
                              <span style={{ fontSize: 12, color: C.muted }}>{x.l}</span>
                            </div>
                            <span style={{ fontWeight: 700, color: x.c, fontSize: 14 }}>{x.v}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </Panel>

                  <Panel>
                    <Head t="הזדמנויות לפי עיר" s="טופ 10" icon="▣" />
                    <ResponsiveContainer width="100%" height={160}>
                      <BarChart data={cityChart} layout="vertical" margin={{ right: 55, left: 5 }}>
                        <XAxis type="number" hide />
                        <YAxis type="category" dataKey="name" width={60} tick={{ fill: C.muted, fontSize: 10 }} />
                        <Tooltip contentStyle={{ background: C.surface, border: "1px solid "+C.border, borderRadius: 8, direction: "rtl", fontSize: 11 }} />
                        <Bar dataKey="opp" fill={C.cyan} radius={[0, 3, 3, 0]} name="הזדמנויות" barSize={12} />
                      </BarChart>
                    </ResponsiveContainer>
                  </Panel>
                </div>

                <Panel>
                  <Head t="התראות אחרונות" s={alerts.length+" התראות"} icon="●" />
                  <Table data={alerts.slice(0, 6)} cols={[
                    { h: "", r: r => <span style={{ width: 7, height: 7, borderRadius: "50%", display: "inline-block", background: r.severity === "high" ? C.red : r.severity === "medium" ? C.orange : C.green }} />, a: "center" },
                    { h: "כותרת", r: r => <span style={{ fontSize: 11, fontWeight: 600 }}>{(r.title || "").substring(0, 55)}</span> },
                    { h: "עיר", r: r => <span style={{ color: C.muted, fontSize: 11 }}>{r.city || "-"}</span>, nw: true },
                    { h: "סוג", r: r => <span style={{ color: C.dim, fontSize: 10 }}>{r.alert_type}</span>, nw: true },
                    { h: "תאריך", r: r => <span style={{ color: C.dim, fontSize: 10 }}>{r.created_at ? new Date(r.created_at).toLocaleDateString("he-IL") : "-"}</span>, nw: true },
                  ]} />
                </Panel>
              </div>
            )}

            {tab === "ssi" && (
              <div style={{ animation: "fadeUp 0.25s ease" }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 24 }}>
                  <Stat label="לחץ גבוה" val={+(dist.high || 0) + +(dist.critical || 0)} icon="!" color={C.red} />
                  <Stat label="לחץ בינוני" val={dist.medium || "0"} icon="▲" color={C.orange} />
                  <Stat label="לחץ נמוך" val={dist.low || "0"} icon="△" color={C.gold} />
                  <Stat label="SSI ממוצע" val={s.avg_ssi || "-"} icon="◎" color={C.cyan} />
                </div>
                <Panel>
                  <Head t="מתחמים עם סימני מצוקה" s="ממוינים לפי SSI" icon="⚡" />
                  <Table data={topSSI} cols={[
                    { h: "#", r: (_, i) => <span style={{ color: C.dim, fontSize: 10 }}>{i + 1}</span>, a: "center" },
                    { h: "SSI", r: r => <Badge score={r.enhanced_ssi_score} />, a: "center", nw: true },
                    { h: "מתחם", r: r => <span style={{ fontWeight: 600 }}>{(r.name || r.addresses || "").substring(0, 42)}</span> },
                    { h: "עיר", k: "city", nw: true },
                    { h: "IAI", r: r => r.iai_score ? <Badge score={r.iai_score} type="iai" /> : <span style={{ color: C.dim }}>-</span>, a: "center", nw: true },
                    { h: "סטטוס", r: r => <span style={{ color: C.dim, fontSize: 10 }}>{r.status || "-"}</span>, nw: true },
                    { h: "גורמים", r: r => { const f = typeof r.ssi_enhancement_factors === "string" ? JSON.parse(r.ssi_enhancement_factors || "[]") : (r.ssi_enhancement_factors || []); return <span style={{ fontSize: 10, color: C.muted }}>{f.slice(0, 2).join(" | ") || "-"}</span>; } },
                  ]} empty='לא נמצאו מתחמים עם סימני מצוקה. לחץ "עדכון SSI" למעלה.' />
                </Panel>
              </div>
            )}

            {tab === "opp" && (
              <div style={{ animation: "fadeUp 0.25s ease" }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginBottom: 24 }}>
                  <Stat label="סה״כ הזדמנויות" val={s.opportunities} sub="IAI 30+" icon="★" color={C.gold} />
                  <Stat label="מצוינות" val={s.excellent} sub="IAI 70+" icon="◆" color={C.green} />
                  <Stat label="IAI ממוצע" val={s.avg_iai || "-"} icon="△" color={C.cyan} />
                </div>
                <Panel>
                  <Head t="טופ הזדמנויות" s="ממוינות לפי IAI" icon="★" />
                  <Table data={topIAI} cols={[
                    { h: "#", r: (_, i) => <span style={{ color: C.dim, fontSize: 10 }}>{i + 1}</span>, a: "center" },
                    { h: "IAI", r: r => <Badge score={r.iai_score} type="iai" />, a: "center", nw: true },
                    { h: "מתחם", r: r => <span style={{ fontWeight: 600 }}>{(r.name || r.addresses || "").substring(0, 45)}</span> },
                    { h: "עיר", k: "city", nw: true },
                    { h: "SSI", r: r => r.enhanced_ssi_score ? <Badge score={r.enhanced_ssi_score} /> : <span style={{ color: C.dim }}>-</span>, a: "center", nw: true },
                    { h: "יזם", r: r => <span style={{ color: C.muted, fontSize: 11 }}>{(r.developer || "-").substring(0, 20)}</span>, nw: true },
                    { h: "סטטוס", r: r => <span style={{ color: C.dim, fontSize: 10 }}>{r.status || "-"}</span>, nw: true },
                  ]} />
                </Panel>
              </div>
            )}

            {tab === "cities" && (
              <div style={{ animation: "fadeUp 0.25s ease" }}>
                <Panel style={{ marginBottom: 20 }}>
                  <Head t="הזדמנויות לפי ערים" s={s.cities+" ערים פעילות"} icon="▣" />
                  <ResponsiveContainer width="100%" height={320}>
                    <BarChart data={cityChart} margin={{ right: 5, left: 5, bottom: 50 }}>
                      <XAxis dataKey="name" tick={{ fill: C.muted, fontSize: 10 }} angle={-45} textAnchor="end" height={60} />
                      <YAxis tick={{ fill: C.dim, fontSize: 10 }} />
                      <Tooltip contentStyle={{ background: C.surface, border: "1px solid "+C.border, borderRadius: 8, direction: "rtl", fontSize: 11 }} />
                      <Bar dataKey="total" fill={C.borderLight} name="סה״כ" radius={[3, 3, 0, 0]} />
                      <Bar dataKey="opp" fill={C.cyan} name="הזדמנויות" radius={[3, 3, 0, 0]} />
                      <Bar dataKey="str" fill={C.red} name="לחוצים" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </Panel>
                <Panel>
                  <Table data={cities} cols={[
                    { h: "עיר", r: r => <span style={{ fontWeight: 700 }}>{r.city}</span>, nw: true },
                    { h: "מתחמים", k: "total", a: "center" },
                    { h: "הזדמנויות", r: r => <span style={{ color: C.cyan, fontWeight: 700 }}>{r.opportunities}</span>, a: "center" },
                    { h: "לחוצים", r: r => +r.stressed > 0 ? <span style={{ color: C.red, fontWeight: 700 }}>{r.stressed}</span> : <span style={{ color: C.dim }}>0</span>, a: "center" },
                    { h: "IAI ממוצע", r: r => <span style={{ color: +r.avg_iai >= 50 ? C.green : C.muted }}>{r.avg_iai || "-"}</span>, a: "center" },
                  ]} />
                </Panel>
              </div>
            )}

            {tab === "alerts" && (
              <div style={{ animation: "fadeUp 0.25s ease" }}>
                <Panel>
                  <Head t="התראות" s="20 אחרונות" icon="●" />
                  <Table data={alerts} cols={[
                    { h: "", r: r => <span style={{ width: 7, height: 7, borderRadius: "50%", display: "inline-block", background: r.severity === "high" ? C.red : r.severity === "medium" ? C.orange : C.green }} />, a: "center" },
                    { h: "כותרת", r: r => <span style={{ fontSize: 11, fontWeight: 600 }}>{r.title}</span> },
                    { h: "תיאור", r: r => <span style={{ fontSize: 10, color: C.muted }}>{(r.description || "").substring(0, 70)}</span> },
                    { h: "מתחם", r: r => <span style={{ color: C.muted, fontSize: 11 }}>{r.complex_name || "-"}</span>, nw: true },
                    { h: "עיר", r: r => <span style={{ fontSize: 11 }}>{r.city || "-"}</span>, nw: true },
                    { h: "סוג", r: r => <span style={{ color: C.dim, fontSize: 10 }}>{r.alert_type}</span>, nw: true },
                    { h: "תאריך", r: r => <span style={{ color: C.dim, fontSize: 10 }}>{r.created_at ? new Date(r.created_at).toLocaleDateString("he-IL") : "-"}</span>, nw: true },
                  ]} />
                </Panel>
              </div>
            )}
          </main>

          <footer style={{ borderTop: "1px solid "+C.border, padding: "14px 28px", textAlign: "center", marginTop: 24 }}>
            <span style={{ fontSize: 10, color: C.dim }}>QUANTUM Intelligence v4.13.3 | {s.total_complexes} מתחמים | {s.cities} ערים</span>
          </footer>
        </div>
      );
    }

    ReactDOM.createRoot(document.getElementById('root')).render(<App />);
  </script>
</body>
</html>`);
});

module.exports = router;
