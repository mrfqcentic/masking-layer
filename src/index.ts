import { config } from "./config.js";
import { createApp } from "./server.js";

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(
    `[masking-layer] listening on http://localhost:${config.port}`,
  );
  console.log(
    `[masking-layer] upstream: ${config.llmBaseUrl} (model: ${config.model ?? "auto"})`,
  );
  if (!config.llmApiKey) {
    console.warn(
      "[masking-layer] LLM_API_KEY is not set; upstream requests will fail",
    );
  }
});

function shutdown(signal: string): void {
  console.log(`[masking-layer] received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));