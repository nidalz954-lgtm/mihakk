import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createStaticHandler, DEMO_CSP } from "./src/static-app.mjs";

const parsedPort = Number.parseInt(process.env.PORT ?? "3000", 10);
const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 3000;
const host = process.env.HOST || "127.0.0.1";
// --demo serves dist-demo/ (ElevenLabs smart employee) with its wider CSP; the default stays strict.
const demo = process.argv.includes("--demo");
const server = createServer(createStaticHandler(demo ? { root: fileURLToPath(new URL("./dist-demo/", import.meta.url)), csp: DEMO_CSP } : {}));
server.requestTimeout = 10_000;
server.headersTimeout = 12_000;
server.keepAliveTimeout = 5_000;

server.listen(port, host, () => {
  process.stdout.write(`Mihakk${demo ? " demo (ElevenLabs smart employee, not for submission)" : ""} listening on http://${host}:${port}\n`);
});

function shutdown(signal) {
  server.close(() => {
    process.stdout.write(`Mihakk stopped after ${signal}\n`);
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
