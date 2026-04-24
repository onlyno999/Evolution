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

export interface EvolutionLogRow {
  period: string;
  isLive: boolean;
  alphaGeneName: string;
  genes: Record<string, {
    prediction: number;
    rank: number | null;
    isHit: boolean;
    targetZone: string;
  }>;
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
  evolutionLogs: EvolutionLogRow[];
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
  { name: "RAPID", weights: { density: 1.0, momentum: 4.5, recency: 3.5, p3Safety: 2.0, zonePreference: 1 } }, // Zone 1: P4-P6
  { name: "STAL", weights: { density: 3.0, momentum: 3.5, recency: 2.0, p3Safety: 5.0, zonePreference: 2 } },  // Zone 2: P6-P8
  { name: "ALPH", weights: { density: 2.0, momentum: 4.0, recency: 3.0, p3Safety: 3.0, zonePreference: 3 } }, // Zone 3: P7-P9
  { name: "AGGR", weights: { density: 5.0, momentum: 2.5, recency: 4.0, p3Safety: 4.0, zonePreference: 4 } } // Zone 4: P8-P10
];

function calculateGeneticScore(
  num: number,
  history: number[],
  density: number,
  chromosome: StrategyChromosome,
  isLastRec: boolean
): number {
  if (isLastRec) return -999999;

  const historyLen = history.length;
  const curPos = historyLen > 0 ? history[historyLen - 1] : 7;
  // Calculate average position of last 5 periods to detect stability
  const avgPos = historyLen > 0 ? history.slice(-5).reduce((a, b) => a + b, 0) / Math.min(historyLen, 5) : 7;
  
  const w = chromosome.weights;
  // Base density score (how often it hits back zone in general)
  let score = (density / 100) * w.density * 5;
  
  // 1. Zone Specialization Bonus - Deep Integration with Evolution Logs
  const pref = w.zonePreference;
  let zoneMatchScore = 0;
  
  // Precise target scoring based on stability (avgPos) and current state (curPos)
  if (pref === 1 && avgPos >= 4 && avgPos <= 6) zoneMatchScore = 15;
  else if (pref === 2 && avgPos >= 6 && avgPos <= 8) zoneMatchScore = 15;
  else if (pref === 3 && avgPos >= 7 && avgPos <= 9) zoneMatchScore = 15;
  else if (pref === 4 && avgPos >= 8 && avgPos <= 10) zoneMatchScore = 15;

  score += zoneMatchScore;

  // 2. P3 Safety Guard (Avoiding the Red Zone)
  // If the number is currently in P1-P3 or on the edge (P4), heavily penalize
  if (curPos <= 3) score *= 0.05 * w.p3Safety;
  if (curPos === 4) score *= 0.4 * w.p3Safety;
  
  // 3. Momentum / Trajectory Tracking
  // We prefer numbers that are "falling" (moving from P1 towards P10) or stable in the back zone
  const recent = history.slice(-3);
  if (recent.length >= 2) {
    const trend = recent[recent.length - 1] - recent[0];
    if (trend > 0) {
      // Falling trajectory: Very good for staying out of P1-P3
      score *= (1.5 * w.momentum);
    } else if (trend === 0) {
      // Stable: Good if already in back zone
      if (curPos >= 4) score *= (1.2 * w.momentum);
    } else {
      // Rising trajectory: Risk of hitting P1-P3
      score *= (0.2 * w.momentum);
    }
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

  // 1. Backtest ALL Chromosomes to find the current ALPHA gene
  const winnerHistory: Record<string, number> = {};
  const geneOverallLastRec: Record<string, number | null> = {};
  const evolutionLogs: EvolutionLogRow[] = [];
  
  CHROMOSOMES.forEach(c => {
    winnerHistory[c.name] = 0;
    geneOverallLastRec[c.name] = null;
  });

  // DEEP WARM-UP: We look back at the last 60 periods to give weight to long-term survival
  // but we only display the last 20 (logLimit) in the UI logs.
  const totalWindow = 60;
  const logLimit = 20;

  for (let tIdx = Math.max(10, totalPeriods - totalWindow); tIdx < totalPeriods; tIdx++) {
    const testData = sortedData.slice(0, tIdx);
    const targetEntry = sortedData[tIdx];
    const isLogRow = tIdx >= (totalPeriods - logLimit);

    const simHistoryMap: Record<number, number[]> = {};
    const simDensityMap: Record<number, number> = {};
    numRange.forEach(n => {
      const h: number[] = [];
      testData.forEach(e => {
        const r = e.numbers.indexOf(n);
        if (r !== -1) h.push(r + 1);
      });
      simHistoryMap[n] = h;
      simDensityMap[n] = (h.filter(p => p >= 4).length / (h.length || 1)) * 100;
    });

    // Use a copy to sort to determine Alpha Gene for this row safely
    const sortedForThisRow = [...CHROMOSOMES].sort((a,b) => (winnerHistory[b.name] || 0) - (winnerHistory[a.name] || 0));
    const currentRowAlpha = sortedForThisRow[0].name;

    const logRow: EvolutionLogRow = {
      period: targetEntry.period,
      isLive: false,
      alphaGeneName: currentRowAlpha,
      genes: {}
    };

    // DRAFT SYSTEM: Rank genes by current winnerHistory and let them pick UNIQELY
    const takenInRound = new Set<number>();
    const roundOrder = [...sortedForThisRow];

    roundOrder.forEach(gene => {
      const candidates = numRange.map(n => ({
        num: n,
        score: calculateGeneticScore(n, simHistoryMap[n], simDensityMap[n], gene, n === geneOverallLastRec[gene.name])
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

      const pref = gene.weights.zonePreference;
      const targetZoneStr = pref === 1 ? "P4-6" : pref === 2 ? "P6-8" : pref === 3 ? "P7-9" : "P8-10";

      if (rank >= 1 && rank <= 3) {
        scoreDelta = isLatest ? -1.2 : -0.4;
      } else if (rank >= 4 && rank <= 10) {
        const isBullseye = (pref === 1 && rank >= 4 && rank <= 6) || 
                          (pref === 2 && rank >= 6 && rank <= 8) || 
                          (pref === 3 && rank >= 7 && rank <= 9) || 
                          (pref === 4 && rank >= 8 && rank <= 10);
        
        if (isBullseye) scoreDelta = isLatest ? 1.5 : 0.8;
        else scoreDelta = isLatest ? 0.6 : 0.4;
      }

      winnerHistory[gene.name] = (winnerHistory[gene.name] || 0) + scoreDelta;

      if (isLogRow) {
        logRow.genes[gene.name] = {
          prediction: bestForGene,
          rank: rank,
          isHit: rank >= 4 && rank <= 10,
          targetZone: targetZoneStr
        };
      }
    });

    if (isLogRow) {
      evolutionLogs.push(logRow);
    }
  }

  // Final Alpha Selection after backtest completes
  const finalAlphaOrder = [...CHROMOSOMES].sort((a,b) => (winnerHistory[b.name] || 0) - (winnerHistory[a.name] || 0));
  const alphaGene = finalAlphaOrder[0];

  // Primary Prediction based on defined Alpha
  const genePredictions: Record<string, number> = {};
  const currentTaken = new Set<number>();
  
  // Create the LIVE row based on final Alpha
  const lastCompletedIndex = totalPeriods - 1;
  const liveRow: EvolutionLogRow = {
    period: (Number(sortedData[lastCompletedIndex].period) + 1).toString(),
    isLive: true,
    alphaGeneName: alphaGene.name,
    genes: {}
  };

  finalAlphaOrder.forEach(gene => {
    const historyMap: Record<number, number[]> = {};
    const densityMap: Record<number, number> = {};
    numRange.forEach(n => {
      const h = globalPosHistory[n] || [];
      historyMap[n] = h;
      densityMap[n] = (h.filter(p => p >= 4).length / (h.length || 1)) * 100;
    });

    const candidates = numRange.map(n => ({
      num: n,
      score: calculateGeneticScore(n, historyMap[n], densityMap[n], gene, n === geneOverallLastRec[gene.name])
    })).sort((a, b) => b.score - a.score);

    let bestUnique = candidates[0].num;
    for (const c of candidates) {
        if (!currentTaken.has(c.num)) {
            bestUnique = c.num;
            break;
        }
    }
    
    genePredictions[gene.name] = bestUnique;
    currentTaken.add(bestUnique);
    
    const pref = gene.weights.zonePreference;
    liveRow.genes[gene.name] = {
      prediction: bestUnique,
      rank: null,
      isHit: false,
      targetZone: pref === 1 ? "P4-6" : pref === 2 ? "P6-8" : pref === 3 ? "P7-9" : "P8-10"
    };
  });
  
  const displayLogs = [liveRow, ...evolutionLogs.reverse()];

  // Normalize Gene Pulse
  const normalizedGenePulse: Record<string, number> = {};
  CHROMOSOMES.forEach(c => {
    normalizedGenePulse[c.name] = Math.max(0, Math.min(10, Math.round((winnerHistory[c.name] || 0))));
  });

  // 2. Simulation Stats and Final Recommendation
  const fullSimulationHistory: (boolean | null)[] = [];
  const recHistory: number[] = []; 
  const predictionHistory: Record<string, number> = {};
  const startSimIdx = 10; 
  let lastSimRec: number | null = null; 

  for (let tIdx = startSimIdx; tIdx < totalPeriods; tIdx++) {
    const trainingData = sortedData.slice(0, tIdx);
    const targetEntry = sortedData[tIdx];
    
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

    const simCandidates = numRange.map(n => ({
      num: n,
      score: calculateGeneticScore(n, simHistoryMap[n], simDensityMap[n], alphaGene, n === lastSimRec)
    })).sort((a, b) => b.score - a.score);

    const simRec = simCandidates[0]?.num;
    lastSimRec = simRec; 
    recHistory.push(simRec);
    predictionHistory[targetEntry.period] = simRec;

    const actualRank = targetEntry.numbers.indexOf(simRec) + 1;
    fullSimulationHistory.push(actualRank >= 4 && actualRank <= 10);
  }

  const displayHitHistory = [...fullSimulationHistory].slice(-20);
  const redStreak = [...displayHitHistory].reverse().findIndex(h => h !== false); 

  const bestRec = genePredictions[alphaGene.name];
  const liveCandidates = numRange.map(n => {
    const h = globalPosHistory[n] || [];
    const d = (h.filter(p => p >= 4).length / (h.length || 1)) * 100;
    return { num: n, score: calculateGeneticScore(n, h, d, alphaGene, n === bestRec) };
  }).sort((a, b) => b.score - a.score);

  const finalDensityMap: Record<number, number> = {};
  numRange.forEach(n => {
    const h = globalPosHistory[n] || [];
    finalDensityMap[n] = (h.filter(p => p >= 4).length / (h.length || 1)) * 100;
  });

  return {
    regressionReport: `遗传算法已锁定：${alphaGene.name} 基因当前表现最优。已将模型权重同步至 ${alphaGene.name} 专属参数集，锁定高效值洼地区域。`,
    prediction: {
      number: bestRec,
      targetZone: `高价值坑位: ${liveRow.genes[alphaGene.name].targetZone}`,
      confidence: Math.min(Math.round(liveCandidates[0].score * 4.5), 99),
      strategy: alphaGene.name as any,
      evolutionLevel: (totalPeriods / 5) * 1.2 + (redStreak === -1 ? 1000 : (redStreak * 50)),
      version: `V${Math.floor(totalPeriods/10)}.${alphaGene.name.slice(0,2)}`
    },
    hitHistory: displayHitHistory,
    predictionHistory: predictionHistory,
    stockMarket: numRange.map(n => ({
      symbol: `$N${n.toString().padStart(2, '0')}`,
      number: n,
      currentPrice: globalPosHistory[n][globalPosHistory[n].length - 1],
      change: 0,
      changePercent: "0%",
      status: "high",
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
    genePredictions: genePredictions,
    evolutionLogs: displayLogs,
    consecutiveNumbers: [],
    positionDensity: finalDensityMap
  };
}
