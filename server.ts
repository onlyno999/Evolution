import express from "express";
import { createServer as createViteServer } from "vite";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";
import { perform3DAnalysis, type AnalysisResult } from "./src/lib/analysis.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface LotteryEntry {
  period: string;
  numbers: number[];
}

let globalLotteryData: LotteryEntry[] = [
  { period: "21317521", numbers: [4, 7, 6, 9, 1, 8, 3, 5, 2, 10] },
  { period: "21317520", numbers: [9, 2, 3, 1, 10, 6, 5, 8, 4, 7] },
  { period: "21317519", numbers: [10, 7, 2, 6, 9, 8, 5, 1, 3, 4] }
];

let globalAnalysis: AnalysisResult | null = null;
let lastSyncMeta = {
  source: "initial",
  fetchedAt: new Date().toISOString(),
  nextDraw: { period: "21317522", countdown: "00:00:00" },
  serverTime: Date.now()
};

async function terminalSyncAndAnalyze() {
  console.log("📡 [Background Sync] Analysis Terminal Sync Starting...");
  const url = "https://wuk.168y.cloudns.org/";
  
  try {
    const response = await axios.get(`${url}?t=${Date.now()}`, {
      headers: { "User-Agent": "Mozilla/5.0 Node.js" },
      timeout: 10000,
    });

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

    if (newRecords.length > 0) {
      console.log(`✅ [Background Sync] Extracted ${newRecords.length} records from 168y`);
      newRecords.forEach(rec => {
        if (!globalLotteryData.find(d => d.period === rec.period)) {
          globalLotteryData.push(rec);
        }
      });
      globalLotteryData.sort((a, b) => Number(b.period) - Number(a.period));
      if (globalLotteryData.length > 200) globalLotteryData = globalLotteryData.slice(0, 200);
    }

    const currentLatest = globalLotteryData.length > 0 ? Number(globalLotteryData[0].period) : 21317182;
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

    if (globalLotteryData.length >= 10) {
      globalAnalysis = perform3DAnalysis(globalLotteryData);
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

  // Initial sync
  terminalSyncAndAnalyze();
  
  // High-frequency sync every 30 seconds
  setInterval(() => {
    terminalSyncAndAnalyze();
  }, 30 * 1000);

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
  });
}

startServer();
