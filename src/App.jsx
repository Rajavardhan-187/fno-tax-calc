import { useState, useCallback, useMemo, useRef, Fragment } from "react";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

// ─── FORMATTING ────────────────────────────────────────────────────────────
const fmt = (n, d = 2) => {
  if (n === undefined || n === null || isNaN(n)) return "₹0.00";
  const abs = Math.abs(n);
  const s = abs.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
  return (n < 0 ? "-" : "") + "₹" + s;
};
const fmtN = (n) => (n == null ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 }));
const pc  = (n) => (n > 0 ? "#00D68F" : n < 0 ? "#FF4D6A" : "#64748b");
const pcBg = (n, dark = false) => n > 0
  ? (dark ? "rgba(0,214,143,0.10)" : "#f0fdf4")
  : n < 0
  ? (dark ? "rgba(255,77,106,0.10)" : "#fff1f2")
  : (dark ? "rgba(255,255,255,0.03)" : "#f8fafc");
const extractStock = (sym) => String(sym||"").split(/\s+/)[0].toUpperCase();
const LEDGER_KEY = "fno_tax_loss_ledger_v1";

// ─── GROWW PARSER ──────────────────────────────────────────────────────────
const parseGroww = (wb) => {
  const sheetName = wb.SheetNames.find(n => n === "Trade Level") || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) return { error: "No usable sheet found in the file." };

  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  const meta     = {};
  const charges  = { stt: 0, brokerage: 0, exchCharges: 0, gst: 0, stampDuty: 0, sebi: 0, ipft: 0 };
  const trades   = [];
  let currentSection = null;
  let tradeIdCounter = 1;

  for (let i = 0; i < raw.length; i++) {
    const row = raw[i];
    if (!row || !row.some(Boolean)) continue;

    const c0 = String(row[0] ?? "").trim();
    const c1 = row[1];

    if (c0 === "Name")                    { meta.name       = String(c1 ?? "").trim(); continue; }
    if (c0 === "Unique Client Code")      { meta.clientCode = String(c1 ?? "").trim(); continue; }
    if (c0.startsWith("P&L Statement"))   { meta.period     = c0; continue; }

    if (c0 === "Exchange Transaction Charges") { charges.exchCharges = Math.abs(Number(c1) || 0); continue; }
    if (c0 === "SEBI Turnover Charges")        { charges.sebi        = Math.abs(Number(c1) || 0); continue; }
    if (c0 === "STT")                          { charges.stt         = Math.abs(Number(c1) || 0); continue; }
    if (c0 === "Stamp Duty")                   { charges.stampDuty   = Math.abs(Number(c1) || 0); continue; }
    if (c0 === "IPFT Charges")                 { charges.ipft        = Math.abs(Number(c1) || 0); continue; }
    if (c0 === "Brokerage")                    { charges.brokerage   = Math.abs(Number(c1) || 0); continue; }
    if (c0 === "Total GST")                    { charges.gst         = Math.abs(Number(c1) || 0); continue; }

    if (c0 === "Futures" && c1 == null)  { currentSection = "FUT"; continue; }
    if (c0 === "Options" && c1 == null)  { currentSection = "OPT"; continue; }

    if (c0 === "Scrip Name") continue;

    if (c0 === "Total" || c0 === "Summary" || c0 === "Realised P&L" ||
        c0 === "Charges" || c0 === "Disclaimer:" ||
        c0.startsWith("This report") || c0.startsWith("Groww"))
      continue;

    if (currentSection && c0 && row[8] != null) {
      const pnl = Number(row[8]);
      if (isNaN(pnl)) continue;

      const sym = c0;
      const optType = sym.toUpperCase().endsWith("CALL") ? "CE"
                    : sym.toUpperCase().endsWith("PUT")  ? "PE"
                    : "";

      trades.push({
        id:        tradeIdCounter++,
        symbol:    sym,
        type:      currentSection,
        optType,
        qty:       Number(row[1]) || 0,
        buyDate:   String(row[2] ?? ""),
        buyPrice:  Number(row[3]) || 0,
        buyValue:  Number(row[4]) || 0,
        sellDate:  String(row[5] ?? ""),
        sellPrice: Number(row[6]) || 0,
        sellValue: Number(row[7]) || 0,
        grossPnl:  pnl,
      });
    }
  }

  if (trades.length === 0)
    return { error: "No trade rows found. Please upload the Groww F&O P&L report (.xlsx)." };

  return { trades, charges, meta, sheetName };
};

// ─── GROWW CAPITAL GAINS PARSER ──────────────────────────────────────────
const parseGrowwCG = (wb) => {
  const sheetName = wb.SheetNames.find(n => /stock|equity|capital|cg|gain/i.test(n)) || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) return { error:"No usable sheet found." };
  const raw = XLSX.utils.sheet_to_json(ws, { header:1, defval:null });

  const cgTrades = [];
  let hdrRow = -1;

  for (let i = 0; i < Math.min(30, raw.length); i++) {
    const row = raw[i]; if (!row) continue;
    const str = row.map(c => String(c||"").toLowerCase()).join("|");
    if ((str.includes("symbol") || str.includes("script") || str.includes("scrip")) &&
        (str.includes("buy") || str.includes("sell") || str.includes("gain"))) {
      hdrRow = i; break;
    }
  }
  if (hdrRow === -1) return { error:"Could not detect Capital Gains table headers." };

  const hdrs = raw[hdrRow].map(h => String(h||"").toLowerCase().trim());
  const fc = (...ks) => { for (const k of ks) { const i = hdrs.findIndex(h => h.includes(k)); if (i !== -1) return i; } return -1; };
  const C = {
    symbol:   fc("symbol","script","scrip","name","stock"),
    isin:     fc("isin"),
    buyDate:  fc("buy date","purchase date","date of purchase","acquisition"),
    buyQty:   fc("buy qty","quantity","shares","units"),
    buyPrice: fc("avg buy","buy price","avg cost","cost price","purchase price"),
    buyValue: fc("buy value","cost value","purchase value"),
    sellDate: fc("sell date","date of sale","sale date"),
    sellQty:  fc("sell qty","sold qty"),
    sellPrice:fc("avg sell","sell price","sale price"),
    sellValue:fc("sell value","sale value","proceeds"),
    gainLoss: fc("gain","profit","p&l","realised","realized"),
    holding:  fc("holding","period","term","days"),
  };

  let id = 1;
  for (let i = hdrRow+1; i < raw.length; i++) {
    const row = raw[i]; if (!row || !row.some(Boolean)) continue;
    const sym = C.symbol>=0 ? String(row[C.symbol]||"").trim() : "";
    if (!sym || /^(total|grand|sub)/i.test(sym)) continue;

    const num = col => { if(col<0||row[col]==null)return null; if(typeof row[col]==="number")return row[col]; const s=String(row[col]).replace(/[₹,\s()]/g,""); return parseFloat(s)||null; };
    const str = col => col>=0&&row[col]?String(row[col]).trim():"";

    const gainLoss = num(C.gainLoss);
    if (gainLoss === null) continue;

    const buyDateStr  = str(C.buyDate);
    const sellDateStr = str(C.sellDate);
    const holdingStr = str(C.holding).toLowerCase();
    let isLT = false;
    if (holdingStr) {
      isLT = holdingStr.includes("long") || holdingStr.includes("lt") ||
             (holdingStr.match(/\d+/) && parseInt(holdingStr.match(/\d+/)[0]) > 365);
    } else {
      try {
        const parseDate = d => { const parts = d.split(/[-/\s]/); return new Date(parts.reverse().join("-")); };
        const bDate = parseDate(buyDateStr);
        const sDate = parseDate(sellDateStr);
        const days  = (sDate - bDate) / (1000*60*60*24);
        isLT = days > 365;
      } catch { isLT = false; }
    }

    let splitCategory = "post";
    try {
      const parseDate2 = d => { const p = d.split(/[-/\s]/); return new Date(p.length===3?(p[2]+"-"+p[1].padStart(2,"0")+"-"+p[0].padStart(2,"0")):d); };
      const sDate = parseDate2(sellDateStr);
      const splitDate = new Date("2024-07-23");
      splitCategory = sDate < splitDate ? "pre" : "post";
    } catch {}

    cgTrades.push({
      id: id++, symbol: sym, isin: str(C.isin),
      buyDate: buyDateStr, buyQty: num(C.buyQty)||0,
      buyPrice: num(C.buyPrice)||0, buyValue: num(C.buyValue)||0,
      sellDate: sellDateStr, sellQty: num(C.sellQty)||0,
      sellPrice: num(C.sellPrice)||0, sellValue: num(C.sellValue)||0,
      gainLoss, isLT, splitCategory,
    });
  }
  if (cgTrades.length === 0) return { error:"No capital gain rows found. Please upload Groww Capital Gains report." };
  return { cgTrades };
};

// ─── TAX ENGINE ────────────────────────────────────────────────────────────
const calcTurnover = (trades) => {
  const fut = trades.filter(t => t.type === "FUT");
  const opt = trades.filter(t => t.type === "OPT");
  return {
    futures:  fut.reduce((s, t) => s + Math.abs(t.grossPnl), 0),
    options:  opt.reduce((s, t) => s + Math.abs(t.grossPnl), 0),
    futCount: fut.length,
    optCount: opt.length,
    get total() { return this.futures + this.options; },
  };
};

const auditCheck = (turnover, netIncome, totalIncome, prev44AD) => {
  if (turnover > 1000000000)
    return { req: true, reason: "Turnover " + fmt(turnover) + " exceeds ₹10 Crore threshold" };
  if (prev44AD) {
    const pct = turnover > 0 ? (netIncome / turnover) * 100 : 0;
    const basicEx = 250000;
    if ((netIncome < 0 || pct < 6) && totalIncome > basicEx)
      return { req: true, reason: "44AD history: " + (netIncome < 0 ? "F&O Loss" : "Profit " + pct.toFixed(1) + "%") + " < 6% of turnover & income ₹" + fmtN(totalIncome) + " > ₹2.5L basic exemption — Section 44AB(e)" };
  }
  return { req: false, reason: "Not required — turnover " + fmt(turnover) + " is below ₹10 Crore & no prior 44AD that triggers audit" };
};

const FY_CONFIG = {
  "FY 2023-24": {
    ay:"AY 2024-25", label:"FY 2023-24", filing:"31 Jul 2024",
    auditFiling:"31 Oct 2024", basicEx:250000, basicExNew:300000,
    sttFutures:0.0125, sttOptions:0.0625,
    newBands:[[0,300000,0],[300000,600000,5],[600000,900000,10],[900000,1200000,15],[1200000,1500000,20],[1500000,1e15,30]],
    newRebateLimit:700000, newRebateAmt:25000,
    oldRebateLimit:500000, oldRebateAmt:12500,
    ltcgExemption:100000,
    stcgRate:15, stcgRateNew:15, ltcgRate:10, ltcgRateNew:10,
    noSplit:true,
  },
  "FY 2024-25": {
    ay:"AY 2025-26", label:"FY 2024-25", filing:"31 Jul 2025",
    auditFiling:"31 Oct 2025", basicEx:250000, basicExNew:300000,
    sttFutures:0.02, sttOptions:0.1,
    newBands:[[0,300000,0],[300000,700000,5],[700000,1000000,10],[1000000,1200000,15],[1200000,1500000,20],[1500000,1e15,30]],
    newRebateLimit:700000, newRebateAmt:25000,
    oldRebateLimit:500000, oldRebateAmt:12500,
    ltcgExemption:125000,
    stcgRate:15, stcgRateNew:20, ltcgRate:10, ltcgRateNew:12.5, splitDate:"Jul 23, 2024",
  },
  "FY 2025-26": {
    ay:"AY 2026-27", label:"FY 2025-26", filing:"31 Aug 2026",
    auditFiling:"31 Oct 2026", basicEx:250000, basicExNew:400000,
    sttFutures:0.02, sttOptions:0.1,
    newBands:[[0,400000,0],[400000,800000,5],[800000,1200000,10],[1200000,1600000,15],[1600000,2000000,20],[2000000,2400000,25],[2400000,1e15,30]],
    newRebateLimit:1200000, newRebateAmt:60000,
    oldRebateLimit:500000, oldRebateAmt:12500,
    ltcgExemption:125000,
    stcgRate:20, stcgRateNew:20, ltcgRate:12.5, ltcgRateNew:12.5,
    noSplit:true,
  },
};

const calcTaxNew = (income, fyConf) => {
  const conf = fyConf || FY_CONFIG["FY 2024-25"];
  if (income <= 0) return { gross: 0, rebate: 0, surcharge: 0, cess: 0, total: 0, slabs: [] };
  const bands = conf.newBands;
  let gross = 0; const slabs = [];
  for (const [lo, hi, rate] of bands) {
    if (income <= lo) break;
    const taxable = Math.min(income, hi) - lo;
    const tax = taxable * rate / 100;
    gross += tax;
    // NOTE: division by 100 is in a pure JS statement (not inside JSX {})
    const loK = lo * 0.001;
    const hiLabel = hi >= 1e14 ? "∞" : "₹" + fmtN(hi * 0.001) + "K";
    if (taxable > 0 && rate > 0) slabs.push({ label: "₹" + fmtN(loK) + "K – " + hiLabel, rate, taxable, tax });
  }
  const rebate    = income <= conf.newRebateLimit ? Math.min(gross, conf.newRebateAmt) : 0;
  const after     = Math.max(0, gross - rebate);
  const surcharge = income > 50000000 ? after * 0.37 : income > 20000000 ? after * 0.25 : income > 10000000 ? after * 0.15 : income > 5000000 ? after * 0.10 : 0;
  const cess      = (after + surcharge) * 0.04;
  return { gross, rebate, after, surcharge, cess, total: after + surcharge + cess, slabs };
};

const calcTaxOld = (income, age = "below60", fyConf) => {
  const conf = fyConf || FY_CONFIG["FY 2024-25"];
  if (income <= 0) return { gross: 0, rebate: 0, surcharge: 0, cess: 0, total: 0, slabs: [] };
  const bands = age === "superSenior"
    ? [[0,500000,0],[500000,1000000,20],[1000000,1e15,30]]
    : age === "senior"
    ? [[0,300000,0],[300000,500000,5],[500000,1000000,20],[1000000,1e15,30]]
    : [[0,250000,0],[250000,500000,5],[500000,1000000,20],[1000000,1e15,30]];
  let gross = 0; const slabs = [];
  for (const [lo, hi, rate] of bands) {
    if (income <= lo) break;
    const taxable = Math.min(income, hi) - lo;
    const tax = taxable * rate / 100;
    gross += tax;
    if (taxable > 0 && rate > 0) slabs.push({ label: rate + "% slab", rate, taxable, tax });
  }
  const rebate    = income <= conf.oldRebateLimit ? Math.min(gross, conf.oldRebateAmt) : 0;
  const after     = Math.max(0, gross - rebate);
  const surcharge = income > 50000000 ? after * 0.37 : income > 20000000 ? after * 0.25 : income > 10000000 ? after * 0.15 : income > 5000000 ? after * 0.10 : 0;
  const cess      = (after + surcharge) * 0.04;
  return { gross, rebate, after, surcharge, cess, total: after + surcharge + cess, slabs };
};

// ─── SHARE LINK UTILS ────────────────────────────────────────────────────
const compressState = (obj) => {
  try {
    const json = JSON.stringify(obj);
    const bytes = new TextEncoder().encode(json);
    let binary = "";
    bytes.forEach(b => binary += String.fromCharCode(b));
    return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
  } catch { return null; }
};
const decompressState = (str) => {
  try {
    const b64 = str.replace(/-/g,"+").replace(/_/g,"/");
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i=0;i<binary.length;i++) bytes[i] = binary.charCodeAt(i);
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json);
  } catch { return null; }
};

// ─── DESIGN SYSTEM ────────────────────────────────────────────────────────
const makeS = (dark) => {
  const appBg    = dark ? "#080A14" : "#EEF0FB";
  const sideBg   = dark ? "#0C0E1D" : "#FFFFFF";
  const card     = dark ? "#111325" : "#FFFFFF";
  const card2    = dark ? "#181B30" : "#F5F6FF";
  const border   = dark ? "rgba(255,255,255,0.06)" : "rgba(99,102,241,0.11)";
  const border2  = dark ? "rgba(255,255,255,0.03)" : "rgba(99,102,241,0.06)";
  const txt      = dark ? "#E8EAFF" : "#141627";
  const txt2     = dark ? "#7A84B0" : "#515882";
  const txt3     = dark ? "#3D4466" : "#9099C4";
  const rowAlt   = dark ? "#161829" : "#F5F6FF";
  const inpBg    = dark ? "#0C0E1D" : "#FFFFFF";
  const inpBorder= dark ? "rgba(255,255,255,0.09)" : "rgba(99,102,241,0.18)";
  const purple   = "#7C63F5";
  const purpleL  = dark ? "#9B87FF" : "#6248E8";
  const purpleGrad = "linear-gradient(135deg,#7C63F5 0%,#5040E0 100%)";
  const cyan     = "#06C8FF";
  const green    = "#00D68F";
  const red      = "#FF4D6A";
  const amber    = "#FFB020";
  const glassCard= dark ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.75)";
  const glassBdr = dark ? "rgba(255,255,255,0.08)" : "rgba(124,99,245,0.15)";

  return {
    app: {
      fontFamily:"'Plus Jakarta Sans','Inter','Segoe UI',sans-serif",
      background: appBg, color: txt,
      display:"flex", minHeight:"100vh",
      transition:"background .35s, color .35s",
      position:"relative", overflow:"hidden",
    },
    meshBlob1: {
      position:"fixed", top:"-15%", left:"-10%",
      width:500, height:500, borderRadius:"50%",
      background: dark
        ? "radial-gradient(circle, rgba(124,99,245,0.12) 0%, transparent 70%)"
        : "radial-gradient(circle, rgba(124,99,245,0.08) 0%, transparent 70%)",
      pointerEvents:"none", zIndex:0,
    },
    meshBlob2: {
      position:"fixed", bottom:"-10%", right:"5%",
      width:420, height:420, borderRadius:"50%",
      background: dark
        ? "radial-gradient(circle, rgba(6,200,255,0.08) 0%, transparent 70%)"
        : "radial-gradient(circle, rgba(6,200,255,0.05) 0%, transparent 70%)",
      pointerEvents:"none", zIndex:0,
    },
    meshBlob3: {
      position:"fixed", top:"40%", right:"30%",
      width:300, height:300, borderRadius:"50%",
      background: dark
        ? "radial-gradient(circle, rgba(0,214,143,0.06) 0%, transparent 70%)"
        : "radial-gradient(circle, rgba(0,214,143,0.04) 0%, transparent 70%)",
      pointerEvents:"none", zIndex:0,
    },
    sidebar: {
      width:232, flexShrink:0,
      background: dark ? "rgba(12,14,29,0.97)" : "rgba(255,255,255,0.97)",
      backdropFilter:"blur(20px)",
      borderRight:"1px solid " + border,
      display:"flex", flexDirection:"column",
      height:"100vh", position:"sticky", top:0, overflowY:"auto",
      zIndex:20,
      transition:"background .35s",
    },
    logoArea: {
      padding:"22px 18px 18px",
      borderBottom:"1px solid " + border,
      display:"flex", alignItems:"center", gap:11,
    },
    logoMark: {
      width:38, height:38, borderRadius:12, flexShrink:0,
      background: purpleGrad,
      display:"flex", alignItems:"center", justifyContent:"center",
      fontSize:17, fontWeight:800, color:"#fff",
      boxShadow:"0 4px 16px rgba(124,99,245,0.45)",
    },
    logoText: { fontSize:14.5, fontWeight:800, color:txt, letterSpacing:"-0.5px" },
    logoSub:  { fontSize:9.5, color:txt3, marginTop:2, letterSpacing:"0.04em" },
    navSection: { flex:1, padding:"12px 10px", display:"flex", flexDirection:"column", gap:1 },
    navLabel: {
      fontSize:9.5, fontWeight:700, color:txt3, textTransform:"uppercase",
      letterSpacing:"0.12em", padding:"12px 10px 5px",
    },
    navItem: (active) => ({
      display:"flex", alignItems:"center", gap:10,
      padding:"9px 12px", borderRadius:11, cursor:"pointer",
      transition:"all .18s", position:"relative",
      background: active
        ? (dark ? "rgba(124,99,245,0.16)" : "rgba(124,99,245,0.09)")
        : "transparent",
      border:"none",
    }),
    navActivePill: {
      position:"absolute", left:0, top:"50%", transform:"translateY(-50%)",
      width:3, height:20, borderRadius:"0 3px 3px 0",
      background: purpleGrad,
      boxShadow:"0 0 8px rgba(124,99,245,0.6)",
    },
    navIcon: (active) => ({
      fontSize:15, width:20, textAlign:"center", flexShrink:0,
      opacity: active ? 1 : 0.55,
    }),
    navText: (active) => ({
      fontSize:12.5, fontWeight: active ? 700 : 500,
      color: active ? purpleL : txt2,
      whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis",
    }),
    sidebarBottom: {
      padding:"12px 10px 18px",
      borderTop:"1px solid " + border,
    },
    mainArea: { flex:1, display:"flex", flexDirection:"column", minWidth:0, overflow:"hidden", position:"relative", zIndex:1 },
    topHeader: {
      background: dark ? "rgba(8,10,20,0.92)" : "rgba(255,255,255,0.92)",
      backdropFilter:"blur(16px)",
      WebkitBackdropFilter:"blur(16px)",
      padding:"0 28px",
      height:58, flexShrink:0,
      display:"flex", alignItems:"center", justifyContent:"space-between",
      borderBottom:"1px solid " + border,
      position:"sticky", top:0, zIndex:50,
    },
    pageTitle: { fontSize:16, fontWeight:800, color:txt, letterSpacing:"-0.5px" },
    pageSubtitle: { fontSize:11, color:txt3, marginTop:2 },
    sec: { padding:"22px 28px", display:"flex", flexDirection:"column", gap:20 },
    card: {
      background: card, borderRadius:18,
      padding:"20px 24px",
      border:"1px solid " + border,
      boxShadow: dark
        ? "0 4px 32px rgba(0,0,0,0.45)"
        : "0 2px 16px rgba(99,102,241,0.07)",
      transition:"box-shadow .2s, transform .2s",
      position:"relative", overflow:"hidden",
    },
    glass: {
      background: glassCard,
      backdropFilter:"blur(24px)",
      WebkitBackdropFilter:"blur(24px)",
      borderRadius:20,
      padding:"22px 26px",
      border:"1px solid " + glassBdr,
      boxShadow: dark
        ? "0 8px 40px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06)"
        : "0 4px 24px rgba(99,102,241,0.10), inset 0 1px 0 rgba(255,255,255,0.8)",
      position:"relative", overflow:"hidden",
    },
    card2, border, border2, txt, txt2, txt3, rowAlt, dark,
    purple, purpleL, purpleGrad, cyan, green, red, amber,
    appBg, sideBg, inpBg,
    mc: (col) => {
      // Pre-compute rgb string to avoid division/complex expressions inside JSX
      const rgbaMap = {
        "#7C63F5": "124,99,245",
        "#06C8FF": "6,200,255",
        "#00D68F": "0,214,143",
        "#FF4D6A": "255,77,106",
        "#FFB020": "255,176,32",
      };
      const rgb = rgbaMap[col] || "124,99,245";
      return {
        background: dark
          ? "linear-gradient(145deg, " + card + " 0%, rgba(" + rgb + ",0.08) 100%)"
          : card,
        borderRadius:18,
        padding:"20px 22px",
        border:"1px solid " + border,
        boxShadow: dark
          ? "0 4px 28px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)"
          : "0 2px 16px rgba(99,102,241,0.06)",
        position:"relative", overflow:"hidden",
        transition:"transform .2s, box-shadow .2s",
      };
    },
    mcGlow: (col) => ({
      position:"absolute", top:-24, right:-24,
      width:90, height:90, borderRadius:"50%",
      background: col + (dark ? "28" : "18"),
      filter:"blur(22px)",
      pointerEvents:"none",
    }),
    mcIcon: (col) => ({
      position:"absolute", top:16, right:16,
      width:34, height:34, borderRadius:10,
      background: col + (dark ? "22" : "15"),
      border:"1px solid " + col + "33",
      display:"flex", alignItems:"center", justifyContent:"center",
      fontSize:15,
    }),
    mLabel: {
      fontSize:11, fontWeight:700, color:txt3,
      textTransform:"uppercase", letterSpacing:"0.09em", marginBottom:10,
    },
    mVal: (c) => ({
      fontSize:26, fontWeight:800, color:c||txt,
      letterSpacing:"-1px", fontFamily:"'IBM Plex Mono',monospace",
      lineHeight:1,
    }),
    mSub: { fontSize:11, color:txt3, marginTop:7, display:"flex", alignItems:"center", gap:5 },
    h2: { fontSize:14.5, fontWeight:700, color:txt, marginBottom:16, letterSpacing:"-0.3px" },
    h3: { fontSize:10.5, fontWeight:700, color:txt3, textTransform:"uppercase", letterSpacing:"0.09em", marginBottom:12 },
    grid: (n) => ({ display:"grid", gridTemplateColumns:"repeat(" + n + ",1fr)", gap:16 }),
    table: { width:"100%", borderCollapse:"collapse", fontSize:12.5 },
    th: {
      padding:"10px 14px",
      background: dark ? "rgba(255,255,255,0.025)" : card2,
      color:txt3, fontWeight:700, fontSize:10.5, textAlign:"left",
      borderBottom:"1px solid " + border,
      textTransform:"uppercase", letterSpacing:"0.07em",
    },
    td: {
      padding:"10px 14px",
      borderBottom:"1px solid " + border2,
      color:txt, verticalAlign:"middle",
    },
    pill: (ok) => ({
      display:"inline-flex", alignItems:"center", gap:4,
      padding:"3px 11px", borderRadius:20, fontSize:11, fontWeight:700,
      background: ok
        ? (dark ? "rgba(0,214,143,0.14)" : "rgba(0,214,143,0.11)")
        : (dark ? "rgba(255,77,106,0.14)" : "rgba(255,77,106,0.11)"),
      color: ok
        ? (dark ? "#00D68F" : "#00956A")
        : (dark ? "#FF4D6A" : "#D6203E"),
    }),
    inp: {
      width:"100%", padding:"8px 12px",
      border:"1px solid " + inpBorder,
      borderRadius:10, fontSize:12.5,
      fontFamily:"'IBM Plex Mono',monospace",
      color:txt, outline:"none", boxSizing:"border-box",
      background:inpBg,
      transition:"border-color .15s, box-shadow .15s",
    },
    btn: (v) => ({
      padding:"8px 18px", borderRadius:10, fontWeight:700,
      fontSize:12.5, cursor:"pointer", border:"none",
      fontFamily:"'Plus Jakarta Sans',sans-serif",
      transition:"all .18s",
      background: v==="primary" ? purpleGrad
                : v==="ghost"   ? "transparent"
                : v==="success" ? "linear-gradient(135deg,#00D68F,#00956A)"
                : v==="danger"  ? "linear-gradient(135deg,#FF4D6A,#D6203E)"
                : (dark ? "rgba(255,255,255,0.07)" : "rgba(99,102,241,0.07)"),
      color: v==="ghost" ? txt2 : "#fff",
      boxShadow: v==="primary" ? "0 4px 16px rgba(124,99,245,0.38)" : "none",
    }),
    info: (c) => {
      const map = {
        "#f97316": [dark?"rgba(251,146,60,0.11)":"rgba(251,146,60,0.09)", dark?"#FDBA74":"#B45309", dark?"rgba(251,146,60,0.22)":"rgba(251,146,60,0.18)"],
        "#dc2626": [dark?"rgba(255,77,106,0.11)":"rgba(255,77,106,0.07)", dark?"#FF8095":"#B91C1C", dark?"rgba(255,77,106,0.22)":"rgba(255,77,106,0.16)"],
        "#3b82f6": [dark?"rgba(6,200,255,0.09)":"rgba(6,200,255,0.07)", dark?"#67E8FF":"#1E40AF", dark?"rgba(6,200,255,0.18)":"rgba(6,200,255,0.16)"],
        "#16a34a": [dark?"rgba(0,214,143,0.11)":"rgba(0,214,143,0.07)", dark?"#6EF0C0":"#166534", dark?"rgba(0,214,143,0.22)":"rgba(0,214,143,0.16)"],
      };
      const [bg,col,bdr] = map[c] || map["#3b82f6"];
      return { background:bg, border:"1px solid " + bdr, borderRadius:12, padding:"12px 16px", fontSize:12.5, color:col };
    },
    mono: { fontFamily:"'IBM Plex Mono',monospace" },
  };
};

// ─── BADGE ─────────────────────────────────────────────────────────────────
const Badge = ({ children, color = "#7C63F5" }) => (
  <span style={{
    background: color + "1E", color,
    padding:"3px 11px", borderRadius:20,
    fontSize:10.5, fontWeight:700, letterSpacing:"0.03em",
    border:"1px solid " + color + "30",
  }}>{children}</span>
);

// ─── HERO METRIC CARD ─────────────────────────────────────────────────────
const MC = ({ label, val, sub, color = "#7C63F5", S, icon }) => (
  <div style={S.mc(color)}>
    <div style={S.mcGlow(color)} />
    {icon && <div style={S.mcIcon(color)}>{icon}</div>}
    <div style={S.mLabel}>{label}</div>
    <div style={S.mVal(color)}>{val}</div>
    {sub && <div style={S.mSub}><span style={{ opacity:0.6 }}>↗</span>{sub}</div>}
  </div>
);

// ─── DONUT CHART ──────────────────────────────────────────────────────────
// NOTE: All arithmetic (division) kept OUTSIDE JSX expressions
const DonutChart = ({ segments, size = 80, stroke = 16 }) => {
  // Pre-compute center to avoid division inside JSX {}
  const center = Math.floor(size * 0.5);
  const r = (size - stroke) * 0.5;
  const circ = 2 * Math.PI * r;
  const total = segments.reduce((s, d) => s + d.val, 0) || 1;
  // Pre-compute all dash values outside JSX
  const dashData = [];
  let cumOffset = 0;
  for (const seg of segments) {
    const dash = (seg.val / total) * circ;
    dashData.push({ dash, offset: cumOffset, color: seg.color });
    cumOffset += dash;
  }
  return (
    <svg width={size} height={size} style={{ transform:"rotate(-90deg)" }}>
      {dashData.map((d, i) => {
        const gap = circ - d.dash;
        const negOffset = -d.offset;
        return (
          <circle key={i}
            cx={center} cy={center} r={r}
            fill="none"
            stroke={d.color}
            strokeWidth={stroke}
            strokeDasharray={d.dash + " " + gap}
            strokeDashoffset={negOffset}
            strokeLinecap="butt"
            opacity={0.9}
          />
        );
      })}
    </svg>
  );
};

// ─── MAIN COMPONENT ────────────────────────────────────────────────────────
export default function FnOTaxCalc() {
  const [tab, setTab]   = useState(() => { try { return window.location.hash.startsWith("#share=") ? "shareview" : "upload"; } catch { return "upload"; } });
  const [dark, setDark] = useState(false);
  const S = useMemo(() => makeS(dark), [dark]);

  const [fileList, setFileList] = useState([]);

  // ── All state declarations BEFORE any useCallback/useMemo that references them ──
  const [parseError, setParseError] = useState("");
  const [dragging, setDragging]     = useState(false);
  const fileRef = useRef();
  const fileImportRef = useRef();
  const cgFileRef = useRef();

  const [addExp, setAddExp]         = useState({ internet:0, software:0, advisory:0, depreciation:0, officeRent:0, other:0 });
  const [otherInc, setOtherInc]     = useState({ salary:0, houseProperty:0, capitalGains:0, otherSrc:0 });
  const [aisData, setAisData]       = useState({ futTurnover:"", optTurnover:"", grossPnlAIS:"", totalChargesAIS:"", notes:"" });
  const [prev44AD, setPrev44AD]     = useState(false);
  const [aisChecked, setAisChecked] = useState(false);
  const [fyYear, setFyYear]         = useState("FY 2024-25");
  const [advTax, setAdvTax]         = useState({ q1:0,q2:0,q3:0,q4:0 });
  const [regime, setRegime]         = useState("new");
  const [cgTrades, setCgTrades]     = useState([]);
  const [cgParseError, setCgParseError] = useState("");
  const [shareToast, setShareToast] = useState("");
  const [expandedStock, setExpandedStock] = useState(null);
  const [ageGroup, setAgeGroup]     = useState("below60");
  const [dedVIA, setDedVIA]         = useState(0);
  const [newLedgerEntry, setNewLedgerEntry] = useState({ ay:"", fy:"", loss:"", source:"Manual Entry", notes:"" });
  const [editLedgerId, setEditLedgerId]     = useState(null);
  const [editLedgerRow, setEditLedgerRow]   = useState({});

  const loadLedger = () => {
    try { const s = localStorage.getItem(LEDGER_KEY); return s ? JSON.parse(s) : []; }
    catch { return []; }
  };
  const [lossLedger, setLossLedger] = useState(() => loadLedger());
  const saveLedger = (data) => {
    try { localStorage.setItem(LEDGER_KEY, JSON.stringify(data)); } catch {}
  };
  const updateLedger = (data) => { setLossLedger(data); saveLedger(data); };

  // ── Derived merged data ──────────────────────────────────────────────────
  const fyConf  = useMemo(() => FY_CONFIG[fyYear] || FY_CONFIG["FY 2024-25"], [fyYear]);
  const trades  = useMemo(() => fileList.flatMap(f => f.trades.map(t => ({...t, sourceFile: f.id, sourceName: f.filename}))), [fileList]);
  const charges = useMemo(() => {
    const keys = ["stt","brokerage","exchCharges","gst","stampDuty","sebi","ipft"];
    return keys.reduce((acc, k) => { acc[k] = fileList.reduce((s,f) => s+(f.charges[k]||0),0); return acc; }, {});
  }, [fileList]);
  const meta = useMemo(() => fileList[0]?.meta || {}, [fileList]);
  const periods = useMemo(() => fileList.map(f => f.meta?.period||f.filename).filter(Boolean), [fileList]);

  const TO = useMemo(() => calcTurnover(trades), [trades]);

  const chargesTotalFromFile = useMemo(() =>
    Object.values(charges).reduce((s, v) => s + (v || 0), 0), [charges]);

  const addExpTotal = useMemo(() =>
    Object.values(addExp).reduce((s, v) => s + (Number(v) || 0), 0), [addExp]);

  const totalDeductible = useMemo(() => chargesTotalFromFile + addExpTotal, [chargesTotalFromFile, addExpTotal]);

  const grossPnl       = useMemo(() => trades.reduce((s, t) => s + t.grossPnl, 0), [trades]);
  const netBizIncome   = useMemo(() => grossPnl - totalDeductible, [grossPnl, totalDeductible]);

  const otherSalary    = useMemo(() => Number(otherInc.salary) || 0, [otherInc]);
  const nonSalaryInc   = useMemo(() =>
    (Number(otherInc.houseProperty)||0) + (Number(otherInc.capitalGains)||0) + (Number(otherInc.otherSrc)||0),
    [otherInc]);

  const fnoLoss        = useMemo(() => netBizIncome < 0 ? Math.abs(netBizIncome) : 0, [netBizIncome]);
  const cySetOff       = useMemo(() => Math.min(fnoLoss, nonSalaryInc), [fnoLoss, nonSalaryInc]);
  const lossToCarryFwd = useMemo(() => fnoLoss - cySetOff, [fnoLoss, cySetOff]);

  const priorTotal = useMemo(() => {
    const currentAY = fyConf.ay;
    return lossLedger
      .filter(e => e.ay !== currentAY && !e.expired)
      .reduce((s, e) => s + Math.max(0, (Number(e.loss)||0) - (Number(e.usedAmount)||0)), 0);
  }, [lossLedger, fyConf]);

  const fnoForTax      = useMemo(() => Math.max(0, netBizIncome), [netBizIncome]);
  const adjNonSalary   = useMemo(() => Math.max(0, nonSalaryInc - cySetOff), [nonSalaryInc, cySetOff]);
  const priorSetOff    = useMemo(() => Math.min(priorTotal, fnoForTax + adjNonSalary), [priorTotal, fnoForTax, adjNonSalary]);

  const grossTotalInc  = useMemo(() => otherSalary + fnoForTax + adjNonSalary - priorSetOff, [otherSalary, fnoForTax, adjNonSalary, priorSetOff]);
  const taxableNew     = useMemo(() => Math.max(0, grossTotalInc), [grossTotalInc]);
  const taxableOld     = useMemo(() => Math.max(0, grossTotalInc - (Number(dedVIA)||0)), [grossTotalInc, dedVIA]);

  const taxNew    = useMemo(() => calcTaxNew(taxableNew, fyConf), [taxableNew, fyConf]);
  const taxOld    = useMemo(() => calcTaxOld(taxableOld, ageGroup, fyConf), [taxableOld, ageGroup, fyConf]);
  const activeTax = useMemo(() => regime === "new" ? taxNew : taxOld, [regime, taxNew, taxOld]);

  const advTaxPaid   = useMemo(() => Object.values(advTax).reduce((s, v) => s + (Number(v)||0), 0), [advTax]);
  const balanceTax   = useMemo(() => Math.max(0, activeTax.total - advTaxPaid), [activeTax, advTaxPaid]);
  const refundAmt    = useMemo(() => Math.max(0, advTaxPaid - activeTax.total), [activeTax, advTaxPaid]);
  const audit        = useMemo(() => auditCheck(TO.total, netBizIncome, grossTotalInc, prev44AD), [TO, netBizIncome, grossTotalInc, prev44AD]);

  const stockPnl = useMemo(() => {
    const map = {};
    trades.forEach(t => {
      const s = extractStock(t.symbol);
      if (!map[s]) map[s] = { stock:s, trades:[], pnl:0, turnover:0, futPnl:0, optPnl:0, futCount:0, optCount:0 };
      map[s].trades.push(t);
      map[s].pnl += t.grossPnl;
      map[s].turnover += Math.abs(t.grossPnl);
      if (t.type === "FUT") { map[s].futPnl += t.grossPnl; map[s].futCount++; }
      else { map[s].optPnl += t.grossPnl; map[s].optCount++; }
    });
    return Object.values(map).sort((a,b) => b.pnl - a.pnl);
  }, [trades]);

  const winners  = useMemo(() => stockPnl.filter(s => s.pnl > 0).length, [stockPnl]);
  const losers   = useMemo(() => stockPnl.filter(s => s.pnl < 0).length, [stockPnl]);
  const maxWin   = useMemo(() => stockPnl.length ? stockPnl[0] : { stock:"—", pnl:0 }, [stockPnl]);
  const maxLoss  = useMemo(() => stockPnl.length ? stockPnl[stockPnl.length-1] : { stock:"—", pnl:0 }, [stockPnl]);

  const cgSummary = useMemo(() => {
    const preLTCG  = cgTrades.filter(t => t.isLT && t.splitCategory==="pre").reduce((s,t) => s+t.gainLoss, 0);
    const postLTCG = cgTrades.filter(t => t.isLT && t.splitCategory==="post").reduce((s,t) => s+t.gainLoss, 0);
    const preSTCG  = cgTrades.filter(t => !t.isLT && t.splitCategory==="pre").reduce((s,t) => s+t.gainLoss, 0);
    const postSTCG = cgTrades.filter(t => !t.isLT && t.splitCategory==="post").reduce((s,t) => s+t.gainLoss, 0);
    const totalGain = preLTCG + postLTCG + preSTCG + postSTCG;
    // All rate calculations done in pure JS (no JSX), division is safe here
    const baseStcgRate = (fyConf.stcgRate || 15) / 100;
    const postStcgRate = (fyConf.stcgRateNew || fyConf.stcgRate || 20) / 100;
    const baseLtcgRate = (fyConf.ltcgRate || 10) / 100;
    const postLtcgRate = (fyConf.ltcgRateNew || fyConf.ltcgRate || 12.5) / 100;
    const stcgTax = Math.max(0,preSTCG)*baseStcgRate + Math.max(0,postSTCG)*postStcgRate;
    const totalLTCG = preLTCG + postLTCG;
    const ltcgExempt = fyConf.ltcgExemption || 125000;
    const taxableLTCG = Math.max(0, totalLTCG - ltcgExempt);
    const ltcgTax = taxableLTCG > 0
      ? (Math.min(taxableLTCG, Math.max(0,preLTCG)) * baseLtcgRate + Math.max(0, taxableLTCG - Math.max(0,preLTCG)) * postLtcgRate)
      : 0;
    const totalCGTax = (stcgTax + ltcgTax) * 1.04;
    return { preLTCG, postLTCG, preSTCG, postSTCG, totalGain, stcgTax, ltcgTax, totalCGTax, ltcgExempt, taxableLTCG };
  }, [cgTrades, fyConf]);

  // ── generateShareLink — AFTER all derived values are defined ──
  const generateShareLink = useCallback(() => {
    const shareState = {
      fyYear, otherInc, addExp, regime, ageGroup, dedVIA,
      advTax, prev44AD,
      summary: {
        trades: trades.length,
        turnover: TO.total,
        grossPnl,
        netBizIncome,
        totalDeductible,
        grossTotalInc,
        activeTaxTotal: activeTax.total,
        cgTotal: cgSummary?.totalGain || 0,
        cgTax: cgSummary?.totalCGTax || 0,
        metaName: meta.name || "",
        metaPeriod: meta.period || "",
        auditReq: audit.req,
        auditReason: audit.reason,
      },
    };
    const compressed = compressState(shareState);
    if (!compressed) { setShareToast("Failed to generate link"); return; }
    try {
      const url = window.location.origin + window.location.pathname + "#share=" + compressed;
      navigator.clipboard.writeText(url).then(
        () => { setShareToast("✓ Link copied to clipboard!"); setTimeout(() => setShareToast(""), 3000); },
        () => { setShareToast("Link ready — copy from address bar"); window.location.hash = "share=" + compressed; }
      );
    } catch(e) { setShareToast("Copy this URL from your browser address bar"); }
  }, [fyYear, otherInc, addExp, regime, ageGroup, dedVIA, advTax, prev44AD,
      trades, TO, grossPnl, netBizIncome, totalDeductible,
      grossTotalInc, activeTax, cgSummary, meta, audit]);

  // ── File processing ──────────────────────────────────────────────────────
  const processFile = useCallback((file) => {
    if (!file) return;
    if (!file.name.endsWith(".xlsx") && !file.name.endsWith(".xls")) {
      setParseError("Please upload an Excel (.xlsx) file from Groww."); return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: "array" });
        const result = parseGroww(wb);
        if (result.error) { setParseError(result.error); return; }
        setFileList(prev => [...prev, { id: Date.now() + Math.random(), filename: file.name, ...result }]);
        setParseError("");
        setTab("dashboard");
      } catch (err) {
        setParseError("Failed to read file: " + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const processCGFile = useCallback((file) => {
    if (!file) return;
    if (!file.name.endsWith(".xlsx") && !file.name.endsWith(".xls")) {
      setCgParseError("Please upload a .xlsx file (Groww Capital Gains - Stocks report)."); return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type:"array" });
        const result = parseGrowwCG(wb);
        if (result.error) { setCgParseError(result.error); return; }
        setCgTrades(prev => [...prev, ...result.cgTrades.map(t => ({...t, id: Date.now()+Math.random()+t.id}))]);
        setCgParseError(""); setTab("capgains");
      } catch (err) { setCgParseError("Failed: "+err.message); }
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const clearCG = () => { setCgTrades([]); setCgParseError(""); };

  const removeFile = useCallback((id) => {
    setFileList(prev => {
      const next = prev.filter(f => f.id !== id);
      if (next.length === 0) setTab("upload");
      return next;
    });
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault(); setDragging(false);
    Array.from(e.dataTransfer.files).forEach(f => processFile(f));
  }, [processFile]);

  const resetAll = () => { setFileList([]); setParseError(""); setTab("upload"); };

  // ── PDF GENERATION ───────────────────────────────────────────────────────
  const generatePDF = useCallback(() => {
    const doc = new jsPDF({ orientation:"portrait", unit:"mm", format:"a4" });
    const W = 210, M = 14;
    let y = 0;

    const C = {
      orange: [249, 115, 22],
      dark:   [15, 23, 42],
      navy:   [30, 58, 95],
      gray:   [71, 85, 105],
      lgray:  [148, 163, 184],
      bg:     [248, 250, 252],
      white:  [255, 255, 255],
      green:  [22, 163, 74],
      red:    [220, 38, 38],
    };

    const setColor = (c) => doc.setTextColor(...c);
    const fillRect = (x, fy, w, h, col) => { doc.setFillColor(...col); doc.rect(x, fy, w, h, "F"); };

    const checkPage = (need = 20) => {
      if (y + need > 280) { doc.addPage(); y = 16; }
    };

    const section = (title) => {
      checkPage(16);
      fillRect(M, y, W - M*2, 8, C.navy);
      doc.setFontSize(9); doc.setFont("helvetica","bold"); setColor(C.white);
      doc.text(title, M + 3, y + 5.5);
      y += 11;
    };

    const kvRow = (label, value, col = C.dark, bg = null) => {
      checkPage(8);
      if (bg) fillRect(M, y - 0.5, W - M*2, 7, bg);
      doc.setFontSize(8.5); doc.setFont("helvetica","normal"); setColor(C.gray);
      doc.text(label, M + 2, y + 4);
      doc.setFont("helvetica","bold"); setColor(col);
      doc.text(String(value), W - M - 2, y + 4, { align:"right" });
      y += 7;
    };

    fillRect(0, 0, W, 28, C.dark);
    fillRect(0, 26, W, 2, C.orange);
    doc.setFontSize(16); doc.setFont("helvetica","bold"); setColor(C.orange);
    doc.text("F&O TAX CALCULATOR", M, 10);
    doc.setFontSize(9); doc.setFont("helvetica","normal"); setColor([148,163,184]);
    doc.text("ITR-3 Summary Report  ·  " + fyConf.label + " (" + fyConf.ay + ")  ·  ICAI Verified Calculations", M, 17);
    const today = new Date().toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"});
    doc.text("Generated: " + today, W - M, 17, { align:"right" });
    y = 34;

    section("TRADER INFORMATION");
    const infoRows = [
      ["Name",              meta.name || "—"],
      ["Client Code (Groww)", meta.clientCode || "—"],
      ["Period",            periods.length === 1 ? (meta.period || "—") : periods.length + " reports merged"],
      ["Financial Year",    fyConf.label],
      ["Assessment Year",   fyConf.ay],
      ["ITR Form",          "ITR-3 (Non-Speculative Business Income)"],
      ["Tax Regime",        regime === "new" ? "New Tax Regime (Default)" : "Old Tax Regime"],
    ];
    infoRows.forEach(([k,v],i) => kvRow(k, v, C.dark, i%2===0?C.bg:C.white));
    y += 4;

    section("FINANCIAL SUMMARY");
    const futPnlPDF = trades.filter(t=>t.type==="FUT").reduce((s,t)=>s+t.grossPnl,0);
    const optPnlPDF = trades.filter(t=>t.type==="OPT").reduce((s,t)=>s+t.grossPnl,0);
    const summaryRows = [
      ["Total Trades",              trades.length + " (" + TO.futCount + " Futures + " + TO.optCount + " Options)"],
      ["Futures Turnover (Σ|P&L|)", fmt(TO.futures)],
      ["Options Turnover (Σ|P&L|)", fmt(TO.options)],
      ["TOTAL F&O TURNOVER",        fmt(TO.total)],
      ["Gross Trade P&L",           fmt(grossPnl)],
      ["Total Deductible Charges",  fmt(totalDeductible)],
      ["NET BUSINESS INCOME / (LOSS)", fmt(netBizIncome)],
    ];
    summaryRows.forEach(([k,v],i) => kvRow(k, v, C.dark, i%2===0?C.bg:C.white));
    y += 4;

    checkPage(20);
    const auditBg = audit.req ? [254,226,226] : [220,252,231];
    const auditFg = audit.req ? C.red : C.green;
    fillRect(M, y, W-M*2, 14, auditBg);
    doc.setFontSize(10); doc.setFont("helvetica","bold"); setColor(auditFg);
    doc.text(audit.req ? "  TAX AUDIT REQUIRED (Section 44AB)" : "  TAX AUDIT NOT REQUIRED", M+3, y+6);
    doc.setFontSize(8); doc.setFont("helvetica","normal"); setColor(C.gray);
    doc.text(audit.reason, M+3, y+11);
    y += 18;

    section("CHARGES BREAKDOWN (ALL DEDUCTIBLE — SECTION 36)");
    const chargeRows = [
      ["Securities Transaction Tax (STT)", fmt(charges.stt||0), "0.02% Futures / 0.1% Options (Oct 2024)"],
      ["Brokerage",                        fmt(charges.brokerage||0), "₹20/order flat (Groww)"],
      ["Exchange Transaction Charges",     fmt(charges.exchCharges||0), "~0.00188% of value"],
      ["Total GST",                        fmt(charges.gst||0), "18% on brokerage & exchange charges"],
      ["Stamp Duty",                       fmt(charges.stampDuty||0), "0.002% on buy value"],
      ["SEBI Turnover Charges",            fmt(charges.sebi||0), "₹10 per crore"],
      ["IPFT Charges",                     fmt(charges.ipft||0), "₹1 per crore"],
      ["Additional Expenses (manual)",     fmt(addExpTotal), "Internet, software, depreciation etc."],
      ["TOTAL DEDUCTIBLE CHARGES",         fmt(totalDeductible), ""],
    ];
    autoTable(doc, {
      startY: y,
      head: [["Charge Type","Amount","Rate Reference"]],
      body: chargeRows,
      margin: { left:M, right:M },
      styles: { fontSize:8, cellPadding:2.5, textColor:C.dark },
      headStyles: { fillColor:C.navy, textColor:C.white, fontStyle:"bold", fontSize:8 },
      alternateRowStyles: { fillColor:C.bg },
      columnStyles: { 0:{cellWidth:80}, 1:{cellWidth:35, halign:"right", fontStyle:"bold"}, 2:{cellWidth:"auto"} },
    });
    y = doc.lastAutoTable.finalY + 6;

    checkPage(10);
    section("BUSINESS INCOME STATEMENT (ITR-3 / SCHEDULE BP)");
    const plRows = [
      ["Futures Realized P&L",               fmt(futPnlPDF)],
      ["Options Realized P&L",               fmt(optPnlPDF)],
      ["A. Total Gross P&L",                 fmt(grossPnl)],
      ["Less: Total Deductible Charges",     "(" + fmt(totalDeductible) + ")"],
      ["NET BUSINESS INCOME / (LOSS)",       fmt(netBizIncome)],
    ];
    plRows.forEach(([k,v],i) => {
      const isTotal = k.startsWith("NET");
      kvRow(k, v, isTotal?(netBizIncome>=0?C.green:C.red):C.dark, isTotal?[255,247,237]:(i%2===0?C.bg:C.white));
    });
    y += 4;

    checkPage(10);
    section("TAX COMPUTATION — " + (regime==="new"?"NEW":"OLD") + " TAX REGIME");
    const taxRows = [
      ["Salary / Pension",                   fmt(otherSalary||0)],
      ["F&O Business Income",                fmt(Math.max(0,netBizIncome))],
      ["Other Non-Salary Income (net)",      fmt(adjNonSalary)],
      ["Less: Prior Year F&O Losses",        priorSetOff>0?("(" + fmt(priorSetOff) + ")"):"₹0.00"],
      ["Gross Total Income",                 fmt(grossTotalInc)],
      [regime==="old"?"Less: Chapter VI-A Deductions":"VI-A Deductions (New Regime)", regime==="old"?("(" + fmt(Number(dedVIA)||0) + ")"):"Not applicable"],
      ["Taxable Income (" + (regime==="new"?"New":"Old") + " Regime)", fmt(regime==="new"?taxableNew:taxableOld)],
      ["Gross Tax",                          fmt(activeTax.gross)],
      ["Less: Rebate u/s 87A",               activeTax.rebate>0?("(" + fmt(activeTax.rebate) + ")"):"₹0.00"],
      ["Surcharge",                          fmt(activeTax.surcharge)],
      ["Health & Education Cess @4%",        fmt(activeTax.cess)],
      ["TOTAL TAX PAYABLE",                  fmt(activeTax.total)],
      ["Less: Advance Tax Paid",             fmt(advTaxPaid)],
      [balanceTax>0?"Balance Tax Payable":"Excess Tax (Refund)", balanceTax>0?fmt(balanceTax):fmt(refundAmt)],
    ];
    taxRows.forEach(([k,v],i) => {
      const isTot = k.startsWith("TOTAL") || k.startsWith("Balance") || k.startsWith("Excess");
      const col = k.startsWith("Excess")?C.green:k.startsWith("Balance")&&balanceTax>0?C.red:C.dark;
      kvRow(k, v, isTot?col:C.dark, isTot?[255,247,237]:(i%2===0?C.bg:C.white));
    });
    y += 4;

    checkPage(10);
    section("STOCK-WISE P&L SUMMARY");
    const stockTableBody = stockPnl.map(s => [
      s.stock, s.trades.length,
      s.futCount > 0 ? fmt(s.futPnl) : "—",
      s.optCount > 0 ? fmt(s.optPnl) : "—",
      fmt(s.pnl), fmt(s.turnover),
      s.pnl > 0 ? "Profit" : s.pnl < 0 ? "Loss" : "Even",
    ]);
    stockTableBody.push([
      "TOTAL (" + stockPnl.length + " stocks)", trades.length,
      fmt(trades.filter(t=>t.type==="FUT").reduce((s,t)=>s+t.grossPnl,0)),
      fmt(trades.filter(t=>t.type==="OPT").reduce((s,t)=>s+t.grossPnl,0)),
      fmt(grossPnl), fmt(TO.total), ""
    ]);
    autoTable(doc, {
      startY: y,
      head: [["Stock","Trades","Futures P&L","Options P&L","Net P&L","Turnover","Status"]],
      body: stockTableBody,
      margin: { left:M, right:M },
      styles: { fontSize:7.5, cellPadding:2 },
      headStyles: { fillColor:C.navy, textColor:C.white, fontStyle:"bold", fontSize:8 },
      alternateRowStyles: { fillColor:C.bg },
      columnStyles: {
        0:{fontStyle:"bold"}, 1:{halign:"center"},
        2:{halign:"right"}, 3:{halign:"right"},
        4:{halign:"right", fontStyle:"bold"}, 5:{halign:"right"}, 6:{halign:"center"},
      },
      didParseCell: (data) => {
        if (data.column.index === 4 && data.row.index < stockTableBody.length - 1) {
          const val = data.row.raw[4];
          if (val && val.startsWith("-")) data.cell.styles.textColor = C.red;
          else if (val && val !== "₹0.00") data.cell.styles.textColor = C.green;
        }
        if (data.row.index === stockTableBody.length - 1) {
          data.cell.styles.fillColor = C.dark;
          data.cell.styles.textColor = C.white;
          data.cell.styles.fontStyle = "bold";
        }
      },
    });
    y = doc.lastAutoTable.finalY + 6;

    checkPage(10);
    section("ITR-3 READY VALUES — KEY SCHEDULE FIELDS");
    const itrRows = [
      ["Part A-GEN: Business Code",              "0204 — Trading in Shares & Derivatives"],
      ["Part A-P&L: Turnover / Gross Receipts",  fmt(TO.total)],
      ["Part A-P&L: Net Profit / (Loss)",         fmt(netBizIncome)],
      ["Schedule BP Line 36: Non-Speculative",   fmt(Math.max(0,netBizIncome))],
      ["Schedule CYLA: F&O Loss Set-Off CY",     fnoLoss>0?fmt(cySetOff):"NIL"],
      ["Schedule CFL: Loss to Carry Forward",    lossToCarryFwd>0?fmt(lossToCarryFwd):"NIL"],
      ["Part B-TI: Gross Total Income",          fmt(grossTotalInc)],
      ["Part B-TTI: Total Tax Payable",          fmt(activeTax.total)],
      ["Part B-TTI: Balance Tax / Refund",       balanceTax>0?fmt(balanceTax):"Refund " + fmt(refundAmt)],
    ];
    itrRows.forEach(([k,v],i) => kvRow(k, v, C.dark, i%2===0?C.bg:C.white));
    y += 4;

    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      fillRect(0, 290, W, 8, C.dark);
      doc.setFontSize(7); doc.setFont("helvetica","normal"); setColor(C.lgray);
      doc.text("F&O Tax Calculator · ICAI Verified · For Reference Only · Always verify with a CA before filing ITR", M, 295);
      doc.text("Page " + i + " of " + pageCount, W - M, 295, { align:"right" });
    }

    const filename = "FnO_ITR3_" + (meta.name||"Trader").replace(/\s+/g,"_") + "_" + fyYear.replace(/\s/g,"") + ".pdf";
    doc.save(filename);
  }, [trades, charges, meta, periods, fileList, TO, grossPnl, netBizIncome, totalDeductible,
      addExpTotal, audit, regime, activeTax, otherSalary, adjNonSalary, priorSetOff,
      grossTotalInc, taxableNew, taxableOld, dedVIA, advTaxPaid, balanceTax, refundAmt,
      fnoLoss, cySetOff, lossToCarryFwd, stockPnl, dark, fyConf, fyYear,
      cgSummary, cgTrades, charges.stt, charges.brokerage, charges.exchCharges,
      charges.gst, charges.stampDuty, charges.sebi, charges.ipft]);

  // ════════════════════════════════════════════════════════════════════════
  // TAB PANELS
  // ════════════════════════════════════════════════════════════════════════

  // ── UPLOAD TAB ──────────────────────────────────────────────────────────
  const Upload = () => (
    <div style={S.sec}>
      <div
        style={{
          ...S.card, textAlign:"center", padding:"36px 40px",
          border: dragging ? "2px dashed " + S.purple : "2px dashed " + S.border,
          background: dragging ? (S.dark ? S.purple+"15" : S.purple+"08") : S.card,
        }}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <div style={{ fontSize:44, marginBottom:12 }}>📊</div>
        <div style={{ fontSize:18, fontWeight:700, color:S.txt, marginBottom:6 }}>
          {fileList.length > 0 ? "Add Another Groww F&O Report" : "Upload Groww F&O P&L Report"}
        </div>
        <div style={{ color:S.txt2, fontSize:13, marginBottom:6, lineHeight:1.7 }}>
          <strong>Groww App</strong> → Profile → Reports → <strong>F&O P&L</strong> → Select FY / Date Range → Download (.xlsx)
        </div>
        <div style={{ color:S.txt3, fontSize:11.5, marginBottom:20 }}>
          Upload multiple files (different quarters or years) — they merge automatically
        </div>
        <div style={{ display:"flex", gap:10, justifyContent:"center", flexWrap:"wrap" }}>
          <button style={S.btn("primary")} onClick={() => fileRef.current.click()}>
            ⬆ {fileList.length > 0 ? "Add More Files" : "Choose .xlsx File"}
          </button>
          {fileList.length > 0 && (
            <button
              style={{ ...S.btn("ghost"), border:"1px solid " + S.border, color:S.txt2 }}
              onClick={() => setTab("dashboard")}
            >
              → Go to Dashboard
            </button>
          )}
        </div>
        <input ref={fileRef} type="file" accept=".xlsx,.xls" multiple style={{ display:"none" }}
          onChange={e => Array.from(e.target.files).forEach(f => processFile(f))} />
        {dragging && <div style={{ marginTop:12, color:S.amber, fontWeight:700 }}>Drop files here…</div>}
        {parseError && <div style={{ ...S.info("#dc2626"), marginTop:14, textAlign:"left" }}>⚠ {parseError}</div>}
      </div>

      {fileList.length > 0 && (
        <div style={S.card}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14, flexWrap:"wrap", gap:8 }}>
            <div style={S.h2}>📂 Loaded Reports — {fileList.length} file{fileList.length>1?"s":""}</div>
            <div style={{ ...S.mono, fontSize:12, color:S.txt3 }}>
              {trades.length} trades merged · {fmt(TO.total)} total turnover
            </div>
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
            {fileList.map((f) => {
              const fPnl = f.trades.reduce((s,t) => s+t.grossPnl, 0);
              const fTO  = f.trades.reduce((s,t) => s+Math.abs(t.grossPnl), 0);
              const fFut = f.trades.filter(t=>t.type==="FUT").length;
              const fOpt = f.trades.filter(t=>t.type==="OPT").length;
              return (
                <div key={f.id} style={{
                  display:"flex", alignItems:"center", gap:12, padding:"12px 16px",
                  background:S.card2, borderRadius:10, border:"1px solid " + S.border,
                }}>
                  <div style={{ fontSize:22, flexShrink:0 }}>📄</div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{
                      fontWeight:700, fontSize:13, color:S.dark?"#f1f5f9":"#0f172a",
                      overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                    }}>
                      {f.meta?.name || f.filename}
                    </div>
                    <div style={{ fontSize:11, color:S.txt3, marginTop:2 }}>
                      {f.meta?.period || f.filename}
                    </div>
                  </div>
                  <div style={{ display:"flex", gap:14, fontSize:12, flexShrink:0, flexWrap:"wrap" }}>
                    <div style={{ textAlign:"center" }}>
                      <div style={{ fontWeight:700, color:S.cyan }}>{fFut}</div>
                      <div style={{ color:S.txt3, fontSize:10 }}>FUT</div>
                    </div>
                    <div style={{ textAlign:"center" }}>
                      <div style={{ fontWeight:700, color:S.purpleL }}>{fOpt}</div>
                      <div style={{ color:S.txt3, fontSize:10 }}>OPT</div>
                    </div>
                    <div style={{ textAlign:"center" }}>
                      <div style={{ ...S.mono, fontWeight:700, color:pc(fPnl) }}>{fmt(fPnl)}</div>
                      <div style={{ color:S.txt3, fontSize:10 }}>Net P&L</div>
                    </div>
                    <div style={{ textAlign:"center" }}>
                      <div style={{ ...S.mono, fontWeight:700, color:S.amber }}>{fmt(fTO)}</div>
                      <div style={{ color:S.txt3, fontSize:10 }}>Turnover</div>
                    </div>
                  </div>
                  <button
                    onClick={() => removeFile(f.id)}
                    title="Remove this file"
                    style={{
                      background:"#dc262618", border:"none", borderRadius:6, cursor:"pointer",
                      color:S.red, fontSize:13, padding:"5px 8px", flexShrink:0,
                    }}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
          {fileList.length > 1 && (
            <div style={{ ...S.info("#3b82f6"), marginTop:12 }}>
              ✓ {fileList.length} reports merged — {trades.length} trades combined across all periods
            </div>
          )}
        </div>
      )}

      <div style={S.card}>
        <div style={S.h2}>✅ Verified Groww File Format</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, fontSize:12.5 }}>
          {[
            ["Sheet Used",        "Trade Level (individual trade rows)"],
            ["Charges Source",    "Summary section in file (STT, Brokerage, GST, Exchange, Stamp Duty, SEBI, IPFT)"],
            ["Trade Type",        "Auto-detected from 'Futures' / 'Options' section headers"],
            ["Turnover Formula",  "Σ |Realized P&L| per trade — ICAI 8th Edition (Aug 2022)"],
            ["STT Rate (Futures)","0.02% on sell value (effective Oct 1, 2024)"],
            ["STT Rate (Options)","0.1% on option premium (effective Oct 1, 2024)"],
            ["Loss Set-Off",      "Against all income EXCEPT salary — Section 43(5)"],
            ["Loss Carry-Forward","Up to 8 years against business income — Section 72"],
          ].map(([k, v]) => (
            <div key={k} style={{
              background:S.card2, borderRadius:10, padding:"10px 14px",
              borderLeft:"3px solid " + S.purple,
            }}>
              <div style={{ fontWeight:700, color:S.dark?"#f1f5f9":"#0f172a", marginBottom:2 }}>{k}</div>
              <div style={{ color:S.txt2 }}>{v}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  // ── DASHBOARD TAB ────────────────────────────────────────────────────────
  const Dashboard = () => {
    const futPnl = trades.filter(t => t.type==="FUT").reduce((s,t) => s+t.grossPnl, 0);
    const optPnl = trades.filter(t => t.type==="OPT").reduce((s,t) => s+t.grossPnl, 0);
    const barData = stockPnl.slice(0, 12).map(s => ({ label:s.stock, val:s.pnl }));
    // Pre-compute bar chart max OUTSIDE JSX
    const barMaxAbs = Math.max(...barData.map(d => Math.abs(d.val)), 1);
    const invBarMax = 46.0 / barMaxAbs; // division here is pure JS, not in JSX
    const profitPct = TO.total > 0 ? ((netBizIncome / TO.total) * 100).toFixed(1) + "%" : "—";
    const profitOk  = TO.total > 0 && (netBizIncome / TO.total) >= 0.06;

    return (
      <div style={S.sec}>
        {/* Hero banner */}
        <div style={{
          ...S.glass,
          background: S.dark
            ? "linear-gradient(135deg, rgba(124,99,245,0.18) 0%, rgba(6,200,255,0.08) 100%)"
            : "linear-gradient(135deg, rgba(124,99,245,0.10) 0%, rgba(6,200,255,0.05) 100%)",
          padding:"28px 32px",
        }}>
          <div style={{
            position:"absolute", top:-40, right:-20, width:200, height:200, borderRadius:"50%",
            background: S.dark
              ? "radial-gradient(circle, rgba(124,99,245,0.25) 0%, transparent 70%)"
              : "radial-gradient(circle, rgba(124,99,245,0.12) 0%, transparent 70%)",
            filter:"blur(30px)", pointerEvents:"none",
          }} />
          <div style={{ position:"relative", display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:16 }}>
            <div>
              <div style={{ fontSize:11, fontWeight:700, color:S.purpleL, textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:6 }}>
                FnO Tax Calculator
              </div>
              <div style={{ fontSize:26, fontWeight:800, color:S.dark?"#E8EAFF":"#141627", letterSpacing:"-0.8px", marginBottom:4 }}>
                {meta.name || "Your Trading Summary"}
              </div>
              <div style={{ fontSize:12.5, color:S.txt2 }}>
                {meta.clientCode ? "Client: " + meta.clientCode + " · " : ""}
                {periods.length === 1 && meta.period ? meta.period : periods.length > 1 ? periods.length + " reports merged" : "Upload a Groww F&O report to begin"}
              </div>
            </div>
            <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"center" }}>
              <Badge color={S.cyan}>ITR-3</Badge>
              <Badge color={S.purpleL}>Non-Speculative</Badge>
              <span style={{ ...S.pill(!audit.req), fontSize:11.5, padding:"5px 14px" }}>
                {audit.req ? "⚠ Audit Required" : "✓ No Audit"}
              </span>
              <button
                onClick={generatePDF}
                style={{ ...S.btn("primary"), padding:"8px 18px", fontSize:12.5, display:"flex", alignItems:"center", gap:7 }}
              >
                ⬇ Export PDF
              </button>
            </div>
          </div>
        </div>

        {/* Top 4 KPI cards */}
        <div style={S.grid(4)}>
          <MC label="Total Trades"        val={String(trades.length)}       icon="📊" sub={TO.futCount + " Fut · " + TO.optCount + " Opt"}    color={S.cyan}   S={S} />
          <MC label="F&O Turnover"        val={fmt(TO.total)}                icon="🔢" sub="ICAI 8th Ed · Audit basis"                         color={S.purple} S={S} />
          <MC label="Gross P&L"           val={fmt(grossPnl)}                icon={grossPnl>=0?"📈":"📉"} sub="Futures + Options combined"      color={grossPnl>=0?S.green:S.red} S={S} />
          <MC label="Net Business Income" val={fmt(netBizIncome)}            icon="💼" sub="After all deductible charges"                       color={netBizIncome>=0?S.green:S.red} S={S} />
        </div>

        {/* Middle row: donut + bar chart + quick panels */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 2fr 1fr", gap:16 }}>
          {/* Donut / portfolio split */}
          <div style={S.glass}>
            <div style={S.h3}>Portfolio Split</div>
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:16 }}>
              <div style={{ position:"relative" }}>
                <DonutChart size={110} stroke={18} segments={[
                  { val:TO.futures||1, color:S.cyan },
                  { val:TO.options||1, color:S.purple },
                ]} />
                <div style={{
                  position:"absolute", inset:0,
                  display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
                }}>
                  <div style={{ fontSize:10, color:S.txt3, fontWeight:600 }}>TOTAL</div>
                  <div style={{ fontSize:13, fontWeight:800, color:S.txt, fontFamily:"'IBM Plex Mono',monospace" }}>{trades.length}</div>
                </div>
              </div>
              <div style={{ width:"100%", display:"flex", flexDirection:"column", gap:8 }}>
                {[
                  { label:"Futures", val:TO.futures, count:TO.futCount, col:S.cyan },
                  { label:"Options", val:TO.options, count:TO.optCount, col:S.purple },
                ].map(r => (
                  <div key={r.label} style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <div style={{ width:8, height:8, borderRadius:"50%", background:r.col, flexShrink:0 }} />
                    <div style={{ flex:1, fontSize:11.5, color:S.txt2 }}>{r.label}</div>
                    <div style={{ fontSize:11.5, fontWeight:700, color:r.col, fontFamily:"'IBM Plex Mono',monospace" }}>{fmt(r.val)}</div>
                    <div style={{ fontSize:10, color:S.txt3 }}>({r.count})</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Stock P&L bar chart */}
          <div style={S.glass}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
              <div style={S.h3}>Stock-wise P&L</div>
              <div style={{ fontSize:11, color:S.txt3 }}>Top {barData.length} stocks</div>
            </div>
            {barData.length > 0 ? (
              <div style={{ display:"flex", flexDirection:"column", gap:7 }}>
                {barData.map(d => {
                  // Pre-compute bar width — NO division inside JSX
                  const barW = Math.abs(d.val) * invBarMax;
                  const isPos = d.val >= 0;
                  return (
                    <div key={d.label} style={{ display:"flex", alignItems:"center", gap:10 }}>
                      <div style={{
                        width:68, fontSize:11.5, fontWeight:700, color:S.txt,
                        textAlign:"right", flexShrink:0,
                        overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                      }}>
                        {d.label}
                      </div>
                      <div style={{
                        flex:1, position:"relative", height:20,
                        background:S.dark?"rgba(255,255,255,0.04)":"rgba(99,102,241,0.06)",
                        borderRadius:5, overflow:"hidden",
                      }}>
                        <div style={{
                          position:"absolute", left:"50%", top:0, bottom:0, width:1,
                          background:S.dark?"rgba(255,255,255,0.07)":"rgba(99,102,241,0.12)", zIndex:1,
                        }} />
                        <div style={{
                          position:"absolute", top:2, bottom:2,
                          width:barW + "%",
                          ...(isPos ? { left:"50%" } : { right:"50%" }),
                          background: isPos
                            ? "linear-gradient(90deg," + S.green + "CC," + S.green + ")"
                            : "linear-gradient(270deg," + S.red + "CC," + S.red + ")",
                          borderRadius: isPos ? "0 3px 3px 0" : "3px 0 0 3px",
                        }} />
                      </div>
                      <div style={{
                        width:90, fontSize:11.5, fontWeight:700, color:pc(d.val),
                        textAlign:"right", flexShrink:0, fontFamily:"'IBM Plex Mono',monospace",
                      }}>
                        {fmt(d.val)}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ color:S.txt3, fontSize:12.5, textAlign:"center", padding:"20px 0" }}>No trades loaded</div>
            )}
          </div>

          {/* Quick tax + audit */}
          <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
            <div style={S.glass}>
              <div style={S.h3}>Quick Tax</div>
              {[
                { label:"New Regime", val:taxNew.total, col:S.cyan },
                { label:"Old Regime", val:taxOld.total, col:S.purpleL },
              ].map(r => (
                <div key={r.label} style={{ marginBottom:12 }}>
                  <div style={{ fontSize:10.5, color:S.txt3, marginBottom:3 }}>{r.label}</div>
                  <div style={{ fontSize:20, fontWeight:800, color:r.col, fontFamily:"'IBM Plex Mono',monospace", letterSpacing:"-0.5px" }}>
                    {fmt(r.val)}
                  </div>
                </div>
              ))}
              <div style={{ fontSize:11, color:S.txt3, paddingTop:8, borderTop:"1px solid " + S.border }}>
                Enter other income in Tax Calculator for exact figures
              </div>
            </div>
            <div style={{ ...S.glass, flex:1 }}>
              <div style={S.h3}>Audit Status</div>
              <div style={{
                display:"inline-flex", alignItems:"center", gap:6,
                padding:"7px 14px", borderRadius:20, fontSize:12, fontWeight:700, marginBottom:10,
                background: audit.req ? "rgba(255,77,106,0.14)" : "rgba(0,214,143,0.12)",
                color: audit.req ? S.red : S.green,
                border: "1px solid " + (audit.req ? S.red+"33" : S.green+"33"),
              }}>
                {audit.req ? "⚠ Audit Required" : "✓ No Audit"}
              </div>
              <div style={{ fontSize:11, color:S.txt3, lineHeight:1.6 }}>{audit.reason}</div>
            </div>
          </div>
        </div>

        {/* Sub-KPI row */}
        <div style={S.grid(3)}>
          <MC label="Futures Turnover" val={fmt(TO.futures)} icon="⚡" sub={TO.futCount + " contracts · Σ|P&L|"} color={S.cyan}   S={S} />
          <MC label="Options Turnover" val={fmt(TO.options)} icon="🎯" sub={TO.optCount + " contracts · Σ|P&L|"} color={S.purple} S={S} />
          <MC label="Total Deductible" val={fmt(totalDeductible)} icon="🏷" sub="STT + Brokerage + GST + all charges" color={S.amber} S={S} />
        </div>

        {/* Cross-check + audit controls */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
          <div style={S.card}>
            <div style={S.h2}>📋 Groww Summary Cross-Check</div>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Item</th>
                  <th style={S.th}>Groww</th>
                  <th style={S.th}>Calculated</th>
                  <th style={S.th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["Futures P&L",   futPnl,              futPnl],
                  ["Options P&L",   optPnl,              optPnl],
                  ["Total P&L",     grossPnl,            grossPnl],
                  ["Total Charges", chargesTotalFromFile, chargesTotalFromFile],
                ].map(([label, a, b], i) => (
                  <tr key={i} style={{ background:i%2===0?S.card:S.rowAlt }}>
                    <td style={S.td}>{label}</td>
                    <td style={{ ...S.td, ...S.mono, color:pc(a) }}>{fmt(a)}</td>
                    <td style={{ ...S.td, ...S.mono, color:pc(b) }}>{fmt(b)}</td>
                    <td style={S.td}><span style={S.pill(Math.abs(a-b)<0.01)}>✓ Match</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={S.card}>
            <div style={S.h2}>⚙ Section 44AB — Audit Controls</div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginBottom:14 }}>
              {[
                ["Turnover",  fmt(TO.total), TO.total <= 1000000000],
                ["Profit %",  profitPct,     profitOk],
                ["Threshold", "₹10 Cr",      true],
              ].map(([l,v,ok]) => (
                <div key={l} style={{ background:S.card2, borderRadius:10, padding:"12px 14px" }}>
                  <div style={{ fontSize:10.5, color:S.txt3, marginBottom:4 }}>{l}</div>
                  <div style={{ fontWeight:800, fontSize:13, color:S.txt, ...S.mono }}>{v}</div>
                  <div style={{ marginTop:5 }}><span style={{ ...S.pill(ok), fontSize:10 }}>{ok ? "✓ OK" : "✗ Flag"}</span></div>
                </div>
              ))}
            </div>
            <label style={{ display:"flex", alignItems:"center", gap:10, cursor:"pointer", padding:"10px 0" }}>
              <input
                type="checkbox" checked={prev44AD}
                onChange={e => setPrev44AD(e.target.checked)}
                style={{ width:15, height:15, accentColor:S.purple, cursor:"pointer" }}
              />
              <span style={{ fontSize:12.5, color:S.txt }}>Previously opted <strong>Section 44AD</strong> in last 5 years</span>
            </label>
            <div style={{ ...S.info(prev44AD?"#f97316":"#3b82f6"), fontSize:11.5, marginTop:4 }}>
              {prev44AD
                ? "⚠ 44AD history: 6% profit rule applies (Section 44AB(e))"
                : "✓ No 44AD history — audit only if turnover exceeds ₹10 Crore"}
            </div>
          </div>
        </div>
      </div>
    );
  };

  // ── TURNOVER TAB ─────────────────────────────────────────────────────────
  const Turnover = () => (
    <div style={S.sec}>
      <div style={S.card}>
        <div style={S.h2}>🔢 Turnover Calculation Method (ICAI 8th Edition, Aug 2022)</div>
        <div style={{
          background:S.card2, borderRadius:8, padding:"12px 16px",
          fontFamily:"'IBM Plex Mono',monospace", fontSize:12.5, color:S.txt2, marginBottom:16,
        }}>
          Futures Turnover = Σ |Realized P&L| for each futures trade<br/>
          Options Turnover = Σ |Realized P&L| for each options trade<br/>
          Total Turnover   = Futures Turnover + Options Turnover<br/>
          <br/>
          ✔ Premium NOT added separately (ICAI Aug 2022 clarification — already in net P&L)
        </div>
        <div style={S.grid(3)}>
          <MC label="Futures Turnover" val={fmt(TO.futures)} sub={TO.futCount + " trades"} color="#0ea5e9" S={S} />
          <MC label="Options Turnover" val={fmt(TO.options)} sub={TO.optCount + " trades"} color="#8b5cf6" S={S} />
          <MC label="Total Turnover"   val={fmt(TO.total)}   sub="Audit determination"    color={S.purple} S={S} />
        </div>
      </div>

      {TO.futCount > 0 && (
        <div style={S.card}>
          <div style={S.h2}>📈 Futures Trades — Turnover Breakdown</div>
          <div style={{ overflowX:"auto" }}>
            <table style={S.table}>
              <thead>
                <tr>
                  {["#","Scrip","Buy Date","Buy ₹","Sell Date","Sell ₹","Qty","Realized P&L","Turnover |P&L|"].map(h => (
                    <th key={h} style={S.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trades.filter(t => t.type==="FUT").map((t,i) => (
                  <tr key={t.id} style={{ background:i%2===0?S.card:S.rowAlt }}>
                    <td style={S.td}>{i+1}</td>
                    <td style={{ ...S.td, fontWeight:600 }}>{t.symbol}</td>
                    <td style={S.td}>{t.buyDate}</td>
                    <td style={{ ...S.td, ...S.mono }}>{fmt(t.buyPrice)}</td>
                    <td style={S.td}>{t.sellDate}</td>
                    <td style={{ ...S.td, ...S.mono }}>{fmt(t.sellPrice)}</td>
                    <td style={{ ...S.td, ...S.mono }}>{fmtN(t.qty)}</td>
                    <td style={{ ...S.td, ...S.mono, fontWeight:700, color:pc(t.grossPnl) }}>{fmt(t.grossPnl)}</td>
                    <td style={{ ...S.td, ...S.mono, fontWeight:700, color:S.cyan }}>{fmt(Math.abs(t.grossPnl))}</td>
                  </tr>
                ))}
                <tr style={{ background:"#e0f2fe" }}>
                  <td colSpan={7} style={{ ...S.td, fontWeight:700 }}>Futures Total</td>
                  <td style={{ ...S.td, ...S.mono, fontWeight:800, color:pc(trades.filter(t=>t.type==="FUT").reduce((s,t)=>s+t.grossPnl,0)) }}>
                    {fmt(trades.filter(t=>t.type==="FUT").reduce((s,t)=>s+t.grossPnl,0))}
                  </td>
                  <td style={{ ...S.td, ...S.mono, fontWeight:800, color:S.cyan }}>{fmt(TO.futures)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {TO.optCount > 0 && (
        <div style={S.card}>
          <div style={S.h2}>📉 Options Trades — Turnover Breakdown</div>
          <div style={{ overflowX:"auto" }}>
            <table style={S.table}>
              <thead>
                <tr>
                  {["#","Scrip","Type","Buy Date","Buy ₹","Sell Date","Sell ₹","Qty","Realized P&L","Turnover |P&L|"].map(h => (
                    <th key={h} style={S.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trades.filter(t => t.type==="OPT").map((t,i) => (
                  <tr key={t.id} style={{ background:i%2===0?S.card:S.rowAlt }}>
                    <td style={S.td}>{i+1}</td>
                    <td style={{ ...S.td, fontWeight:600, fontSize:11 }}>{t.symbol}</td>
                    <td style={S.td}>
                      <span style={{
                        padding:"2px 8px", borderRadius:4, fontSize:10.5, fontWeight:700,
                        background:t.optType==="CE"?"#d1fae5":"#fce7f3",
                        color:t.optType==="CE"?"#065f46":"#9d174d",
                      }}>
                        {t.optType || "OPT"}
                      </span>
                    </td>
                    <td style={S.td}>{t.buyDate}</td>
                    <td style={{ ...S.td, ...S.mono }}>{fmt(t.buyPrice)}</td>
                    <td style={S.td}>{t.sellDate}</td>
                    <td style={{ ...S.td, ...S.mono }}>{fmt(t.sellPrice)}</td>
                    <td style={{ ...S.td, ...S.mono }}>{fmtN(t.qty)}</td>
                    <td style={{ ...S.td, ...S.mono, fontWeight:700, color:pc(t.grossPnl) }}>{fmt(t.grossPnl)}</td>
                    <td style={{ ...S.td, ...S.mono, fontWeight:700, color:S.purpleL }}>{fmt(Math.abs(t.grossPnl))}</td>
                  </tr>
                ))}
                <tr style={{ background:S.dark?"rgba(124,99,245,0.10)":"#ede9fe" }}>
                  <td colSpan={8} style={{ ...S.td, fontWeight:700 }}>Options Total</td>
                  <td style={{ ...S.td, ...S.mono, fontWeight:800, color:pc(trades.filter(t=>t.type==="OPT").reduce((s,t)=>s+t.grossPnl,0)) }}>
                    {fmt(trades.filter(t=>t.type==="OPT").reduce((s,t)=>s+t.grossPnl,0))}
                  </td>
                  <td style={{ ...S.td, ...S.mono, fontWeight:800, color:S.purpleL }}>{fmt(TO.options)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );

  // ── P&L TAB ───────────────────────────────────────────────────────────────
  const PnL = () => (
    <div style={S.sec}>
      <div style={S.card}>
        <div style={S.h2}>💰 Business Income Statement (ITR-3 / Schedule BP)</div>
        <table style={S.table}>
          <tbody>
            {[
              { label:"Futures Realized P&L (Net)",   val:trades.filter(t=>t.type==="FUT").reduce((s,t)=>s+t.grossPnl,0), indent:0 },
              { label:"Options Realized P&L (Net)",   val:trades.filter(t=>t.type==="OPT").reduce((s,t)=>s+t.grossPnl,0), indent:0 },
              { label:"A. Total Gross P&L",           val:grossPnl, bold:true, border:true },
              { label:"Less: Deductible Charges (from Groww summary)", val:null, header:true },
              { label:"Securities Transaction Tax (STT)",              val:-(charges.stt||0), indent:1 },
              { label:"Brokerage",                                     val:-(charges.brokerage||0), indent:1 },
              { label:"Exchange Transaction Charges",                  val:-(charges.exchCharges||0), indent:1 },
              { label:"Total GST",                                     val:-(charges.gst||0), indent:1 },
              { label:"Stamp Duty",                                    val:-(charges.stampDuty||0), indent:1 },
              { label:"SEBI Turnover Charges",                         val:-(charges.sebi||0), indent:1 },
              { label:"IPFT Charges",                                  val:-(charges.ipft||0), indent:1 },
              { label:"B. Total Charges from Groww",                  val:-chargesTotalFromFile, bold:true },
              { label:"Less: Additional Expenses (manual)", val:null, header:true },
              { label:"Internet / Phone (business use %)",  val:-(Number(addExp.internet)||0), indent:1 },
              { label:"Trading Software / Platform Fees",  val:-(Number(addExp.software)||0), indent:1 },
              { label:"Advisory / Research Services",       val:-(Number(addExp.advisory)||0), indent:1 },
              { label:"Depreciation (Laptop/PC @ 40% WDV)", val:-(Number(addExp.depreciation)||0), indent:1 },
              { label:"Office Rent (dedicated trading space)", val:-(Number(addExp.officeRent)||0), indent:1 },
              { label:"Other Business Expenses",            val:-(Number(addExp.other)||0), indent:1 },
              { label:"C. Total Additional Expenses",       val:-addExpTotal, bold:true },
              { label:"Net Business Income / (Loss)  [A + B + C]", val:netBizIncome, bold:true, highlight:true, border:true },
            ].map((r, i) => r.header ? (
              <tr key={i}>
                <td colSpan={2} style={{
                  ...S.td, fontWeight:700, color:S.txt2, background:S.card2,
                  fontSize:11, textTransform:"uppercase", letterSpacing:"0.05em",
                }}>
                  {r.label}
                </td>
              </tr>
            ) : (
              <tr key={i} style={{ background:r.highlight?pcBg(netBizIncome,S.dark):i%2===0?S.card:S.rowAlt }}>
                <td style={{
                  ...S.td, paddingLeft:r.indent?30:12,
                  fontWeight:r.bold?700:400,
                  borderTop:r.border?"2px solid " + S.border:undefined,
                  fontSize:r.highlight?14:12.5,
                }}>
                  {r.label}
                </td>
                {r.val !== null && r.val !== undefined && (
                  <td style={{
                    ...S.td, textAlign:"right", ...S.mono,
                    fontWeight:r.bold?800:500,
                    color:r.highlight?pc(r.val):r.val<0?S.red:S.green,
                    fontSize:r.highlight?15:12.5,
                    borderTop:r.border?"2px solid " + S.border:undefined,
                  }}>
                    {r.val < 0 ? "(" + fmt(Math.abs(r.val)) + ")" : fmt(r.val)}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={S.card}>
        <div style={S.h2}>➕ Additional Deductible Expenses (Section 36)</div>
        <div style={{ fontSize:12, color:S.txt2, marginBottom:14 }}>
          All genuine business expenses are 100% deductible. Cash payments &gt; ₹10,000 in a single day are disallowed (Sec 40A).
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12 }}>
          {[
            ["internet","🌐 Internet / Phone (Business %)"],
            ["software","💻 Trading Software / Platform Fees"],
            ["advisory","📞 Advisory / Research Services"],
            ["depreciation","🖥 Depreciation (Laptop/PC @ 40% WDV)"],
            ["officeRent","🏠 Office Rent (Dedicated Trading Space)"],
            ["other","📋 Other Business Expenses"],
          ].map(([key, label]) => (
            <div key={key}>
              <div style={{ fontSize:12, fontWeight:600, color:S.txt2, marginBottom:5 }}>{label}</div>
              <input
                style={S.inp} type="number" placeholder="0" min="0"
                value={addExp[key]||""}
                onChange={e => setAddExp({ ...addExp, [key]: Number(e.target.value)||0 })}
              />
            </div>
          ))}
        </div>
      </div>

      <div style={S.card}>
        <div style={S.h2}>🏷 Charges — Included vs Excluded in Turnover</div>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>Charge (from Groww file)</th>
              <th style={S.th}>Amount</th>
              <th style={S.th}>In Turnover?</th>
              <th style={S.th}>Deductible from Income?</th>
              <th style={S.th}>Rate Reference</th>
            </tr>
          </thead>
          <tbody>
            {[
              { name:"STT",                        val:charges.stt,         ded:true, rate:"Futures 0.02% / Options 0.1% on premium" },
              { name:"Brokerage",                  val:charges.brokerage,   ded:true, rate:"₹20/order (Groww flat rate)" },
              { name:"Exchange Transaction Charges",val:charges.exchCharges, ded:true, rate:"~0.00188% of value" },
              { name:"Total GST",                  val:charges.gst,         ded:true, rate:"18% of brokerage + exchange charges" },
              { name:"Stamp Duty",                 val:charges.stampDuty,   ded:true, rate:"0.002% on buy value" },
              { name:"SEBI Turnover Charges",      val:charges.sebi,        ded:true, rate:"₹10 per crore of turnover" },
              { name:"IPFT Charges",               val:charges.ipft,        ded:true, rate:"₹1 per crore (Investor Protection Fund)" },
            ].map((r, i) => (
              <tr key={i} style={{ background:i%2===0?S.card:S.rowAlt }}>
                <td style={S.td}>{r.name}</td>
                <td style={{ ...S.td, ...S.mono, fontWeight:600 }}>{r.val ? fmt(r.val) : "₹0.00"}</td>
                <td style={S.td}><span style={S.pill(false)}>✗ No</span></td>
                <td style={S.td}><span style={S.pill(r.ded)}>✓ Yes</span></td>
                <td style={{ ...S.td, fontSize:11, color:S.txt2 }}>{r.rate}</td>
              </tr>
            ))}
            <tr style={{ background:S.dark?"rgba(251,146,60,0.12)":"#fef3c7" }}>
              <td style={{ ...S.td, fontWeight:700 }}>Total Charges (Groww)</td>
              <td style={{ ...S.td, ...S.mono, fontWeight:800 }}>{fmt(chargesTotalFromFile)}</td>
              <td colSpan={3} style={{ ...S.td, color:S.dark?"#FDBA74":"#92400e", fontSize:12 }}>
                All charges from Groww report summary — 100% deductible as business expenses
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );

  // ── TAX CALCULATOR TAB ────────────────────────────────────────────────────
  const TaxCalc = () => (
    <div style={S.sec}>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
        <div style={S.card}>
          <div style={S.h3}>Other Income Sources</div>
          {[
            ["salary","👔 Salary / Pension","Cannot be set-off against F&O loss"],
            ["houseProperty","🏠 Net House Property Income","After standard deduction of 30%"],
            ["capitalGains","📈 Capital Gains (STCG + LTCG)","Enter net amount"],
            ["otherSrc","💼 Other Sources (Interest, Dividends)",""],
          ].map(([key, label, note]) => (
            <div key={key} style={{ marginBottom:12 }}>
              <div style={{ fontSize:12, fontWeight:600, color:S.txt2, marginBottom:3 }}>{label}</div>
              {note && <div style={{ fontSize:11, color:S.txt3, marginBottom:3 }}>{note}</div>}
              <input
                style={S.inp} type="number" placeholder="0" min="0"
                value={otherInc[key]||""}
                onChange={e => setOtherInc({ ...otherInc, [key]: Number(e.target.value)||0 })}
              />
            </div>
          ))}
        </div>
        <div style={S.card}>
          <div style={S.h3}>Tax Regime &amp; Profile</div>
          <div style={{ marginBottom:14 }}>
            <div style={{ fontSize:12, fontWeight:600, color:S.txt2, marginBottom:8 }}>Tax Regime</div>
            <div style={{ display:"flex", gap:8 }}>
              {[["new","New Regime (Default)"],["old","Old Regime"]].map(([v,l]) => (
                <button
                  key={v}
                  style={{ ...S.btn(regime===v?"primary":"ghost"), border:"1px solid " + S.border, padding:"7px 14px" }}
                  onClick={() => setRegime(v)}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
          <div style={{ marginBottom:14 }}>
            <div style={{ fontSize:12, fontWeight:600, color:S.txt2, marginBottom:6 }}>Age Group</div>
            <select
              style={{ ...S.inp, background:S.dark?"#0f172a":"#fff", color:S.txt }}
              value={ageGroup}
              onChange={e => setAgeGroup(e.target.value)}
            >
              <option value="below60">Below 60 years</option>
              <option value="senior">Senior Citizen (60–80 years)</option>
              <option value="superSenior">Super Senior (80+ years)</option>
            </select>
          </div>
          {regime === "old" && (
            <div style={{ marginBottom:14 }}>
              <div style={{ fontSize:12, fontWeight:600, color:S.txt2, marginBottom:3 }}>
                Chapter VI-A Deductions (80C + 80D + 80CCD etc.)
              </div>
              <input
                style={S.inp} type="number" placeholder="Max 80C: ₹1,50,000" min="0"
                value={dedVIA||""}
                onChange={e => setDedVIA(Number(e.target.value)||0)}
              />
            </div>
          )}
          <div style={S.info("#f97316")}>
            💡 Old regime: file Form 10IEA before due date to opt in. Once opted out, cannot re-enter.
          </div>
        </div>
      </div>

      <div style={S.card}>
        <div style={S.h2}>📊 Income Computation — All Heads</div>
        <table style={S.table}>
          <tbody>
            {[
              { label:"Salary / Pension",                                 val:otherSalary },
              { label:"F&O Business Income / (Loss) — Non-Speculative",  val:netBizIncome },
              { label:"Less: CY F&O Loss Set-Off (vs non-salary income)", val:netBizIncome<0?-cySetOff:0 },
              { label:"Net House Property (after set-off)",               val:Math.max(0,(Number(otherInc.houseProperty)||0)-cySetOff) },
              { label:"Capital Gains",                                    val:Number(otherInc.capitalGains)||0 },
              { label:"Other Sources",                                    val:Number(otherInc.otherSrc)||0 },
              { label:"Less: Brought-Forward F&O Losses (prior years)",  val:-priorSetOff },
              { label:"Gross Total Income",                              val:grossTotalInc, bold:true, border:true },
              { label:"Less: Chapter VI-A Deductions (Old Regime)",      val:regime==="old"?-(Number(dedVIA)||0):0, dim:regime==="new" },
              { label:"Taxable Income — " + (regime==="new"?"New":"Old") + " Regime", val:regime==="new"?taxableNew:taxableOld, bold:true, highlight:true },
            ].map((r, i) => (
              <tr key={i} style={{
                background:r.highlight?(S.dark?"rgba(249,115,22,0.12)":"#fff7ed"):i%2===0?S.card:S.rowAlt,
              }}>
                <td style={{
                  ...S.td, fontWeight:r.bold?700:400,
                  borderTop:r.border?"2px solid " + S.border:undefined,
                  color:r.dim?S.txt3:S.txt,
                  fontSize:r.highlight?14:12.5,
                  paddingLeft:r.val!==undefined&&r.val<0?24:12,
                }}>
                  {r.label}
                </td>
                <td style={{
                  ...S.td, textAlign:"right", ...S.mono,
                  fontWeight:r.bold?800:500,
                  color:r.highlight?"#f97316":r.val<0?S.red:S.txt,
                  fontSize:r.highlight?15:12.5,
                  borderTop:r.border?"2px solid " + S.border:undefined,
                }}>
                  {r.val === undefined ? "" : r.val<0?"("+fmt(Math.abs(r.val))+")":fmt(r.val)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
        {[["New Regime 🔵", taxNew, "#3b82f6", regime==="new"],["Old Regime 🟣", taxOld, "#8b5cf6", regime==="old"]].map(([title, tax, col, selected]) => (
          <div key={title} style={{ ...S.card, border:"2px solid " + (selected?col:S.border) }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
              <div style={{ fontWeight:700, fontSize:14 }}>{title}</div>
              {selected && <Badge color={col}>SELECTED</Badge>}
            </div>
            <table style={S.table}>
              <tbody>
                {tax.slabs.map((s, i) => (
                  <tr key={i}>
                    <td style={S.td}>{s.label}</td>
                    <td style={{ ...S.td, ...S.mono, textAlign:"right" }}>{fmt(s.tax)}</td>
                  </tr>
                ))}
                <tr><td style={S.td}>Gross Tax</td><td style={{ ...S.td, ...S.mono, textAlign:"right" }}>{fmt(tax.gross)}</td></tr>
                {tax.rebate > 0 && (
                  <tr>
                    <td style={{ ...S.td, color:S.green }}>Rebate u/s 87A</td>
                    <td style={{ ...S.td, ...S.mono, textAlign:"right", color:S.green }}>({fmt(tax.rebate)})</td>
                  </tr>
                )}
                {tax.surcharge > 0 && (
                  <tr>
                    <td style={S.td}>Surcharge</td>
                    <td style={{ ...S.td, ...S.mono, textAlign:"right" }}>{fmt(tax.surcharge)}</td>
                  </tr>
                )}
                <tr>
                  <td style={S.td}>Health &amp; Education Cess @4%</td>
                  <td style={{ ...S.td, ...S.mono, textAlign:"right" }}>{fmt(tax.cess)}</td>
                </tr>
                <tr style={{ background:col+"11" }}>
                  <td style={{ ...S.td, fontWeight:800, fontSize:14 }}>Total Tax Payable</td>
                  <td style={{ ...S.td, ...S.mono, fontWeight:800, fontSize:16, textAlign:"right", color:col }}>{fmt(tax.total)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );

  // ── ADVANCE TAX TAB ───────────────────────────────────────────────────────
  const AdvanceTax = () => {
    const fyNum = fyYear.slice(3,7);
    const nextFyNum = String(parseInt(fyNum) + 1);
    const quarters = [
      { q:"q1", label:"Q1", due:"15 Jun " + fyNum,    pct:15, cum:15,  months:3 },
      { q:"q2", label:"Q2", due:"15 Sep " + fyNum,    pct:30, cum:45,  months:3 },
      { q:"q3", label:"Q3", due:"15 Dec " + fyNum,    pct:30, cum:75,  months:3 },
      { q:"q4", label:"Q4", due:"15 Mar " + nextFyNum, pct:25, cum:100, months:1 },
    ];

    const totalLiability = activeTax.total;
    // All computations in pure JS (no division inside JSX {})
    const q1Due = totalLiability * 0.15;
    const q2Due = totalLiability * 0.45;
    const q3Due = totalLiability * 0.75;
    const q4Due = totalLiability;

    const p1 = Number(advTax.q1)||0;
    const p2 = Number(advTax.q2)||0;
    const p3 = Number(advTax.q3)||0;
    const p4 = Number(advTax.q4)||0;

    const s1 = Math.max(0, q1Due - p1);
    const s2 = Math.max(0, q2Due - (p1+p2));
    const s3 = Math.max(0, q3Due - (p1+p2+p3));
    const s4 = Math.max(0, q4Due - (p1+p2+p3+p4));

    const int234C_q1 = s1 * 0.01 * 3;
    const int234C_q2 = s2 * 0.01 * 3;
    const int234C_q3 = s3 * 0.01 * 3;
    const int234C_q4 = s4 * 0.01 * 1;
    const total234C  = int234C_q1 + int234C_q2 + int234C_q3 + int234C_q4;

    const paid90 = (p1+p2+p3+p4) >= totalLiability * 0.90;
    const shortfall234B = paid90 ? 0 : Math.max(0, totalLiability * 0.90 - (p1+p2+p3+p4));
    const months234B = 3;
    const int234B = shortfall234B * 0.01 * months234B;

    const totalInterest = total234C + int234B;
    const grandTotal    = totalLiability - (p1+p2+p3+p4) + totalInterest;

    const cumPaidArr = [p1, p1+p2, p1+p2+p3, p1+p2+p3+p4];

    return (
      <div style={S.sec}>
        <div style={S.info("#3b82f6")}>
          Advance tax mandatory if total liability &gt; ₹10,000 (Section 208).
          Shortfall at each quarter attracts <strong>1% per month</strong> simple interest — Section 234B (non-payment) &amp; 234C (deferment).
        </div>

        <div style={S.card}>
          <div style={S.h2}>📅 Quarterly Installments — Enter What You Actually Paid</div>
          <div style={S.grid(4)}>
            {quarters.map((qt, qi) => {
              const cumDue  = totalLiability * qt.cum * 0.01;
              const cumPaid = cumPaidArr[qi];
              const ok = cumPaid >= cumDue - 0.5;
              const shortByAmt = Math.max(0, cumDue - cumPaid);
              const pctVal = totalLiability * qt.pct * 0.01;
              return (
                <div key={qt.q} style={S.mc(ok?S.green:S.amber)}>
                  <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
                    <div style={{ fontWeight:800, fontSize:14, color:ok?S.green:S.amber }}>{qt.label} ({qt.pct}%)</div>
                    <div style={{ fontSize:10.5, color:S.txt3 }}>Due: {qt.due}</div>
                  </div>
                  <div style={{ fontSize:11, color:S.txt3, marginBottom:2 }}>Should have paid</div>
                  <div style={{ ...S.mono, fontWeight:800, fontSize:16, color:S.dark?"#f1f5f9":"#0f172a", marginBottom:8 }}>
                    {fmt(pctVal)}
                  </div>
                  <div style={{ fontSize:11.5, color:S.txt2, marginBottom:4 }}>Cumul. due: {fmt(cumDue)}</div>
                  <div style={{ fontSize:11.5, color:S.txt2, marginBottom:4 }}>You paid (₹)</div>
                  <input
                    style={S.inp} type="number" placeholder="0" min="0"
                    value={advTax[qt.q]||""}
                    onChange={e => setAdvTax({ ...advTax, [qt.q]: Number(e.target.value)||0 })}
                  />
                  {!ok && totalLiability > 10000 && (
                    <div style={{ marginTop:6, fontSize:10.5, color:S.amber, fontWeight:600 }}>
                      ⚠ Short by {fmt(shortByAmt)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {totalLiability > 10000 && (
          <div style={S.card}>
            <div style={S.h2}>📐 Interest Calculation (Section 234B &amp; 234C)</div>
            <table style={S.table}>
              <thead>
                <tr>
                  {["Section","Description","Shortfall","Rate","Months","Interest"].map(h => (
                    <th key={h} style={S.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  { sec:"234C Q1", desc:"Jun 15 installment shortfall", short:s1, mo:3, int:int234C_q1 },
                  { sec:"234C Q2", desc:"Sep 15 installment shortfall", short:s2, mo:3, int:int234C_q2 },
                  { sec:"234C Q3", desc:"Dec 15 installment shortfall", short:s3, mo:3, int:int234C_q3 },
                  { sec:"234C Q4", desc:"Mar 15 installment shortfall", short:s4, mo:1, int:int234C_q4 },
                  { sec:"234B",    desc:"Non-payment of 90% by Mar 31", short:shortfall234B, mo:months234B, int:int234B },
                ].map((r,i) => (
                  <tr key={i} style={{ background:r.int>0?(S.dark?"rgba(249,115,22,0.12)":"#fff7ed"):i%2===0?S.card:S.rowAlt }}>
                    <td style={{ ...S.td, fontWeight:700, color:S.amber }}>{r.sec}</td>
                    <td style={S.td}>{r.desc}</td>
                    <td style={{ ...S.td, ...S.mono, color:r.short>0?S.red:S.txt2 }}>{r.short>0?fmt(r.short):"—"}</td>
                    <td style={{ ...S.td, color:S.txt2 }}>1%/mo</td>
                    <td style={{ ...S.td, textAlign:"center" }}>{r.mo}</td>
                    <td style={{ ...S.td, ...S.mono, fontWeight:700, color:r.int>0?S.red:S.green }}>
                      {r.int > 0 ? fmt(r.int) : "₹0 — No interest"}
                    </td>
                  </tr>
                ))}
                <tr style={{ background:S.dark?"rgba(249,115,22,0.15)":"#fff3e0" }}>
                  <td colSpan={5} style={{ ...S.td, fontWeight:800 }}>Total Interest (234B + 234C)</td>
                  <td style={{ ...S.td, ...S.mono, fontWeight:800, fontSize:15, color:totalInterest>0?S.red:S.green }}>
                    {totalInterest > 0 ? fmt(totalInterest) : "₹0 — No interest due"}
                  </td>
                </tr>
              </tbody>
            </table>
            {!paid90 && (
              <div style={{ ...S.info("#dc2626"), marginTop:12 }}>
                ⚠ You paid less than 90% of tax liability by Mar 31 — Section 234B applies.
                Interest estimated at {months234B} months. Actual depends on exact payment date.
              </div>
            )}
            {totalInterest === 0 && (
              <div style={{ ...S.info("#16a34a"), marginTop:12 }}>
                ✓ No interest due — all installments paid on time and 90% of liability covered.
              </div>
            )}
          </div>
        )}

        <div style={S.card}>
          <div style={S.h2}>💳 Complete Payment Summary</div>
          <table style={S.table}>
            <tbody>
              {[
                { label:"Total Tax Liability",                    val:totalLiability },
                { label:"Total Advance Tax Paid (Q1+Q2+Q3+Q4)",  val:advTaxPaid },
                { label:"Section 234C Interest (Deferment)",     val:total234C,     warn:total234C>0 },
                { label:"Section 234B Interest (Non-payment)",   val:int234B,       warn:int234B>0 },
                { label:"Total Interest",                        val:totalInterest, warn:totalInterest>0 },
                { label:"Balance Self-Assessment Tax + Interest", val:Math.max(0,grandTotal), bold:true, red:grandTotal>0 },
                { label:"Refund (if any)",                       val:Math.max(0,-grandTotal), bold:true, green:grandTotal<0 },
              ].map((r,i) => r.val===0&&!r.bold ? null : (
                <tr key={i} style={{
                  background:r.bold?(S.dark?"rgba(124,99,245,0.10)":"#f8faff"):r.warn?(S.dark?"rgba(249,115,22,0.10)":"#fff7ed"):i%2===0?S.card:S.rowAlt,
                }}>
                  <td style={{ ...S.td, fontWeight:r.bold?700:400 }}>{r.label}</td>
                  <td style={{
                    ...S.td, ...S.mono, textAlign:"right",
                    fontWeight:r.bold?800:500, fontSize:r.bold?15:13,
                    color:r.green?S.green:r.red?S.red:r.warn?S.amber:S.txt,
                  }}>
                    {fmt(r.val)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {totalLiability < 10000 && (
            <div style={{ ...S.info("#16a34a"), marginTop:12 }}>
              ✓ Tax liability below ₹10,000 — advance tax not mandatory (Section 208). No interest applicable.
            </div>
          )}
        </div>
      </div>
    );
  };

  // ── LOSSES TAB ────────────────────────────────────────────────────────────
  const Losses = () => {
    const currentAY = fyConf.ay;
    const currentFY = fyConf.label;

    const addEntry = () => {
      if (!newLedgerEntry.ay || !newLedgerEntry.loss) return;
      const entry = {
        id: Date.now(), ay: newLedgerEntry.ay, fy: newLedgerEntry.fy||"",
        loss: Number(newLedgerEntry.loss)||0, usedAmount: 0,
        source: newLedgerEntry.source||"Manual Entry",
        notes: newLedgerEntry.notes||"", expired: false,
        addedOn: new Date().toLocaleDateString("en-IN"),
      };
      updateLedger([...lossLedger, entry]);
      setNewLedgerEntry({ ay:"", fy:"", loss:"", source:"Manual Entry", notes:"" });
    };

    const addCurrentYear = () => {
      if (lossToCarryFwd <= 0) return;
      const existing = lossLedger.find(e => e.ay === currentAY);
      if (existing) {
        updateLedger(lossLedger.map(e => e.ay === currentAY
          ? { ...e, loss: lossToCarryFwd, source: "F&O Report (Auto)", fy: currentFY }
          : e));
      } else {
        updateLedger([...lossLedger, {
          id: Date.now(), ay: currentAY, fy: currentFY,
          loss: lossToCarryFwd, usedAmount: 0, source: "F&O Report (Auto)", notes:"",
          expired: false, addedOn: new Date().toLocaleDateString("en-IN"),
        }]);
      }
    };

    const deleteEntry = (id) => updateLedger(lossLedger.filter(e => e.id !== id));

    const saveEdit = () => {
      updateLedger(lossLedger.map(e => e.id === editLedgerId ? { ...e, ...editLedgerRow } : e));
      setEditLedgerId(null); setEditLedgerRow({});
    };

    const exportLedger = () => {
      const blob = new Blob([JSON.stringify(lossLedger, null, 2)], { type:"application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url;
      a.download = "fno_loss_ledger.json"; a.click(); URL.revokeObjectURL(url);
    };

    const importLedger = (e) => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try { const data = JSON.parse(ev.target.result); updateLedger(data); }
        catch { alert("Invalid ledger JSON file."); }
      };
      reader.readAsText(file);
      e.target.value = "";
    };

    const expireOld = () => {
      const updated = lossLedger.map(e => {
        const ayNum = parseInt(String(e.ay||"").replace(/\D/g,"").slice(0,4));
        return ayNum && ayNum < 2017 ? { ...e, expired: true } : e;
      });
      updateLedger(updated);
    };

    const activeLosses   = lossLedger.filter(e => !e.expired && e.ay !== currentAY);
    const availableTotal = activeLosses.reduce((s,e) => s + Math.max(0,(Number(e.loss)||0)-(Number(e.usedAmount)||0)), 0);
    const currentEntry   = lossLedger.find(e => e.ay === currentAY);

    return (
      <div style={S.sec}>
        <div style={S.card}>
          <div style={S.h2}>📉 Current Year Loss Set-Off (Schedule CYLA)</div>
          {netBizIncome >= 0 ? (
            <div style={S.info("#16a34a")}>
              ✓ F&O is profitable this year. Net Income: <strong>{fmt(netBizIncome)}</strong> — No loss to set off.
            </div>
          ) : (
            <>
              <div style={S.info("#f97316")}>
                F&O Loss: <strong>{fmt(Math.abs(netBizIncome))}</strong> · Can be set off against all income EXCEPT salary (Section 43(5) + Section 71)
              </div>
              <table style={{ ...S.table, marginTop:14 }}>
                <thead>
                  <tr>
                    <th style={S.th}>Income Head</th>
                    <th style={S.th}>Amount</th>
                    <th style={S.th}>Set-Off Allowed?</th>
                    <th style={S.th}>Set-Off Applied</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { head:"Salary / Pension",      val:otherSalary,                       can:false },
                    { head:"House Property Income", val:Number(otherInc.houseProperty)||0, can:true },
                    { head:"Capital Gains",         val:Number(otherInc.capitalGains)||0,  can:true },
                    { head:"Other Sources",         val:Number(otherInc.otherSrc)||0,      can:true },
                  ].map((r,i) => (
                    <tr key={i} style={{ background:i%2===0?S.card:S.rowAlt }}>
                      <td style={S.td}>{r.head}</td>
                      <td style={{ ...S.td,...S.mono }}>{fmt(r.val)}</td>
                      <td style={S.td}><span style={S.pill(r.can)}>{r.can?"✓ Yes":"✗ No"}</span></td>
                      <td style={{ ...S.td,...S.mono, color:S.red, fontWeight:600 }}>
                        {r.can ? "(" + fmt(Math.min(r.val,fnoLoss)) + ")" : "-"}
                      </td>
                    </tr>
                  ))}
                  <tr style={{ background:S.dark?"rgba(255,77,106,0.12)":"#fee2e2" }}>
                    <td colSpan={3} style={{ ...S.td, fontWeight:700 }}>Loss to Carry Forward → Ledger (Schedule CFL)</td>
                    <td style={{ ...S.td,...S.mono, fontWeight:800, color:S.red, fontSize:14 }}>
                      ({fmt(lossToCarryFwd)})
                    </td>
                  </tr>
                </tbody>
              </table>
              {lossToCarryFwd > 0 && (
                <div style={{ marginTop:12, display:"flex", gap:10, alignItems:"center", flexWrap:"wrap" }}>
                  <button
                    onClick={addCurrentYear}
                    style={{ ...S.btn("primary"), padding:"8px 16px", fontSize:12.5, display:"flex", alignItems:"center", gap:6 }}
                  >
                    ➕ {currentEntry ? "Update" : "Add"} {fmt(lossToCarryFwd)} to Loss Ledger ({currentAY})
                  </button>
                  {currentEntry && (
                    <span style={{ ...S.info("#16a34a"), padding:"6px 12px" }}>
                      ✓ Already in ledger: {fmt(currentEntry.loss)}
                    </span>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div style={S.card}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14, flexWrap:"wrap", gap:10 }}>
            <div style={S.h2}>📚 Carry-Forward Loss Ledger (Persistent — Section 72)</div>
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={exportLedger} style={{ ...S.btn("ghost"), border:"1px solid " + S.border, color:S.txt2, fontSize:11.5, padding:"6px 12px" }}>
                ⬇ Export JSON
              </button>
              <button onClick={() => fileImportRef.current.click()} style={{ ...S.btn("ghost"), border:"1px solid " + S.border, color:S.txt2, fontSize:11.5, padding:"6px 12px" }}>
                ⬆ Import JSON
              </button>
              <button onClick={expireOld} style={{ ...S.btn("ghost"), border:"1px solid " + S.border, color:S.txt3, fontSize:11.5, padding:"6px 12px" }}>
                🗑 Mark Expired
              </button>
              <input ref={fileImportRef} type="file" accept=".json" style={{ display:"none" }} onChange={importLedger} />
            </div>
          </div>

          <div style={{ ...S.grid(4), marginBottom:16 }}>
            {[
              { label:"Total Entries",          val:String(lossLedger.length),   color:"#3b82f6" },
              { label:"Active Losses",           val:String(activeLosses.length), color:S.amber },
              { label:"Total Available (Prior)", val:fmt(availableTotal),         color:S.red },
              { label:"Used This Year",          val:fmt(priorSetOff),            color:S.green },
            ].map((m,i) => (
              <div key={i} style={S.mc(m.color)}>
                <div style={S.mLabel}>{m.label}</div>
                <div style={{ ...S.mVal(m.color), fontSize:17 }}>{m.val}</div>
              </div>
            ))}
          </div>

          <div style={{ background:S.card2, borderRadius:10, padding:"14px 16px", marginBottom:16, border:"1px solid " + S.border }}>
            <div style={{ fontSize:12, fontWeight:700, color:S.txt2, marginBottom:12, textTransform:"uppercase", letterSpacing:"0.05em" }}>
              ➕ Add Entry Manually
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr 1.5fr auto", gap:10, alignItems:"end" }}>
              {[
                { key:"ay",     label:"Assessment Year",  ph:"e.g. AY 2023-24" },
                { key:"fy",     label:"Financial Year",   ph:"e.g. FY 2022-23" },
                { key:"loss",   label:"Loss Amount (₹)",  ph:"e.g. 50000",     type:"number" },
                { key:"source", label:"Source",           ph:"e.g. Groww" },
                { key:"notes",  label:"Notes (optional)", ph:"e.g. NIFTY options" },
              ].map(({key,label,ph,type}) => (
                <div key={key}>
                  <div style={{ fontSize:11, color:S.txt3, marginBottom:4 }}>{label}</div>
                  <input
                    style={S.inp} placeholder={ph} type={type||"text"}
                    value={newLedgerEntry[key]||""}
                    onChange={e => setNewLedgerEntry({ ...newLedgerEntry, [key]: e.target.value })}
                  />
                </div>
              ))}
              <button onClick={addEntry} style={{ ...S.btn("primary"), padding:"8px 14px", fontSize:12.5 }}>
                Add
              </button>
            </div>
          </div>

          {lossLedger.length === 0 ? (
            <div style={{ ...S.info("#3b82f6"), textAlign:"center" }}>
              No entries yet. Add prior-year losses manually or click "Add to Loss Ledger" after filing.
            </div>
          ) : (
            <div style={{ overflowX:"auto" }}>
              <table style={S.table}>
                <thead>
                  <tr>
                    {["AY","FY","Loss (₹)","Used (₹)","Available","Source","Notes","Added On","Status",""].map(h => (
                      <th key={h} style={S.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {lossLedger.map((e,i) => {
                    const available = Math.max(0,(Number(e.loss)||0)-(Number(e.usedAmount)||0));
                    const isCurrent = e.ay === currentAY;
                    const isEditing = editLedgerId === e.id;
                    return (
                      <tr key={e.id} style={{
                        background: e.expired ? (S.dark?"#162032":"#f1f5f9") :
                                    isCurrent ? (S.dark?"rgba(0,214,143,0.08)":"#f0fdf4") :
                                    i%2===0?S.card:S.rowAlt,
                        opacity: e.expired ? 0.5 : 1,
                      }}>
                        <td style={{ ...S.td, fontWeight:700 }}>
                          {isCurrent ? (
                            <span style={{ background:S.purpleGrad, color:"#fff", padding:"2px 8px", borderRadius:4, fontSize:11 }}>
                              ● {e.ay}
                            </span>
                          ) : e.ay}
                        </td>
                        <td style={{ ...S.td,...S.mono, fontSize:11 }}>{e.fy||"—"}</td>
                        <td style={{ ...S.td,...S.mono, fontWeight:700, color:S.red }}>{fmt(Number(e.loss)||0)}</td>
                        <td style={{ ...S.td,...S.mono }}>
                          {isEditing ? (
                            <input
                              style={{ ...S.inp, width:90 }} type="number" min="0"
                              value={editLedgerRow.usedAmount??e.usedAmount}
                              onChange={ev => setEditLedgerRow({...editLedgerRow, usedAmount:Number(ev.target.value)||0})}
                            />
                          ) : fmt(Number(e.usedAmount)||0)}
                        </td>
                        <td style={{ ...S.td,...S.mono, fontWeight:700, color:available>0?S.amber:S.green }}>
                          {available > 0 ? fmt(available) : <span style={{ color:S.green }}>✓ Fully Used</span>}
                        </td>
                        <td style={{ ...S.td, fontSize:11 }}>{e.source}</td>
                        <td style={{ ...S.td, fontSize:11, color:S.txt3 }}>{e.notes||"—"}</td>
                        <td style={{ ...S.td, fontSize:10, color:S.txt3 }}>{e.addedOn||"—"}</td>
                        <td style={S.td}>
                          {e.expired
                            ? <span style={S.pill(false)}>Expired</span>
                            : isCurrent
                            ? <span style={{ background:S.dark?"#2d1800":"#fff7ed", color:S.amber, padding:"2px 8px", borderRadius:4, fontSize:10, fontWeight:700 }}>Current</span>
                            : available > 0
                            ? <span style={S.pill(true)}>Active</span>
                            : <span style={{ background:S.dark?"rgba(0,214,143,0.12)":"#f0fdf4", color:S.green, padding:"2px 8px", borderRadius:4, fontSize:10, fontWeight:700 }}>Used</span>}
                        </td>
                        <td style={{ ...S.td, whiteSpace:"nowrap" }}>
                          {isEditing ? (
                            <div style={{ display:"flex", gap:4 }}>
                              <button onClick={saveEdit} style={{ ...S.btn("primary"), fontSize:11, padding:"3px 8px" }}>Save</button>
                              <button onClick={() => setEditLedgerId(null)} style={{ ...S.btn("ghost"), fontSize:11, padding:"3px 8px", border:"1px solid " + S.border, color:S.txt2 }}>✕</button>
                            </div>
                          ) : (
                            <div style={{ display:"flex", gap:4 }}>
                              <button
                                onClick={() => { setEditLedgerId(e.id); setEditLedgerRow({usedAmount:e.usedAmount}); }}
                                style={{ background:"#3b82f620", border:"none", borderRadius:5, cursor:"pointer", color:"#3b82f6", fontSize:12, padding:"3px 7px" }}
                              >
                                ✏
                              </button>
                              <button
                                onClick={() => deleteEntry(e.id)}
                                style={{ background:"#dc262620", border:"none", borderRadius:5, cursor:"pointer", color:S.red, fontSize:12, padding:"3px 7px" }}
                              >
                                ✕
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ ...S.info("#3b82f6"), marginTop:12 }}>
            💾 Ledger is saved automatically in your browser's localStorage. Use <strong>Export JSON</strong> to back it up
            and <strong>Import JSON</strong> to restore. File ITR-3 before due date to preserve carry-forward rights (Section 80 read with 139(1)).
          </div>
        </div>

        {priorTotal > 0 && (
          <div style={S.card}>
            <div style={S.h2}>📊 Brought-Forward Loss Application This Year (Schedule BFLA)</div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12, marginBottom:14 }}>
              {[
                { label:"Total Prior Losses Available", val:fmt(priorTotal),  color:S.red },
                { label:"Applied This Year (set-off)",  val:fmt(priorSetOff), color:S.green },
                { label:"Remaining After This Year",    val:fmt(Math.max(0,priorTotal-priorSetOff)), color:S.amber },
              ].map((m,i) => (
                <div key={i} style={S.mc(m.color)}>
                  <div style={S.mLabel}>{m.label}</div>
                  <div style={{ ...S.mVal(m.color), fontSize:17 }}>{m.val}</div>
                </div>
              ))}
            </div>
            <div style={S.info("#f97316")}>
              {fmt(priorSetOff)} of prior losses applied against this year's income.
              Remaining {fmt(Math.max(0,priorTotal-priorSetOff))} to carry forward further.
            </div>
          </div>
        )}
      </div>
    );
  };

  // ── ITR-3 VALUES TAB ──────────────────────────────────────────────────────
  const ITR3 = () => (
    <div style={S.sec}>
      <div style={{ ...S.card, background:S.dark?"#0F1123":"#1A1D3B", color:"#E8EAFF" }}>
        <div style={{ fontSize:16, fontWeight:800, marginBottom:3 }}>📋 ITR-3 Ready Values — {fyConf.label} / {fyConf.ay}</div>
        <div style={{ color:S.txt3, fontSize:12.5 }}>Copy these exact values into incometax.gov.in e-filing portal · Due: {fyConf.filing}</div>
      </div>

      {[
        { title:"Part A-GEN (General Information)", rows:[
          ["Business Activity Code",    "0204 — Trading in Shares & Derivatives"],
          ["Nature of Business",        "Non-Speculative Business (F&O Trading)"],
          ["Tax Audit Required?",       audit.req ? "Yes — Section 44AB" : "No"],
          ["Books of Accounts",         "Yes — maintained under Section 44AA"],
          ["ITR Filing Due Date",       audit.req ? fyConf.auditFiling : fyConf.filing],
        ]},
        { title:"Part A-P&L (Trading / Profit & Loss Account)", rows:[
          ["Turnover / Gross Receipts from F&O", fmt(TO.total)],
          ["Total Buy Value",            fmt(trades.reduce((s,t)=>s+(t.buyValue||0),0))],
          ["Total Sell Value",           fmt(trades.reduce((s,t)=>s+(t.sellValue||0),0))],
          ["Gross Profit (Net Realized P&L)", fmt(grossPnl)],
          ["STT",                        fmt(charges.stt||0)],
          ["Brokerage",                  fmt(charges.brokerage||0)],
          ["Exchange Transaction Charges", fmt(charges.exchCharges||0)],
          ["Total GST on charges",       fmt(charges.gst||0)],
          ["Stamp Duty",                 fmt(charges.stampDuty||0)],
          ["SEBI Turnover Charges",      fmt(charges.sebi||0)],
          ["IPFT Charges",               fmt(charges.ipft||0)],
          ["Additional Business Expenses", fmt(addExpTotal)],
          ["Net Profit / (Loss)",        fmt(netBizIncome)],
        ]},
        { title:"Schedule BP — Line Items", rows:[
          ["Line 1: Net profit from P&L as per books",        fmt(netBizIncome)],
          ["Line 36: Non-Speculative Business Income",        fmt(Math.max(0, netBizIncome))],
          ["Line 42: Speculative Business Income (Intraday)", "₹0.00 (no intraday)"],
          ["Line 53 (No Accounts): Gross Receipts",           fmt(TO.total)],
        ]},
        { title:"Schedule CYLA (Current Year Loss Adjustment)", rows:[
          ["F&O Loss (Non-Speculative)",       fmt(fnoLoss)],
          ["Set-Off against House Property",   fmt(Math.min(Number(otherInc.houseProperty)||0, fnoLoss))],
          ["Set-Off against Other Sources",    fmt(Math.min(Number(otherInc.otherSrc)||0, fnoLoss))],
          ["Net Loss After Current Year Set-Off", fmt(lossToCarryFwd)],
        ]},
        { title:"Schedule CFL (Carry Forward Losses)", rows:[
          ["Non-Speculative Loss to CFL (" + fyConf.ay + ")", fmt(lossToCarryFwd)],
          ["CFL Period",                       "Up to AY 2033-34 (8 years)"],
          ["Eligible Set-Off",                 "Against Non-Speculative Business Income only"],
        ]},
        { title:"Part B-TI → Part B-TTI (Tax Computation)", rows:[
          ["F&O Business Income",              fmt(Math.max(0, netBizIncome))],
          ["Salary Income",                    fmt(otherSalary)],
          ["Gross Total Income",               fmt(grossTotalInc)],
          ["Taxable Income (" + (regime==="new"?"New":"Old") + " Regime)", fmt(regime==="new"?taxableNew:taxableOld)],
          ["Gross Tax",                        fmt(activeTax.gross)],
          ["Rebate u/s 87A",                   fmt(activeTax.rebate)],
          ["Surcharge",                        fmt(activeTax.surcharge)],
          ["Health & Education Cess @4%",      fmt(activeTax.cess)],
          ["Total Tax Liability",              fmt(activeTax.total)],
          ["Less: Advance Tax Paid",           fmt(advTaxPaid)],
          ["Balance Tax / (Refund)",           fmt(balanceTax > 0 ? balanceTax : -refundAmt)],
        ]},
      ].map(({ title, rows }) => (
        <div key={title} style={S.card}>
          <div style={S.h2}>📌 {title}</div>
          <table style={S.table}>
            <tbody>
              {rows.map(([label, val], i) => (
                <tr key={i} style={{ background:i%2===0?S.card:S.card2 }}>
                  <td style={{ ...S.td, color:S.txt2, width:"60%" }}>{label}</td>
                  <td style={{ ...S.td, ...S.mono, fontWeight:700, color:S.dark?"#f1f5f9":"#0f172a" }}>{val}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <div style={{ textAlign:"center" }}>
        <button
          onClick={generatePDF}
          style={{ ...S.btn("primary"), padding:"12px 28px", fontSize:14, display:"inline-flex", alignItems:"center", gap:8 }}
        >
          ⬇ Download ITR-3 Summary PDF
        </button>
        <div style={{ color:S.txt3, fontSize:11.5, marginTop:8 }}>
          Includes: Turnover · P&L · Charges · Tax computation · Stock P&L · ITR-3 schedule values
        </div>
      </div>
      <div style={S.info("#dc2626")}>
        ⚠ <strong>Disclaimer:</strong> These values are computed from ICAI guidelines and CBDT ITR-3 form.
        Always verify with a Chartered Accountant before filing. Tax laws are subject to change — verify with incometaxindia.gov.in.
      </div>
    </div>
  );

  // ── STOCK P&L TAB ────────────────────────────────────────────────────────
  const StockPnL = () => {
    // Pre-compute bar scale OUTSIDE JSX — NO division inside JSX
    const maxAbsStk = Math.max(...stockPnl.map(s => Math.abs(s.pnl)), 1);
    const barScaleStk = 46.0 / maxAbsStk;

    return (
      <div style={S.sec}>
        <div style={{ ...S.card, background:S.dark?"#0F1123":"#1A1D3B", color:"#E8EAFF" }}>
          <div style={{ fontSize:15, fontWeight:800, marginBottom:4 }}>📈 Stock-wise P&L — All F&O Trades Per Underlying</div>
          <div style={{ color:S.txt3, fontSize:12.5, lineHeight:1.7 }}>
            Net P&L per stock = all Futures + Options trades on that underlying summed together.
            Turnover per stock = Σ |Realized P&L| per trade (ICAI 8th Ed, Aug 2022). Click any row to see individual trades.
          </div>
        </div>

        <div style={S.grid(5)}>
          {[
            { label:"Stocks Traded", val:String(stockPnl.length), color:"#3b82f6" },
            { label:"Profitable",    val:String(winners),          color:S.green },
            { label:"Loss-Making",   val:String(losers),           color:S.red },
            { label:"Best Stock",    val:maxWin.stock,             color:S.green, sub:fmt(maxWin.pnl) },
            { label:"Worst Stock",   val:maxLoss.stock,            color:S.red,   sub:fmt(maxLoss.pnl) },
          ].map((m,i) => (
            <div key={i} style={S.mc(m.color)}>
              <div style={S.mLabel}>{m.label}</div>
              <div style={{ ...S.mVal(m.color), fontSize:18 }}>{m.val}</div>
              {m.sub && <div style={{ ...S.mSub, ...S.mono }}>{m.sub}</div>}
            </div>
          ))}
        </div>

        <div style={S.card}>
          <div style={S.h2}>📊 P&L Bar Chart — Best to Worst</div>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {stockPnl.map(s => {
              // All computation outside JSX {}
              const barW = Math.abs(s.pnl) * barScaleStk;
              const isP  = s.pnl >= 0;
              return (
                <div key={s.stock} style={{ display:"flex", alignItems:"center", gap:10 }}>
                  <div style={{
                    width:90, fontWeight:700, fontSize:12.5,
                    color:S.dark?"#f1f5f9":"#0f172a",
                    textAlign:"right", flexShrink:0,
                  }}>
                    {s.stock}
                  </div>
                  <div style={{
                    flex:1, position:"relative", height:24,
                    background:S.dark?"rgba(255,255,255,0.06)":"rgba(99,102,241,0.08)",
                    borderRadius:6, overflow:"hidden",
                  }}>
                    <div style={{
                      position:"absolute", left:"50%", top:0, bottom:0, width:1,
                      background:S.dark?"rgba(255,255,255,0.08)":"rgba(99,102,241,0.12)", zIndex:1,
                    }} />
                    <div style={{
                      position:"absolute", top:2, bottom:2,
                      width:barW + "%",
                      ...(isP ? { left:"50%" } : { right:"50%" }),
                      background: isP ? S.green : S.red,
                      borderRadius: isP ? "0 3px 3px 0" : "3px 0 0 3px",
                      transition:"width .3s",
                    }} />
                  </div>
                  <div style={{
                    width:108, ...S.mono, fontWeight:700, fontSize:12.5,
                    color:pc(s.pnl), textAlign:"right", flexShrink:0,
                  }}>
                    {fmt(s.pnl)}
                  </div>
                </div>
              );
            })}
            <div style={{ display:"flex", alignItems:"center", gap:10, marginTop:2 }}>
              <div style={{ width:90 }} />
              <div style={{ flex:1, display:"flex", justifyContent:"center" }}>
                <span style={{ fontSize:10, color:S.txt3 }}>◄ Loss &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Profit ►</span>
              </div>
              <div style={{ width:108 }} />
            </div>
          </div>
        </div>

        <div style={S.card}>
          <div style={S.h2}>🗂 Stock-Wise Detail — Click to Expand Individual Trades</div>
          <div style={{ overflowX:"auto" }}>
            <table style={S.table}>
              <thead>
                <tr>
                  {["Stock","FUT","OPT","Trades","Futures P&L","Options P&L","Net P&L","Turnover","Status"].map(h => (
                    <th key={h} style={S.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stockPnl.map((s,si) => (
                  <Fragment key={s.stock}>
                    <tr
                      onClick={() => setExpandedStock(expandedStock===s.stock ? null : s.stock)}
                      style={{
                        background:expandedStock===s.stock?(S.dark?"rgba(0,214,143,0.07)":"#f0fdf4"):si%2===0?S.card:S.rowAlt,
                        cursor:"pointer",
                      }}
                    >
                      <td style={{ ...S.td, fontWeight:800, fontSize:13 }}>
                        <span style={{ marginRight:7, color:S.txt3, fontSize:10 }}>{expandedStock===s.stock?"▼":"▶"}</span>
                        {s.stock}
                      </td>
                      <td style={{ ...S.td, textAlign:"center" }}>
                        {s.futCount>0 ? (
                          <span style={{ background:S.dark?"rgba(96,165,250,0.18)":"#dbeafe", color:S.purpleL, padding:"2px 8px", borderRadius:4, fontSize:11, fontWeight:700 }}>
                            {s.futCount}
                          </span>
                        ) : <span style={{ color:S.txt3 }}>—</span>}
                      </td>
                      <td style={{ ...S.td, textAlign:"center" }}>
                        {s.optCount>0 ? (
                          <span style={{ background:S.dark?"rgba(124,99,245,0.18)":"#ede9fe", color:S.purple, padding:"2px 8px", borderRadius:4, fontSize:11, fontWeight:700 }}>
                            {s.optCount}
                          </span>
                        ) : <span style={{ color:S.txt3 }}>—</span>}
                      </td>
                      <td style={{ ...S.td, textAlign:"center", fontWeight:600 }}>{s.trades.length}</td>
                      <td style={{ ...S.td, ...S.mono, fontWeight:600, color:pc(s.futPnl) }}>{s.futCount>0?fmt(s.futPnl):"—"}</td>
                      <td style={{ ...S.td, ...S.mono, fontWeight:600, color:pc(s.optPnl) }}>{s.optCount>0?fmt(s.optPnl):"—"}</td>
                      <td style={{ ...S.td, ...S.mono, fontWeight:800, fontSize:14, color:pc(s.pnl) }}>{fmt(s.pnl)}</td>
                      <td style={{ ...S.td, ...S.mono, color:S.txt2 }}>{fmt(s.turnover)}</td>
                      <td style={S.td}>
                        <span style={S.pill(s.pnl>0)}>{s.pnl>0?"▲ Profit":s.pnl<0?"▼ Loss":"● Even"}</span>
                      </td>
                    </tr>
                    {expandedStock===s.stock && (
                      <tr>
                        <td colSpan={9} style={{ padding:0, background:S.card2, border:"none" }}>
                          <div style={{ padding:"12px 16px 12px 34px" }}>
                            <div style={{ fontSize:11, fontWeight:700, color:S.txt2, marginBottom:8, textTransform:"uppercase", letterSpacing:"0.05em" }}>
                              {s.stock} — {s.trades.length} trades
                            </div>
                            <table style={{ ...S.table, fontSize:12 }}>
                              <thead>
                                <tr>
                                  {["#","Scrip","Type","Buy Date","Buy ₹","Qty","Sell Date","Sell ₹","Realized P&L","Turnover"].map(h => (
                                    <th key={h} style={{ ...S.th, background:S.dark?"rgba(255,255,255,0.04)":S.card2, fontSize:10 }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {s.trades.map((t,ti) => (
                                  <tr key={t.id} style={{ background:ti%2===0?S.card:S.rowAlt }}>
                                    <td style={{ ...S.td, color:S.txt3 }}>{ti+1}</td>
                                    <td style={{ ...S.td, fontWeight:600, fontSize:11 }}>{t.symbol}</td>
                                    <td style={S.td}>
                                      {t.type==="FUT" ? (
                                        <span style={{ background:S.dark?"rgba(96,165,250,0.18)":"#dbeafe", color:S.purpleL, padding:"2px 6px", borderRadius:4, fontSize:10, fontWeight:700 }}>FUT</span>
                                      ) : (
                                        <span style={{ background:t.optType==="CE"?(S.green+"18"):(S.red+"18"), color:t.optType==="CE"?S.green:S.red, padding:"2px 6px", borderRadius:4, fontSize:10, fontWeight:700 }}>
                                          {t.optType||"OPT"}
                                        </span>
                                      )}
                                    </td>
                                    <td style={S.td}>{t.buyDate}</td>
                                    <td style={{ ...S.td, ...S.mono }}>{fmt(t.buyPrice)}</td>
                                    <td style={{ ...S.td, ...S.mono }}>{fmtN(t.qty)}</td>
                                    <td style={S.td}>{t.sellDate}</td>
                                    <td style={{ ...S.td, ...S.mono }}>{fmt(t.sellPrice)}</td>
                                    <td style={{ ...S.td, ...S.mono, fontWeight:700, color:pc(t.grossPnl) }}>{fmt(t.grossPnl)}</td>
                                    <td style={{ ...S.td, ...S.mono, color:S.txt2 }}>{fmt(Math.abs(t.grossPnl))}</td>
                                  </tr>
                                ))}
                                <tr style={{ background:pcBg(s.pnl, S.dark) }}>
                                  <td colSpan={8} style={{ ...S.td, fontWeight:800 }}>{s.stock} Total</td>
                                  <td style={{ ...S.td, ...S.mono, fontWeight:800, fontSize:14, color:pc(s.pnl) }}>{fmt(s.pnl)}</td>
                                  <td style={{ ...S.td, ...S.mono, fontWeight:700, color:S.txt2 }}>{fmt(s.turnover)}</td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
                <tr style={{ background:S.dark?"#0F1123":"#1A1D3B" }}>
                  <td style={{ ...S.td, color:"#fff", fontWeight:800, fontSize:14 }} colSpan={6}>
                    GRAND TOTAL — {stockPnl.length} stocks · {trades.length} trades
                  </td>
                  <td style={{ ...S.td, ...S.mono, fontWeight:800, fontSize:16, color:grossPnl>=0?S.green:S.red }}>{fmt(grossPnl)}</td>
                  <td style={{ ...S.td, ...S.mono, fontWeight:800, fontSize:14, color:S.amber }}>{fmt(TO.total)}</td>
                  <td style={S.td} />
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div style={S.card}>
          <div style={S.h2}>✅ Turnover Verification — ICAI Official Source</div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, fontSize:12.5 }}>
            {[
              ["Authority","ICAI Guidance Note on Tax Audit u/s 44AB — 8th Edition, Para 5.10(b)/5.14(b), dated 19 Aug 2022"],
              ["Futures Rule","Σ |favourable/unfavourable differences| per squared-off futures trade"],
              ["Options Rule","Same as futures — Σ |P&L| per squared-off trade (NOT adding premium separately)"],
              ["Premium Clarification","Premium on options sale already in net P&L → do NOT add again (ICAI Aug 19, 2022)"],
              ["Open Positions","Counted when trade is actually squared off — not at year end (ICAI 2023 update)"],
              ["Reverse Trades","Difference on reverse trades also part of turnover"],
              ["Audit Limit","₹10 Crore for F&O (100% digital transactions — enhanced limit per Sec 44AB proviso)"],
              ["Your Turnover", fmt(TO.total) + " — verified match against Groww summary ✓"],
            ].map(([k,v]) => (
              <div key={k} style={{ background:S.card2, borderRadius:8, padding:"10px 14px", borderLeft:"3px solid " + S.purple }}>
                <div style={{ fontWeight:700, color:S.dark?"#f1f5f9":"#0f172a", marginBottom:2 }}>{k}</div>
                <div style={{ color:S.txt2, fontSize:12 }}>{v}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  // ── AIS RECONCILIATION TAB ────────────────────────────────────────────────
  const AISRecon = () => {
    const ais = aisData;
    const A = (k) => Number(ais[k]||0);

    const appTO     = TO.total;
    const appGross  = grossPnl;
    const appChg    = totalDeductible;
    const appNet    = netBizIncome;

    const aisFutTO  = A("futTurnover");
    const aisOptTO  = A("optTurnover");
    const aisTotalTO= aisFutTO + aisOptTO;
    const aisGross  = A("grossPnl");
    const aisChg    = A("totalCharges");
    const aisNet    = aisGross - aisChg;

    const diff = (a, b) => Math.abs(a - b);
    const OK   = 0.5;

    const rows = [
      { label:"Futures Turnover",     app:TO.futures,    ais:aisFutTO,   key:"futTurnover" },
      { label:"Options Turnover",     app:TO.options,    ais:aisOptTO,   key:"optTurnover" },
      { label:"Total F&O Turnover",   app:appTO,         ais:aisTotalTO, key:null },
      { label:"Gross Trade P&L",      app:appGross,      ais:aisGross,   key:"grossPnl" },
      { label:"Total Charges",        app:appChg,        ais:aisChg,     key:"totalCharges" },
      { label:"Net Business Income",  app:appNet,        ais:aisNet,     key:null },
    ];

    const allMatch = rows.filter(r=>r.ais!==0).every(r => diff(r.app,r.ais) <= OK);
    const hasAIS   = Object.values(ais).some(v => v !== "" && v !== 0 && v !== "0");

    const save = () => { setAisChecked(true); };
    const clear = () => { setAisData({ futTurnover:"",optTurnover:"",grossPnlAIS:"",totalChargesAIS:"",notes:"" }); setAisChecked(false); };

    return (
      <div style={S.sec}>
        <div style={{ ...S.card, background:S.dark?"#0F1123":"#1A1D3B", color:"#E8EAFF" }}>
          <div style={{ fontSize:15, fontWeight:800, marginBottom:4 }}>🔍 AIS / Form 26AS Reconciliation</div>
          <div style={{ color:S.txt2, fontSize:12.5, lineHeight:1.7 }}>
            Cross-check your Groww P&L figures against your Annual Information Statement (AIS) and Form 26AS
            from the Income Tax portal. Mismatches are the #1 cause of IT scrutiny notices for F&O traders.
            Download AIS from: <strong>incometax.gov.in → AIS</strong>
          </div>
        </div>

        <div style={S.card}>
          <div style={S.h2}>📋 How to Get Your AIS / 26AS Values</div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, fontSize:12.5 }}>
            {[
              ["Step 1 — Login", "Go to incometax.gov.in → Login with PAN + OTP"],
              ["Step 2 — AIS",   "Services → Annual Information Statement (AIS) → View AIS"],
              ["Step 3 — Filter","Select FY → Look for Section: Securities Transaction"],
              ["Step 4 — Values","Note down: Turnover, Proceeds, Gains/Losses as shown in AIS"],
              ["26AS Alternative","Services → View Form 26AS → Part F (SFT) for large transactions"],
              ["Broker TIS",     "Transaction Information Summary may also show F&O data from NSE/BSE"],
            ].map(([k,v]) => (
              <div key={k} style={{ background:S.card2, borderRadius:10, padding:"10px 14px", borderLeft:"3px solid " + S.cyan }}>
                <div style={{ fontWeight:700, color:S.dark?"#93c5fd":"#1d4ed8", marginBottom:2 }}>{k}</div>
                <div style={{ color:S.txt2, fontSize:12 }}>{v}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={S.card}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
            <div style={S.h2}>✏ Enter AIS / 26AS Values</div>
            <button onClick={clear} style={{ ...S.btn("ghost"), fontSize:11.5, border:"1px solid " + S.border, color:S.txt3, padding:"5px 10px" }}>
              Clear
            </button>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
            {[
              { key:"futTurnover",  label:"Futures Turnover (from AIS)",     ph:"As shown in AIS" },
              { key:"optTurnover",  label:"Options Turnover (from AIS)",     ph:"As shown in AIS" },
              { key:"grossPnl",     label:"Gross P&L / Proceeds (from AIS)", ph:"Net realized gain/loss" },
              { key:"totalCharges", label:"Total Charges (from AIS/broker)",  ph:"STT + all charges" },
            ].map(({key,label,ph}) => (
              <div key={key}>
                <div style={{ fontSize:12, fontWeight:600, color:S.txt2, marginBottom:4 }}>{label}</div>
                <input
                  style={S.inp} type="number" min="0" placeholder={ph}
                  value={ais[key]||""}
                  onChange={e => setAisData({...aisData,[key]:e.target.value})}
                />
              </div>
            ))}
          </div>
          <div style={{ marginTop:12 }}>
            <div style={{ fontSize:12, fontWeight:600, color:S.txt2, marginBottom:4 }}>Notes / Observations</div>
            <input
              style={S.inp} type="text" placeholder="e.g. AIS shows different STT, checked with contract notes..."
              value={ais.notes||""}
              onChange={e => setAisData({...aisData, notes:e.target.value})}
            />
          </div>
          <div style={{ display:"flex", gap:10, marginTop:14 }}>
            <button onClick={save} style={{ ...S.btn("primary"), padding:"9px 20px" }}>
              ✓ Run Reconciliation
            </button>
            {aisChecked && allMatch && (
              <span style={{ ...S.info("#16a34a"), display:"flex", alignItems:"center", padding:"8px 14px" }}>
                ✓ All figures match — no discrepancies
              </span>
            )}
          </div>
        </div>

        {aisChecked && hasAIS && (
          <>
            <div style={S.card}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
                <div style={S.h2}>⚖ Reconciliation Results</div>
                <span style={{ ...S.pill(allMatch), fontSize:13, padding:"6px 14px" }}>
                  {allMatch ? "✓ FULL MATCH — No Issues" : "⚠ MISMATCHES FOUND — Review Required"}
                </span>
              </div>
              <table style={S.table}>
                <thead>
                  <tr>
                    {["Item","Your App (Groww)","AIS / 26AS","Difference","Status","Action Needed"].map(h => (
                      <th key={h} style={S.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r,i) => {
                    const hasBoth = r.ais !== 0;
                    const matched = !hasBoth || diff(r.app, r.ais) <= OK;
                    const d       = hasBoth ? r.app - r.ais : 0;
                    const bigDiff = hasBoth && Math.abs(d) > 1000;
                    return (
                      <tr key={i} style={{ background: !hasBoth?S.card:matched?S.card:(S.dark?"#3b0000":"#fee2e2") }}>
                        <td style={{ ...S.td, fontWeight:600 }}>{r.label}</td>
                        <td style={{ ...S.td,...S.mono, color:pc(r.app) }}>{fmt(r.app)}</td>
                        <td style={{ ...S.td,...S.mono }}>
                          {hasBoth ? (
                            <span style={{ color:matched?"inherit":S.red, fontWeight:matched?400:700 }}>{fmt(r.ais)}</span>
                          ) : (
                            <span style={{ color:S.txt3 }}>Not entered</span>
                          )}
                        </td>
                        <td style={{ ...S.td,...S.mono, fontWeight:700, color:d>0?S.amber:d<0?S.red:S.green }}>
                          {hasBoth ? (d===0?"₹0.00":(d>0?"+":"") + fmt(d)) : "—"}
                        </td>
                        <td style={S.td}>
                          {!hasBoth ? (
                            <span style={{ color:S.txt3, fontSize:11 }}>—</span>
                          ) : matched ? (
                            <span style={S.pill(true)}>✓ Match</span>
                          ) : (
                            <span style={S.pill(false)}>✗ Mismatch</span>
                          )}
                        </td>
                        <td style={{ ...S.td, fontSize:11.5, color:S.txt2 }}>
                          {!hasBoth ? "Enter AIS value to check"
                           : matched ? "No action needed"
                           : bigDiff ? "⚠ Large gap — verify contract notes and re-check AIS"
                           : "Minor rounding difference — verify contract notes"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {!allMatch && (
              <div style={S.card}>
                <div style={S.h2}>🛠 Common Reasons for Mismatches &amp; How to Fix</div>
                <div style={{ display:"flex", flexDirection:"column", gap:10, fontSize:13 }}>
                  {[
                    { icon:"📅", title:"Date Range Mismatch", desc:"AIS may cover Apr–Mar but Groww report was downloaded for a shorter period. Re-download Groww report for full FY." },
                    { icon:"💱", title:"STT Rate Change (Oct 1, 2024)", desc:"Trades before Oct 1, 2024 used old STT rates. AIS may reflect this split. Verify against your contract notes." },
                    { icon:"🔄", title:"Open Positions at Year End", desc:"Groww report only shows squared-off trades. If you had open F&O positions on March 31, those appear in AIS but not Groww P&L." },
                    { icon:"🏦", title:"Multiple Brokers", desc:"AIS aggregates data from ALL brokers via PAN. If you traded F&O on any other platform, their data also appears in AIS." },
                    { icon:"🔢", title:"Rounding Differences", desc:"Tiny differences (< ₹2) are normal due to paisa rounding in exchange records vs broker records. These don't need correction." },
                    { icon:"✉", title:"What to Do If Mismatch > ₹1,000", desc:"Keep contract notes from Groww as proof. If AIS shows higher turnover/income, report the higher figure in ITR-3 to avoid notices. Consult your CA." },
                  ].map((r,i) => (
                    <div key={i} style={{ display:"flex", gap:12, padding:"12px 14px", background:S.card2, borderRadius:9, border:"1px solid " + S.border }}>
                      <div style={{ fontSize:22, flexShrink:0 }}>{r.icon}</div>
                      <div>
                        <div style={{ fontWeight:700, color:S.dark?"#f1f5f9":"#0f172a", marginBottom:3 }}>{r.title}</div>
                        <div style={{ color:S.txt2, fontSize:12.5, lineHeight:1.6 }}>{r.desc}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={S.card}>
              <div style={S.h2}>📋 ITR Filing Guidance Based on Reconciliation</div>
              <div style={{ display:"flex", flexDirection:"column", gap:8, fontSize:13 }}>
                {[
                  ["Report the HIGHER of App vs AIS turnover",
                    "If AIS shows higher turnover than your Groww report, always report the higher figure in ITR-3."],
                  ["Keep all contract notes for 6 years",
                    "CBDT can re-open assessments up to 6 years back. Keep Groww P&L reports, contract notes, and AIS screenshots."],
                  ["File before July 31 (non-audit) or Oct 31 (audit)",
                    "Your current audit status: " + (audit.req?"⚠ AUDIT REQUIRED — Oct 31 deadline":"✓ Not Required — July 31 deadline") + ". Late filing loses loss carry-forward."],
                  ["Respond to any AIS feedback requests",
                    "The IT portal allows you to mark AIS entries. Always respond to avoid automatic adjustments."],
                ].map(([title,desc],i) => (
                  <div key={i} style={{ display:"flex", gap:12, padding:"12px 14px", background:S.card2, borderRadius:9, border:"1px solid " + S.border }}>
                    <div style={{ fontWeight:700, color:S.amber, flexShrink:0, fontSize:16 }}>→</div>
                    <div>
                      <div style={{ fontWeight:700, color:S.dark?"#f1f5f9":"#0f172a", marginBottom:2 }}>{title}</div>
                      <div style={{ color:S.txt2, fontSize:12, lineHeight:1.6 }}>{desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {!aisChecked && (
          <div style={{ ...S.info("#3b82f6"), textAlign:"center" }}>
            Enter your AIS values above and click <strong>Run Reconciliation</strong> to see the comparison
          </div>
        )}
      </div>
    );
  };

  // ── CAPITAL GAINS TAB ─────────────────────────────────────────────────────
  const CapGains = () => {
    // Pre-compute all rates in pure JS (no division inside JSX)
    const stcgRate1 = fyConf.stcgRate || 15;
    const stcgRate2 = fyConf.stcgRateNew || fyConf.stcgRate || 20;
    const ltcgRate1 = fyConf.ltcgRate || 10;
    const ltcgRate2 = fyConf.ltcgRateNew || fyConf.ltcgRate || 12.5;
    const stcgTax1  = Math.max(0, cgSummary.preSTCG)  * stcgRate1 * 0.01;
    const stcgTax2  = Math.max(0, cgSummary.postSTCG) * stcgRate2 * 0.01;
    const cessTax   = (cgSummary.stcgTax + cgSummary.ltcgTax) * 0.04;
    const combinedTotal = activeTax.total + cgSummary.totalCGTax;
    const combinedBalance = combinedTotal - advTaxPaid;

    return (
      <div style={S.sec}>
        <div style={{ ...S.card, textAlign:"center", padding:"28px 32px" }}>
          <div style={{ fontSize:36, marginBottom:10 }}>📈</div>
          <div style={{ fontSize:16, fontWeight:700, color:S.dark?"#f1f5f9":"#0f172a", marginBottom:6 }}>
            Upload Groww Capital Gains Report (Stocks)
          </div>
          <div style={{ color:S.txt2, fontSize:12.5, marginBottom:16, lineHeight:1.7 }}>
            Groww App → Profile → Reports → <strong>Capital Gains - Stocks</strong> → Select FY → Download (.xlsx)<br/>
            This is separate from the F&O P&L report.
          </div>
          <div style={{ display:"flex", gap:10, justifyContent:"center", flexWrap:"wrap" }}>
            <button style={S.btn("primary")} onClick={() => cgFileRef.current.click()}>
              ⬆ Upload Capital Gains .xlsx
            </button>
            {cgTrades.length > 0 && (
              <button style={{ ...S.btn("ghost"), border:"1px solid " + S.border, color:S.txt2 }} onClick={clearCG}>
                🗑 Clear ({cgTrades.length} trades)
              </button>
            )}
          </div>
          <input ref={cgFileRef} type="file" accept=".xlsx,.xls" style={{ display:"none" }}
            onChange={e => processCGFile(e.target.files[0])} />
          {cgParseError && <div style={{ ...S.info("#dc2626"), marginTop:12, textAlign:"left" }}>⚠ {cgParseError}</div>}
          {cgTrades.length === 0 && !cgParseError && (
            <div style={{ ...S.info("#3b82f6"), marginTop:12 }}>
              No file uploaded yet. Capital gains tax is calculated separately from F&O business income at special rates.
            </div>
          )}
        </div>

        {cgTrades.length > 0 && (
          <>
            <div style={S.grid(4)}>
              {[
                { label:"Total CG Trades",    val:String(cgTrades.length),    color:"#3b82f6" },
                { label:"Total Gain / Loss",   val:fmt(cgSummary.totalGain),   color:cgSummary.totalGain>=0?S.green:S.red },
                { label:"CG Tax (with cess)",  val:fmt(cgSummary.totalCGTax),  color:S.amber },
                { label:"LTCG Exempt",         val:fmt(cgSummary.ltcgExempt),  color:S.purpleL },
              ].map((m,i) => (
                <div key={i} style={S.mc(m.color)}>
                  <div style={S.mLabel}>{m.label}</div>
                  <div style={{ ...S.mVal(m.color), fontSize:18 }}>{m.val}</div>
                </div>
              ))}
            </div>

            {fyConf.splitDate && (
              <div style={S.info("#f97316")}>
                <strong>Budget 2024 Split Date: {fyConf.splitDate}.</strong> Gains from sales before Jul 23 use old rates
                (STCG {stcgRate1}%, LTCG {ltcgRate1}%). Gains from sales on/after Jul 23 use new rates (STCG {stcgRate2}%, LTCG {ltcgRate2}%).
                ITR-3 requires both reported separately.
              </div>
            )}

            <div style={S.card}>
              <div style={S.h2}>💰 Capital Gains Tax Breakdown (Schedule CG)</div>
              <table style={S.table}>
                <thead>
                  <tr>
                    {["Category","Gains","Rate","Tax Before Cess","Notes"].map(h => <th key={h} style={S.th}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {[
                    { cat:"STCG Before Jul 23 (Sec 111A)",           val:cgSummary.preSTCG,  rate:stcgRate1 + "%", tax:stcgTax1, note:"Listed equity, STT paid" },
                    { cat:"STCG On/After Jul 23 (Sec 111A)",         val:cgSummary.postSTCG, rate:stcgRate2 + "%", tax:stcgTax2, note:fyYear==="FY 2024-25"?"Budget 2024 revised rate":"" },
                    { cat:"LTCG (all, Sec 112A)",                    val:cgSummary.preLTCG+cgSummary.postLTCG, rate:ltcgRate1 + "/" + ltcgRate2 + "%", tax:cgSummary.ltcgTax, note:"Exempt: " + fmt(cgSummary.ltcgExempt) + ", Taxable: " + fmt(cgSummary.taxableLTCG) },
                    { cat:"Health & Education Cess @4%",             val:null,                rate:"4%",            tax:cessTax,  note:"On STCG+LTCG tax" },
                    { cat:"TOTAL CAPITAL GAINS TAX",                  val:cgSummary.totalGain, rate:"—",            tax:cgSummary.totalCGTax, note:"Payable separately from business income tax", total:true },
                  ].map((r,i) => (
                    <tr key={i} style={{ background:r.total?(S.dark?"#1e2a3a":"#f0f9ff"):i%2===0?S.card:S.rowAlt }}>
                      <td style={{ ...S.td, fontWeight:r.total?700:400, fontSize:r.total?13:12.5 }}>{r.cat}</td>
                      <td style={{ ...S.td, ...S.mono, color:r.val!=null?pc(r.val):S.txt2 }}>
                        {r.val!=null ? fmt(r.val) : "—"}
                      </td>
                      <td style={{ ...S.td, color:S.txt2 }}>{r.rate}</td>
                      <td style={{ ...S.td, ...S.mono, fontWeight:r.total?800:500, color:r.total?"#f97316":pc(r.tax) }}>
                        {fmt(r.tax)}
                      </td>
                      <td style={{ ...S.td, fontSize:11.5, color:S.txt3 }}>{r.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {(Number(otherInc.capitalGains)||0) > 0 && (
              <div style={S.info("#f97316")}>
                ⚠ You have both a Capital Gains report uploaded AND a manual value in
                Tax Calculator → Capital Gains (₹{fmtN(Number(otherInc.capitalGains))}).
                Remove the manual entry to avoid double-counting — the uploaded report is more accurate.
              </div>
            )}

            <div style={S.card}>
              <div style={S.h2}>🧮 Combined Tax Picture (F&amp;O + Capital Gains)</div>
              <table style={S.table}>
                <tbody>
                  {[
                    { label:"F&O Business Income Tax",   val:activeTax.total,         color:"#3b82f6" },
                    { label:"Capital Gains Tax",         val:cgSummary.totalCGTax,    color:S.purpleL },
                    { label:"TOTAL TAX LIABILITY",       val:combinedTotal,           color:S.amber,  bold:true },
                    { label:"Advance Tax Paid",          val:advTaxPaid,              color:S.txt2 },
                    { label:"Balance Tax / (Refund)",    val:combinedBalance,
                      color:combinedBalance>0?S.red:S.green, bold:true },
                  ].map((r,i) => (
                    <tr key={i} style={{ background:r.bold?(S.dark?"#1e2a10":"#f7fdf0"):i%2===0?S.card:S.rowAlt }}>
                      <td style={{ ...S.td, fontWeight:r.bold?700:400 }}>{r.label}</td>
                      <td style={{ ...S.td, ...S.mono, fontWeight:r.bold?800:500, fontSize:r.bold?15:13, textAlign:"right", color:r.color||S.txt }}>
                        {fmt(r.val)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={S.card}>
              <div style={S.h2}>📋 All Capital Gain Trades ({fyYear})</div>
              <div style={{ overflowX:"auto" }}>
                <table style={S.table}>
                  <thead>
                    <tr>
                      {["#","Stock","Buy Date","Buy ₹","Sell Date","Sell ₹","Qty","Gain/Loss","Type","Period","CG Rate"].map(h => (
                        <th key={h} style={S.th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {cgTrades.map((t,i) => {
                      // Pre-compute rate labels — no division inside JSX
                      const cgRate = t.isLT
                        ? (t.splitCategory==="pre" ? ltcgRate1 + "%" : ltcgRate2 + "%")
                        : (t.splitCategory==="pre" ? stcgRate1 + "%" : stcgRate2 + "%");
                      return (
                        <tr key={t.id} style={{ background:i%2===0?S.card:S.rowAlt }}>
                          <td style={{ ...S.td, color:S.txt3 }}>{i+1}</td>
                          <td style={{ ...S.td, fontWeight:700 }}>{t.symbol}</td>
                          <td style={S.td}>{t.buyDate}</td>
                          <td style={{ ...S.td, ...S.mono }}>{fmt(t.buyPrice)}</td>
                          <td style={S.td}>{t.sellDate}</td>
                          <td style={{ ...S.td, ...S.mono }}>{fmt(t.sellPrice)}</td>
                          <td style={{ ...S.td, ...S.mono }}>{fmtN(t.buyQty)}</td>
                          <td style={{ ...S.td, ...S.mono, fontWeight:700, color:pc(t.gainLoss) }}>{fmt(t.gainLoss)}</td>
                          <td style={S.td}>
                            <span style={{
                              padding:"2px 8px", borderRadius:4, fontSize:10.5, fontWeight:700,
                              background:t.isLT?(S.dark?"#1e1b4b":"#ede9fe"):(S.dark?"#0c2a3d":"#dbeafe"),
                              color:t.isLT?S.purpleL:S.cyan,
                            }}>
                              {t.isLT?"LTCG":"STCG"}
                            </span>
                          </td>
                          <td style={S.td}>
                            <span style={{ fontSize:10.5, color:t.splitCategory==="pre"?S.amber:S.green, fontWeight:600 }}>
                              {t.splitCategory==="pre"?"Pre Jul 23":"Post Jul 23"}
                            </span>
                          </td>
                          <td style={{ ...S.td, fontSize:11, color:S.txt2 }}>{cgRate}</td>
                        </tr>
                      );
                    })}
                    <tr style={{ background:S.dark?"#0F1123":"#0f172a" }}>
                      <td colSpan={7} style={{ ...S.td, color:"#E8EAFF", fontWeight:800 }}>
                        TOTAL ({cgTrades.length} trades)
                      </td>
                      <td style={{ ...S.td, ...S.mono, fontWeight:800, fontSize:15, color:cgSummary.totalGain>=0?S.green:S.red }}>
                        {fmt(cgSummary.totalGain)}
                      </td>
                      <td colSpan={3} style={{ ...S.td, ...S.mono, fontWeight:700, color:S.amber }}>
                        Tax: {fmt(cgSummary.totalCGTax)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    );
  };

  // ── SHARE VIEW TAB ────────────────────────────────────────────────────────
  const ShareView = () => {
    const hash = typeof window !== "undefined" ? window.location.hash : "";
    const shareParam = hash.replace("#share=","");
    const data = shareParam ? decompressState(shareParam) : null;
    const s = data?.summary || {};

    if (!data) return (
      <div style={{ ...S.sec, alignItems:"center", justifyContent:"center", minHeight:400 }}>
        <div style={{ ...S.card, textAlign:"center", padding:40 }}>
          <div style={{ fontSize:40, marginBottom:12 }}>🔗</div>
          <div style={{ fontSize:16, fontWeight:700, color:S.dark?"#f1f5f9":"#0f172a", marginBottom:8 }}>No shared data found</div>
          <div style={{ color:S.txt2 }}>Open this tab via a share link from someone's F&O Tax Calculator</div>
        </div>
      </div>
    );

    return (
      <div style={S.sec}>
        <div style={{ ...S.card, background:S.dark?"#0F1123":"#1A1D3B", color:"#E8EAFF" }}>
          <div style={{ fontSize:15, fontWeight:800, marginBottom:4 }}>🔗 Shared Tax Summary</div>
          <div style={{ color:S.txt2, fontSize:12.5 }}>
            {s.metaName || "Trader"} · {s.metaPeriod || data.fyYear} · Read-only view
          </div>
        </div>
        <div style={S.grid(3)}>
          {[
            { label:"Trades",              val:String(s.trades||0),      color:"#3b82f6" },
            { label:"F&O Turnover",        val:fmt(s.turnover||0),       color:S.purpleL },
            { label:"Net Business Income", val:fmt(s.netBizIncome||0),   color:s.netBizIncome>=0?S.green:S.red },
          ].map((m,i) => (
            <div key={i} style={S.mc(m.color)}>
              <div style={S.mLabel}>{m.label}</div>
              <div style={{ ...S.mVal(m.color), fontSize:18 }}>{m.val}</div>
            </div>
          ))}
        </div>
        <div style={S.card}>
          <div style={S.h2}>📋 Summary for CA</div>
          <table style={S.table}>
            <tbody>
              {[
                ["Financial Year", data.fyYear],
                ["F&O Turnover", fmt(s.turnover||0)],
                ["Gross Trade P&L", fmt(s.grossPnl||0)],
                ["Total Deductible Charges", fmt(s.totalDeductible||0)],
                ["Net F&O Business Income", fmt(s.netBizIncome||0)],
                ["Capital Gains (total)", fmt(s.cgTotal||0)],
                ["Capital Gains Tax", fmt(s.cgTax||0)],
                ["Gross Total Income", fmt(s.grossTotalInc||0)],
                ["Tax Regime", data.regime==="new"?"New Tax Regime":"Old Tax Regime"],
                ["F&O Tax Liability", fmt(s.activeTaxTotal||0)],
                ["Tax Audit Required", s.auditReq?"⚠ YES":"✓ No"],
                ["Audit Reason", s.auditReason||"—"],
              ].map(([label,val],i) => (
                <tr key={i} style={{ background:i%2===0?S.card:S.rowAlt }}>
                  <td style={{ ...S.td, color:S.txt2 }}>{label}</td>
                  <td style={{ ...S.td, ...S.mono, fontWeight:600, color:S.txt }}>{val}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={S.info("#3b82f6")}>
          This is a read-only view. The actual trade data and report are with the person who shared this link.
          Ask them to also share the PDF export for full details.
        </div>
      </div>
    );
  };

  // ── ROUTING ──────────────────────────────────────────────────────────────
  const panels = {
    upload:Upload, dashboard:Dashboard, turnover:Turnover, pnl:PnL,
    stockpnl:StockPnL, capgains:CapGains, tax:TaxCalc, advance:AdvanceTax,
    losses:Losses, aisrecon:AISRecon, itr3:ITR3, shareview:ShareView,
  };
  const Panel = panels[tab] || Upload;

  const pageTitles = {
    upload:"Upload Report", dashboard:"Dashboard", turnover:"Turnover Analysis",
    pnl:"P&L & Charges", stockpnl:"Stock-wise P&L", capgains:"Capital Gains",
    tax:"Tax Calculator", advance:"Advance Tax & 234B/C", losses:"Loss Carry-Forward Ledger",
    aisrecon:"AIS / 26AS Reconciliation", itr3:"ITR-3 Ready Values", shareview:"Shared Summary",
  };

  return (
    <div style={S.app}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,400;0,500;0,600;0,700;0,800;1,400&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap');
        *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
        input:focus  { border-color:#7C63F5!important; box-shadow:0 0 0 3px rgba(124,99,245,0.16)!important; outline:none; }
        select:focus { border-color:#7C63F5!important; outline:none; }
        button { font-family:'Plus Jakarta Sans',sans-serif; }
        button:hover { opacity:0.88; transform:translateY(-1px); }
        a { text-decoration:none; }
        ::-webkit-scrollbar { width:4px; height:4px; }
        ::-webkit-scrollbar-track { background:transparent; }
        ::-webkit-scrollbar-thumb { background:${S.dark?"rgba(124,99,245,0.25)":"rgba(124,99,245,0.18)"}; border-radius:4px; }
        .nav-item:hover { background:${S.dark?"rgba(124,99,245,0.10)":"rgba(124,99,245,0.07)"}!important; }
        @keyframes fadeIn { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        .page-fade { animation: fadeIn 0.22s ease-out forwards; }
      `}</style>

      <div style={S.meshBlob1} />
      <div style={S.meshBlob2} />
      <div style={S.meshBlob3} />

      {/* ── SIDEBAR ──────────────────────────────────────────────────────── */}
      <div style={S.sidebar}>
        <div style={S.logoArea}>
          <div style={S.logoMark}>₹</div>
          <div>
            <div style={S.logoText}>F&O Tax</div>
            <div style={S.logoSub}>ICAI Verified · ITR-3</div>
          </div>
        </div>

        <div style={S.navSection}>
          {[{ id:"upload", icon:"📁", label:"Upload Report" }].map(({ id, icon, label }) => (
            <div key={id} className="nav-item" style={S.navItem(tab===id)} onClick={() => setTab(id)}>
              {tab===id && <div style={S.navActivePill} />}
              <span style={S.navIcon(tab===id)}>{icon}</span>
              <span style={S.navText(tab===id)}>{label}</span>
            </div>
          ))}

          {(trades.length > 0 || cgTrades.length > 0) && (
            <>
              <div style={S.navLabel}>Analytics</div>
              {[
                { id:"dashboard", icon:"◈", label:"Dashboard" },
                { id:"turnover",  icon:"⊞", label:"Turnover" },
                { id:"pnl",       icon:"₹", label:"P&L & Charges" },
                { id:"stockpnl",  icon:"▲", label:"Stock P&L" },
                { id:"capgains",  icon:"◎", label:"Capital Gains" },
              ].map(({ id, icon, label }) => (
                <div key={id} className="nav-item" style={S.navItem(tab===id)} onClick={() => setTab(id)}>
                  {tab===id && <div style={S.navActivePill} />}
                  <span style={{ ...S.navIcon(tab===id), fontFamily:"monospace", fontSize:13 }}>{icon}</span>
                  <span style={S.navText(tab===id)}>{label}</span>
                </div>
              ))}

              <div style={S.navLabel}>Tax Filing</div>
              {[
                { id:"tax",      icon:"⊕", label:"Tax Calculator" },
                { id:"advance",  icon:"◷", label:"Advance Tax" },
                { id:"losses",   icon:"↓", label:"Loss Ledger" },
                { id:"aisrecon", icon:"⊜", label:"AIS Reconcile" },
                { id:"itr3",     icon:"≡", label:"ITR-3 Values" },
              ].map(({ id, icon, label }) => (
                <div key={id} className="nav-item" style={S.navItem(tab===id)} onClick={() => setTab(id)}>
                  {tab===id && <div style={S.navActivePill} />}
                  <span style={{ ...S.navIcon(tab===id), fontFamily:"monospace", fontSize:13 }}>{icon}</span>
                  <span style={S.navText(tab===id)}>{label}</span>
                </div>
              ))}
            </>
          )}
        </div>

        <div style={S.sidebarBottom}>
          <div style={{ marginBottom:12 }}>
            <div style={{ fontSize:9.5, fontWeight:700, color:S.txt3, textTransform:"uppercase", letterSpacing:"0.09em", marginBottom:6 }}>
              Financial Year
            </div>
            <select
              value={fyYear}
              onChange={e => setFyYear(e.target.value)}
              style={{
                ...S.inp, fontSize:12, fontWeight:700, color:S.purpleL,
                background:S.dark?"rgba(124,99,245,0.10)":"rgba(124,99,245,0.06)",
                border:"1px solid rgba(124,99,245,0.22)",
              }}
            >
              {Object.keys(FY_CONFIG).map(fy => (
                <option key={fy} value={fy}>{fy}</option>
              ))}
            </select>
            <div style={{ marginTop:5, fontSize:10.5, color:S.txt3, textAlign:"center" }}>
              {fyConf.ay} · Due {fyConf.filing}
            </div>
          </div>
          <button
            onClick={() => setDark(d => !d)}
            style={{
              ...S.btn("ghost"), width:"100%", justifyContent:"center",
              border:"1px solid " + S.border, color:S.txt2,
              display:"flex", alignItems:"center", gap:8, padding:"8px 12px",
            }}
          >
            <span style={{ fontSize:13 }}>{dark ? "☀️" : "🌙"}</span>
            <span style={{ fontSize:12, fontWeight:600 }}>{dark ? "Light Mode" : "Dark Mode"}</span>
          </button>
        </div>
      </div>

      {/* ── MAIN AREA ─────────────────────────────────────────────────────── */}
      <div style={S.mainArea}>
        <div style={S.topHeader}>
          <div>
            <div style={S.pageTitle}>{pageTitles[tab] || "F&O Tax Calculator"}</div>
            <div style={S.pageSubtitle}>{fyConf.label} · {fyConf.ay} · ICAI Verified Calculations</div>
          </div>

          <div style={{ display:"flex", gap:8, alignItems:"center" }}>
            {trades.length > 0 && (
              <div style={{
                background:S.dark?"rgba(124,99,245,0.12)":"rgba(124,99,245,0.07)",
                border:"1px solid rgba(124,99,245,0.2)", borderRadius:10,
                padding:"5px 12px", fontSize:11.5, fontWeight:700, color:S.purpleL,
              }}>
                {trades.length} trades{meta.name ? " · " + meta.name : ""}
              </div>
            )}
            {trades.length > 0 && (
              <div style={{ position:"relative" }}>
                <button
                  onClick={generateShareLink}
                  style={{ ...S.btn("ghost"), fontSize:12, padding:"6px 14px", border:"1px solid " + S.border, color:S.txt2, display:"flex", alignItems:"center", gap:6 }}
                >
                  🔗 Share
                </button>
                {shareToast && (
                  <div style={{
                    position:"absolute", top:44, right:0,
                    background:S.dark?"#111325":"#fff",
                    border:"1px solid rgba(0,214,143,0.3)",
                    color:S.green, padding:"8px 14px", borderRadius:10,
                    fontSize:12, fontWeight:600, whiteSpace:"nowrap",
                    zIndex:999, boxShadow:"0 8px 24px rgba(0,0,0,0.2)",
                  }}>
                    {shareToast}
                  </div>
                )}
              </div>
            )}
            {trades.length > 0 && (
              <button
                onClick={generatePDF}
                style={{ ...S.btn("primary"), padding:"7px 16px", fontSize:12, display:"flex", alignItems:"center", gap:6 }}
              >
                ⬇ PDF
              </button>
            )}
            {trades.length > 0 && (
              <button
                style={{ ...S.btn("ghost"), fontSize:12, padding:"6px 12px", border:"1px solid " + S.border, color:S.txt3 }}
                onClick={resetAll}
              >
                ⟳
              </button>
            )}
          </div>
        </div>

        <div style={{ flex:1, overflowY:"auto" }} key={tab} className="page-fade">
          <Panel />
        </div>
      </div>
    </div>
  );
}