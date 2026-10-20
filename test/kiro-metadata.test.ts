/**
 * Kiro lane metadata: the Kiro models must be advertised as their own lane.
 *
 * Two surfaces carry the provider label:
 *  - the host picker, via buildProviderConfig's per-model `owned_by`;
 *  - the proxy's GET /v1/models, which reports the same label per id.
 *
 * Both must say "kiro" for a Kiro model (not the "opencode" default the
 * source map used to fall through to), and a Kiro model must get the
 * direct-lane compat: reasoning effort is offered only when the entry
 * declares an effort map (the 8 Claude entries), never unconditionally.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildProviderConfig } from "../src/index.ts";
import { startProxy } from "../src/proxy.ts";
import { ALL_MODELS, getModelUpstream } from "../src/models.ts";
import { authHeaders } from "./_auth.ts";

/** Test-only proxy port (outside the 29471-29476 Kiro lane block). */
const TEST_PORT = 29611;

const KIRO_REASONING_ID = "claude-opus-5.5";
const KIRO_PLAIN_ID = "deepseek-3.2";

/** The catalog the host would register: every model tagged with its lane. */
function registeredCatalog() {
	return ALL_MODELS.map((m) => ({ ...m, source: getModelUpstream(m.id) }));
}

test("buildProviderConfig labels a Kiro model as owned by kiro with the direct-lane compat", () => {
	const cfg = buildProviderConfig(registeredCatalog(), TEST_PORT);

	const kiro = cfg.models.find((m) => m.id === KIRO_REASONING_ID);
	assert.ok(kiro, "the Kiro Claude entry must be registered");
	assert.equal(kiro!.owned_by, "kiro");
	assert.equal(
		kiro!.compat?.supportsReasoningEffort,
		true,
		"a Kiro entry with an effort map offers reasoning effort",
	);

	const plain = cfg.models.find((m) => m.id === KIRO_PLAIN_ID);
	assert.ok(plain, "the non-reasoning Kiro entry must be registered");
	assert.equal(plain!.owned_by, "kiro");
	assert.equal(
		plain!.compat?.supportsReasoningEffort,
		false,
		"a Kiro entry without an effort map must not claim reasoning effort",
	);

	// The other lanes keep their own vendor labels.
	const ownerOf = (id: string): string | undefined =>
		cfg.models.find((m) => m.id === id)?.owned_by;
	assert.equal(ownerOf("dots-studio/dots-3-note-preview:free"), "kilocode");
	assert.equal(ownerOf("z-ai/glm-5.3-flash"), "clinecode");
	assert.equal(ownerOf("ovh-free/gpt-oss-120b"), "ovhcloud");
	assert.equal(ownerOf("cat-jam-free"), "opencode");
});

test("GET /v1/models reports owned_by kiro for the Kiro lane and keeps the other labels", async () => {
	const { server, port } = await startProxy(TEST_PORT);
	const effectivePort = port ?? TEST_PORT;
	try {
		const res = await fetch(`http://127.0.0.1:${effectivePort}/v1/models`, {
			headers: { ...authHeaders() },
		});
		assert.equal(res.status, 200);
		const json = (await res.json()) as { data: Array<{ id: string; owned_by: string }> };
		const ownedBy = new Map(json.data.map((m) => [m.id, m.owned_by]));

		assert.equal(ownedBy.get(KIRO_REASONING_ID), "kiro");
		assert.equal(ownedBy.get(KIRO_PLAIN_ID), "kiro");
		assert.equal(ownedBy.get("dots-studio/dots-3-note-preview:free"), "kilocode");
		assert.equal(ownedBy.get("z-ai/glm-5.3-flash"), "clinecode");
		assert.equal(ownedBy.get("ovh-free/gpt-oss-120b"), "ovhcloud");
		assert.equal(ownedBy.get("cat-jam-free"), "opencode");
	} finally {
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
