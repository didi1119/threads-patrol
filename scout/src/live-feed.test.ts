// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readLiveFeed } from './live-feed.js';

describe('real Threads feed normalization', () => {
  it('rejects duplicated timestamp-only headers but preserves short daily conversation', () => {
    document.body.innerHTML = ['empty', 'daily'].map(handle => `<div><a href="/@${handle}">${handle}</a><a href="/@${handle}/post/T_${handle}"><time datetime="2026-10-02T00:00:00Z">1d</time></a><svg></svg></div>`).join('');
    for (const el of Array.from(document.querySelectorAll('div'))) Object.defineProperty(el, 'innerText', {value: `${el.querySelector('a')!.textContent}\n1d\n1d${el.querySelector('a')!.textContent==='daily'?'\n只想發呆':''}`, configurable:true});
    const wrapper=document.createElement('div');wrapper.innerHTML=readLiveFeed(100000).html;
    expect(wrapper.querySelectorAll('article')).toHaveLength(1);
    expect(wrapper.querySelector('[data-post-text]')?.textContent).toBe('只想發呆');
  });
  it('reads a nested permalink, text and timestamp without absorbing the neighboring post', () => {
    document.body.innerHTML = `<main>${['alice', 'bob'].map(handle => `<div><div><div><div><div><div><div>
      <a href="/@${handle}">${handle}</a><span><a href="/@${handle}/post/ABC_${handle}"><time datetime="2026-10-01T00:21:31.000Z">8h</time></a></span>
      </div></div></div></div></div></div><p>想去森林放空</p><svg></svg><span>1.2K</span><span>25</span><span>4</span><span>8</span></div>`).join('')}</main>`;
    // jsdom has no layout or innerText; fallback retains DOM text in this fixture.
    for (const el of Array.from(document.querySelectorAll('div'))) {
      Object.defineProperty(el, 'innerText', { configurable:true, value: el.querySelector('p') ? `${el.querySelector('a')!.textContent}\n8h\n想去森林放空\n1.2K\n25\n4\n8` : el.textContent });
    }
    const result = readLiveFeed(100_000);
    const wrapper = document.createElement('div');
    wrapper.innerHTML = result.html;
    expect(wrapper.querySelectorAll('[data-thread-post]')).toHaveLength(2);
    expect(wrapper.querySelector('[data-post-text]')?.textContent).toBe('想去森林放空');
    expect(wrapper.querySelector('[data-likes]')?.getAttribute('data-likes')).toBe('1.2K');
    expect(wrapper.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-01T00:21:31.000Z');
  });
  it('does not invent a candidate when permalink or date is missing', () => {
    document.body.innerHTML = '<div>推薦流載入中</div>';
    expect(readLiveFeed(100_000).html).toBe('');
  });
});
