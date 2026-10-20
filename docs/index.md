---
# https://vitepress.dev/reference/default-theme-home-page
layout: home

hero:
  name: "pi-freeflow"
  text: "50 free models. Up to 1M context. Zero API keys."
  tagline: "Thin OMP/Pi provider: model list + dumb relay proxy + log. Host pi-ai owns thinking & normalization."
  actions:
    - theme: brand
      text: Get Started
      link: /pages/architecture
    - theme: alt
      text: View on GitHub
      link: https://github.com/trefeon/pi-freeflow

features:
  - title: "50 Curated Free Models"
    details: 12 OpenCode Zen + 13 KiloCode Gateway + 2 Cline + 8 OVHcloud AI Endpoints + 15 Kiro — up to 1M context, 512K output, vision support. Everything keyless except Kiro, which takes a bearer token. Zen and Kiro are deprecated in favour of the official CLI ACP integrations.
  - title: "BYO Relay Pool"
    details: Round-robin across your own relays — a self-hosted pool that runs many egress IPs on one small host, or Cloudflare Workers / Vercel Edge / Deno Deploy workers.
  - title: "Adaptive Failover"
    details: Auto-rolls on 429/5xx, cooldown for unhealthy relays, transparent direct fallback when pool exhausted.
  - title: "Master/Worker Proxy"
    details: Single-port 28180 shared across OMP subagents — 0ms startup for parallel workers, no port conflicts.
  - title: "Thin by Design"
    details: No build step, one runtime dep, no payload normalizer — host pi-ai owns thinking and reasoning translation.
  - title: "Observable Logging"
    details: Auto-rotating 10MB file logger at ~/.pi/agent/pi-freeflow.log with request correlation IDs.
---
