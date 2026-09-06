import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This repository has a separate Node lab lockfile above the dashboard.
  turbopack: { root: process.cwd() },
};

export default nextConfig;
