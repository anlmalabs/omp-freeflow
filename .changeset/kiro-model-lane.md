---
"pi-freeflow": minor
---

Added a Kiro lane with 15 free models, bringing the catalog to 50.

This lane is deprecated: it is a stopgap that will be retired in favour of the
official Kiro CLI ACP integration, which carries the credential and the session
for you instead of a hand-exported bearer token. The OpenCode Zen lane is
deprecated on the same terms, in favour of the official OpenCode CLI ACP
integration. Both still work; expect both to go away once the ACP paths land.

Kiro's models are a new direct-only lane: they are never routed through your
relay pool, so your existing relays keep serving the upstreams they already
serve and nothing moves off them. Context windows reach 1M on the Claude
Opus entries, with 200K on Sonnet and Haiku, 272K on the GPT-5.6 family, and
128K on DeepSeek, Qwen3 Coder, GLM 5, and MiniMax. The Claude entries surface
the model's reasoning and offer the usual thinking-level choices — Kiro exposes
no effort control, so the level you pick is not forwarded upstream; the rest
are not reasoning models and offer none.

This lane is token-gated rather than keyless. Put a Kiro bearer token you
obtained out of band in the `PI_FREEFLOW_KIRO_TOKEN` environment variable
before you start a session and the models are ready to pick — there is no
login command for it. Without that variable set, a request to one of these
models answers 501 instead of going upstream anonymously, so the cause is
never a puzzling upstream rejection. The token stays on your machine and is
sent to Kiro only.
