import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@oss-capacity/core"],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js", ".jsx"]
    };

    return config;
  }
};

export default nextConfig;
