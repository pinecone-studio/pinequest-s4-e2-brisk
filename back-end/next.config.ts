import type { NextConfig } from "next";

// API-only backend service (aegis-cctv-backend).
// Serves the route handlers under app/api/** consumed by aegis-cctv-front.
const nextConfig: NextConfig = {
  images: { unoptimized: true },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        crypto: false,
      };
    }
    return config;
  },
};

export default nextConfig;
