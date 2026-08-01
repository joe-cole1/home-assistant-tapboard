# Tapboard Repository Instructions

## Post-commit local deployment

After every commit in this repository:

1. Rebuild and restart the local Tapboard Docker Compose service with `docker compose up -d --build`.
2. Confirm the `tapboard` container is running and bound to host port `3005`.
3. Verify `http://localhost:3005/healthz` returns HTTP 200.

This instruction applies to the local test container only. Do not deploy to any remote environment or restart Home Assistant/ESPHome unless the user separately requests it.
