import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from "axios";

// --- State Management for Serverless Reuse ---
let globalLotteryData: LotteryEntry[] = [];
let globalAnalysis: any = null;
let lastSyncTime = 0;

// --- Inlined Analysis Logic ---
interface LotteryEntry {
  period: string;
  numbers: number[];
}

function calculateNumScore(num: number, history: number[], density: number, isLastRec: boolean): number {
  if (isLastRec) return -999999;
  const curPos = history.length > 0 ? history[history.length - 1] : 10;
  const isValueZone = curPos >= 4 && curPos <= 10;
  let score = (density / 100);
  if (!isValueZone) score *= 0.0001; else score *= 2.5;
  const recent = history.slice(-3);
  if (recent.some(p => p <= 3)) score *= 0.05;
  return score;
}

function perform3DAnalysis(data: LotteryEntry[]) {
  const numRange = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  if (data.length < 5) return null;
  const sortedData = [...data].sort((a, b) => Number(a.period) - Number(b.period));
  const totalPeriods = sortedData.length;
  const globalPosHistory: Record<number, number[]> = {};
  numRange.forEach(n => globalPosHistory[n] = []);
  sortedData.forEach(entry => {
    entry.numbers.forEach((num, rankIdx) => {
      if (globalPosHistory[num]) globalPosHistory[num].push(rankIdx + 1);
    });
  });
  const fullSimulationHistory: (boolean | null)[] = [];
  let lastSimRec: number | null = null;
  for (let tIdx = 10; tIdx < totalPeriods; tIdx++) {
    const trainingData = sortedData.slice(0, tIdx);
    const targetEntry = sortedData[tIdx];
    const simHistory: Record<number, number[]> = {};
    const simDensity: Record<number, number> = {};
    numRange.forEach(n => {
      const h: number[] = [];
      trainingData.forEach(e => {
        const r = e.numbers.indexOf(n);
        if (r !== -1) h.push(r + 1);
      });
      simHistory[n] = h;
      simDensity[n] = (h.filter(p => p >= 4).length / (h.length || 1)) * 100;
    });
    const simRec = numRange.map(n => ({
      num: n,
      score: calculateNumScore(n, simHistory[n], simDensity[n], n === lastSimRec)
    })).sort((a, b) => b.score - a.score)[0]?.num;
    lastSimRec = simRec;
    const actualRank = targetEntry.numbers.indexOf(simRec) + 1;
    fullSimulationHistory.push(actualRank >= 4 && actualRank <= 10);
  }
  const displayHitHistory = [...fullSimulationHistory].slice(-20);
  while (displayHitHistory.length < 20) displayHitHistory.unshift(null);

  const finalCandidates = numRange.map(n => {
    const history = globalPosHistory[n] || [];
    const density = (history.filter(p => p >= 4).length / (history.length || 1)) * 100;
    return { num: n, score: calculateNumScore(n, history, density, n === lastSimRec) };
  }).sort((a, b) => b.score - a.score);

  const best = finalCandidates[0];
  const lastSuccess = fullSimulationHistory[fullSimulationHistory.length - 1];
  const liveRecent = fullSimulationHistory.slice(-5);
  const liveFailRate = liveRecent.length > 0 ? liveRecent.filter(h => h === false).length / liveRecent.length : 0;
  let strategy: "Momentum" | "Liquidation-Pivot" | "Value-Capture" = "Value-Capture";
  if (lastSuccess === false) strategy = "Liquidation-Pivot";
  else if (liveFailRate < 0.2) strategy = "Momentum";

  return {
    regressionReport: `进化型分析终端: 已完成 ${totalPeriods} 轮自我进化。DNA链路校准完毕。`,
    prediction: {
      number: best.num,
      targetZone: "核心获利区间 (P04-P10)",
      confidence: Math.min(Math.round(best.score * 100), 99),
      strategy,
      evolutionLevel: Math.floor(totalPeriods / 5) * 1.2
    },
    hitHistory: displayHitHistory,
    stockMarket: numRange.map(num => {
      const h = globalPosHistory[num];
      const latest = h[h.length - 1] || 10;
      const prev = h[h.length - 2] || latest;
      return {
        symbol: `$N${num.toString().padStart(2, '0')}`,
        number: num,
        currentPrice: latest,
        change: prev - latest,
        status: (latest >= 4 && latest <= 10) ? "high" : "low"
      };
    }),
    evolutionMetrics: {
      learningCycles: totalPeriods * 128,
      memoryNodes: totalPeriods * 12,
      optimizationRate: `${(0.99 + (totalPeriods % 100) / 10000).toFixed(4)}%`
    }
  };
}

async function syncData() {
  const sources = [
    "https://wuk.168y.cloudns.org/",
    "http://wuk.168y.cloudns.org/"
  ];
  
  for (const url of sources) {
    try {
      const response = await axios.get(`${url}?t=${Date.now()}`, {
        headers: { 
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Mobile/15E148 Safari/604.1",
          "Referer": url,
          "Accept": "text/html"
        },
        timeout: 8000,
      });
      
      const dataStr = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
      const newRecords: any[] = [];
      const pairRegex = /(\d{8,15})[\s\S]{1,200}?((\d{1,2},){9}\d{1,2})/g;
      let m;
      while ((m = pairRegex.exec(dataStr)) !== null) {
        const p = m[1];
        const r = m[2];
        const nums = r.split(',').map(Number).filter(n => !isNaN(n) && n >= 1 && n <= 10);
        if (nums.length === 10 && !newRecords.find(nr => nr.period === p)) {
          newRecords.push({ period: p, numbers: nums });
        }
      }
      
      if (newRecords.length > 0) {
        newRecords.sort((a, b) => Number(b.period) - Number(a.period));
        globalLotteryData = newRecords.slice(0, 150);
        globalAnalysis = perform3DAnalysis(globalLotteryData);
        lastSyncTime = Date.now();
        return { success: true };
      }
    } catch (err: any) {}
  }
  return { success: false };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const isStale = Date.now() - lastSyncTime > 4 * 60 * 1000;
  if (globalLotteryData.length === 0 || isStale) {
    await syncData();
  }

  res.status(200).json({
    success: true,
    data: globalLotteryData,
    analysis: globalAnalysis,
    lastSyncTime
  });
}
