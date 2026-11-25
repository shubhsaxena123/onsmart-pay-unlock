// OnSmart Lock – ESP32
// Connects to WiFi, checks in with the server every 2 s ("I'm online, anything for me?"),
// and unlocks the servo when the server answers "UNLOCK".
// Libraries: ESP32Servo (install from Library Manager). WiFi + HTTPClient come with the ESP32 board package.

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ESP32Servo.h>

// ---------- CHANGE THESE ----------
const char* WIFI_SSID     = "YOUR_WIFI";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* SERVER        = "https://your-app.onrender.com";  // no trailing slash
const char* LOCK_ID       = "5424";                           // the code printed on the lock
const char* LOCK_SECRET   = "lock5424secret";                 // must match LOCKS on the server
const int   SERVO_PIN     = 13;
const int   LOCK_ANGLE    = 0;
const int   UNLOCK_ANGLE  = 90;
const unsigned long POLL_MS = 2000;
// -----------------------------------

Servo servo;
unsigned long lastPoll = 0;

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.print("Connecting to WiFi");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) { delay(500); Serial.print("."); }
  Serial.println(WiFi.status() == WL_CONNECTED ? " connected" : " failed, will retry");
}

String request(const char* method, const String& path) {
  WiFiClientSecure client;
  client.setInsecure();  // skips certificate check – fine for a demo; pin the server cert for production
  HTTPClient http;
  http.begin(client, String(SERVER) + path);
  http.addHeader("X-Lock-Key", LOCK_SECRET);
  http.setTimeout(8000);
  int code = (strcmp(method, "POST") == 0) ? http.POST("") : http.GET();
  String body = code > 0 ? http.getString() : "";
  http.end();
  if (code != 200) { Serial.printf("%s %s -> %d\n", method, path.c_str(), code); return ""; }
  body.trim();
  return body;
}

void unlockNow() {
  Serial.println("UNLOCK received – opening");
  servo.write(UNLOCK_ANGLE);
  // Tell the server it's done (retry a few times so the website shows "Unlocked")
  for (int i = 0; i < 5; i++) {
    if (request("POST", String("/api/lock/") + LOCK_ID + "/ack") == "OK") break;
    delay(1000);
  }
}

void setup() {
  Serial.begin(115200);
  servo.attach(SERVO_PIN);
  servo.write(LOCK_ANGLE);  // locked on power-up
  WiFi.mode(WIFI_STA);
  connectWiFi();
}

void loop() {
  connectWiFi();
  if (WiFi.status() == WL_CONNECTED && millis() - lastPoll >= POLL_MS) {
    lastPoll = millis();
    String reply = request("GET", String("/api/lock/") + LOCK_ID + "/poll");
    if (reply == "UNLOCK") unlockNow();
  }
  delay(50);
}
