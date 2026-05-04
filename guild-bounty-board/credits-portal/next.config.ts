import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  basePath: "/credits",
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
