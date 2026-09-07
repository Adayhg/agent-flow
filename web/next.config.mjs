/** @type {import('next').NextConfig} */
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH || '').replace(/\/$/, '')

const nextConfig = {
  basePath,
  images: {
    unoptimized: true,
  },
}

export default nextConfig
