import {it,expect} from 'vitest';
import {render,screen,fireEvent} from '@testing-library/react';
import {DailyFeed} from './DailyFeed';
it('defaults to today and offers date and likes filters without generated replies or recommendations',()=>{
 const c=(id:string,likes:number,observedAt:string)=>({id,author:id,text:'日常貼文',sourceUrl:'https://threads.com/@a/post/'+id,observedAt,createdAt:observedAt,publicMetrics:{likes},aiReason:'不應顯示的建議'}) as any;
 render(<DailyFeed items={[c('today',1500,'2026-10-03T00:30:00Z'),c('yesterday',6000,'2026-10-02T00:30:00Z')]} now={new Date('2026-10-03T05:00:00Z')}/>);
 expect(screen.getByText('today')).toBeTruthy();expect(screen.queryByText('yesterday')).toBeNull();expect(screen.queryByText('不應顯示的建議')).toBeNull();
 fireEvent.change(screen.getByLabelText('採集日期'),{target:{value:'2026-10-02'}});expect(screen.getByText('yesterday')).toBeTruthy();
 fireEvent.change(screen.getByLabelText('最低讚數'),{target:{value:'10000'}});expect(screen.queryByText('yesterday')).toBeNull();
});
