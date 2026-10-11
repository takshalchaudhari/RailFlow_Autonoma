import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backendTarget =
  process.env.VITE_API_BASE_URL ||
  process.env.VITE_BACKEND_URL ||
  "http://127.0.0.1:8010";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      "/api": backendTarget,
      "/health": backendTarget,
    },
  },
});
