import {describe,it,expect} from 'vitest';
import {FeedDiscovery} from './feed-discovery.js';
const post=(id:string,text='今天只想放空')=>`<article data-thread-post><a data-post-url href="https://www.threads.com/@a/post/${id}"></a><p data-post-text>${text}</p></article>`;
describe('bounded discovery',()=>{
  it('keeps different posts across virtualized snapshots and deduplicates overlaps',()=>{
    const d=new FeedDiscovery(20000);d.add(post('1')+post('2'));d.add(post('2')+post('3'));
    expect(d.count).toBe(3);expect(d.html.match(/data-thread-post/g)).toHaveLength(3);
  });
  it('refreshes after fifteen scrolls or three stagnant snapshots, not for lack of travel keywords',()=>{
    const d=new FeedDiscovery(20000);d.add(post('1'));expect(d.shouldRefresh(14)).toBe(false);expect(d.shouldRefresh(15)).toBe(true);
    d.add(post('1'));d.add(post('1'));d.add(post('1'));expect(d.shouldRefresh(3)).toBe(true);
    d.beginPass();d.add(post('2','上班好累'));expect(d.shouldRefresh(1)).toBe(false);
  });
  it('refreshes after three mostly sensitive batches without treating daily banter as off-topic',()=>{
    const d=new FeedDiscovery(20000);
    for(let i=0;i<3;i++)d.add(post(String(i),'自殺 仇恨 總統 選舉'));
    expect(d.shouldRefresh(3)).toBe(true);
  });
  it('does not exceed the raw discovery cap or character limit',()=>{
    const d=new FeedDiscovery(200000);for(let i=0;i<190;i++)d.add(post(String(i)));expect(d.count).toBe(180);
    expect(()=>new FeedDiscovery(10).add(post('1'))).toThrow('Content limit');
  });
});
