import { describe, expect, it } from "vitest";
import { candidatePriority, sourceReviewGuard, guardCandidate } from "./candidate";

describe("candidatePriority", () => {
  it('keeps broad daily humor eligible but prevents self-posts, timestamp noise and sensitive disputes from ranking as recommendations',()=>{
    expect(sourceReviewGuard({author:'ordinary',text:'週末計畫只剩雞排跟發呆'})).toBeNull();
    expect(sourceReviewGuard({author:'@BEST_FOREST_HOUSE',text:'黑森林派對'} )?.kind).toBe('own-account');
    expect(sourceReviewGuard({author:'ordinary',text:'1d'})?.kind).toBe('missing-context');
    for(const text of ['你支持代孕完全無法挺你了','身材管理都不行的人在跟我講什麼階級跟品味','選舉政治仇恨']){
      const c=guardCandidate({author:'ordinary',text,status:'new',suggestedScores:{playability:5,bridge:5,mediaFit:5,timing:5,safety:5},drafts:['危險的幽默'],aiReason:'適合回覆'} as any);
      expect(c.sourceGuard?.kind).toBe('sensitive');expect(candidatePriority(c.suggestedScores!).bucket).toBe('rejected');expect(c.drafts).toEqual(['','','']);
    }
  });
  it("recommends a safe, timely, naturally bridgeable candidate", () => {
    expect(candidatePriority({ playability: 5, bridge: 5, mediaFit: 4, timing: 4, safety: 5 })).toEqual({
      total: 23,
      bucket: "recommended",
    });
  });
});
