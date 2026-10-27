import React,{useState,useEffect} from 'react';
import type {Candidate} from './domain/candidate';
import {feedDates,filterFeed,taipeiDay} from './domain/feed';
export function DailyFeed({items,now}:{items:Candidate[];now?:Date}){
 const [clock,setClock]=useState(new Date());useEffect(()=>{if(now)return;const timer=setInterval(()=>setClock(new Date()),30000);return()=>clearInterval(timer);},[now]);
 const today=taipeiDay(now??clock),dates=feedDates(now??clock);const [day,setDay]=useState(today),[likes,setLikes]=useState(1001);
 useEffect(()=>{setDay(today);},[today]);
 const rows=filterFeed(items,day,likes);
 return <section><p className="help">只收錄超過 1,000 讚的貼文，不自動生成草稿或推薦回覆。日期是爬到貼文的台北日期；首頁每天換成當日資料，歷史僅回查最近七天。</p>
 <div className="metric-grid"><label>採集日期<select aria-label="採集日期" value={day} onChange={e=>setDay(e.target.value)}>{dates.map(d=><option key={d} value={d}>{d}{d===today?' · 今天':''}</option>)}</select></label><label>最低讚數<select aria-label="最低讚數" value={likes} onChange={e=>setLikes(Number(e.target.value))}>{[[1001,'超過 1,000'],[3000,'3,000 以上'],[5000,'5,000 以上'],[10000,'10,000 以上'],[50000,'50,000 以上']].map(([v,label])=><option key={v} value={v}>{label}</option>)}</select></label></div>
 <p className="help">{day} · {rows.length} 則 · 按原帖讚數由高到低，不是回覆推薦榜</p>
 <div className="candidate-list">{rows.map(c=><article className="candidate-card" key={c.id}><div className="card-top"><span className="badge">採集貼文</span><small>{day}</small></div><h2>{c.author||'Threads 對話'}</h2><p>{c.text}</p><div className="card-bottom"><span>原帖 ♡ {c.publicMetrics!.likes!.toLocaleString('zh-TW')} · 回覆 {c.publicMetrics?.replies??'—'}</span><a href={c.sourceUrl} target="_blank" rel="noopener noreferrer">開啟原帖 ↗</a></div></article>)}</div>
 {!rows.length&&<div className="empty"><h2>這個日期與讚數篩選尚無貼文。</h2><p>不會用前幾天或低於門檻的貼文補入今天。</p></div>}</section>;
}
