import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Pin Turbopack's workspace root to this project. Without this, a stray
  // lockfile in the parent folder (C:\Users\veera\package-lock.json) makes
  // Next.js serve from the wrong root and every /api/* route returns 404.
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
