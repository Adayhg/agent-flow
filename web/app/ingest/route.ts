/**
 * Same-origin bridge for optional local runtime events.
 *
 * Keeping this as a Next route means the public launcher can forward the
 * request to the private relay without exposing port 3001 or requiring a new
 * local Agent Flow service. The relay remains the authentication and privacy
 * boundary.
 */
export const dynamic = 'force-dynamic'

const RELAY_INGEST_URL = process.env.AGENT_FLOW_RELAY_INGEST_URL || 'http://172.17.0.1:3001/ingest'

export async function POST(request: Request): Promise<Response> {
  const headers = new Headers({
    'Content-Type': request.headers.get('content-type') || 'application/json',
  })
  const authorization = request.headers.get('authorization')
  const sourceToken = request.headers.get('x-agent-flow-token')
  if (authorization) headers.set('Authorization', authorization)
  if (sourceToken) headers.set('X-Agent-Flow-Token', sourceToken)

  try {
    const upstream = await fetch(RELAY_INGEST_URL, {
      method: 'POST',
      headers,
      body: await request.text(),
      cache: 'no-store',
    })
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    })
  } catch {
    return Response.json({ error: 'relay-unavailable' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    })
  }
}
