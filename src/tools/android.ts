/**
 * AndroidControl - Full Android device control via Termux:API
 *
 * Requires the Termux:API app + `pkg install termux-api` inside Termux.
 * All commands are thin wrappers around the `termux-*` CLI tools, so the
 * agent can drive the phone (SMS, calls, camera, sensors, clipboard,
 * notifications, media, TTS, location, battery, vibration, toasts, etc.)
 * without any extra native code.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Logger } from "../utils/logger.js";
import type { ToolDefinition } from "./registry.js";

const execFileAsync = promisify(execFile);
const logger = new Logger("Android");

async function run(cmd: string, args: string[] = [], input?: string): Promise<any> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      encoding: "utf8",
      timeout: 30000,
      input
    } as any);
    const out = (stdout || "").trim();
    try { return JSON.parse(out); } catch { return out || stderr || "ok"; }
  } catch (err: any) {
    logger.error(`${cmd} failed: ${err.message}`);
    throw new Error(`Android command failed: ${err.message}`);
  }
}

/**
 * Returns the full set of Android control tools as ToolDefinitions.
 * Pass the result into ToolRegistry.register() on startup.
 */
export function getAndroidTools(): ToolDefinition[] {
  const t = (name: string, description: string, parameters: any, handler: (a: any) => Promise<any>): ToolDefinition => ({
    name, description, parameters, enabled: true, handler
  });

  return [
    t("android_battery", "Get battery status (level, plugged, temperature, health).",
      { type: "object", properties: {} },
      async () => run("termux-battery-status")),

    t("android_location", "Get GPS/network location.",
      { type: "object", properties: { provider: { type: "string", enum: ["gps", "network", "passive"] } } },
      async (a) => run("termux-location", a.provider ? ["-p", a.provider] : [])),

    t("android_sms_send", "Send an SMS message.",
      { type: "object", properties: { number: { type: "string" }, text: { type: "string" } }, required: ["number", "text"] },
      async (a) => run("termux-sms-send", ["-n", a.number, a.text])),

    t("android_sms_list", "List received SMS messages.",
      { type: "object", properties: { limit: { type: "number" } } },
      async (a) => run("termux-sms-list", ["-l", String(a.limit || 20)])),

    t("android_call", "Place a phone call to a number.",
      { type: "object", properties: { number: { type: "string" } }, required: ["number"] },
      async (a) => run("termux-telephony-call", [a.number])),

    t("android_contacts", "List phone contacts.",
      { type: "object", properties: {} },
      async () => run("termux-contact-list")),

    t("android_notification", "Post a system notification.",
      { type: "object", properties: {
        title: { type: "string" }, content: { type: "string" }, id: { type: "string" }
      }, required: ["title", "content"] },
      async (a) => run("termux-notification", [
        "--title", a.title, "--content", a.content, ...(a.id ? ["--id", a.id] : [])
      ])),

    t("android_toast", "Show a toast popup on screen.",
      { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      async (a) => run("termux-toast", [a.text])),

    t("android_vibrate", "Vibrate the device.",
      { type: "object", properties: { duration: { type: "number", description: "ms" } } },
      async (a) => run("termux-vibrate", ["-d", String(a.duration || 500)])),

    t("android_tts", "Speak text aloud via text-to-speech.",
      { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      async (a) => run("termux-tts-speak", [a.text])),

    t("android_clipboard_get", "Read the system clipboard.",
      { type: "object", properties: {} },
      async () => run("termux-clipboard-get")),

    t("android_clipboard_set", "Write to the system clipboard.",
      { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      async (a) => run("termux-clipboard-set", [a.text])),

    t("android_camera_photo", "Capture a photo from the device camera.",
      { type: "object", properties: {
        path: { type: "string" }, camera: { type: "string", enum: ["0", "1"] }
      }, required: ["path"] },
      async (a) => run("termux-camera-photo", ["-c", a.camera || "0", a.path])),

    t("android_camera_info", "List available cameras.",
      { type: "object", properties: {} },
      async () => run("termux-camera-info")),

    t("android_media_player", "Control media player (play/pause/stop/info/play <file>).",
      { type: "object", properties: {
        action: { type: "string", enum: ["play", "pause", "stop", "info"] },
        file: { type: "string" }
      }, required: ["action"] },
      async (a) => run("termux-media-player", a.file ? ["play", a.file] : [a.action])),

    t("android_sensor", "Read a device sensor (accelerometer, gyroscope, etc.).",
      { type: "object", properties: {
        sensor: { type: "string" }, samples: { type: "number" }
      }, required: ["sensor"] },
      async (a) => run("termux-sensor", ["-s", a.sensor, "-n", String(a.samples || 1)])),

    t("android_wifi_info", "Get current WiFi connection info.",
      { type: "object", properties: {} },
      async () => run("termux-wifi-connectioninfo")),

    t("android_wifi_scan", "Scan for nearby WiFi networks.",
      { type: "object", properties: {} },
      async () => run("termux-wifi-scaninfo")),

    t("android_brightness", "Set screen brightness (0-255 or 'auto').",
      { type: "object", properties: { level: { type: "string" } }, required: ["level"] },
      async (a) => run("termux-brightness", [a.level])),

    t("android_volume", "Get or set a volume stream (music, ring, call, system, notification).",
      { type: "object", properties: {
        stream: { type: "string" }, level: { type: "number" }
      } },
      async (a) => run("termux-volume", a.stream ? [a.stream, String(a.level)] : [])),

    t("android_open", "Open a URL, file, or intent on the device.",
      { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
      async (a) => run("termux-open", [a.target])),

    t("android_share", "Share text or a file via the Android share sheet.",
      { type: "object", properties: {
        text: { type: "string" }, file: { type: "string" }
      } },
      async (a) => a.file
        ? run("termux-share", [a.file])
        : run("termux-share", [], a.text)),

    t("android_download", "Download a URL via the system DownloadManager.",
      { type: "object", properties: {
        url: { type: "string" }, title: { type: "string" }
      }, required: ["url"] },
      async (a) => run("termux-download", a.title ? ["-t", a.title, a.url] : [a.url])),

    t("android_fingerprint", "Request fingerprint authentication.",
      { type: "object", properties: { title: { type: "string" } } },
      async (a) => run("termux-fingerprint", a.title ? ["-t", a.title] : [])),
  ];
}
