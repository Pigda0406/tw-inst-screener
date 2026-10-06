// 靜態頁面由 assets(docs/)提供;只有 /data.json 會進到這裡,從 R2 讀出最新資料。
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
};
