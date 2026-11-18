// The model of a Harness provider in Oh My Pi (daemon acp_models.py).
//
// The daemon starts "omp acp -e <this file>". This extension registers the provider "harness" with one
// model. HARNESS_OMP_PROVIDER (JSON) gives the server address, the model, and the context length. The
// API key is only in the environment variable HARNESS_PROVIDER_API_KEY: OMP reads the variable name.
// With no valid configuration, the extension does nothing.
export default function harnessProvider(pi) {
	let config;
	try {
		config = JSON.parse(process.env.HARNESS_OMP_PROVIDER || "");
	} catch {
		return;
	}
	if (!config || typeof config.baseUrl !== "string" || typeof config.model !== "string") return;
	const context = Number.isInteger(config.context) && config.context > 0 ? config.context : 128000;
	pi.registerProvider("harness", {
		baseUrl: config.baseUrl,
		apiKey: "HARNESS_PROVIDER_API_KEY",
		api: "openai-completions",
		models: [
			{
				id: config.model,
				name: config.model,
				api: "openai-completions",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: context,
				maxTokens: Math.min(Math.floor(context / 4), 32768),
			},
		],
	});
}
