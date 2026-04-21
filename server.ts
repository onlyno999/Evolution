import express from "express";
import { createServer as createViteServer } from "vite";
import axios from "axios";
import * as cheerio from "cheerio";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { perform3DAnalysis, type AnalysisResult } from "./src/lib/analysis.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Persistent global data store
let globalLotteryData: { period: string; numbers: number[] }[] = [];
let globalAnalysis: AnalysisResult | null = null;
let lastSyncMeta = {
  source: "initializing",
  fetchedAt: "",
  nextDraw: { period: "21317183", countdown: "00:00:00" },
  serverTime: Date.now()
};

const extractFromItem = (item: any) => {
  if (!item || typeof item !== "object") return null;
  let p = (item.preDrawIssue || item.drawIssue || item.period || item.p || "").toString();
  let r = (item.preDrawCode || item.drawCode || item.result || item.r || "");
  if (p && r && typeof r === "string" && r.includes(',')) {
     const nums = r.split(',').map(Number).filter(n => !isNaN(n) && n > 0 && n <= 10);
     if (nums.length === 10) return { period: p, numbers: nums };
  }
  return null;
};

const manualSync = [
  { p: "21317495", n: [7, 1, 3, 8, 4, 10, 6, 5, 9, 2] },
  { p: "21317494", n: [2, 4, 5, 8, 3, 7, 9, 10, 6, 1] },
  { p: "21317493", n: [5, 2, 9, 4, 7, 1, 10, 6, 3, 8] },
  { p: "21317492", n: [9, 7, 5, 8, 6, 3, 2, 10, 1, 4] },
  { p: "21317491", n: [10, 2, 8, 1, 4, 6, 9, 5, 3, 7] },
  { p: "21317490", n: [9, 5, 7, 8, 6, 10, 1, 3, 2, 4] },
  { p: "21317489", n: [1, 8, 7, 10, 2, 9, 3, 4, 5, 6] },
  { p: "21317488", n: [5, 10, 4, 6, 1, 9, 3, 8, 7, 2] },
  { p: "21317487", n: [10, 6, 9, 7, 5, 8, 3, 2, 4, 1] },
  { p: "21317486", n: [5, 4, 6, 10, 9, 8, 1, 3, 2, 7] },
  { p: "21317424", n: [6, 1, 9, 8, 4, 3, 5, 2, 7, 10] },
  { p: "21317182", n: [8, 9, 10, 3, 6, 7, 1, 4, 5, 2] },
  { p: "21317181", n: [6, 9, 4, 10, 3, 7, 1, 2, 5, 8] },
  { p: "21317180", n: [4, 8, 2, 7, 3, 1, 5, 6, 10, 9] },
  { p: "21317179", n: [1, 10, 8, 4, 3, 7, 5, 2, 9, 6] },
  { p: "21317178", n: [1, 8, 2, 4, 9, 7, 10, 5, 6, 3] },
  { p: "21317177", n: [3, 2, 9, 10, 8, 1, 4, 5, 7, 6] },
  { p: "21317176", n: [3, 6, 2, 10, 5, 4, 7, 1, 8, 9] },
  { p: "21317175", n: [6, 7, 5, 3, 2, 10, 8, 4, 1, 9] },
  { p: "21317174", n: [5, 10, 1, 8, 9, 7, 6, 4, 2, 3] },
  { p: "21317173", n: [8, 1, 9, 6, 4, 7, 5, 2, 10, 3] },
  { p: "21317172", n: [7, 9, 4, 8, 3, 10, 6, 5, 2, 1] },
  { p: "21317171", n: [3, 2, 4, 9, 10, 6, 8, 7, 5, 1] },
  { p: "21317170", n: [3, 6, 5, 10, 7, 8, 1, 9, 4, 2] },
  { p: "21317169", n: [1, 10, 3, 9, 4, 8, 2, 5, 6, 7] },
  { p: "21317168", n: [3, 5, 6, 10, 2, 1, 7, 8, 4, 9] },
  { p: "21317167", n: [5, 8, 10, 3, 4, 7, 9, 1, 6, 2] },
  { p: "21317166", n: [9, 5, 3, 10, 2, 1, 4, 8, 7, 6] },
  { p: "21317165", n: [8, 9, 10, 5, 6, 7, 2, 1, 3, 4] },
  { p: "21317164", n: [4, 3, 5, 9, 1, 8, 10, 2, 6, 7] },
  { p: "21317163", n: [3, 1, 7, 9, 5, 6, 2, 10, 4, 8] },
  { p: "21317162", n: [3, 4, 6, 1, 8, 10, 7, 9, 2, 5] },
  { p: "21317161", n: [5, 4, 6, 10, 1, 3, 9, 8, 7, 2] },
  { p: "21317160", n: [6, 2, 1, 3, 10, 5, 7, 4, 8, 9] },
  { p: "21317159", n: [4, 2, 9, 8, 10, 3, 7, 5, 1, 6] },
  { p: "21317158", n: [7, 4, 1, 10, 9, 6, 5, 8, 2, 3] },
  { p: "21317157", n: [1, 5, 4, 7, 6, 8, 3, 9, 2, 10] },
  { p: "21317156", n: [10, 6, 5, 1, 4, 7, 9, 2, 3, 8] },
  { p: "21317155", n: [1, 6, 5, 7, 4, 8, 10, 2, 3, 9] },
  { p: "21317154", n: [1, 9, 4, 2, 7, 5, 10, 6, 3, 8] },
  { p: "21317153", n: [2, 8, 6, 9, 10, 7, 4, 3, 5, 1] },
  { p: "21317152", n: [6, 3, 2, 4, 7, 8, 5, 1, 9, 10] },
  { p: "21317151", n: [2, 10, 8, 5, 6, 7, 3, 1, 9, 4] },
  { p: "21317150", n: [10, 8, 3, 2, 6, 4, 9, 1, 5, 7] },
  { p: "21317149", n: [7, 5, 10, 3, 1, 9, 2, 4, 6, 8] },
  { p: "21317148", n: [7, 9, 1, 3, 4, 2, 10, 5, 6, 8] },
  { p: "21317147", n: [1, 8, 4, 6, 2, 9, 3, 7, 10, 5] },
  { p: "21317146", n: [8, 4, 7, 6, 10, 1, 9, 2, 5, 3] },
  { p: "21317145", n: [1, 7, 2, 4, 3, 10, 5, 9, 8, 6] },
  { p: "21317144", n: [10, 6, 3, 9, 7, 1, 5, 8, 2, 4] },
  { p: "21317143", n: [10, 9, 1, 2, 6, 3, 7, 4, 5, 8] },
  { p: "21317142", n: [1, 10, 8, 6, 5, 2, 9, 4, 3, 7] },
  { p: "21317141", n: [6, 7, 5, 8, 10, 3, 4, 2, 1, 9] },
  { p: "21317140", n: [6, 4, 2, 7, 8, 10, 9, 5, 1, 3] },
  { p: "21317139", n: [1, 9, 6, 7, 8, 3, 5, 10, 4, 2] },
  { p: "21317138", n: [6, 4, 9, 8, 10, 2, 5, 3, 7, 1] },
  { p: "21317137", n: [6, 8, 4, 7, 1, 10, 3, 2, 9, 5] },
  { p: "21317136", n: [8, 6, 9, 7, 5, 1, 3, 10, 4, 2] },
  { p: "21317135", n: [2, 5, 4, 3, 6, 7, 9, 8, 10, 1] },
  { p: "21317134", n: [2, 1, 10, 9, 3, 7, 5, 6, 8, 4] },
  { p: "21317133", n: [6, 10, 2, 7, 1, 8, 3, 5, 9, 4] },
  { p: "21317132", n: [2, 5, 7, 4, 10, 8, 3, 6, 9, 1] },
  { p: "21317131", n: [4, 3, 9, 8, 5, 1, 2, 7, 6, 10] },
  { p: "21317130", n: [9, 8, 2, 10, 5, 3, 4, 7, 1, 6] },
  { p: "21317129", n: [1, 10, 2, 8, 9, 6, 7, 3, 5, 4] },
  { p: "21317128", n: [2, 1, 6, 5, 8, 4, 10, 9, 7, 3] },
  { p: "21317127", n: [3, 9, 5, 2, 7, 1, 10, 8, 6, 4] },
  { p: "21317126", n: [9, 2, 10, 8, 3, 4, 1, 6, 5, 7] }
];

async function terminalSyncAndAnalyze() {
  console.log("📡 [Background Sync] Analysis Terminal Sync Starting...");
  const sources = [
    { url: "https://wuk.168y.cloudns.org/pks/getLotteryPksInfo.do?lotCode=10012", ref: "https://wuk.168y.cloudns.org/" },
    { url: "https://wuk.168y.cloudns.org/CurrentPk10/getCurrentRecord.do?lotCode=10012", ref: "https://wuk.168y.cloudns.org/" },
    { url: "https://api.api68.com/pks/getLotteryPksInfo.do?lotCode=10012", ref: "https://api.api68.com/" }
  ];

  let foundNextPeriod = "";
  let sourceUsed = "cache";
  const now = Date.now();

  for (const source of sources) {
    try {
      const response = await axios.get(`${source.url}${source.url.includes('?') ? '&' : '?'}t=${Date.now()}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Referer": source.ref
        },
        timeout: 10000,
      });

      const newRecords: any[] = [];
      const bodyStr = typeof response.data === "string" ? response.data : JSON.stringify(response.data);

      // JSON PARSER
      let jsonData = null;
      try { jsonData = typeof response.data === "object" ? response.data : JSON.parse(response.data); } catch(e) {}
      if (jsonData) {
        const scan = (obj: any) => {
          if (!obj || typeof obj !== "object") return;
          const rec = extractFromItem(obj);
          if (rec && !newRecords.find(nr => nr.period === rec.period)) newRecords.push(rec);
          Object.values(obj).forEach(val => { if (val && typeof val === "object") scan(val); });
        };
        scan(jsonData);
        const timeData = jsonData.data || jsonData.result || jsonData;
        if (timeData.drawIssue) foundNextPeriod = timeData.drawIssue.toString();
      }

      // Regex Fallback
      const codeMatches = bodyStr.match(/"(drawCode|preDrawCode|r|result)":"([\d,]{19,25})"/g);
      const issueMatches = bodyStr.match(/"(drawIssue|preDrawIssue|p|period)":(\d{10,14}|"\d{10,14}")/g);
      if (codeMatches && issueMatches) {
        issueMatches.forEach((im, idx) => {
          const p = im.match(/\d{10,14}/)?.[0];
          const r = codeMatches[idx]?.match(/[\d,]{19,25}/)?.[0];
          if (p && r) {
            const nums = r.split(',').map(Number).filter(n => !isNaN(n) && n > 0 && n <= 10);
            if (nums.length === 10 && !newRecords.find(nr => nr.period === p)) newRecords.push({ period: p, numbers: nums });
          }
        });
      }

      if (newRecords.length > 0) {
        sourceUsed = source.url.includes("168y") ? "wuk-168y" : "api68";
        newRecords.forEach(rec => {
          if (!globalLotteryData.find(d => d.period === rec.period)) {
            globalLotteryData.push(rec);
          }
        });
        break;
      }
    } catch (err) {
      console.warn(`[Background Sync] Source failed: ${source.url}`);
    }
  }

  // Apply Manual Sync
  manualSync.forEach(entry => {
    const existingIdx = globalLotteryData.findIndex(d => d.period === entry.p);
    if (existingIdx !== -1) globalLotteryData.splice(existingIdx, 1);
    globalLotteryData.push({ period: entry.p, numbers: entry.n });
  });

  globalLotteryData.sort((a, b) => Number(b.period) - Number(a.period));

  // Determine Next Period & Countdown
  const currentLatest = globalLotteryData.length > 0 ? Number(globalLotteryData[0].period) : 21317182;
  let finalNextPeriod = (currentLatest + 1).toString();
  if (foundNextPeriod && parseInt(foundNextPeriod) > currentLatest) {
    finalNextPeriod = foundNextPeriod;
  }

  // REFINED SYNC LOGIC: Target 05s mark of minutes ending in 4 or 9
  const bjTime = new Date(now + (new Date().getTimezoneOffset() + 480) * 60000);
  const curMinutes = bjTime.getMinutes();
  const curSeconds = bjTime.getSeconds();
  
  // High-Precision Grid Calculation: 04:05, 09:05, 14:05... 59:05
  // Total seconds from the start of the hour for the current time
  const currentHourSeconds = curMinutes * 60 + curSeconds;
  
  // Define targets (in seconds from hour start): 4:05 (245s), 9:05 (545s), etc.
  const targets = [];
  for (let k = 0; k < 12; k++) {
    targets.push(245 + k * 300);
  }
  
  // Find the next active terminal sync point
  let nextTargetSeconds = targets.find(t => t > currentHourSeconds);
  if (!nextTargetSeconds) {
    // Wrap around to the first target of the next hour (04:05)
    nextTargetSeconds = 245 + 3600;
  }
  
  let diffSeconds = nextTargetSeconds - currentHourSeconds;
  
  const mm = Math.floor(diffSeconds / 60);
  const ss = diffSeconds % 60;
  const countdown = `00:${mm.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`;

  lastSyncMeta = {
    source: sourceUsed,
    fetchedAt: new Date().toISOString(),
    nextDraw: { period: finalNextPeriod, countdown },
    serverTime: now
  };

  // Run Analysis Engine
  if (globalLotteryData.length >= 10) {
    console.log("🧠 [Analysis Engine] Running evolution model...");
    globalAnalysis = perform3DAnalysis(globalLotteryData);
    console.log(`✅ [Analysis Engine] Prediction calculated: Number ${globalAnalysis.prediction.number} in ${globalAnalysis.prediction.targetZone}`);
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Analysis API
  app.get("/api/lottery-data", async (req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    
    // Return cached global data and analysis
    res.json({ 
      success: true, 
      data: globalLotteryData.slice(0, 150),
      analysis: globalAnalysis,
      serverTime: Date.now(),
      source: lastSyncMeta.source,
      fetchedAt: lastSyncMeta.fetchedAt,
      nextDraw: lastSyncMeta.nextDraw
    });
  });

  // Trigger initial sync
  terminalSyncAndAnalyze();
  
  // Set automated interval (10 minutes as requested)
  setInterval(() => {
    terminalSyncAndAnalyze();
  }, 10 * 60 * 1000);

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

