import type { MetadataRoute } from 'next'

const basePath = (process.env.NEXT_PUBLIC_BASE_PATH || '').replace(/\/$/, '')

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Agent Flow Office',
    short_name: 'Agent Office',
    description: 'Internal real-time view of agent execution flows',
    start_url: `${basePath}/`,
    scope: `${basePath}/`,
    display: 'standalone',
    background_color: '#0a0a1a',
    theme_color: '#0a0a1a',
    icons: [
      { src: `${basePath}/icon-light-32x32.png`, sizes: '32x32', type: 'image/png' },
      { src: `${basePath}/apple-icon.png`, sizes: '180x180', type: 'image/png' },
    ],
  }
}
