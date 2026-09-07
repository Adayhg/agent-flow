export function GET() {
  return Response.json(
    { status: 'ok', service: 'agent-flow-office-web' },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
