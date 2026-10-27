import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "../package.json" with { type: "json" };

const extensionKey =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2MMIurte87Qyc3+fgE14sZvVNdY7Y/olNx0+9P5av+/KaVbtRjgsAWB7hEdJhvX0qjAPi083fknAmZ/kMjTWVGhjWgl+XVxWH19PANwk7gbPw0qxYQsEi8p9iFJteirmszxPootNYsFnSCdgTebk9O7j2E1mNDCcR9+vt6rOMTZXBgjNy8tmAtHeWG5m8XD+EZSvx7sxh4bXNIhKMcpUnnx8j6+BHiuJyAkKsgTHkZ8pDAapwRYX+FpMzSLap5ugeiGCFiA3RWOTFG0LdbjJ1tuIczu3EJ3diGOgQtt5nZmZJvCkcA60l4qShDiJhWTFHHi2VsROY51eJLecQsffFQIDAQAB";

export default defineManifest({
  manifest_version: 3,
  name: "AIPageGo — AI 网页助手",
  description: "让 AI 帮你浏览、总结、操作网页，并把成功的对话固化为可复用工具",
  version: pkg.version,
  key: extensionKey,
  icons: {
    16: "icons/icon-16.png",
    32: "icons/icon-32.png",
    48: "icons/icon-48.png",
    128: "icons/icon-128.png"
  },
  action: {
    default_title: "AIPageGo",
    default_icon: {
      16: "icons/icon-16.png",
      32: "icons/icon-32.png",
      48: "icons/icon-48.png",
      128: "icons/icon-128.png"
    }
  },
  side_panel: { default_path: "src/sidepanel/index.html" },
  background: { service_worker: "src/background/index.ts", type: "module" },
  optional_permissions: ["debugger", "bookmarks", "history", "downloads", "notifications"],
  permissions: ["sidePanel", "storage", "scripting", "activeTab", "tabs", "tabGroups", "webNavigation", "contextMenus", "alarms"],
  host_permissions: [
    "<all_urls>",
    "ws://127.0.0.1/*",
    "ws://localhost/*"
  ],
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/bootstrap.ts"],
      run_at: "document_idle"
    },
    {
      // Keeps the recorder as a CRX/Vite build entry without loading it on
      // ordinary pages. Diagnostic policy injects this generated file via BG.
      matches: ["http://127.0.0.1/__aipagego_recorder__/*"],
      js: ["src/content/recorder/main-world.ts"],
      world: "MAIN",
      run_at: "document_start"
    }
  ],
  web_accessible_resources: [
    {
      // The MAIN-world loader dynamically imports this built chunk. Making it
      // readable does not execute it; policy-gated scripting injection does.
      resources: ["src/sidepanel/index.html", "assets/main-world.ts-*.js"],
      matches: ["<all_urls>"]
    }
  ]
});
