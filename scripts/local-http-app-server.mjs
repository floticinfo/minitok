import { startServer } from "../tests/fixtures/local-http-app/server.js";

const port = Number(process.env.PORT || 43127);
try {
  const app = await startServer(port);
  console.log(`local-http-app listening at ${app.baseUrl}`);
  const close = async () => { await app.close(); process.exitCode = 0; };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
