# XLILNYX OFFICIAL — Cyber OSINT MCP

A read-only remote MCP server for **authorized cyber OSINT on public sources**. The default deployment is authless and exposes only free public-source tools (DNS-over-HTTPS and RDAP) so it can be connected to remote MCP clients that support authless connectors. Optional provider API tools are disabled by default.

## Current scope

- `osint_dns_lookup`: A, AAAA, MX, NS, TXT, CNAME, CAA via Google Public DNS-over-HTTPS.
- `osint_domain_rdap`: public registration metadata through `rdap.org`.
- `osint_ip_rdap`: public IP network allocation metadata; rejects non-public/non-unicast ranges.
- `osint_domain_intel`: DNS + RDAP; optional VirusTotal domain data only when optional-provider mode is safely enabled.
- `osint_sources_status`: provider configuration status, never reveals key values.

When optional-provider mode is enabled for a generic MCP client that supports static bearer headers, the server also exposes `osint_virustotal_domain`, `osint_virustotal_url`, `osint_shodan_host`, and `osint_web_search`. These integrations require their respective API keys.

This initial release deliberately does **not** perform arbitrary port scanning, exploitation, credential collection, account intrusion, or private-person location tracking. It does not claim to have checked anything unless a provider request succeeds.

## Deploy entirely from an Android browser

### 1. Create a GitHub repository

1. Open GitHub in your Android browser and sign in.
2. Create a new repository named `xlilnyx-cyber-osint`. For a private service, choose **Private**.
3. Upload the files from this project, preserving the folders `src/` and `scripts/` and the root files (`package.json`, `render.yaml`, `.gitignore`, `.env.example`, `README.md`, `SKILL.md`). Do not upload a real `.env` file or API keys.

### 2. Create a Render web service

1. Open Render Dashboard and connect the GitHub repository.
2. Create a **Web Service** from the repository. If Render offers a Blueprint flow, it can read `render.yaml`; otherwise set:
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check path: `/health`
3. Keep `ENABLE_OPTIONAL_PROVIDER_APIS=false` for the first deployment. Do not add provider API keys yet. This default mode is unauthenticated but exposes only free public DNS/RDAP tools; rate limiting is enabled.
4. Deploy and wait for the Render deployment to report success.

### 3. Check that the server is alive

Open `https://YOUR-SERVICE.onrender.com/health` in your browser. A successful deployment should return JSON similar to:

```json
{"ok":true,"service":"xlilnyx-cyber-osint","timestamp":"..."}
```

This only verifies the web process is alive; it does **not** prove all OSINT providers are configured.

### 4. Connect an MCP-compatible client

For Claude remote custom connectors, add a remote MCP server using:

- URL: `https://YOUR-SERVICE.onrender.com/mcp`
- Transport: Streamable HTTP
- Authentication: no authentication (default public-source mode)

**Important compatibility detail:** Claude remote connectors support authless or OAuth-based servers; this starter does not implement OAuth yet. Do not assume Claude can send a static bearer token. Therefore, keep optional provider APIs disabled in this mode. The server has no provider API keys to abuse, and exposes only public DNS/RDAP lookups. If you want VirusTotal, Shodan, or Brave API integrations in Claude, add a proper OAuth authorization flow or put the service behind a compatible OAuth gateway before enabling those keys.

Custom remote connectors in Claude are currently limited to eligible paid plans and may be added via Claude web settings; after adding it on the web, Claude mobile can use already-added remote connectors. Check Anthropic's current connector documentation and your account/workspace settings.

### 5. Test the actual tools

Call `osint_sources_status`, then run these safe tests:

- `osint_dns_lookup` with `example.com`
- `osint_domain_rdap` with `example.com`
- `osint_ip_rdap` with `8.8.8.8`
- `osint_domain_intel` with `example.com`

If configured, also test `osint_virustotal_domain` with `example.com`, `osint_virustotal_url` with `https://example.com/`, `osint_shodan_host` with `8.8.8.8`, and `osint_web_search` with a generic public query.

A tool call returning data is the evidence that the provider path works. If it errors, check Render logs and upstream availability. Do not share secrets in screenshots. The optional provider tools will not appear while `ENABLE_OPTIONAL_PROVIDER_APIS=false`.

## Map skill commands to MCP tools

| Skill command | MCP tool(s) |
|---|---|
| `/osint` | `osint_sources_status`, then select tools for the task |
| `/search-info` | `osint_web_search` |
| `/domain-info` | `osint_domain_intel` |
| `/dns-lookup` | `osint_dns_lookup` |
| `/ip-info` | `osint_ip_rdap` |
| `/url-check` | `osint_virustotal_url` |
| `/threat-intel` | `osint_virustotal_domain`, `osint_virustotal_url`, or `osint_shodan_host` according to target type |
| `/website-recon` | `osint_domain_intel`; only public metadata, no active scanning |
| `/source-check` | `osint_web_search`, then evaluate the returned source metadata |
| `/osint-report` | call relevant tools and write a sourced report from returned results |

A skill command is only an instruction. Live calls happen only when the MCP server is deployed **and** connected to the assistant/client. Without that connection, the assistant must not invent live results.

## Security notes

- Keep repository private where possible; never commit API keys.
- Default mode is unauthenticated and intended only for the free, read-only DNS/RDAP tools; it uses in-memory rate limiting, so it is a starter and not a production security boundary.
- Do not configure optional provider API keys or set `ENABLE_OPTIONAL_PROVIDER_APIS=true` while the server is in authless mode. The code refuses to enable optional providers without `MCP_AUTH_TOKEN`, but a static bearer token is not a supported auth mode for Claude remote custom connectors. Implement OAuth first for a Claude-facing deployment.
- For generic MCP clients that support a static bearer header, set `MCP_AUTH_TOKEN` to a unique random secret of at least 32 characters. Keep it only in hosting environment variables and the client's secret configuration; rotate it if exposed.
- Use only public sources and systems you own or have permission to assess.
- Public RDAP/IP metadata usually identifies a network allocation or organization, not the person behind an IP.
- Provider quotas, coverage, retention, and terms vary. VirusTotal URL lookups can expose submitted URLs to a third-party provider; never submit confidential links.
- Rate limiting in this starter is in-memory and per process. For production or multiple instances, add a shared rate limiter, structured audit logging with data minimization, and stronger authentication/OAuth.
