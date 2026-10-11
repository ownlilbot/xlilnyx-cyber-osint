const base = (process.argv[2] || '').replace(/\/$/, '');
if (!base) {
  console.error('Usage: node scripts/smoke-test.mjs https://YOUR-SERVICE.onrender.com');
  process.exit(2);
}
const headers = { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' };
if (process.env.MCP_AUTH_TOKEN) headers.authorization = `Bearer ${process.env.MCP_AUTH_TOKEN}`;

async function request(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const data = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).find(Boolean);
    if (!data) throw new Error(`${path} returned an SSE response without a data event`);
    return JSON.parse(data);
  }
  return JSON.parse(text);
}

const healthRes = await fetch(`${base}/health`, { signal: AbortSignal.timeout(10000) });
if (!healthRes.ok) throw new Error(`/health returned HTTP ${healthRes.status}`);
const health = await healthRes.json();
console.log('HEALTH OK:', health);

const init = await request('/mcp', {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'xlilnyx-smoke-test', version: '1.0.0' } }
});
if (init.error) throw new Error(`MCP initialize failed: ${JSON.stringify(init.error)}`);
console.log('MCP INITIALIZE OK:', init.result?.serverInfo || init.result?.protocolVersion || 'response received');

const list = await request('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
if (list.error) throw new Error(`tools/list failed: ${JSON.stringify(list.error)}`);
const names = (list.result?.tools || []).map(t => t.name);
console.log('TOOLS FOUND:', names.join(', '));
for (const required of ['osint_dns_lookup', 'osint_domain_rdap', 'osint_ip_rdap', 'osint_domain_intel', 'osint_sources_status']) {
  if (!names.includes(required)) throw new Error(`Required tool missing: ${required}`);
}
console.log('SMOKE TEST PASSED. This checks MCP reachability and tool registration only, not upstream provider success.');
