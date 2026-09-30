import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Sinh .next/standalone — server.js tối giản để chạy trong image Docker nhỏ gọn
  output: "standalone",
};

export default nextConfig;
