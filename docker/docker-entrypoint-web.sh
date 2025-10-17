#!/bin/sh
set -e

# Extract hostname and port from GTS_SERVER_API_BASE
# Default: http://localhost:7806
API_BASE="${GTS_SERVER_API_BASE:-http://localhost:7806}"

# Parse hostname and port from URL
HOSTNAME=$(echo "$API_BASE" | sed -E 's|^https?://([^:/]+).*|\1|')
PORT=$(echo "$API_BASE" | sed -E 's|^https?://[^:]+:([0-9]+).*|\1|')

# If port extraction failed (no port in URL), use default
if [ "$PORT" = "$API_BASE" ]; then
  PORT=7806
fi

# Create runtime config file
cat > /usr/share/nginx/html/config.json << EOF
{
  "server": {
    "hostname": "${HOSTNAME}",
    "port": ${PORT}
  }
}
EOF

echo "Generated runtime config:"
cat /usr/share/nginx/html/config.json

# Execute the CMD
exec "$@"
