const items = [
  ['AI 如何进入创作者工作流', 'How AI fits into a creator workflow'],
  ['从一次性合作到长期商业资产', 'From one-off deals to durable brand value'],
];

export function GET(): Response {
  const origin = process.env.NEXT_PUBLIC_WEBSITE_ORIGIN ?? 'http://localhost:3002';
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>GaoQ Insights</title><link>${escapeXml(origin)}</link>
<description>Creator operations, AI and brand growth.</description>
${items.map(([zh, en], index) => `<item><title>${escapeXml(`${zh} / ${en}`)}</title><link>${escapeXml(`${origin}/zh-CN/insights#${index + 1}`)}</link><guid>${escapeXml(`${origin}/insights/${index + 1}`)}</guid></item>`).join('')}
</channel></rss>`;
  return new Response(body, {
    headers: { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
