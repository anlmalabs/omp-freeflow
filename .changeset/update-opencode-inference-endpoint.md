---
"pi-freeflow": patch
---

Restore OpenCode free models following upstream endpoint and gate migration

OpenCode free models were failing with HTTP 403 FreeTierError after upstream deprecated the older endpoint and moved free inference traffic to the v1 inference gateway. Upstream also requires public authorization and non-empty schema declarations on compatibility tools.

Requests now route to the active endpoint with the required public credentials and schema declarations, restoring free model access across both direct connections and deployed relays.
