// 靜態頁面由 assets(docs/)提供;只有 /data.json 會進到這裡,從 R2 讀出最新資料。
// scheduled:Cloudflare 排程準時觸發 GitHub Actions 更新資料(GitHub 自身排程常延遲,保留為備援)。
const WORKFLOW_DISPATCH_URL =
  'https://api.github.com/repos/weiyungwu/tw-inst-screener/actions/workflows/update.yml/dispatches';

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname !== '/data.json') return new Response('Not found', { status: 404 });

    const obj = await env.DATA.get('data.json');
    if (!obj) return new Response('data.json not found in R2', { status: 404 });

    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set('etag', obj.httpEtag);
    headers.set('cache-control', 'no-cache');
    return new Response(obj.body, { headers });
  },

  async scheduled(controller, env) {
    const res = await fetch(WORKFLOW_DISPATCH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'tw-inst-screener-cron',
      },
      body: JSON.stringify({ ref: 'master' }),
    });
    // 失敗就丟錯,讓 Cloudflare 的排程紀錄標示為失敗
    if (!res.ok) throw new Error(`workflow dispatch failed: ${res.status} ${await res.text()}`);
  },
};
