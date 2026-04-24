import express from "express";
import { createServer as createViteServer } from "vite";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";
import { perform3DAnalysis, type AnalysisResult, type EvolutionLogRow } from "./src/lib/analysis.ts";
import { syncEvolutionLogs, fetchHistoricalLogs, updateLiveStatus, getLiveStatus } from "./src/lib/firebase.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface LotteryEntry {
  period: string;
  numbers: number[];
}

let globalLotteryData: LotteryEntry[] = [];

let globalAnalysis: AnalysisResult | null = null;
let lastAnalyzedPeriod: string | null = null;
let isInitializing = true;

let lastSyncMeta = {
  source: "initial",
  fetchedAt: new Date().toISOString(),
  nextDraw: { period: "21317183", countdown: "00:00:00" },
  serverTime: Date.now()
};

async function terminalSyncAndAnalyze() {
  console.log("📡 [Background Sync] Starting sync cycle...");
  const url = "https://wuk.168y.cloudns.org/";
  
  try {
    // On first run, try to pull state from Cloud to satisfy "Locking" logic across restarts
    if (isInitializing) {
      console.log("📡 [Initialization] Attempting to restore state from Cloud...");
      try {
        const cloudStatus = await getLiveStatus();
        if (cloudStatus && cloudStatus.prediction) {
          console.log(`✅ [Initialization] Restored consensus for period ${cloudStatus.period}`);
          lastAnalyzedPeriod = cloudStatus.period;
          // We'll reconstruct analysis object partially or wait for sync to fill data
        }
      } catch (e) {
        console.warn("⚠️ [Initialization] Cloud restore failed, proceeding with fresh sync.");
      }
      isInitializing = false;
    }

    console.log("📡 [Background Sync] Fetching data from 168y...");
    const response = await axios.get(`${url}?t=${Date.now()}`, {
      headers: { "User-Agent": "Mozilla/5.0 Node.js" },
      timeout: 20000,
    });
    console.log("📡 [Background Sync] Data fetched, parsing...");

    const dataStr = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    const newRecords: any[] = [];
    
    // Most robust pattern: matches period (8-15 digits) and the 10开奖号码
    const pairRegex = /(\d{8,15})[\s\S]{1,200}?((\d{1,2},){9}\d{1,2})/g;
    let m;
    while ((m = pairRegex.exec(dataStr)) !== null) {
      const p = m[1];
      const r = m[2];
      const nums = r.split(',').map(n => parseInt(n)).filter(n => !isNaN(n) && n >= 1 && n <= 10);
      if (nums.length === 10 && !newRecords.find(nr => nr.period === p)) {
        newRecords.push({ period: p, numbers: nums });
      }
    }

    let hasNewData = false;
    if (newRecords.length > 0) {
      console.log(`✅ [Background Sync] Extracted ${newRecords.length} records from 168y`);
      newRecords.forEach(rec => {
        if (!globalLotteryData.find(d => d.period === rec.period)) {
          globalLotteryData.push(rec);
          hasNewData = true;
        }
      });
      globalLotteryData.sort((a, b) => Number(b.period) - Number(a.period));
      if (globalLotteryData.length > 200) globalLotteryData = globalLotteryData.slice(0, 200);
    }

    const currentLatestPeriod = globalLotteryData.length > 0 ? globalLotteryData[0].period : "0";
    const currentLatest = globalLotteryData.length > 0 ? Number(currentLatestPeriod) : 21317182;
    const now = Date.now();
    const bjTime = new Date(now + (new Date().getTimezoneOffset() + 480) * 60000);
    const currentHourSeconds = bjTime.getMinutes() * 60 + bjTime.getSeconds();
    
    // Countdown logic: Target 05s mark of minutes ending in 4 or 9
    let nextTargetSeconds = 245; 
    while (nextTargetSeconds <= currentHourSeconds) nextTargetSeconds += 300;
    
    const diff = nextTargetSeconds - currentHourSeconds;
    const mm = Math.floor(diff / 60);
    const ss = diff % 60;
    const countdown = `00:${mm.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`;

    lastSyncMeta = {
      source: "wuk-168y",
      fetchedAt: new Date().toISOString(),
      nextDraw: { period: (currentLatest + 1).toString(), countdown },
      serverTime: now
    };

    // LOCKING LOGIC: Only re-analyze if we have new data OR if no analysis exists for the CURRENT period
    // Even if it's the first run, if lastAnalyzedPeriod (from Cloud) matches currentLatestPeriod, we SKIP.
    const isLocked = globalAnalysis && currentLatestPeriod === lastAnalyzedPeriod && !hasNewData;
    
    if (globalLotteryData.length >= 10 && !isLocked) {
      try {
        console.log(`📡 [Background Sync] Core Trigger: New draw ${currentLatestPeriod} detected. Run Analysis.`);
        lastAnalyzedPeriod = currentLatestPeriod;
        
        console.log("📡 [Background Sync] Fetching historical logs from Cloud...");
        const historyLogs = await fetchHistoricalLogs(60);
        console.log(`📡 [Background Sync] Found ${historyLogs.length} historical logs. Starting Engine...`);
        
        globalAnalysis = perform3DAnalysis(globalLotteryData, historyLogs);
        
        // Detailed Hit and Pulse Monitoring for stabilization
        if (globalAnalysis.evolutionLogs && globalAnalysis.evolutionLogs.length > 0) {
            const lastCompleted = globalAnalysis.evolutionLogs[globalAnalysis.evolutionLogs.length - 1];
            console.log(`🎯 [Background Sync] Period ${lastCompleted.period} Hits:`, 
                Object.entries(lastCompleted.genes)
                    .filter(([_, g]) => g.isHit)
                    .map(([name, _]) => name)
                    .join(', ') || 'NONE'
            );
        }
        
        console.log("📡 [Background Sync] 3D Analysis complete.");
        console.log("📊 [Dynamic Pulse Status]:", JSON.stringify(globalAnalysis.genePulse));
        
        // Auto-persist new findings to prevent data loss
        if (globalAnalysis.evolutionLogs) {
          console.log("📡 [Background Sync] Syncing evolution logs to Cloud...");
          await syncEvolutionLogs(globalAnalysis.evolutionLogs);
          console.log("📡 [Background Sync] Updating live status in Cloud...");
          await updateLiveStatus(
            globalLotteryData[0].period,
            globalAnalysis.prediction || {},
            globalAnalysis.evolutionMetrics || {},
            globalAnalysis.genePulse || {},
            globalAnalysis.genePredictions || {}
          );
          console.log("📡 [Background Sync] Cloud sync complete.");
        }
      } catch (e) {
        console.warn("[Background Sync] Persistent analysis failed, fallback to local:", e);
        globalAnalysis = perform3DAnalysis(globalLotteryData);
        lastAnalyzedPeriod = currentLatestPeriod;
      }
    } else if (globalLotteryData.length >= 10) {
      console.log(`🔏 [Background Sync] Logic Locked: Results for Period ${currentLatestPeriod} already finalized.`);
    }
  } catch (err: any) {
    console.warn(`[Background Sync] Sync failed: ${err.message}`);
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.get("/api/lottery-data", async (req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
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

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
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
    
    // Kick off initial sync after listener is established
    terminalSyncAndAnalyze();
    
    // High-frequency sync every 30 seconds
    setInterval(() => {
      terminalSyncAndAnalyze();
    }, 30 * 1000);
  });
}

startServer();
