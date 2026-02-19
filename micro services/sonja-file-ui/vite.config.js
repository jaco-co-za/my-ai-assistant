import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";

function buildProxy(env) {
  const target = (env.VITE_FILE_SERVICE_URL || "http://localhost:3224").trim();
  const authHeader = (env.VITE_FILE_SERVICE_AUTH || "").trim();
  return {
    "/api/file": {
      target,
      changeOrigin: true,
      rewrite: (p) => p.replace(/^\/api\/file/, ""),
      configure: (proxy) => {
        proxy.on("proxyReq", (proxyReq) => {
          if (authHeader) {
            proxyReq.setHeader("Authorization", authHeader);
          }
        });
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const port = Number.parseInt(env.VITE_PORT || "5188", 10);
  const proxy = buildProxy(env);
  return {
    plugins: [vue()],
    server: {
      host: true,
      port: Number.isFinite(port) ? port : 5188,
      proxy,
    },
    preview: {
      host: true,
      port: Number.isFinite(port) ? port : 5188,
      proxy,
    },
  };
});
