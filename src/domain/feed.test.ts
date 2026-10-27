import {it,expect} from 'vitest';
import {taipeiDay,feedDates,filterFeed,feedCutoff} from './feed';
it('uses Taipei midnight and keeps today plus six earlier dates',()=>{
 expect(taipeiDay(new Date('2026-10-03T16:01:00Z'))).toBe('2026-10-04');
 expect(feedDates(new Date('2026-10-03T16:01:00Z'))).toEqual(['2026-10-04','2026-10-03','2026-10-02','2026-10-01','2026-09-30','2026-09-29','2026-09-28']);
 expect(feedCutoff(new Date('2026-10-03T16:01:00Z'))).toBe('2026-09-27T16:00:00.000Z');
});
it('shows only the selected collection date, strictly above 1000 likes, sorted by likes rather than AI scores',()=>{
 const c=(id:string,likes:number|null,at:string)=>({id,publicMetrics:{likes},observedAt:at,createdAt:at}) as any;
 const rows=[c('low',999,'2026-10-03T00:30:00Z'),c('edge',1000,'2026-10-03T00:30:00Z'),c('unknown',null,'2026-10-03T00:30:00Z'),c('a',1001,'2026-10-03T00:30:00Z'),c('b',5000,'2026-10-03T00:30:00Z'),c('yesterday',9999,'2026-10-02T00:30:00Z')];
 expect(filterFeed(rows,'2026-10-03',1001).map(c=>c.id)).toEqual(['b','a']);
 expect(filterFeed(rows,'2026-10-03',3000).map(c=>c.id)).toEqual(['b']);
});
