export function parseDshUrl(value: string): URL {
  if (!value?.trim()) throw new Error('缺少 dsh_url：请先自行启动 dsh Web，将启动输出的完整 URL（含 token）填入 .env，然后重新启动 Soul。');
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('dsh_url 格式无效，请填写 dsh 启动输出的完整 URL。'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.hash) {
    throw new Error('dsh_url 必须是本机 dsh Web 的 HTTP 根地址，例如 http://127.0.0.1:8766/?token=实际token。');
  }
  const token = url.searchParams.get('token');
  if (url.searchParams.size !== 1 || url.searchParams.getAll('token').length !== 1 || !token || !/^[A-Za-z0-9_-]+$/.test(token) || /这里|实际|启动|your.?token|replace/i.test(token)) {
    throw new Error('dsh_url 缺少有效的 token 或仍是占位文字，请复制 dsh 本次启动输出的完整 URL。');
  }
  return url;
}
