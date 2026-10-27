import type {Candidate} from './candidate';
const DAY=86400000;
export function taipeiDay(at=new Date()){return new Date(at.getTime()+8*3600000).toISOString().slice(0,10);}
export function feedDates(at=new Date()){return Array.from({length:7},(_,i)=>taipeiDay(new Date(at.getTime()-i*DAY)));}
export function feedCutoff(at=new Date()){return new Date(Date.parse(feedDates(at)[6]+'T00:00:00+08:00')).toISOString();}
export function filterFeed(items:Candidate[],day:string,minLikes=1001){return items.filter(c=>taipeiDay(new Date(c.collectedAt||c.createdAt))===day&&(c.publicMetrics?.likes??0)>=Math.max(1001,minLikes)&&!c.sourceGuard).sort((a,b)=>(b.publicMetrics?.likes??0)-(a.publicMetrics?.likes??0));}
