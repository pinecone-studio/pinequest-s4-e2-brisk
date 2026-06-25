# Remote Camera Setup

Use remote mode when cameras are exposed through a cloud-synced RTSP endpoint instead of the local LAN address.

## Enable Remote Mode

Set the whole configuration to remote mode:

```json
{
  "connection_mode": "remote"
}
```

Or set a single camera to remote mode:

```json
{
  "id": "cam_010",
  "connection_mode": "remote",
  "remote_rtsp_url": "rtsp://user:password@example.com:554/path"
}
```

If `connection_mode` is omitted, the app uses local mode.

## Camera Fields

Each camera can define:

- `rtsp_url`: local LAN RTSP URL.
- `remote_rtsp_url`: cloud or remote RTSP URL.
- `connection_mode`: `local` or `remote`.

When `connection_mode` is `remote`, `remote_rtsp_url` is required. The app does not expose RTSP URLs or credentials through `/api/cameras`.

## Expected RTSP Format

```text
rtsp://<username>:<password>@<host>:<port>/<path>
```

Use the exact RTSP URL provided by the cloud camera system.

## Deployment Checklist

- Confirm every remote camera has `remote_rtsp_url`.
- Keep `rtsp_url` for LAN fallback.
- Verify firewall and cloud relay access from the server running Next.js.
- Avoid committing real production credentials when possible.

## Verification

1. Set `connection_mode` to `remote`.
2. Add `remote_rtsp_url` for one test camera.
3. Run `npm run build`.
4. Start the app and open `/cameras`.
5. Confirm `/api/stream/<camera-id>` returns MJPEG for working remote endpoints.

Server logs show `Camera mode: local` or `Camera mode: remote` without printing RTSP credentials.

## Troubleshooting

- `503` with missing `remote_rtsp_url`: add the remote URL or switch back to `local`.
- `STREAM UNAVAILABLE`: verify the cloud RTSP endpoint, credentials, port, and firewall access.
- Slow connection: increase stream open timeouts in a follow-up tuning change.
