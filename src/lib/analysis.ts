export interface LotteryEntry {
  period: string;
  numbers: number[]; // e.g. [1, 5, 2, 10, 3, 4, 8, 9, 7, 6] where numbers[0] is Rank 1
}

export interface StockMetric {
  symbol: string;
  number: number;
  currentPrice: number; // Current Rank (Position)
  change: number; // Rank change vs last period (negative change is "rising" towards P1)
  changePercent: string;
  status: "high" | "low" | "mid"; // P4-P10 is high, P1-P3 is low
  volatility: number;
}

export interface AnalysisResult {
  regressionReport: string;
  consecutiveNumbers: { number: number; count: number; position: number }[];
  positionDensity: Record<number, number>; // number -> percentage in back zone (4-10)
  prediction: {
    number: number;
    targetZone: string;
    confidence: number;
    strategy: string;
    evolutionLevel: number;
    version: string;
  };
  hitHistory: boolean[]; // Last 20 prediction results
  predictionHistory: Record<string, number>; // period -> predictedNumber
  kLineData: any[];
  stockMarket: StockMetric[];
  evolutionMetrics: {
    learningCycles: number;
    memoryNodes: number;
    optimizationRate: string;
  };
  genePulse?: Record<string, number>;
  genePredictions?: Record<string, number>;
}

// Unified scoring function to ensure consistency between simulation and live predictions
/**
 * Genetic Strategy Chromosomes
 * Each one represents a different evolutionary path.
 */
interface StrategyChromosome {
  name: string;
  weights: {
    density: number;
    momentum: number;
    recency: number;
    p3Safety: number;
    zonePreference: number; // New: 1=P4, 2=P5-P7, 3=P8-P10
  };
}

const CHROMOSOMES: StrategyChromosome[] = [
  { name: "Rapid-Rebound", weights: { density: 1.0, momentum: 4.5, recency: 3.5, p3Safety: 0.5, zonePreference: 1 } }, // Zone 1: P4-P6
  { name: "Stable-Trend", weights: { density: 3.0, momentum: 0.5, recency: 0.2, p3Safety: 5.0, zonePreference: 2 } },  // Zone 2: P6-P8
  { name: "Alpha-Centrist", weights: { density: 2.0, momentum: 1.0, recency: 1.0, p3Safety: 1.0, zonePreference: 3 } }, // Zone 3: P7-P9
  { name: "Aggressive-Deep", weights: { density: 5.0, momentum: 0.05, recency: 0.1, p3Safety: 3.0, zonePreference: 4 } } // Zone 4: P8-P10
];

function calculateGeneticScore(
  num: number,
  history: number[],
  density: number,
  chromosome: StrategyChromosome,
  isLastRec: boolean
): number {
  if (isLastRec) return -999999;

  const curPos = history.length > 0 ? history[history.length - 1] : 10;
  const isValueZone = curPos >= 4 && curPos <= 10;
  
  const w = chromosome.weights;
  let score = (density / 100) * w.density;
  
  if (!isValueZone) {
    score *= 0.1; 
  } else {
    // Zone Specialization (New 4-District overlapping model)
    const pref = w.zonePreference;
    let isInTarget = false;
    
    if (pref === 1 && curPos >= 4 && curPos <= 6) isInTarget = true;
    else if (pref === 2 && curPos >= 6 && curPos <= 8) isInTarget = true;
    else if (pref === 3 && curPos >= 7 && curPos <= 9) isInTarget = true;
    else if (pref === 4 && curPos >= 8 && curPos <= 10) isInTarget = true;

    if (isInTarget) {
      score *= 3.0; // Significant boost for landing in assigned district
    } else {
      score *= 0.5; // Penalty for straying outside district
    }
    
    // P3 Proximity safeguard
    if (curPos === 4) score *= 0.2;
  }
  
  // Recent Trajectory (Momentum)
  const recent = history.slice(-3);
  if (recent.length >= 2) {
    const trend = recent[recent.length - 1] - recent[0];
    if (trend < 0) score *= (0.05 * w.momentum); // Extreme penalty for rising
    else score *= (2.0 * w.momentum); // Extreme reward for falling/stable
  }
  
  return score;
}

export function perform3DAnalysis(data: LotteryEntry[]): AnalysisResult {
  // ... (setup code remains same)
  const numRange = Array.from({ length: 10 }, (_, i) => i + 1);
  if (data.length < 10) { /* ... preamble same ... */ }

  const sortedData = [...data].sort((a, b) => Number(a.period) - Number(b.period));
  const totalPeriods = sortedData.length;

  const globalPosHistory: Record<number, number[]> = {};
  numRange.forEach(n => globalPosHistory[n] = []);
  sortedData.forEach(entry => {
    entry.numbers.forEach((num, rankIdx) => {
      if (globalPosHistory[num]) globalPosHistory[num].push(rankIdx + 1);
    });
  });

  // 1. Walk-Forward Simulation and Genetic Evolution
  const winnerHistory: Record<string, number> = {};
  const geneOverallLastRec: Record<string, number> = {};
  CHROMOSOMES.forEach(c => {
    winnerHistory[c.name] = 5.0; // Start with baseline "trust"
    geneOverallLastRec[c.name] = -1;
  });

  const fullSimulationHistory: boolean[] = [];
  const predictionHistory: Record<string, number> = {};
  const recHistory: number[] = [];
  const startSimIdx = 5; // Reduced from 10 to provide more historical depth

  for (let tIdx = startSimIdx; tIdx < totalPeriods; tIdx++) {
    const trainingData = sortedData.slice(0, tIdx);
    const targetEntry = sortedData[tIdx];

    // 关键修正：只有在该期已经有正式开奖结果的情况下，才记录红绿灯
    if (!targetEntry.numbers || targetEntry.numbers.length < 10) continue;

    const simHistoryMap: Record<number, number[]> = {};
    const simDensityMap: Record<number, number> = {};
    numRange.forEach(n => {
      const h: number[] = [];
      trainingData.forEach(e => {
        const r = e.numbers.indexOf(n);
        if (r !== -1) h.push(r + 1);
      });
      simHistoryMap[n] = h;
      simDensityMap[n] = (h.filter(p => p >= 4).length / (h.length || 1)) * 100;
    });

    // A. Identify the LEADER at this specific moment in history
    const currentLeadership = [...CHROMOSOMES].sort((a,b) => winnerHistory[b.name] - winnerHistory[a.name]);
    const alphaAtThisMoment = currentLeadership[0];

    // B. Re-calculate scores for the leader to get the system's official choice for this period
    const alphaCandidates = numRange.map(n => {
        const lastRec = recHistory.length > 0 ? recHistory[recHistory.length - 1] : null;
        return {
            num: n,
            score: calculateGeneticScore(n, simHistoryMap[n], simDensityMap[n], alphaAtThisMoment, n === lastRec)
        };
    }).sort((a, b) => b.score - a.score);
    
    const systemChoice = alphaCandidates[0].num;
    predictionHistory[targetEntry.period] = systemChoice;
    
    const systemRank = targetEntry.numbers.indexOf(systemChoice) + 1;
    // 只有主推号进入 P4-P10 才亮绿灯
    const isHit = systemRank >= 4 && systemRank <= 10;
    fullSimulationHistory.push(isHit);
    recHistory.push(systemChoice);

    // C. 核心：四大基因“责任区”演化考核
    const takenInRound = new Set<number>();
    currentLeadership.forEach(gene => {
      const candidates = numRange.map(n => ({
        num: n,
        score: calculateGeneticScore(n, simHistoryMap[n], (simHistoryMap[n].filter(p => p >= 4).length / (simHistoryMap[n].length || 1)) * 100, gene, false)
      })).sort((a, b) => b.score - a.score);

      let bestForGene = candidates[0].num;
      for (const cand of candidates) {
        if (!takenInRound.has(cand.num)) {
          bestForGene = cand.num;
          break;
        }
      }
      geneOverallLastRec[gene.name] = bestForGene; 
      takenInRound.add(bestForGene);
      
      const rank = targetEntry.numbers.indexOf(bestForGene) + 1;
      const isLatest = tIdx === totalPeriods - 1;
      let scoreDelta = 0;

      // 判定逻辑：必须落在自己的“责任区”才算满分，落在其他盈利区算生存，落在红区大减分
      const pref = gene.weights.zonePreference;
      const isBullseye = (pref === 1 && rank >= 4 && rank <= 6) || 
                        (pref === 2 && rank >= 6 && rank <= 8) || 
                        (pref === 3 && rank >= 7 && rank <= 9) || 
                        (pref === 4 && rank >= 8 && rank <= 10);

      if (rank >= 1 && rank <= 3) {
        scoreDelta = isLatest ? -4.0 : -2.5; // 红区处罚加剧
      } else if (isBullseye) {
        scoreDelta = isLatest ? 3.0 : 2.0; // 责任区命中奖励
      } else if (rank >= 4 && rank <= 10) {
        scoreDelta = isLatest ? 1.0 : 0.5; // 存活奖（非责任区但盈利）
      }
      
      winnerHistory[gene.name] += scoreDelta;
    });
  }

  // 2. Final Output Construction (UI 坑位分值：基于近期“责任区”命中率的动态脉冲)
  const normalizedGenePulse: Record<string, number> = {};
  const pulseWindow = 12;
  const zoneHits: Record<string, number> = {};
  
  CHROMOSOMES.forEach(c => zoneHits[c.name] = 0);

  const pulseStartIdx = Math.max(startSimIdx, totalPeriods - pulseWindow);
  for (let tIdx = pulseStartIdx; tIdx < totalPeriods; tIdx++) {
    const targetEntry = sortedData[tIdx];
    const trainingData = sortedData.slice(0, tIdx);
    
    // 获取当期各基因的预测号（复真当时状态）
    const simHistoryMap: Record<number, number[]> = {};
    numRange.forEach(n => {
      const h: number[] = [];
      trainingData.forEach(e => {
        const r = e.numbers.indexOf(n);
        if (r !== -1) h.push(r + 1);
      });
      simHistoryMap[n] = h;
    });

    const takenInRound = new Set<number>();
    const roundOrder = [...CHROMOSOMES].sort((a,b) => winnerHistory[b.name] - winnerHistory[a.name]);

    roundOrder.forEach(gene => {
      const candidates = numRange.map(n => ({
        num: n,
        score: calculateGeneticScore(n, simHistoryMap[n], (simHistoryMap[n].filter(p => p >= 4).length / (simHistoryMap[n].length || 1)) * 100, gene, false)
      })).sort((a, b) => b.score - a.score);

      let bestForGene = candidates[0].num;
      for (const cand of candidates) {
        if (!takenInRound.has(cand.num)) {
          bestForGene = cand.num;
          break;
        }
      }
      takenInRound.add(bestForGene);
      const rank = targetEntry.numbers.indexOf(bestForGene) + 1;
      const pref = gene.weights.zonePreference;
      const isBullseye = (pref === 1 && rank >= 4 && rank <= 6) || 
                        (pref === 2 && rank >= 6 && rank <= 8) || 
                        (pref === 3 && rank >= 7 && rank <= 9) || 
                        (pref === 4 && rank >= 8 && rank <= 10);
      
      if (isBullseye) zoneHits[gene.name]++;
    });
  }

  CHROMOSOMES.forEach(c => {
    // 坑位分数 = (近期责任区命中数 / 窗口期) * 10
    const hitRate = zoneHits[c.name] / pulseWindow;
    normalizedGenePulse[c.name] = Math.max(1, Math.min(10, Math.round(hitRate * 10 + 2))); // 基础分2分，随命中率波动
  });

  const finalLeadership = [...CHROMOSOMES].sort((a, b) => winnerHistory[b.name] - winnerHistory[a.name]);
  const finalAlpha = finalLeadership[0];
  const displayHitHistory = [...fullSimulationHistory].slice(-20);
  const redStreak = [...displayHitHistory].reverse().findIndex(h => h !== false); 
  
  const liveCandidates = numRange.map(n => {
    const history = globalPosHistory[n] || [];
    const density = (history.filter(p => p >= 4).length / (history.length || 1)) * 100;
    const lastRec = recHistory.length > 0 ? recHistory[recHistory.length - 1] : null;
    return {
      num: n,
      score: calculateGeneticScore(n, history, density, finalAlpha, n === lastRec)
    };
  }).sort((a, b) => b.score - a.score);

  const bestRec = liveCandidates[0].num;

  const genePredictions: Record<string, number> = {};
  const currentTaken = new Set<number>();
  
  finalLeadership.forEach(gene => {
    const candidates = numRange.map(n => {
        const h = globalPosHistory[n] || [];
        const d = (h.filter(p => p >= 4).length / (h.length || 1)) * 100;
        const lastRec = recHistory.length > 0 ? recHistory[recHistory.length - 1] : null;
        return { num: n, score: calculateGeneticScore(n, h, d, gene, n === lastRec) };
    }).sort((a, b) => b.score - a.score);
    
    let bestUnique = candidates[0].num;
    for (const c of candidates) {
      if (!currentTaken.has(c.num)) {
        bestUnique = c.num;
        break;
      }
    }
    genePredictions[gene.name] = bestUnique;
    currentTaken.add(bestUnique);
  });

  return {
    regressionReport: `遗传算法已激活：当前最优基因集 [${finalAlpha.name}]。已回溯分析${totalPeriods}期，并根据各基因共振频率完成${CHROMOSOMES.length}重路径重构。`,
    consecutiveNumbers: [], 
    positionDensity: {},
    prediction: {
      number: bestRec,
      targetZone: `逻辑基因: ${finalAlpha.name}`,
      confidence: Math.min(Math.round(liveCandidates[0].score * 80), 99),
      strategy: finalAlpha.name,
      evolutionLevel: (totalPeriods / 5) * 1.2 + (redStreak === -1 ? 20 * 50 : (redStreak * 50)),
      version: `V${Math.floor(totalPeriods/10)}.${finalAlpha.name.slice(0,2)}`
    },
    hitHistory: displayHitHistory,
    predictionHistory: predictionHistory,
    stockMarket: numRange.map(n => ({
      symbol: `$N${n.toString().padStart(2, '0')}`,
      number: n,
      currentPrice: globalPosHistory[n][globalPosHistory[n].length - 1] || 0,
      change: 0,
      changePercent: "0%",
      status: (globalPosHistory[n][globalPosHistory[n].length - 1] || 0) >= 4 ? "high" : "low",
      volatility: 0
    })),
    kLineData: sortedData.slice(-30).map(e => {
        const d: any = { period: e.period.slice(-3) };
        e.numbers.forEach((n, i) => d[`n${n}`] = i + 1);
        return d;
    }),
    evolutionMetrics: {
        learningCycles: totalPeriods * CHROMOSOMES.length,
        memoryNodes: totalPeriods * 15,
        optimizationRate: "Alpha-Resonance"
    },
    genePulse: normalizedGenePulse,
    genePredictions: genePredictions
  };
}
