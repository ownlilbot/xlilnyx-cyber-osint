import crypto from 'node:crypto';
import net from 'node:net';
import express from 'express';
import ipaddr from 'ipaddr.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod/v4';

const PORT = Number(process.env.PORT || 10000);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || '';
const OPTIONAL_APIS_ENABLED = process.env.ENABLE_OPTIONAL_PROVIDER_APIS === 'true';
const MAX_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE || 60);

if (AUTH_TOKEN && AUTH_TOKEN.length < 32) {
  console.error('CONFIG ERROR: If MCP_AUTH_TOKEN is set, it must be at least 32 characters.');
  process.exit(1);
}
if (OPTIONAL_APIS_ENABLED && !AUTH_TOKEN) {
  console.error('CONFIG ERROR: Optional provider APIs require MCP_AUTH_TOKEN for clients that support bearer headers. For Claude custom connectors, implement OAuth before enabling paid/provider APIs.');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb', strict: true }));

const rateBuckets = new Map();
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.start >= 60_000) bucket = { start: now, count: 0 };
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (bucket.count > MAX_PER_MINUTE) return res.status(429).json({ error: 'Rate limit exceeded. Try again in a minute.' });
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) if (now - v.start > 120_000) rateBuckets.delete(k);
  }
  next();
});

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireAuth(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !safeEqual(match[1], AUTH_TOKEN)) {
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ error: 'Unauthorized. Provide the configured bearer token.' });
  }
  next();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: 'follow',
    signal: AbortSignal.timeout(12_000),
    headers: {
      'accept': 'application/json',
      'user-agent': 'XLILNYX-OSINT-MCP/1.0 (read-only public-source research)',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 1000) }; }
  if (!response.ok) {
    const err = new Error(`Upstream source returned HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return { data: body, status: response.status, url: response.url, checked_at: new Date().toISOString() };
}

function cleanDomain(input) {
  const value = String(input || '').trim().toLowerCase().replace(/\.$/, '');
  if (value.length > 253 || value.includes('://') || value.includes('/') || value.includes('@') || value.includes(':')) {
    throw new Error('Masukkan nama domain saja, misalnya example.com; jangan sertakan URL atau port.');
  }
  const ascii = new URL(`http://${value}`).hostname;
  if (!ascii || ascii.length > 253 || !ascii.includes('.') || !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(ascii)) {
    throw new Error('Format domain tidak valid.');
  }
  return ascii;
}

function cleanUrl(input) {
  let parsed;
  try { parsed = new URL(String(input).trim()); } catch { throw new Error('URL tidak valid.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Hanya URL HTTP/HTTPS yang didukung.');
  if (parsed.username || parsed.password) throw new Error('URL yang memuat kredensial tidak diizinkan.');
  if (parsed.hostname === 'localhost' || parsed.hostname.endsWith('.localhost') || parsed.hostname.endsWith('.local')) {
    throw new Error('URL localhost atau jaringan lokal tidak didukung.');
  }
  return parsed.toString();
}

function cleanPublicIp(input) {
  const value = String(input || '').trim();
  if (net.isIP(value) === 0) throw new Error('Alamat IP tidak valid.');
  const parsed = ipaddr.parse(value);
  const range = parsed.range();
  const allowed = ['unicast'];
  if (!allowed.includes(range)) throw new Error(`IP ditolak karena termasuk rentang ${range}; hanya IP publik unicast yang didukung.`);
  return value;
}

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
function errorResult(error) {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error?.message || 'Unknown error', checked_at: new Date().toISOString() }, null, 2) }] };
}

async function dnsLookup(domain) {
  const d = cleanDomain(domain);
  const types = ['A', 'AAAA', 'MX', 'NS', 'TXT', 'CNAME', 'CAA'];
  const records = {};
  const errors = {};
  await Promise.all(types.map(async type => {
    try {
      const result = await fetchJson(`https://dns.google/resolve?name=${encodeURIComponent(d)}&type=${type}`);
      records[type] = (result.data.Answer || []).map(r => ({ name: r.name, type: r.type, ttl: r.TTL, data: r.data }));
    } catch (e) { errors[type] = e.message; }
  }));
  return { target: d, source: 'Google Public DNS-over-HTTPS', checked_at: new Date().toISOString(), records, errors };
}

async function domainRdap(domain) {
  const d = cleanDomain(domain);
  const result = await fetchJson(`https://rdap.org/domain/${encodeURIComponent(d)}`);
  const x = result.data;
  return {
    target: d,
    source: result.url || 'https://rdap.org/',
    checked_at: result.checked_at,
    handle: x.handle || null,
    ldhName: x.ldhName || null,
    status: x.status || [],
    events: (x.events || []).map(e => ({ action: e.eventAction, date: e.eventDate })),
    nameservers: (x.nameservers || []).map(n => n.ldhName).filter(Boolean),
    entities: (x.entities || []).map(e => ({ roles: e.roles || [], handle: e.handle || null })),
    notices: (x.notices || []).map(n => ({ title: n.title, description: (n.description || []).slice(0, 3) })),
    note: 'Data registration may be redacted or incomplete; RDAP output is not proof of an individual identity.'
  };
}

async function ipRdap(ip) {
  const target = cleanPublicIp(ip);
  const result = await fetchJson(`https://rdap.org/ip/${encodeURIComponent(target)}`);
  const x = result.data;
  return {
    target,
    source: result.url || 'https://rdap.org/',
    checked_at: result.checked_at,
    name: x.name || null,
    handle: x.handle || null,
    startAddress: x.startAddress || null,
    endAddress: x.endAddress || null,
    ipVersion: x.ipVersion || null,
    country: x.country || null,
    type: x.type || null,
    parentHandle: x.parentHandle || null,
    entities: (x.entities || []).map(e => ({ roles: e.roles || [], handle: e.handle || null })),
    note: 'RDAP typically describes the registered network or organization, not the person using an IP.'
  };
}

function requireKey(name) {
  const key = process.env[name];
  if (!key) throw new Error(`${name} belum dikonfigurasi. Tambahkan di Environment Variables hosting lalu redeploy.`);
  return key;
}

async function virusTotalDomain(domain) {
  const d = cleanDomain(domain);
  const key = requireKey('VIRUSTOTAL_API_KEY');
  const result = await fetchJson(`https://www.virustotal.com/api/v3/domains/${encodeURIComponent(d)}`, { headers: { 'x-apikey': key } });
  const a = result.data.data?.attributes || {};
  return {
    target: d, source: 'VirusTotal API v3', checked_at: result.checked_at,
    reputation: a.reputation ?? null,
    last_analysis_stats: a.last_analysis_stats || null,
    categories: a.categories || {},
    last_analysis_date: a.last_analysis_date ? new Date(a.last_analysis_date * 1000).toISOString() : null,
    note: 'Reputation is a signal, not a definitive verdict. Check the provider terms and rate limits.'
  };
}

async function virusTotalUrl(url) {
  const target = cleanUrl(url);
  const key = requireKey('VIRUSTOTAL_API_KEY');
  const id = Buffer.from(target).toString('base64url');
  const result = await fetchJson(`https://www.virustotal.com/api/v3/urls/${id}`, { headers: { 'x-apikey': key } });
  const a = result.data.data?.attributes || {};
  return {
    target, source: 'VirusTotal API v3', checked_at: result.checked_at,
    reputation: a.reputation ?? null,
    last_analysis_stats: a.last_analysis_stats || null,
    categories: a.categories || {},
    last_analysis_date: a.last_analysis_date ? new Date(a.last_analysis_date * 1000).toISOString() : null,
    note: 'This checks an existing VirusTotal URL record; it does not guarantee a fresh scan. Avoid submitting confidential URLs.'
  };
}

async function shodanHost(ip) {
  const target = cleanPublicIp(ip);
  const key = requireKey('SHODAN_API_KEY');
  const result = await fetchJson(`https://api.shodan.io/shodan/host/${encodeURIComponent(target)}?key=${encodeURIComponent(key)}`);
  const x = result.data;
  return {
    target, source: 'Shodan Host API', checked_at: result.checked_at,
    ip_str: x.ip_str || target, country_name: x.country_name || null,
    org: x.org || null, isp: x.isp || null, asn: x.asn || null,
    ports: x.ports || [], hostnames: x.hostnames || [], domains: x.domains || [],
    last_update: x.last_update || null,
    data: (x.data || []).slice(0, 25).map(item => ({ port: item.port, transport: item.transport, product: item.product, version: item.version, module: item._shodan?.module })),
    note: 'Uses existing public Shodan observations; this tool does not scan or exploit the target.'
  };
}

async function braveSearch(query, count = 5) {
  const key = requireKey('BRAVE_SEARCH_API_KEY');
  const q = String(query || '').trim();
  if (q.length < 2 || q.length > 300) throw new Error('Query harus berisi 2–300 karakter.');
  const n = Math.max(1, Math.min(10, Number(count) || 5));
  const result = await fetchJson(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${n}`, { headers: { 'X-Subscription-Token': key } });
  const rows = result.data.web?.results || [];
  return {
    query: q, source: 'Brave Search API', checked_at: result.checked_at,
    results: rows.slice(0, n).map(r => ({ title: r.title, url: r.url, description: r.description, age: r.age || null, page_age: r.page_age || null }))
  };
}

function createMcpServer() {
  const server = new McpServer({ name: 'xlilnyx-cyber-osint', version: '1.0.0' });

  server.registerTool('osint_dns_lookup', {
    title: 'DNS Lookup', description: 'Look up public DNS records for a domain using Google Public DNS-over-HTTPS. Read-only; no scanning.',
    inputSchema: { domain: z.string().min(3).max(253).describe('Domain only, e.g. example.com') }
  }, async ({ domain }) => { try { return textResult(await dnsLookup(domain)); } catch (e) { return errorResult(e); } });

  server.registerTool('osint_domain_rdap', {
    title: 'Domain RDAP', description: 'Retrieve public domain registration metadata through the RDAP aggregator.',
    inputSchema: { domain: z.string().min(3).max(253).describe('Domain only, e.g. example.com') }
  }, async ({ domain }) => { try { return textResult(await domainRdap(domain)); } catch (e) { return errorResult(e); } });

  server.registerTool('osint_ip_rdap', {
    title: 'Public IP RDAP', description: 'Retrieve public IP allocation/registration information. Private, loopback, link-local, and non-unicast addresses are rejected.',
    inputSchema: { ip: z.string().min(3).max(45).describe('Public IPv4 or IPv6 address') }
  }, async ({ ip }) => { try { return textResult(await ipRdap(ip)); } catch (e) { return errorResult(e); } });

  server.registerTool('osint_domain_intel', {
    title: 'Domain Intelligence Summary', description: 'Combine public DNS and RDAP information for one domain. Optional VirusTotal result is included only when its API key is configured.',
    inputSchema: { domain: z.string().min(3).max(253).describe('Domain only, e.g. example.com') }
  }, async ({ domain }) => {
    try {
      const d = cleanDomain(domain);
      const [dns, rdap] = await Promise.allSettled([dnsLookup(d), domainRdap(d)]);
      let vt = null; let vtError = null;
      if (OPTIONAL_APIS_ENABLED && process.env.VIRUSTOTAL_API_KEY) { try { vt = await virusTotalDomain(d); } catch (e) { vtError = e.message; } }
      return textResult({ target: d, checked_at: new Date().toISOString(), dns: dns.status === 'fulfilled' ? dns.value : { error: dns.reason?.message }, rdap: rdap.status === 'fulfilled' ? rdap.value : { error: rdap.reason?.message }, virus_total: vt, virus_total_note: vtError || (!OPTIONAL_APIS_ENABLED || !process.env.VIRUSTOTAL_API_KEY ? 'Optional VirusTotal integration is disabled or not configured; reputation check skipped.' : null) });
    } catch (e) { return errorResult(e); }
  });

  if (OPTIONAL_APIS_ENABLED) {
  server.registerTool('osint_virustotal_domain', {
    title: 'VirusTotal Domain Reputation', description: 'Check existing VirusTotal domain reputation data. Requires VIRUSTOTAL_API_KEY.',
    inputSchema: { domain: z.string().min(3).max(253) }
  }, async ({ domain }) => { try { return textResult(await virusTotalDomain(domain)); } catch (e) { return errorResult(e); } });

  server.registerTool('osint_virustotal_url', {
    title: 'VirusTotal URL Reputation', description: 'Check an existing VirusTotal record for an HTTP/HTTPS URL. Requires VIRUSTOTAL_API_KEY. Do not submit confidential URLs.',
    inputSchema: { url: z.string().min(8).max(2048) }
  }, async ({ url }) => { try { return textResult(await virusTotalUrl(url)); } catch (e) { return errorResult(e); } });

  server.registerTool('osint_shodan_host', {
    title: 'Shodan Host Lookup', description: 'Read existing Shodan observations for a public IP. Does not scan or exploit. Requires SHODAN_API_KEY.',
    inputSchema: { ip: z.string().min(3).max(45) }
  }, async ({ ip }) => { try { return textResult(await shodanHost(ip)); } catch (e) { return errorResult(e); } });

  server.registerTool('osint_web_search', {
    title: 'Public Web Search', description: 'Search publicly indexed web pages using Brave Search API. Requires BRAVE_SEARCH_API_KEY.',
    inputSchema: { query: z.string().min(2).max(300), count: z.number().int().min(1).max(10).optional() }
  }, async ({ query, count }) => { try { return textResult(await braveSearch(query, count)); } catch (e) { return errorResult(e); } });

  }

  server.registerTool('osint_sources_status', {
    title: 'OSINT Source Configuration', description: 'Show which optional provider integrations are configured without exposing secret values.',
    inputSchema: {}
  }, async () => textResult({ checked_at: new Date().toISOString(), sources: {
    google_dns_over_https: { configured: true, note: 'No API key required for basic public DNS lookups; subject to provider availability.' },
    rdap: { configured: true, note: 'Public RDAP aggregator; data availability varies by registry.' },
    brave_search: { configured: OPTIONAL_APIS_ENABLED && Boolean(process.env.BRAVE_SEARCH_API_KEY), provider_key_present: Boolean(process.env.BRAVE_SEARCH_API_KEY), enabled: OPTIONAL_APIS_ENABLED, required_env: 'BRAVE_SEARCH_API_KEY' },
    virustotal: { configured: OPTIONAL_APIS_ENABLED && Boolean(process.env.VIRUSTOTAL_API_KEY), provider_key_present: Boolean(process.env.VIRUSTOTAL_API_KEY), enabled: OPTIONAL_APIS_ENABLED, required_env: 'VIRUSTOTAL_API_KEY' },
    shodan: { configured: OPTIONAL_APIS_ENABLED && Boolean(process.env.SHODAN_API_KEY), provider_key_present: Boolean(process.env.SHODAN_API_KEY), enabled: OPTIONAL_APIS_ENABLED, required_env: 'SHODAN_API_KEY' }
  }, authentication: AUTH_TOKEN ? 'Bearer token required (works only with clients that can send a static Authorization header).' : 'Authless public-source mode for remote connectors; optional provider APIs are disabled.',
    security: 'Read-only public-source OSINT. No port scanning, exploitation, credential collection, or access to private accounts.' }));

  return server;
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'xlilnyx-cyber-osint', timestamp: new Date().toISOString() }));
app.get('/', (_req, res) => res.type('text').send('XLILNYX Cyber OSINT MCP server. Health: /health | MCP endpoint: /mcp'));
app.all('/mcp', requireAuth, async (req, res) => {
  if (!['POST'].includes(req.method)) return res.status(405).json({ error: 'MCP endpoint accepts POST requests. Use an MCP-compatible client.' });
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => { void transport.close(); void server.close(); });
  } catch (error) {
    console.error('MCP request failed:', error?.message || 'unknown error');
    if (!res.headersSent) res.status(500).json({ error: 'MCP request failed. Check service logs for details.' });
    void transport.close();
    void server.close();
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`XLILNYX Cyber OSINT MCP listening on port ${PORT}`));
