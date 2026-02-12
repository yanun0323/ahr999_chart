import solid from "vite-plugin-solid";
import { defineConfig } from "vite";

const normalizeBasePath = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === "/") {
    return "/";
  }

  const leading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return leading.endsWith("/") ? leading : `${leading}/`;
};

export default defineConfig({
  base: normalizeBasePath(process.env.VITE_BASE_PATH ?? "/"),
  plugins: [solid()],
  server: {
    port: 5173
  }
});
