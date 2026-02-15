import express from "express";
import dotenv from "dotenv";
import endpoints from "./routes/endpoints";
import { initializeHomeAssistant } from "./homeAssistant";

dotenv.config();

const app = express();
const port = Number(process.env.PORT) || 3222;

app.use(express.json({ limit: "2mb" }));
app.use((req, _res, next) => {
  console.log(`HTTP ${req.method} ${req.path}`);
  if (req.method !== "GET") {
    console.log("HTTP body", JSON.stringify(req.body));
  }
  next();
});
app.use(endpoints);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal Server Error" });
});

app.listen(port, () => {
  console.log(`micro-service-home-assistant listening on port ${port}`);
  initializeHomeAssistant().catch((err) => {
    console.error("Failed to initialize Home Assistant MCP client", err);
  });
});
