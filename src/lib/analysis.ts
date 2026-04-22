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
  geneLastRanks?: Record<string, number>;
  geneHistory?: { period: string; leader: string; results: Record<string, { num: number; rank: number }> }[];
}

// Unified scoring function to ensure consistency between simulation and live predictions
/**
 * Genetic Strategy Chromosomes
 * Each one represents a different evolutionary path.
 */
export interface StrategyChromosome {
  name: string;
  weights: {
    density: number;
    momentum: number;
    recency: number;
    p3Safety: number;
    zonePreference: number; // New: 1=P4, 2=P5-P7, 3=P8-P10
  };
}

export const CHROMOSOMES: StrategyChromosome[] = [
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
    winnerHistory[c.name] = 100.0; // 全部初始化：100分
    geneOverallLastRec[c.name] = -1;
  });

  const fullSimulationHistory: boolean[] = [];
  const predictionHistory: Record<string, number> = {};
  const recHistory: number[] = [];
  const geneHistoryLogs: { period: string; leader: string; results: Record<string, { num: number; rank: number }> }[] = [];
  
  // 深度演化固化：将模拟深度从 20 期提升到 100 期
  // 这样在计算最近 20 期红绿灯时，各基因已经有了 80 期的积分底蕴，霸主地位更稳固
  // 历史接力记录（谁在那一期当班）就不会因为单次的换届而产生蝴蝶效应
  const walkStartIdx = Math.max(5, totalPeriods - 100); 

  for (let tIdx = walkStartIdx; tIdx < totalPeriods; tIdx++) {
    const trainingData = sortedData.slice(0, tIdx);
    const targetEntry = sortedData[tIdx];

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

    const currentLeadership = [...CHROMOSOMES].sort((a,b) => winnerHistory[b.name] - winnerHistory[a.name]);
    
    // Assign unique numbers for THIS round based on hierarchy
    const takenInRound = new Set<number>();
    const roundPredictions: Record<string, number> = {};

    currentLeadership.forEach(gene => {
      const candidates = numRange.map(n => ({
        num: n,
        score: calculateGeneticScore(n, simHistoryMap[n], simDensityMap[n], gene, recHistory.length > 0 && n === recHistory[recHistory.length - 1])
      })).sort((a, b) => b.score - a.score);

      let bestForGene = candidates[0].num;
      for (const cand of candidates) {
        if (!takenInRound.has(cand.num)) {
          bestForGene = cand.num;
          break;
        }
      }
      roundPredictions[gene.name] = bestForGene;
      takenInRound.add(bestForGene);
    });

    const systemChoice = roundPredictions[currentLeadership[0].name];
    predictionHistory[targetEntry.period] = systemChoice;
    const systemRank = targetEntry.numbers.indexOf(systemChoice) + 1;
    fullSimulationHistory.push(systemRank >= 4 && systemRank <= 10);
    recHistory.push(systemChoice);

    const periodResults: Record<string, { num: number; rank: number }> = {};

    // 全量积分累积：严格执行用户最新的奖惩标准
    CHROMOSOMES.forEach(gene => {
      const pred = roundPredictions[gene.name];
      const rank = targetEntry.numbers.indexOf(pred) + 1;
      const pref = gene.weights.zonePreference;
      
      periodResults[gene.name] = { num: pred, rank: rank };

      const isBullseye = (pref === 1 && rank >= 4 && rank <= 6) || 
                        (pref === 2 && rank >= 6 && rank <= 8) || 
                        (pref === 3 && rank >= 7 && rank <= 9) || 
                        (pref === 4 && rank >= 8 && rank <= 10);

      let delta = 0;
      if (rank >= 1 && rank <= 3) {
        delta = -15.0; // 闯红灯：扣15
      } else if (isBullseye) {
        delta = 10.0;  // 指定坑位：涨10
      } else if (rank >= 4 && rank <= 10) {
        delta = 5.0;   // 安全区命中：涨5
      }
      
      winnerHistory[gene.name] = Math.max(1, Math.min(1000, winnerHistory[gene.name] + delta));
    });

    geneHistoryLogs.push({
      period: targetEntry.period,
      leader: currentLeadership[0].name,
      results: periodResults
    });
  }

  // 2. Final Output Construction
  // 提取当前最新预测 (Next Round)，将其作为“待开奖”行加入历史记录
  const finalLeadership = [...CHROMOSOMES].sort((a, b) => {
    return winnerHistory[b.name] - winnerHistory[a.name];
  });
  const finalAlpha = finalLeadership[0];

  // 恢复接力模式：红绿灯记录的是每一期【当时对应霸主】的真实战绩
  // 无论谁在台上，红绿灯只看那一刻正式推荐的号准不准，形成连续的接力账本
  // 过滤掉 rank: -1 的待开奖行，只取最近 20 期已入账的结果，确保灯位全满（只要数据够）
  const completedHistory = geneHistoryLogs.filter(h => {
    const leader = h.leader;
    return h.results[leader] && h.results[leader].rank !== -1;
  });

  const displayHitHistory: boolean[] = completedHistory.slice(-20).map(round => {
    const res = round.results[round.leader];
    return res.rank >= 4 && res.rank <= 10;
  });

  const redStreak = [...displayHitHistory].reverse().findIndex(h => h !== false); 
  
  const liveCandidates = numRange.map(n => {
    const history = globalPosHistory[n] || [];
    const d = (history.filter(p => p >= 4).length / (history.length || 1)) * 100;
    const lastRec = recHistory.length > 0 ? recHistory[recHistory.length - 1] : null;
    return {
      num: n,
      score: calculateGeneticScore(n, history, d, finalAlpha, n === lastRec)
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

  // 关键：将“当前预测”压入历史日志的第一行，名次标注为 -1 (代表待定)
  const lastFinishedEntry = sortedData[totalPeriods - 1];
  if (lastFinishedEntry) {
    const nextPeriod = (parseInt(lastFinishedEntry.period) + 1).toString();
    const nextRoundResults: Record<string, { num: number; rank: number }> = {};
    CHROMOSOMES.forEach(g => {
        nextRoundResults[g.name] = { num: genePredictions[g.name], rank: -1 };
    });
    geneHistoryLogs.push({
        period: nextPeriod,
        leader: finalAlpha.name,
        results: nextRoundResults
    });
  }

  // 提取最后一期实战结果作为“卡片展示”的上期名次
  const geneLastRanks: Record<string, number> = {};
  // 注意：因为我们刚加了“待定”行，所以上期结果要在倒数第二行找，或者直接从刚才的循环记录中取
  const genuineHistory = geneHistoryLogs.filter(h => Object.values(h.results).every(r => r.rank !== -1));
  if (genuineHistory.length > 0) {
    const lastDrawn = genuineHistory[genuineHistory.length - 1];
    Object.entries(lastDrawn.results).forEach(([name, res]) => {
      geneLastRanks[name] = res.rank;
    });
  }

  const normalizedGenePulse: Record<string, number> = {};
  CHROMOSOMES.forEach(c => {
    normalizedGenePulse[c.name] = Math.round(winnerHistory[c.name]);
  });

  return {
    regressionReport: `遗传算法已激活：当前最优基因集 [${finalAlpha.name}]。已针对第${(parseInt(lastFinishedEntry?.period || '0') + 1)}期完成最新路径演化。`,
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
    genePredictions: genePredictions,
    geneLastRanks: geneLastRanks,
    geneHistory: geneHistoryLogs
  };
}
