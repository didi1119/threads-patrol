import React from 'react';
type Metric={timestamp:string;status:string;failureStage?:string;failureCode?:string;extractedCount?:number;deliveredCount?:number;discovery?:{seenCount:number;scrollCount:number;refreshCount:number}};
export function ScoutSummary({scout}:{scout:{latest?:Metric;unavailable?:boolean}}){
  const m=scout.latest;const count=(n:number|undefined)=>n===undefined?'尚未記錄':`${n} 則`;
  const message=m?.failureCode==='RATE_LIMIT'?'Cloudflare 暫時限制建立瀏覽器工作階段；沒有進入 Threads，不需要重新登入。':m?.failureStage==='ingestion'&&m.status==='stopped'?'已抓到貼文，但送入工作台失敗；已送與未送分開記錄。':m?.status==='completed'?'這輪已完成；不代表已通過長期穩定驗收。':scout.unavailable?'暫時讀不到巡查狀態，不代表成功或零候選。':'尚未完成巡查驗收。';
  return <section className="review-summary"><h2>遠端巡查 · {m?.status==='completed'?'最近一輪完成':'尚未通過穩定驗收'}</h2><p>{message}</p>
    {m&&<p>看到 {count(m.discovery?.seenCount)} · 抓到 {count(m.extractedCount)} · 實際入庫 {count(m.deliveredCount)}</p>}
    {m?.discovery&&<p>滑動 {m.discovery.scrollCount} 次 · 重新整理 {m.discovery.refreshCount} 次</p>}
    <small>每日 08:30、12:30、17:30、22:00 · 每段最多滑 15 次，最多重整 2 次；停滯或明顯不適合接話時提早重整。{m&&` 最近 ${new Date(m.timestamp).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}。`}AI 未看到原帖圖片，仍需人工讀原帖；穩定性另依自然排程驗證。</small>
  </section>;
}
