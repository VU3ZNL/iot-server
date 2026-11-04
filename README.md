# Radio Buoy IoT Server

Collects everything the Radio Buoy base unit uploads (base, buoy and every unit on the nRF24 mesh) and
broadcasts it live: web dashboard (map, unit cards, bearing base to buoy, trends, SOS history), Server-Sent
Events, Telegram and webhook alerts for new SOS events.

```
Buoy (ESP32) --nRF24 mesh--> Base unit (ESP8266) --WiFi/HTTPS POST--> this server --> dashboard / Telegram / webhook
```

## Run locally

```
npm install
IOT_KEY=your-long-random-secret npm start      # PowerShell: $env:IOT_KEY="..."; npm start
```
Open http://localhost:3000

Test without hardware:
```
curl -X POST http://localhost:3000/api/ingest \
  -H "Content-Type: application/json" -H "X-API-Key: your-long-random-secret" \
  -d '{"v":4,"node":2,"self":{"role":"base","fix":true,"lat":12.97,"lon":77.59},"toBuoy":{"id":1,"brg":247,"dist":830},"peers":[{"id":1,"role":"buoy","alive":true,"fix":true,"lat":12.971,"lon":77.595,"sos":false}]}'
```

## Deploy on Render

1. Push this repo to GitHub (private is fine).
2. Render > New > Blueprint > select the repo. `render.yaml` is picked up automatically.
3. Enter `IOT_KEY` (long random secret) when asked. Optional: Telegram / webhook variables.
4. Check `https://<your-service>.onrender.com/api/health`.
5. Optional custom domain: Settings > Custom Domains, then add a CNAME record at your DNS provider
   (e.g. `buoy.yourdomain.com` -> the onrender.com address).

Notes: the free plan sleeps after 15 minutes without traffic and has no persistent disk (log file is lost on
restart). Use the `starter` plan for a server that must always be awake for SOS alerts.

## Base unit settings (RadioBase_RX sketch)

```
#define IOT_URL "https://<your-domain>/api/ingest"
#define IOT_KEY "same secret as the server"
#define IOT_TLS 1      // Render is HTTPS only; plain http:// is redirected and the ESP8266 will not follow it
```

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `IOT_KEY` | yes | Secret the base unit sends in the `X-API-Key` header |
| `PORT` | no | Default 3000 (Render sets it automatically) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | no | Push every new SOS to Telegram |
| `SOS_WEBHOOK_URL` | no | POST every new SOS as JSON (Zapier, Make, n8n) |
| `DATA_DIR` | no | History folder, default `./data` |

See `.env.example`. Never commit a real `.env`.

## API

| Endpoint | Description |
|---|---|
| `POST /api/ingest` | Base unit upload (header `X-API-Key`) |
| `GET /api/stream` | Live Server-Sent Events |
| `GET /api/latest` | Newest snapshot of every unit |
| `GET /api/history/:id?minutes=60` | Recent points of one unit |
| `GET /api/alerts` | Recent SOS events |
| `GET /api/health` | Health check |

Upload format:
```
{"v":4,"node":2,"uptime":..,"rssi":..,"heap":..,
 "self":{role,fix,sats,lat,lon,course,speed,heading,roll,pitch,temp,pres,alt},
 "toBuoy":{"id":1,"brg":247,"dist":830},
 "peers":[{id,role,hops,link,age,alive,fix,sats,sos,reason,relay,roll,pitch,lat,lon,course,speed,temp,pres,alt,csq,op}]}
```

## Security

- The dashboard and read endpoints are public. Put a login or reverse-proxy password in front if positions are sensitive.
- History is in memory and lost on restart; every upload is also appended to `data/ingest.ndjson` (rotated at 20 MB).
