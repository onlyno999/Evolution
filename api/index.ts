import express from "express";
import axios from "axios";
import { perform3DAnalysis } from "../src/lib/analysis";

const app = express();

// 注意：在 Vercel 上为了持久化，建议这里对接 Redis
// 临时方案（每 5 分钟同步一次，数据存内存会随函数销毁而重置）
let globalLotteryData: any[] = [];
let globalAnalysis: any = null;

let lastSyncTime = 0;

async function syncData() {
  const url = "https://wuk.168y.cloudns.org/";
  try {
    const response = await axios.get(`${url}?t=${Date.now()}`, {
      headers: { "User-Agent": "Mozilla/5.0 Node.js" },
      timeout: 10000,
    });
    const dataStr = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    const newRecords: any[] = [];
    const pairRegex = /(\d{8,15})[\s\S]{1,200}?((\d{1,2},){9}\d{1,2})/g;
    let m;
    while ((m = pairRegex.exec(dataStr)) !== null) {
      const p = m[1];
      const r = m[2];
      const nums = r.split(',').map(Number);
      if (nums.length === 10) newRecords.push({ period: p, numbers: nums });
    }
    // 合并并排序
    globalLotteryData = [...newRecords, ...globalLotteryData].slice(0, 200);
    if (globalLotteryData.length >= 10) {
      globalAnalysis = perform3DAnalysis(globalLotteryData);
    }
    lastSyncTime = Date.now();
    return true;
  } catch (err) {
    return false;
  }
}

// 数据接口
app.get("/api/lottery-data", async (req, res) => {
  const isStale = Date.now() - lastSyncTime > 5 * 60 * 1000;
  if (globalLotteryData.length === 0 || isStale) {
    await syncData();
  }
  res.json({
    success: true,
    data: globalLotteryData,
    analysis: globalAnalysis,
    lastSyncTime
  });
});

// 定时任务接口（vercel.json 会调用此接口）
app.get("/api/sync", async (req, res) => {
  const success = await syncData();
  res.json({ success });
});

export default app;
