import axios from 'axios';
import * as cheerio from 'cheerio';

async function testSimplifiedSync() {
  const url = "https://wuk.168y.cloudns.org/";
  console.log(`📡 Testing Simplified Sync from ${url}...`);
  try {
    const response = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
      timeout: 10000,
    });
    
    const newRecords: any[] = [];
    const $ = cheerio.load(response.data);
    
    $("tr").each((_, row) => {
      const tds = $(row).find("td");
      if (tds.length >= 2) {
        const p = $(tds[0]).text().trim();
        const r = tds.map((i, el) => $(el).text().trim()).get().join(",");
        
        const periodMatch = p.match(/\d{8,15}/);
        const codeMatch = r.match(/(\d{1,2},){9}\d{1,2}/);
        
        if (periodMatch && codeMatch) {
          const nums = codeMatch[0].split(',').map(n => parseInt(n)).filter(n => !isNaN(n) && n >= 1 && n <= 10);
          if (nums.length === 10 && !newRecords.find(nr => nr.period === periodMatch[0])) {
            newRecords.push({ period: periodMatch[0], numbers: nums });
          }
        }
      }
    });

    console.log(`✅ Success! Extracted ${newRecords.length} records.`);
    if (newRecords.length > 0) {
      console.log('Sample Record:', newRecords[0]);
    } else {
      console.log('❌ No records found in the table!');
    }
  } catch (e) {
    console.error('❌ Failed:', e.message);
  }
}

testSimplifiedSync();
