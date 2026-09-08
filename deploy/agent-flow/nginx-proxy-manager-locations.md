# Nginx Proxy Manager custom locations

Attach these locations to the existing authenticated launcher host. Keep the
host's current access list/session policy enabled; this route is internal and
must not become an unauthenticated public service.

Use `/agent-flow/` as the public path. The exact NPM form fields differ by
version, so preserve the existing host's SSL and access-list settings and add
the following locations:

## Web UI

```nginx
location = /agent-flow {
    return 301 /agent-flow/;
}

location /agent-flow/ {
    auth_basic "Agent Flow Office";
    auth_basic_user_file /data/nginx/custom/agent-flow-office.htpasswd;
    # Strip the public prefix; Next.js basePath is used for generated asset
    # URLs, while the next-server itself serves the route at its root.
    proxy_pass http://172.17.0.1:8612/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Prefix /agent-flow;
    proxy_read_timeout 60s;
}
```

## SSE relay

```nginx
location = /agent-flow/events {
    proxy_pass http://172.17.0.1:3001/events;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
    add_header Cache-Control no-cache;
}
```

## Local runtime ingest

The local Claude/Codex integration sends only bounded lifecycle metadata to
this endpoint. It is protected by the relay's `AGENT_FLOW_INGEST_TOKEN`; do
not put the token in the URL or expose the private relay port directly.

```nginx
location = /agent-flow/ingest {
    proxy_pass http://172.17.0.1:3001/ingest;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header X-Agent-Flow-Token $http_x_agent_flow_token;
    proxy_request_buffering off;
    client_max_body_size 256k;
    proxy_read_timeout 30s;
}
```

This route may be enabled before a local source is configured: without the
token the relay returns `503 ingest-disabled`, and without a valid token it
returns `401`. No Windows service is required.

The private listeners must not be published directly. Test the proxy with
`nginx -t`/NPM's equivalent before reloading and then verify the authenticated
browser stream, not only an HTTP 200 response.
