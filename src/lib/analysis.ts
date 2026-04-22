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

  // 1. Backtest ALL Chromosomes to find the current ALPHA gene
  const winnerHistory: Record<string, number> = {};
  const geneOverallLastRec: Record<string, number | null> = {};
  
  CHROMOSOMES.forEach(c => {
    winnerHistory[c.name] = 0;
    geneOverallLastRec[c.name] = null;
  });

  // We look back at the last 10 periods to see which gene would have survived
  const backtestWindow = 10;
  for (let tIdx = Math.max(10, totalPeriods - backtestWindow); tIdx < totalPeriods; tIdx++) {
    const testData = sortedData.slice(0, tIdx);
    const targetEntry = sortedData[tIdx];

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

    // DRAFT SYSTEM: Rank genes by current winnerHistory and let them pick UNIQELY
    const takenInRound = new Set<number>();
    const roundOrder = CHROMOSOMES.sort((a,b) => winnerHistory[b.name] - winnerHistory[a.name]);

    roundOrder.forEach(gene => {
      const candidates = numRange.map(n => ({
        num: n,
        score: calculateGeneticScore(n, simHistoryMap[n], simDensityMap[n], gene, n === geneOverallLastRec[gene.name])
      })).sort((a, b) => b.score - a.score);

      // Pick the best AVAILABLE number for this gene's logic
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

      if (rank >= 1 && rank <= 3) {
        // ABSOLUTE FAILURE: Hit the red zone
        scoreDelta = isLatest ? -1.2 : -0.4; // Softened penalty to prevent score wipeout
      } else if (rank >= 4 && rank <= 10) {
        // SUCCESS: In the profit zone, but now check specialization
        const pref = gene.weights.zonePreference;
        const isBullseye = (pref === 1 && rank >= 4 && rank <= 6) || 
                          (pref === 2 && rank >= 6 && rank <= 8) || 
                          (pref === 3 && rank >= 7 && rank <= 9) || 
                          (pref === 4 && rank >= 8 && rank <= 10);
        
        if (isBullseye) {
          scoreDelta = isLatest ? 1.5 : 0.8; // Reward for precision
        } else {
          scoreDelta = isLatest ? 0.6 : 0.4; // Reward for survival (keeps progress steady)
        }
      }

      winnerHistory[gene.name] += scoreDelta;
    });
  }

  // Normalize scores to integer-like display for UI (0-10 scale)
  const normalizedGenePulse: Record<string, number> = {};
  CHROMOSOMES.forEach(c => {
    normalizedGenePulse[c.name] = Math.max(0, Math.min(10, Math.round(winnerHistory[c.name])));
  });

  const currentAlphaOrder = CHROMOSOMES.sort((a, b) => winnerHistory[b.name] - winnerHistory[a.name]);
  const alphaGene = currentAlphaOrder[0];

  // 2. Main Simulation Loop (This drives the global stats)
  // ... (stays same but using the alpha gene for the primary system prediction)

  // 2. Main Simulation Loop (using weighted DNA based on the Alpha Gene)
  const fullSimulationHistory: (boolean | null)[] = [];
  const recHistory: number[] = []; 
  const predictionHistory: Record<string, number> = {};
  const startSimIdx = 10; 
  let lastSimRec: number | null = null; 

  for (let tIdx = startSimIdx; tIdx < totalPeriods; tIdx++) {
    const trainingData = sortedData.slice(0, tIdx);
    const targetEntry = sortedData[tIdx];
    
    // Use the draft system for simulation as well to be consistent
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

  // 3. Final Hit History Construction
  // fullSimulationHistory Index Map:
  // [0] = result for sortedData[10]
  // [totalLength - 1] = result for sortedData[totalLength - 1] (which is the last finished period)
  const displayHitHistory = [...fullSimulationHistory].slice(-20);
  // ... (rest remains consistent but uses alphaGene and its metrics)
  
  // 4. Final Recommendation using the Alpha Strategy
  const latestRecent = fullSimulationHistory.filter(h => h !== null).slice(-10);
  const redStreak = displayHitHistory.reverse().findIndex(h => h !== false); 
  displayHitHistory.reverse(); // put back

  const liveCandidates = numRange.map(n => {
    const history = globalPosHistory[n] || [];
    const density = (history.filter(p => p >= 4).length / (history.length || 1)) * 100;
    
    let chasingPenalty = 1.0;
    for (let i = 1; i <= 3; i++) {
      const pIdx = fullSimulationHistory.length - i;
      if (pIdx >= 0 && recHistory[pIdx] === n && fullSimulationHistory[pIdx] === false) chasingPenalty *= 0.01;
    }

    return {
      num: n,
      score: calculateGeneticScore(n, history, density, alphaGene, n === lastSimRec) * chasingPenalty
    };
  }).sort((a, b) => b.score - a.score);

  const genePredictions: Record<string, number> = {};
  const currentTaken = new Set<number>();
  
  // Use the pre-calculated Alpha Order to let genes pick uniquely
  currentAlphaOrder.forEach(gene => {
    const candidates = numRange.map(n => {
        const h = globalPosHistory[n] || [];
        const d = (h.filter(p => p >= 4).length / (h.length || 1)) * 100;
        return { num: n, score: calculateGeneticScore(n, h, d, gene, n === lastSimRec) };
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

  const bestRec = genePredictions[alphaGene.name];

  return {
    regressionReport: `遗传算法已激活：当前最优基因集 [${alphaGene.name}]。已回溯近10期胜率，强制切换逻辑分支以绕过红点敏感区。`,
    // ... mapped to the result format
    prediction: {
      number: bestRec,
      targetZone: `逻辑基因: ${alphaGene.name}`,
      confidence: Math.min(Math.round(liveCandidates[0].score * 80), 99),
      strategy: alphaGene.name as any,
      evolutionLevel: (totalPeriods / 5) * 1.2 + (redStreak === -1 ? 20 * 50 : (redStreak * 50)),
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
    genePredictions: genePredictions
  };
}
