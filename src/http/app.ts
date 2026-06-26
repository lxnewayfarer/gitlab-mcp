import express, { type Express } from "express";
import helmet from "helmet";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { getConfig } from "../config/index.js";
import { mcpOAuthProvider } from "../auth/mcpOAuthProvider.js";
import { authRoutes } from "./authRoutes.js";
import { mcpRoute } from "./mcpRoute.js";

/** Build the Express application (no listen) — convenient for tests. */
export function createApp(): Express {
  const app = express();

  app.use(helmet());
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/", (_req, res) => {
    res
      .status(200)
      .type("html")
      .send(
        `<!doctype html><meta charset="utf-8"><title>GitLab MCP Server</title>
         <h1>GitLab MCP Server</h1>
         <p><a href="/auth/login">Log in with GitLab</a> to obtain an MCP bearer token.</p>`,
      );
  });

  app.use("/auth", authRoutes());

  const cfg = getConfig();
  app.use(
    mcpAuthRouter({
      provider: mcpOAuthProvider(),
      issuerUrl: new URL(cfg.PUBLIC_BASE_URL),
      resourceServerUrl: new URL(`${cfg.PUBLIC_BASE_URL.replace(/\/$/, "")}/mcp`),
      scopesSupported: ["mcp"],
      resourceName: "GitLab MCP",
    }),
  );

  app.use("/mcp", mcpRoute());

  return app;
}
