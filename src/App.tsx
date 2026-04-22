import React, { useState, useEffect, useMemo } from "react";
import { 
  PawPrint,
  TrendingDown,
  BarChart3, 
  Cpu, 
  History, 
  Layers, 
  Scan, 
  Target, 
  AlertCircle,
  RefreshCw,
  Zap,
  Microscope,
  Box,
  LineChart,
  Database,
  Activity,
  ChevronRight
} from "lucide-react";
import { 
  ComposedChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer, 
  Area
} from "recharts";
import { motion, AnimatePresence } from "motion/react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

import { perform3DAnalysis, type LotteryEntry, type AnalysisResult, CHROMOSOMES } from "./lib/analysis";
import { 
  fetchHitHistoryFromCloud, 
  syncHitHistoryToCloud, 
  updateLiveStatus, 
  getLiveStatus,
  ensureAuth,
  subscribeToLiveStatus,
  subscribeToHitHistory,
  SharedHit
} from "./lib/firebase";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Custom Tooltip for Technical Chart
const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-[#161a20] border border-[#2d343d] p-3 shadow-2xl backdrop-blur-md">
        <p className="text-[#94a3b8] text-[10px] mb-1 font-mono uppercase tracking-widest">{label} 期</p>
        {payload.map((p: any, i: number) => (
          <div key={i} className="flex items-center gap-2 mt-1">
            <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: p.color }} />
            <span className="text-[#e0e6ed] text-[11px] font-mono">{p.name}: <span className="font-bold">P{p.value}</span></span>
          </div>
        ))}
      </div>
    );
  }
  return null;
};

export default function App() {
  const [data, setData] = useState<LotteryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNum, setSelectedNum] = useState<number>(1);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<{ source: string, count: number } | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  
  // High-level render guard to prevent white/black screen on crash
  const [hasCriticalError, setHasCriticalError] = useState(false);

  const [nextDraw, setNextDraw] = useState<{ period: string; countdown: string }>({ period: "21317183", countdown: "00:00:00" });
  const [beijingTime, setBeijingTime] = useState<string>("");
  const [timeOffset, setTimeOffset] = useState<number>(0);
  const [targetTime, setTargetTime] = useState<number | null>(null);

  // Render error recovery
  if (hasCriticalError) {
    return (
      <div className="min-h-screen bg-[#090b0e] flex items-center justify-center p-6 text-white font-sans">
        <div className="bg-[#161a20] border border-red-500/30 p-8 rounded-lg max-w-md w-full text-center">
          <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
          <h2 className="text-[#e0e6ed] text-xl font-bold mb-2">系统引擎加载失败</h2>
          <p className="text-[#94a3b8] text-sm mb-6">行情分析链路出现预期外错误。请尝试刷新页面恢复监控。</p>
          <button onClick={() => window.location.reload()} className="px-6 py-2 bg-red-500 hover:bg-red-600 text-white rounded font-bold">立刻刷新页面</button>
        </div>
      </div>
    );
  }

  // Beijing Time Clock (Synced with Server Offset)
  useEffect(() => {
    const updateTime = () => {
      const syncedNow = new Date(Date.now() + timeOffset);
      const options: Intl.DateTimeFormatOptions = {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      };
      setBeijingTime(new Intl.DateTimeFormat('en-US', options).format(syncedNow));
    };
    updateTime();
    const timer = setInterval(updateTime, 1000);
    return () => clearInterval(timer);
  }, [timeOffset]);

  const lastTriggeredTarget = React.useRef<number>(0);

  // High-Precision Sync Countdown
  useEffect(() => {
    const timer = setInterval(() => {
      if (!targetTime) return;

      const nowSynced = Date.now() + timeOffset;
      const diff = Math.max(0, Math.floor((targetTime - nowSynced) / 1000));

      if (diff <= 0) {
        setNextDraw(prev => ({ ...prev, countdown: "00:00:00" }));
        return;
      }

      const h = Math.floor(diff / 3600);
      const m = Math.floor((diff % 3600) / 60);
      const s = diff % 60;

      const newTimeStr = [
        h.toString().padStart(2, '0'),
        m.toString().padStart(2, '0'),
        s.toString().padStart(2, '0')
      ].join(':');

      setNextDraw(prev => ({ ...prev, countdown: newTimeStr }));
    }, 1000);
    return () => clearInterval(timer);
  }, [targetTime, timeOffset]);

  const [backendAnalysis, setBackendAnalysis] = useState<AnalysisResult | null>(null);
  const [cloudHits, setCloudHits] = useState<Record<string, boolean>>({});
  const [cloudPrediction, setCloudPrediction] = useState<{ period: string, prediction: any } | null>(null);

  useEffect(() => {
    let unsubLive: (() => void) | null = null;
    let unsubHits: (() => void) | null = null;

    const initCloud = async () => {
      try {
        await ensureAuth();
        
        // 1. Subscribe to Historical Consensus (Real-time history sync)
        unsubHits = subscribeToHitHistory((history) => {
          const map: Record<string, boolean> = {};
          history.forEach(h => map[h.period] = h.isHit);
          setCloudHits(map);
          setSyncStatus(prev => ({ source: "Cloud", count: Object.keys(map).length }));
        });

        // 2. Subscribe to Live Consensus (Master Number sync)
        unsubLive = subscribeToLiveStatus((data) => {
          if (data && data.prediction) {
            setCloudPrediction({
              period: data.period,
              prediction: data.prediction
            });
          }
        });
      } catch (e) {
        console.error("Cloud Synchro Failure:", e);
      }
    };
    initCloud();
    return () => {
      unsubLive?.();
      unsubHits?.();
    };
  }, [data.length]);

  const fetchLotteryData = async (silent = false) => {
    if (isRefreshing) return; 
    if (!silent) setLoading(true);
    setIsRefreshing(true);
    try {
      // Aggressively bypass cache
      const resp = await fetch(`/api/lottery-data?t=${Date.now()}&_=${Math.random()}`);
      const json = await resp.json();
      if (json.success) {
        if (json.serverTime) {
          const newOffset = json.serverTime - Date.now();
          // Only update offset if drift is significant (>2s) to prevent loop
          if (Math.abs(newOffset - timeOffset) > 2000 || timeOffset === 0) {
            setTimeOffset(newOffset);
          }
        }

        const newData = json.data || [];
        setData(newData);
        if (json.analysis) {
          setBackendAnalysis(json.analysis);
        }
        setSyncStatus({ source: json.source, count: newData.length });
        
        if (json.nextDraw) {
          setNextDraw(json.nextDraw);
          
          if (json.serverTime) {
            const parts = json.nextDraw.countdown.split(':');
            if (parts.length === 3) {
              const seconds = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
              setTargetTime(json.serverTime + seconds * 1000);
            }
          }
        }
        setError(null);
      } else {
        setError("无法拉取最新行情数据");
      }
    } catch (err) {
      console.error(err);
      setError("网络错误：行情引擎链路中断");
    } finally {
      if (!silent) setLoading(false);
      setIsRefreshing(false);
      setLastUpdated(new Date());
    }
  };

  useEffect(() => {
    fetchLotteryData();
  }, []);

  useEffect(() => {
    // Dual-Layer Sync Architecture
    const schedule = setInterval(() => {
      const nowSynced = Date.now() + timeOffset;
      const syncedDate = new Date(nowSynced);
      
      const minutes = syncedDate.getMinutes();
      const seconds = syncedDate.getSeconds();
      
      // EXCLUSIVE SYNC WINDOW: Only refresh at X4:50 and X9:50
      // This prevents server overload and client-side instability
      if (minutes % 5 === 4 && seconds === 50) {
        console.log(`[Scheduled Sync] Running at ${syncedDate.toLocaleTimeString()}`);
        fetchLotteryData(true);
      }
    }, 1000);
    
    return () => clearInterval(schedule);
  }, [targetTime, timeOffset]);

  const analysis = useMemo(() => {
    if (data.length === 0) return null;
    
    // 1. Get temporary simulated analysis
    const result = perform3DAnalysis(data);
    
    // 2. Pure UI Logic: Combine current results with cloud overrides
    try {
      const storageKey = "evolution_consensus_v7_alignment";
      const saved = localStorage.getItem(storageKey);
      const localHistoryMap: Record<string, boolean> = saved ? JSON.parse(saved) : {};
      
      const combinedHistoryMap = { ...localHistoryMap, ...cloudHits };
      
      const finishedRounds = data.filter(d => d.numbers && d.numbers.length === 10);
      
      // 深度对齐：我们有 result.hitHistory [旧 -> 新]
      // 也有 finishedRounds [新 -> 旧]
      // 我们需要确保显示出的 20 个灯，准确对应最近的 20 个已开奖期号
      const finalizedHistory = result.hitHistory.map((h, i) => {
        const offset = result.hitHistory.length - 1 - i;
        const targetRound = finishedRounds[offset];
        
        if (targetRound) {
          const p = targetRound.period;
          const predNum = result.predictionHistory[p];
          
          // CRITICAL: Force UI to calculate truth based on actual rank if cloud sync is messy
          if (predNum !== undefined) {
             const actualRank = targetRound.numbers.indexOf(predNum) + 1;
             // Any position between 4 and 10 is a definitive GREEN HIT
             if (actualRank >= 4 && actualRank <= 10) return true;
             if (actualRank >= 1 && actualRank <= 3) return false;
          }

          if (combinedHistoryMap[p] !== undefined) return combinedHistoryMap[p];
        }
        return h;
      });

      result.hitHistory = finalizedHistory;

      // 3. Consensus Override: Use cloud prediction if same period
      const currentPeriod = data[0]?.period;
      if (cloudPrediction && cloudPrediction.period === currentPeriod) {
        result.prediction = cloudPrediction.prediction;
        if (cloudPrediction.resonanceData) {
          result.genePulse = cloudPrediction.resonanceData;
        }
        if (cloudPrediction.evolutionMetadata) {
          result.evolutionMetrics = cloudPrediction.evolutionMetadata;
        }
      }
    } catch (e) {
      console.warn("Resonance Convergence Failure:", e);
    }
    
    return result;
  }, [data, cloudHits, cloudPrediction]);

  // Auto-select the recommended number when analysis updates
  useEffect(() => {
    if (analysis?.prediction.number) {
      setSelectedNum(analysis.prediction.number);
    }
  }, [analysis?.prediction.number]);

  // Handle Cloud Data Persistence Side-effects (Moved after analysis declaration)
  useEffect(() => {
    if (!analysis || data.length === 0) return;

    try {
      const storageKey = "evolution_consensus_v7_alignment";
      const saved = localStorage.getItem(storageKey);
      const localHistoryMap: Record<string, boolean> = saved ? JSON.parse(saved) : {};
      
      const newHitsForCloud: SharedHit[] = [];
      let hasUpdate = false;

      // Detect if we have new results that need to be broadcast to cloud
      analysis.hitHistory.forEach((h, i) => {
        const reverseIdx = analysis.hitHistory.length - 1 - i;
        const finishedRounds = data.filter(d => d.numbers && d.numbers.length === 10);
        const targetRound = finishedRounds[reverseIdx];

        if (targetRound) {
          const p = targetRound.period;
          const historicalPredictionNum = analysis.predictionHistory[p];
          
          if (cloudHits[p] === undefined && h !== null && localHistoryMap[p] === undefined && historicalPredictionNum) {
             localHistoryMap[p] = h;
             newHitsForCloud.push({
               period: p,
               isHit: h,
               number: historicalPredictionNum,
               strategy: analysis.prediction.strategy,
               timestamp: new Date().toISOString()
             });
             hasUpdate = true;
          }
        }
      });

      if (hasUpdate) {
        localStorage.setItem(storageKey, JSON.stringify(localHistoryMap));
        syncHitHistoryToCloud(newHitsForCloud).catch(console.error);
        
        // Always push current prediction to cloud if it's the latest (including Pulse resonance)
        // Add fallbacks to ensure Firestore doesn't receive 'undefined'
        updateLiveStatus(
          data[0].period, 
          analysis.prediction || {}, 
          analysis.evolutionMetrics || {}, 
          analysis.genePulse || {}
        ).catch(console.error);
      }
    } catch (e) {
      console.warn("Cloud Sync Execution Failure:", e);
    }
  }, [analysis?.prediction.number, data.length, cloudHits]);

  // Initial loading state or critical data missing
  if (loading && data.length === 0) {
    return (
      <div className="min-h-screen bg-[#090b0e] flex flex-col items-center justify-center p-6 text-white font-sans">
        <div className="relative">
           <div className="w-16 h-16 border-4 border-[#00ff9d]/20 border-t-[#00ff9d] rounded-full animate-spin mb-6" />
           <Cpu className="w-8 h-8 text-[#00ff9d] absolute top-4 left-4 animate-pulse" />
        </div>
        <h2 className="text-[#e0e6ed] text-lg font-bold tracking-widest uppercase mb-2">PRA Engine Booting</h2>
        <p className="text-[#94a3b8] text-[10px] uppercase tracking-[0.2em] animate-pulse">Synchronizing Global Market Nodes...</p>
      </div>
    );
  }

  return (
    <div className="sleek-grid">
      {/* Header */}
      <header className="header sleek-panel flex flex-col lg:flex-row lg:items-center justify-between px-4 lg:px-6 z-50 py-3 lg:py-0 gap-3 lg:gap-0 h-auto lg:h-[60px]">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 sm:gap-3 shrink-0">
          <div className="flex items-center gap-2">
            <Cpu className="w-5 h-5 text-[#00ff9d]" />
            <h1 className="text-sm sm:text-lg font-bold tracking-wide text-[#00ff9d] uppercase">
              进化型分析终端
            </h1>
          </div>
          <div className="flex flex-col items-start gap-1">
            <div className="flex items-center gap-1.5">
              <span className={cn(
                "status-badge px-2 py-1 border text-[9px] sm:text-[10px] font-mono rounded uppercase transition-colors duration-500",
                syncStatus?.source === 'live' 
                  ? "bg-[#00ff9d]/10 text-[#00ff9d] border-[#00ff9d]/20" 
                  : "bg-amber-500/10 text-amber-500 border-amber-500/20"
              )}>
                {syncStatus?.source === 'live' ? 'Evolution Engine Live' : 'AI Cluster Learning...'}
              </span>
              <span className="flex items-center gap-1 px-1.5 py-0.5 bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded text-[8px] font-bold uppercase animate-pulse">
                <Target className="w-2.5 h-2.5" />
                Global Consensus Active
              </span>
            </div>
            {isRefreshing && (
              <RefreshCw className="w-2 h-2 text-[#00ff9d] animate-spin ml-2" />
            )}
            {lastUpdated && (
              <span className="text-white/20 text-[8px] font-mono whitespace-nowrap ml-1 tracking-tighter">
                LAST_SYNC: {lastUpdated.toLocaleTimeString()} [{syncStatus?.count || 0}P]
              </span>
            )}
          </div>
        </div>
        
        {/* Simplified Ticker */}
        <div className="hidden xl:flex items-center gap-4 overflow-hidden max-w-2xl px-4 border-x border-[#2d343d]">
           <div className="flex animate-marquee whitespace-nowrap gap-6">
             {analysis?.stockMarket.map(stock => (
               <div key={stock.symbol} className="flex items-center gap-2">
                  <span className="text-[#e0e6ed] text-[10px] font-mono font-bold">{stock.symbol}</span>
                  <span className={cn("text-[9px] font-mono", stock.change > 0 ? "text-[#00ff9d]" : "text-[#ff4e50]")}>
                    {stock.changePercent}
                  </span>
               </div>
             ))}
           </div>
        </div>

        <div className="flex items-center justify-between sm:justify-end gap-4 sm:gap-6 text-[11px] sm:text-[12px] font-mono text-[#94a3b8]">
          <div className="flex flex-col items-end border-r border-[#2d343d] pr-4">
             <div className="flex items-center gap-2 mb-1">
               <span className="relative flex h-2 w-2">
                 <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00ff9d] opacity-75"></span>
                 <span className="relative inline-flex rounded-full h-2 w-2 bg-[#00ff9d]"></span>
               </span>
               <span className="text-[10px] px-1.5 py-0.5 bg-[#00ff9d]/10 text-[#00ff9d] border border-[#00ff9d]/20 rounded uppercase font-bold tracking-tighter text-nowrap">4/9 Grid Sync +05s</span>
             </div>
             <span className="text-[#00ff9d] font-black text-[16px] sm:text-[20px] tracking-[0.1em] leading-none font-mono">{beijingTime}</span>
          </div>
          <div className="flex flex-col items-end border-r border-[#2d343d] pr-4">
             <div className="flex flex-col items-end">
               <span className="text-[10px] text-[#3b82f6] uppercase font-bold mb-0.5 whitespace-nowrap">Focus Target</span>
               <span className="text-[#e0e6ed] font-black text-[14px] lg:text-[16px] font-mono tracking-tight">{nextDraw.period}</span>
             </div>
          </div>
          <div className="flex flex-col items-end">
             <span className="hidden lg:inline text-[#e0e6ed] font-bold text-[10px]">SYNCED: {lastUpdated.toLocaleTimeString('zh-CN', { hour12: false })}</span>
             <span className="text-[9px] opacity-70 italic text-[#00ff9d] uppercase">Neural Link Established</span>
          </div>
          <button 
            onClick={() => fetchLotteryData()}
            disabled={loading}
            className="p-1.5 sm:p-2 border border-[#2d343d] hover:border-[#00ff9d] transition-colors rounded disabled:opacity-50"
          >
            <RefreshCw className={cn("w-3.5 h-3.5 sm:w-4 h-4", loading && "animate-spin")} />
          </button>
        </div>
      </header>

      <div className="dashboard-scroll">
        <div className="dashboard-container">
          <div className="pc-main-layout">
      <aside className="sidebar sleek-panel p-4 lg:p-5 overflow-y-auto flex flex-col gap-6 lg:h-full">
        {/* Evolutionary Status */}
        <section className={cn(
          "p-4 border rounded mb-2 transition-all duration-500",
          analysis?.prediction?.strategy === "INSTANT-RESCUE" 
            ? "bg-[#ff4e50]/10 border-[#ff4e50]/30 animate-pulse" 
            : "bg-[#00ff9d]/5 border-[#00ff9d]/10"
        )}>
           <div className="flex items-center justify-between mb-3">
             <div className="flex items-center gap-2">
               <Zap className={cn("w-3 h-3", analysis?.prediction?.strategy === "INSTANT-RESCUE" ? "text-[#ff4e50]" : "text-[#00ff9d]")} />
               <span className={cn(
                 "text-[10px] font-black uppercase tracking-widest",
                 analysis?.prediction?.strategy === "INSTANT-RESCUE" ? "text-[#ff4e50]" : "text-[#00ff9d]"
               )}>
                 {analysis?.prediction?.strategy === "INSTANT-RESCUE" ? "Instant Rescue Active" : "Infinite learning Active"}
               </span>
             </div>
             <span className="text-[9px] font-black font-mono text-white/60 bg-white/5 px-1.5 py-0.5 rounded border border-white/10">
               {analysis?.prediction?.version ?? "V1.0.0"}
             </span>
           </div>
           <div className="grid grid-cols-2 gap-4 font-mono">
              <div className="flex flex-col">
                <span className="text-[8px] text-white/40 uppercase">Evolution Level</span>
                <span className={cn(
                  "text-[12px] font-bold",
                  analysis?.prediction?.strategy === "INSTANT-RESCUE" ? "text-[#ff4e50]" : "text-[#00ff9d]"
                )}>LV.{analysis?.prediction?.evolutionLevel?.toFixed(1) ?? "0.0"}</span>
              </div>
              <div className="flex flex-col items-end relative">
                <span className="text-[8px] text-white/40 uppercase">Evo_Version</span>
                <div className="flex items-center gap-1.5">
                  <motion.div 
                    animate={{ scale: [1, 1.2, 1], opacity: [1, 0.5, 1] }}
                    transition={{ duration: 2, repeat: Infinity }}
                    className="w-1 h-1 rounded-full bg-[#00ff9d]"
                  />
                  <span className={cn(
                    "text-[12px] font-black",
                    (analysis?.prediction.evolutionLevel || 0) > 200 ? "text-[#ff4e50]" : "text-[#00ff9d]"
                  )}>{analysis?.prediction?.version ?? "V1.0.0"}</span>
                </div>
                <span className="text-[6px] text-[#00ff9d]/60 uppercase font-bold tracking-tighter absolute -bottom-2">Live Evolving</span>
              </div>
           </div>
           <div className="grid grid-cols-2 gap-4 font-mono mt-3 pt-3 border-t border-white/5">
              <div className="flex flex-col">
                <span className="text-[8px] text-white/40 uppercase">Opt_Rate</span>
                <span className="text-[12px] text-[#00ff9d] font-bold">{analysis?.evolutionMetrics?.optimizationRate ?? "99.00%"}</span>
              </div>
              <div className="flex flex-col items-end">
                <span className="text-[8px] text-white/40 uppercase">Neural_Link</span>
                <span className="text-[10px] text-[#00ff9d] font-bold uppercase">Active</span>
              </div>
           </div>
        </section>

        <button 
          onClick={() => analysis?.prediction.number && setSelectedNum(analysis.prediction.number)}
          className="w-full p-5 bg-gradient-to-br from-[#1e293b] to-[#0f172a] prediction-ribbon border border-[#00ff9d]/30 text-left hover:from-[#2d3b4f] transition-all group shrink-0"
        >
          <h3 className="text-[10px] lg:text-[11px] uppercase tracking-[0.5px] lg:tracking-[1px] text-[#00ff9d] mb-3 lg:mb-4 border-l-2 border-[#00ff9d] pl-2 font-black">
            锁定价值洼地 (Evolution Target)
          </h3>
          <div className="flex items-center gap-4 lg:gap-6">
            <div className="text-[36px] lg:text-[42px] font-black font-mono text-white leading-none group-hover:scale-110 transition-transform">
              {(analysis?.prediction.number ?? "--").toString().padStart(2, '0')}
            </div>
            <div className="flex flex-col">
              <span className="text-[9px] lg:text-[10px] text-[#94a3b8] font-mono uppercase">进化策略 / {analysis?.prediction.strategy}</span>
              <span className="text-[12px] lg:text-[14px] font-bold text-[#00ff9d] uppercase italic">P04 - P10 盈利区间</span>
            </div>
          </div>
        </button>

        <section>
          <h2 className="text-[11px] uppercase tracking-[1px] text-[#94a3b8] mb-4 border-l-2 border-[#3b82f6] pl-2 font-bold">
            基因链共振 (Gene Pulse)
          </h2>
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(analysis?.genePulse || {}).map(([name, rawScore]) => {
              const score = Number(rawScore);
              const isAlpha = analysis?.prediction.strategy === name;
              const predictedNum = analysis?.genePredictions?.[name];
              
              const zoneMap: Record<string, string> = {
                "Rapid-Rebound": "P4-P6",
                "Stable-Trend": "P6-P8",
                "Alpha-Centrist": "P7-P9",
                "Aggressive-Deep": "P8-P10"
              };

              return (
                <div key={name} className={cn(
                  "p-2 border rounded transition-all duration-300",
                  isAlpha ? "bg-[#00ff9d]/10 border-[#00ff9d]/30 shadow-[0_0_10px_rgba(0,255,157,0.05)]" : "bg-black/40 border-white/5"
                )}>
                  <div className="flex justify-between items-center mb-1.5">
                    <div className="flex items-center gap-1.5">
                      <div className="flex flex-col">
                        <span className={cn(
                          "text-[8px] font-bold uppercase",
                          isAlpha ? "text-[#00ff9d]" : "text-white/40"
                        )}>{name}</span>
                        <span className="text-[7px] text-white/30 font-mono tracking-wider">{zoneMap[name]}</span>
                      </div>
                      {predictedNum && (
                        <span className="px-1 py-0.5 rounded bg-white/5 text-[9px] font-mono font-bold text-white border border-white/10 leading-none">
                          #{predictedNum}
                        </span>
                      )}
                    </div>
                    <span className="text-[9px] font-mono text-white/60">{score}/1000</span>
                  </div>
                  
                  <div className="h-1 bg-white/5 rounded-full overflow-hidden mt-1">
                    <motion.div 
                      initial={{ width: 0 }}
                      animate={{ width: `${(score / 1000) * 100}%` }}
                      className={cn(
                        "h-full transition-all duration-1000",
                        isAlpha ? "bg-[#00ff9d]" : "bg-[#3b82f6]/40"
                      )}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* 演化实战日志 (EVOLUTION LOGS) */}
          <div className="bg-black/40 border border-white/10 rounded-xl overflow-hidden mt-3 shadow-inner">
            <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between bg-white/5">
              <div className="flex items-center gap-2">
                <Database className="w-3.5 h-3.5 text-[#00ff9d]" />
                <span className="text-[10px] font-bold tracking-widest text-[#00ff9d]">演化实战日志 / EVOLUTION LOGS</span>
              </div>
              <span className="text-[8px] text-white/30 font-mono">HISTORY [LAST 20 ROUNDS]</span>
            </div>
            <div className="max-h-[220px] overflow-y-auto custom-scrollbar">
              <table className="w-full text-left border-collapse table-fixed">
                <thead className="sticky top-0 bg-[#0a0a0a] z-10">
                  <tr className="border-b border-white/5">
                    <th className="p-2 w-[50px] text-[8px] text-white/40 font-mono uppercase">期号</th>
                    <th className="p-2 text-[8px] text-white/40 font-mono uppercase text-center">RAPID</th>
                    <th className="p-2 text-[8px] text-white/40 font-mono uppercase text-center">STAL</th>
                    <th className="p-2 text-[8px] text-white/40 font-mono uppercase text-center">ALPH</th>
                    <th className="p-2 text-[8px] text-white/40 font-mono uppercase text-center">AGGR</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                        {[...(analysis?.geneHistory || [])].reverse().map((round) => (
                          <tr key={round.period} className={cn(
                            "hover:bg-white/5 transition-colors",
                            (Object.values(round.results)[0] as any).rank === -1 && "bg-[#00ff9d]/5 border-y border-[#00ff9d]/20"
                          )}>
                            <td className="p-2 text-[10px] font-mono text-white/70 whitespace-nowrap">
                              {round.period.slice(-3)}
                              {(Object.values(round.results)[0] as any).rank === -1 && (
                                <span className="ml-1 text-[7px] bg-[#00ff9d] text-black px-0.5 rounded font-bold animate-pulse">LIVE</span>
                              )}
                            </td>
                            {CHROMOSOMES.map(c => {
                              const res = round.results[c.name];
                              if (!res) return <td key={c.name} className="p-2 text-center text-[10px] text-white/10">-</td>;
                              const isPending = res.rank === -1;
                              const isWin = res.rank >= 4 && res.rank <= 10;
                              const isLeader = round.leader === c.name;
                              
                              return (
                                <td key={c.name} className="p-2 text-center">
                                  <div className="flex flex-col items-center">
                                    <span className={cn(
                                      "text-[10px] font-bold px-1.5 rounded-sm min-w-[20px] leading-tight transition-all duration-300",
                                      isLeader && "ring-1 ring-yellow-400/60 shadow-[0_0_8px_rgba(250,204,21,0.3)]",
                                      isPending ? "text-white/80 bg-white/10 border border-white/20" :
                                      isWin ? "text-green-400 bg-green-400/10" : "text-red-400 bg-red-400/10"
                                    )}>
                                      {res.num.toString().padStart(2, '0')}
                                    </span>
                                    <span className={cn(
                                      "text-[7px] font-mono mt-0.5",
                                      isLeader ? "text-yellow-400/70 font-bold" : "text-white/30"
                                    )}>
                                      {isPending ? "---" : `P${res.rank.toString().padStart(2, '0')}`}
                                    </span>
                                    {!isPending && res.rank >= 4 && res.rank <= 10 && (
                                      <span className={cn(
                                        "text-[6px] px-1 rounded-full border leading-none mt-0.5 py-0.5",
                                        (c.weights.zonePreference === 1 && res.rank >= 4 && res.rank <= 6) ||
                                        (c.weights.zonePreference === 2 && res.rank >= 6 && res.rank <= 8) ||
                                        (c.weights.zonePreference === 3 && res.rank >= 7 && res.rank <= 9) ||
                                        (c.weights.zonePreference === 4 && res.rank >= 8 && res.rank <= 10)
                                          ? "bg-green-500/30 text-green-200 border-green-500/40 font-bold"
                                          : "text-white/20 border-white/10"
                                      )}>
                                        {c.weights.zonePreference === 1 ? "P4-6" :
                                         c.weights.zonePreference === 2 ? "P6-8" :
                                         c.weights.zonePreference === 3 ? "P7-9" : "P8-10"}
                                      </span>
                                    )}
                                  </div>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section>
          <h2 className="text-[11px] uppercase tracking-[1px] text-[#94a3b8] mb-4 border-l-2 border-[#00ff9d] pl-2 font-bold">
            数据流实时监控 (DNA Stream)
          </h2>
          <div className="space-y-3">
            {analysis?.stockMarket.filter(s => s.status === "high").map((stock) => (
              <div key={stock.symbol} className="flex flex-col gap-1.5 font-mono text-[11px]">
                <div className="flex justify-between items-center px-1">
                   <div className="flex items-center gap-2">
                     <span className="text-[#e0e6ed] font-bold">{stock.symbol}</span>
                     <span className="text-[9px] px-1 bg-[#ff4e50]/10 text-[#ff4e50] border border-[#ff4e50]/20 rounded">高位</span>
                   </div>
                   <span className={cn("font-bold", stock.change > 0 ? "text-[#00ff9d]" : "text-[#ff4e50]")}>
                      P{stock.currentPrice} ({stock.changePercent})
                   </span>
                </div>
                <div className="h-1 bg-[#232931] rounded-full overflow-hidden">
                  <motion.div 
                    initial={{ width: 0 }} 
                    animate={{ width: `${(stock.currentPrice / 10) * 100}%` }}
                    className="h-full bg-gradient-to-r from-[#2d343d] to-[#ff4e50]" 
                  />
                </div>
              </div>
            ))}
          </div>
        </section>

        <div className="mt-auto pt-4 border-t border-[#2d343d]">
          <div className="flex justify-between text-[10px] text-[#94a3b8] font-mono">
            <span>Uptime</span>
            <span className="text-[#00ff9d]">99.9%</span>
          </div>
        </div>
      </aside>

      {/* Main Content Area - Technical Charts */}
      <main className="main-chart bg-[#090b0e] p-4 lg:p-8 flex flex-col relative overflow-hidden lg:h-full">
        {/* Grid Background */}
        <div className="absolute inset-0 opacity-[0.05] pointer-events-none" 
          style={{ 
            backgroundImage: "linear-gradient(#2d343d 1px, transparent 1px), linear-gradient(90deg, #2d343d 1px, transparent 1px)",
            backgroundSize: "40px 40px"
          }} 
        />
        
        <div className="relative z-10 flex flex-col h-full">
          <div className="flex justify-between items-end mb-6 lg:mb-10 gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <div className="w-1.5 h-1.5 rounded-full bg-[#00ff9d] animate-pulse" />
                <span className="text-[10px] text-[#00ff9d] font-mono tracking-widest uppercase">Live Market Data</span>
              </div>
              <h2 className="text-lg lg:text-xl font-bold text-[#e0e6ed] tracking-tight">标的 [{selectedNum.toString().padStart(2, '0')}] 趋势 K线图</h2>
              <p className="text-[10px] lg:text-xs text-[#94a3b8] mt-1 font-mono uppercase tracking-widest italic">Stock-Logic: P04-P10 = High Resistance Zone</p>
            </div>
            <div className="flex flex-wrap items-center gap-3 lg:gap-4">
              <div className="hidden sm:flex items-center gap-2 text-[10px] text-[#94a3b8]">
                <div className="w-2 h-2 bg-[#00ff9d]" /> <span>向上回归</span>
              </div>
              <div className="flex gap-1 p-1 bg-[#161a20] border border-[#2d343d] rounded shadow-inner flex-wrap max-w-[200px] sm:max-w-none">
                {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
                  <button key={n} onClick={() => setSelectedNum(n)} className={cn("px-2 py-0.5 text-[9px] font-mono transition-all rounded", selectedNum === n ? "bg-[#00ff9d] text-black font-bold shadow-lg" : "text-[#94a3b8] hover:text-white hover:bg-[#2d343d]")}>
                    #{n}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="h-[320px] lg:h-full w-full border-l border-b border-[#2d343d] relative">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={analysis?.kLineData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorWave" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#00ff9d" stopOpacity={0.2}/>
                    <stop offset="95%" stopColor="#00ff9d" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#2d343d" vertical={false} opacity={0.2} />
                <XAxis 
                  dataKey="period" 
                  stroke="#2d343d" 
                  fontSize={7} 
                  tick={{ fill: '#64748b' }}
                  tickLine={false} 
                  axisLine={false} 
                  interval="preserveStartEnd"
                  minTickGap={10}
                  tickFormatter={(val) => val?.toString().slice(-3) || ''}
                />
                <YAxis 
                   stroke="#2d343d" 
                   fontSize={10} 
                   tick={{ fill: '#64748b' }}
                   tickLine={false} 
                   axisLine={false} 
                   domain={[1, 10]} 
                   reversed 
                   ticks={[1, 3, 5, 7, 9, 10]}
                   tickFormatter={(val) => `P${val}`}
                />
                <Tooltip content={<CustomTooltip />} />
                <Area 
                  type="monotone" 
                  dataKey={`n${selectedNum}`} 
                  stroke="none"
                  fill="url(#colorWave)" 
                  animationDuration={300}
                  connectNulls={true}
                />
                <Line 
                  type="monotone" 
                  dataKey={`n${selectedNum}`} 
                  stroke="#00ff9d" 
                  strokeWidth={2} 
                  dot={{ r: 2, fill: '#00ff9d', strokeWidth: 0 }}
                  activeDot={{ r: 4, stroke: '#161a20', strokeWidth: 2, fill: '#00ff9d' }}
                  animationDuration={300}
                  connectNulls={true}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      </main>

          </div>

          {/* Bottom Panel - Prediction and Analysis */}
      <section className="bottom-panel sleek-panel flex flex-col lg:flex-row items-stretch border-t border-[#2d343d] p-0">
        <div className="flex-1 p-4 lg:p-6 border-b lg:border-b-0 lg:border-r border-[#2d343d]">
          <div className="flex items-center justify-between mb-3 lg:mb-4">
            <h3 className="text-[10px] lg:text-[11px] uppercase tracking-[0.5px] lg:tracking-[1px] text-[#94a3b8] border-l-2 border-[#3b82f6] pl-2 font-bold">
              DNA 动能进化分析 (Dynamic Evolution)
            </h3>
            <div className="flex items-center gap-1.5 px-2 py-0.5 bg-[#3b82f6]/10 border border-[#3b82f6]/20 rounded">
              <div className="w-1 h-1 rounded-full bg-[#3b82f6] animate-pulse" />
              <span className="text-[8px] text-[#3b82f6] font-mono font-bold uppercase tracking-tighter">Self-Learning Active</span>
            </div>
          </div>
          <p className="text-[10px] lg:text-[11px] text-[#94a3b8] font-mono uppercase mb-2 lg:mb-3">全自动逻辑闭环导向：</p>
          <div className="flex items-baseline gap-3 lg:gap-4">
             <div className="text-[24px] lg:text-[28px] font-black font-mono text-[#3b82f6]">EVO: {analysis?.prediction.number.toString().padStart(2, '0')}</div>
             <div className="text-[9px] lg:text-[10px] text-[#3b82f6] font-mono font-bold">Confidence: {analysis?.prediction.confidence}%</div>
          </div>
        </div>

        <div className="flex-1 p-4 lg:p-6 lg:border-r border-[#2d343d]">
          <div className="flex items-center justify-between mb-3 lg:mb-4">
            <h3 className="text-[10px] lg:text-[11px] uppercase tracking-[0.5px] lg:tracking-[1px] text-[#94a3b8] border-l-2 border-[#ff4e50] pl-2 font-bold">
              进化回路性能简报 (Feedback Loop)
            </h3>
            <div className="flex items-center gap-1.5 px-2 py-0.5 bg-[#00ff9d]/10 border border-[#00ff9d]/20 rounded">
              <div className="w-1 h-1 rounded-full bg-[#00ff9d] animate-pulse" />
              <span className="text-[8px] text-[#00ff9d] font-mono font-bold uppercase tracking-tighter">Real-Time Logged</span>
            </div>
          </div>
          <p className="text-[10px] lg:text-[11px] text-[#94a3b8] font-mono uppercase mb-3">近20期逻辑进化达成率：</p>
          <div className="flex gap-2 items-center flex-wrap bg-white/5 p-3 rounded border border-white/5">
            <div className="flex gap-1.5 items-center flex-wrap flex-1">
              {Array.from({ length: 20 }).map((_, i) => {
                const history = analysis?.hitHistory || [];
                const hit = history[i];
                return (
                  <div key={i} className="relative w-3.5 h-3.5">
                    {/* Fixed Deep Background */}
                    <div className="absolute inset-0 rounded-full bg-black/40 border border-white/5" />
                    
                    {/* Persistent Color Core */}
                    <motion.div 
                      initial={{ opacity: 0, scale: 0.5 }}
                      animate={hit !== undefined && hit !== null ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.5 }}
                      className={cn(
                        "absolute inset-0 rounded-full border transition-all duration-700",
                        hit === true ? "bg-[#00ff9d] border-[#00ff9d]/40 shadow-[0_0_10px_rgba(0,255,157,0.6)]" : 
                        hit === false ? "bg-[#ff4e50] border-[#ff4e50]/40 shadow-[0_0_10px_rgba(255,78,80,0.6)]" : 
                        ""
                      )}
                      title={hit === true ? "Hit" : hit === false ? "Fail" : "Wait"}
                    />
                  </div>
                );
              })}
            </div>
            <div className="text-[14px] lg:text-[16px] font-black font-mono text-white/90 ml-2 shrink-0">
              {analysis && analysis.hitHistory ? Math.round((analysis.hitHistory.filter(h => h === true).length) / (analysis.hitHistory.filter(h => h !== null).length || 1) * 100) : 0}%
            </div>
          </div>
        </div>

        <div className="flex-1 p-4 lg:p-6">
          <h3 className="text-[10px] lg:text-[11px] uppercase tracking-[0.5px] lg:tracking-[1px] text-[#94a3b8] mb-3 lg:mb-4 border-l-2 border-[#00ff9d] pl-2 font-bold">
            实时开奖同步 (Latest Result)
          </h3>
          <p className="text-[10px] lg:text-[11px] text-[#94a3b8] font-mono uppercase mb-2">
            期号: {data?.[0]?.period || "---"} 状态: 已封标校准
          </p>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {(data?.[0]?.numbers || []).map((num, i) => {
              const rank = i + 1;
              const isRecommended = analysis?.prediction && num === analysis.prediction.number;
              const isLastResultHit = analysis?.hitHistory?.[analysis.hitHistory.length - 1];
              
              return (
                <div 
                  key={i} 
                  className={cn(
                    "w-6 h-6 sm:w-7 sm:h-7 rounded-full flex items-center justify-center text-[10px] sm:text-[11px] font-bold border transition-all",
                    isRecommended && rank >= 4 
                      ? "bg-[#00ff9d] text-[#090b0e] border-[#00ff9d] shadow-[0_0_10px_rgba(0,255,157,0.5)] scale-110" 
                      : isRecommended && rank <= 3
                        ? "bg-[#ff4e50] text-white border-[#ff4e50] shadow-[0_0_10px_rgba(255,78,80,0.5)] scale-110 animate-pulse"
                        : "bg-[#1e293b] text-[#00ff9d] border-[#00ff9d]/30"
                  )}
                  title={`Position P${rank} - ${rank <= 3 ? 'No Value Zone' : 'Target Zone'}`}
                >
                  {num}
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  </div>

      {/* Global Error Notification */}
      <AnimatePresence>
        {error && (
          <motion.div 
            initial={{ opacity: 0, y: 50 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 50 }}
            className="fixed bottom-6 right-6 bg-[#ff4e50]/20 border border-[#ff4e50]/50 p-4 rounded backdrop-blur-md z-[100] max-w-sm"
          >
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-[#ff4e50] shrink-0 mt-0.5" />
              <div className="text-[#ff4e50] font-mono">
                <p className="text-[11px] font-bold uppercase tracking-widest">System Warning</p>
                <p className="text-[10px] mt-1 italic">{error}</p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
