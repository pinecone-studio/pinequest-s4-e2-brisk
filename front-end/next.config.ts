import type { NextConfig } from "next";

const cameraServiceOrigin =
  process.env.BACKEND_URL ?? process.env.CAMERA_SERVICE_ORIGIN ?? "http://localhost:3001";
const isStaticExport = process.env.STATIC_EXPORT === "1";

const nextConfig: NextConfig = {
  ...(isStaticExport
    ? { output: "export" as const }
    : {
        async rewrites() {
          return [
            {
              source: "/api/camera-service/:path*",
              destination: `${cameraServiceOrigin}/api/:path*`,
            },
          ];
        },
      }),
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
