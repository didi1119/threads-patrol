import {parseHTML} from 'linkedom';

export interface DiscoveryStats { seenCount:number; scrollCount:number; refreshCount:number }
export const SCROLLS_PER_PASS=15;
export const MAX_REFRESHES=2;
export const MAX_DISCOVERED_POSTS=180;
/** Novelty and obvious unsuitable-topic signals, not a brand-keyword relevance gate. */
export class FeedDiscovery {
  private readonly posts=new Map<string,string>();
  private stagnant=0;
  private unsuitable=0;
  private size=0;
  private fallback='';
  constructor(private readonly maxCharacters:number){}
  get count(){return this.posts.size;}
  get html(){return this.posts.size?[...this.posts.values()].join(''):this.fallback;}
  beginPass(){this.stagnant=0;this.unsuitable=0;}
  shouldRefresh(scrolls:number){return scrolls>=SCROLLS_PER_PASS||this.stagnant>=3||this.unsuitable>=3;}
  add(html:string){
    if(html.length>this.maxCharacters)throw new Error('Content limit exceeded');
    const {document}=parseHTML(html);const nodes=Array.from(document.querySelectorAll('[data-thread-post]'));
    let added=0;let unsuitable=0;
    for(const node of nodes){
      const url=node.querySelector('[data-post-url]')?.getAttribute('href');
      if(!url)continue;
      const text=node.querySelector('[data-post-text]')?.textContent||'';
      if(node.hasAttribute('data-promoted')||/自殺|仇恨|性侵|總統|选举|選舉|戰爭|战争/.test(text))unsuitable++;
      if(this.posts.has(url)||this.count>=MAX_DISCOVERED_POSTS)continue;
      const value=node.outerHTML;
      if(this.size+value.length>this.maxCharacters)throw new Error('Content limit exceeded');
      this.posts.set(url,value);this.size+=value.length;added++;
    }
    if(!nodes.length&&!this.posts.size)this.fallback=html;
    this.stagnant=added?0:this.stagnant+1;
    this.unsuitable=nodes.length&&unsuitable/nodes.length>=0.7?this.unsuitable+1:0;
  }
}
