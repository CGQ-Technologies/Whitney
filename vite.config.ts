import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiPort = Number(env.BACKEND_PORT) || 3001;

  return {
    plugins: [react()],
    server: {
      port: Number(env.FRONTEND_PORT) || 5173,
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${apiPort}`,
          ws: true,
        },
      },
    },
  };
});
