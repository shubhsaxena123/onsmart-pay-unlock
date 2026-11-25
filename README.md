# OnSmart – Pay to Unlock (website version)

Three pieces:

| Piece | What it does |
|---|---|
| `server.js` + `public/` | The website. User enters the lock code, gets a unique amount (e.g. ₹50.13), pays by UPI. |
| `esp32/OnSmartLock/OnSmartLock.ino` | The lock. Checks in with the server every 2 s and unlocks when told to. |
| Notification helper (MacroDroid on **your** phone) | Forwards your "₹50.13 received" notification to the server, which confirms the payment. |

Flow: user opens site → enters `5424` → server checks lock is online → shows ₹50.13 + Pay button + QR →
user pays your UPI ID → your phone gets "Received ₹50.13" → MacroDroid sends it to the server →
server matches 50.13 to lock 5424 → ESP32's next check-in gets `UNLOCK` → servo opens → website shows ✓.

---

## 1. Run it on your laptop (to try it out)

```
npm install
node server.js
```
Open http://localhost:3000 . Admin page: http://localhost:3000/admin.html?key=change-me-admin

## 2. Put it online (free, Render.com)

1. Push this folder to a GitHub repo.
2. On render.com → **New → Web Service** → pick the repo.
   - Build command: `npm install`
   - Start command: `node server.js`
3. Add **Environment Variables**:

| Name | Example | Meaning |
|---|---|---|
| `UPI_ID` | `yourname@paytm` | Where money goes (a Paytm for Business merchant UPI ID works best) |
| `PAYEE_NAME` | `OnSmart` | Name shown in the UPI app |
| `LOCKS` | `5424:Xk29s8dLq:50` | `code:secret:price`, comma-separated for more locks |
| `NOTIFY_SECRET` | long random text | Password for the notification helper |
| `ADMIN_KEY` | long random text | Password for the admin page |

You get a URL like `https://onsmart.onrender.com`. Print that, plus the lock code, on the lock.
Tip: make a QR sticker of `https://onsmart.onrender.com/?lock=5424` – it pre-fills the code.

> Note: Render's free plan sleeps after ~15 min without traffic. The ESP32's check-ins every 2 s keep it awake, but the free plan has monthly hour limits – fine for a demo. Payment sessions are kept in memory, so they reset if the server restarts.

## 3. ESP32

1. Arduino IDE → install the **ESP32 board package** and the **ESP32Servo** library.
2. Open `esp32/OnSmartLock/OnSmartLock.ino`, set `WIFI_SSID`, `WIFI_PASSWORD`, `SERVER` (your Render URL), `LOCK_ID`, `LOCK_SECRET` (same as in `LOCKS`), `SERVO_PIN`, angles.
3. Upload. Serial Monitor (115200) shows check-ins and unlocks.
4. The admin page should show the lock as **Online**.

The ESP32 only needs a WiFi network with internet. A phone hotspot works for demos.

## 4. Notification helper on your phone (MacroDroid, free)

Install **MacroDroid** from Play Store on the phone that receives the payments. Create a macro:

- **Trigger:** *Notification Received* → app: **Paytm for Business** (or Paytm) → text contains: `Received`
  - Using bank SMS instead? Use *SMS Received* → content contains `credited`.
- **Action:** *HTTP Request*
  - Method: `POST`
  - URL: `https://YOUR-SITE.onrender.com/api/notify`
  - Content type: `application/json`
  - Body:
    ```
    {"key":"YOUR_NOTIFY_SECRET","text":"[notification_title] [notification]"}
    ```
    (For SMS, use the SMS message-text variable instead. Pick variables from MacroDroid's "..." variable menu if the names differ.)
- Give MacroDroid notification access when it asks, and turn **off battery optimisation** for it so it keeps running.

Test it without paying anyone:
```
curl -X POST https://YOUR-SITE.onrender.com/api/notify -H "Content-Type: application/json" \
  -d '{"key":"YOUR_NOTIFY_SECRET","text":"Received ₹50.13 from Test"}'
```
(start a session on the website first and use the amount it shows)

The server only accepts texts containing *received / credited / added / deposited*, so outgoing "Paid ₹…" notifications are ignored.

## 5. Admin page (demo + manual override)

`/admin.html?key=YOUR_ADMIN_KEY` shows which locks are online and recent payments, with:
- **Mark paid** – if the notification was missed but you can see the money arrived.
- **Force unlock** – opens a lock directly.

## Known limitations (good to mention in the report)

- Confirmation depends on your phone being on, online and receiving the notification.
- If Paytm/bank changes its notification wording, adjust the regex in `server.js` (`/api/notify`).
- Matching is by unique amount (₹50.01–₹50.99), so up to 99 payments can be pending at once.
- A stranger paying you the exact same amount by coincidence within the 10-minute window would unlock that lock (very unlikely).
- `setInsecure()` on the ESP32 skips the HTTPS certificate check. Fine for a demo; pin the certificate for production.
