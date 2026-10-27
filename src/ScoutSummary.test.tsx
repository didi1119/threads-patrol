import React from 'react';
import {render,screen,cleanup} from '@testing-library/react';
import {afterEach,it,expect} from 'vitest';
import {ScoutSummary} from './ScoutSummary';
afterEach(cleanup);
it('distinguishes discovery, delivery and refresh counts',()=>{
  render(<ScoutSummary scout={{latest:{timestamp:'2026-10-02T12:00:00Z',status:'completed',extractedCount:80,deliveredCount:80,discovery:{seenCount:100,scrollCount:45,refreshCount:2}}}}/>);
  expect(screen.getByText(/看到 100 則/)).toBeTruthy();
  expect(screen.getByText(/實際入庫 80 則/)).toBeTruthy();
  expect(screen.getByText(/滑動 45 次/)).toBeTruthy();
});
it('does not label extracted posts as delivered when transmission failed',()=>{
  render(<ScoutSummary scout={{latest:{timestamp:'2026-10-02T12:00:00Z',status:'stopped',failureStage:'ingestion',extractedCount:9,deliveredCount:0}}}/>);
  expect(screen.getByText(/抓到 9 則/)).toBeTruthy();expect(screen.getByText(/實際入庫 0 則/)).toBeTruthy();
  expect(screen.getByText(/送入工作台失敗/)).toBeTruthy();
});
