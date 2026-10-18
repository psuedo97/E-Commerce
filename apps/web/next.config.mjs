/** @type {import('next').NextConfig} */
const nextConfig = {
  // Lets a production build use its own folder while `next dev` is running (they clash on .next).
  distDir: process.env.NEXT_DIST_DIR || '.next',
};
export default nextConfig;
