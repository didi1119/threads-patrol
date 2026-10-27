/** Runs inside the page. Reads visible post DOM into the bounded extraction contract. */
export function readLiveFeed(rawLimit: unknown): { currentUrl: string; html: string } {
  const limit = Number(rawLimit);
  const root = document.createElement('div');
  const seen = new Set<string>();
  for (const link of Array.from(document.querySelectorAll('a[href*="/post/"]')).slice(0, 80)) {
    const href = link.getAttribute('href') ?? '';
    const match = href.match(/^\/@([\w.]+)\/post\/([\w-]+)(?:[/?#]|$)/);
    if (!match || seen.has(href)) continue;
    let container: Element | null = link.parentElement;
    for (let level = 0; container && level < 12; level++, container = container.parentElement) {
      const postLinks = container.querySelectorAll('a[href*="/post/"]');
      if (Array.from(postLinks).some(a => a.getAttribute('href') !== href)) break;
      const lines = ((container as HTMLElement).innerText ?? container.textContent ?? '').split('\n').map(s => s.trim()).filter(Boolean);
      const handleIndex = lines.indexOf(match[1]);
      if (handleIndex < 0 || lines.length < handleIndex + 3) continue;
      const body = lines.slice(handleIndex + 2);
      const timestampLabel = container.querySelector('time[datetime]')?.textContent?.trim();
      while (body.length && (body[0] === timestampLabel || /^\d+\s*(?:s|m|h|d|w|秒|分鐘|小時|天|週|周)$/i.test(body[0]))) body.shift();
      if (!container.querySelector('svg') && level < 6) continue;
      const counters: string[] = [];
      while (body.length && counters.length < 4 && /^[\d.,]+\s*(?:[kKmM]|萬|万)?$/.test(body[body.length - 1])) {
        counters.unshift(body.pop()!);
      }
      const text = body.filter(s => !/^(?:Translate|翻譯|See translation|查看翻譯)$/.test(s)).join('\n').slice(0, 10_000);
      const datetime = container.querySelector('time[datetime]')?.getAttribute('datetime');
      if (!text || !datetime) continue;
      const post = document.createElement('article');
      post.setAttribute('data-thread-post', '');
      post.setAttribute('data-author-handle', match[1]);
      if (/^(?:Sponsored|贊助|赞助)$/m.test(lines.join('\n'))) post.setAttribute('data-promoted', '');
      const anchor = document.createElement('a');
      anchor.setAttribute('data-post-url', '');
      anchor.href = new URL(href, location.origin).href;
      const content = document.createElement('p');
      content.setAttribute('data-post-text', '');
      content.textContent = text;
      const time = document.createElement('time');
      time.setAttribute('data-posted-at', '');
      time.setAttribute('datetime', datetime);
      post.append(anchor, content, time);
      for (const [index, key] of ['data-likes', 'data-replies'].entries()) {
        const metric = document.createElement('span');
        metric.setAttribute(key, counters[index] ?? '');
        post.append(metric);
      }
      root.append(post);
      seen.add(href);
      break;
    }
    if (seen.size >= 40) break;
  }
  return { currentUrl: location.href, html: root.innerHTML.slice(0, limit + 1) };
}
