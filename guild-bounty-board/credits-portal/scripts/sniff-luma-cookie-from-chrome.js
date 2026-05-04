/**
 * Read Luma session cookies from Chrome's remote-debugging port (CDP).
 *
 * Hand launch:
 *   npm run ops:luma:cookie-from-chrome
 *
 * One-shot: spawn Chrome + wait for CDP + sniff (minimal manual steps):
 *   npm run ops:luma:cookie-from-chrome:auto
 *
 * Flags:
 *   --launch-chrome          Start Chrome with --remote-debugging-port + --user-data-dir if nothing listens
 *   --fresh-chrome           (with --launch-chrome) killall Google Chrome first — saves work docs first!
 *   --wait-for-login         (with --launch-chrome) pause until Enter — use first time / empty jar
 *   --kill-chrome-after      Terminate Chromium we spawned (by PID); default leaves browser open
 *   --print-shell-export       export LUMA_COOKIE=...
 *
 * Env: CHROME_BIN, CHROME_CDP_USER_DATA_DIR, CHROME_DEBUG_PORT
 *
 * Optional auto-login via puppeteer-core (attached to existing CDP):
 *   npm run ops:luma:cookie-from-chrome:auto-login
 *   --auto-login              Use puppeteer-core to drive lu.ma; poll until session cookie
 *   --auto-login-timeout=MS Override wait (default 180000 ; env LUMA_AUTO_LOGIN_TIMEOUT_MS)
 * Put LUMA_LOGIN_EMAIL + LUMA_LOGIN_PASSWORD (or LUMA_EMAIL / LUMA_PASSWORD) in .env.local
 * for best-effort Luma email/password when shown.
 * Google: optional GOOGLE_EMAIL in .env.local to match the account row; GOOGLE_PASSWORD optional
 * (typed only if both are set). Automated Google logins are often blocked — you can still complete
 * OAuth in the Chrome window while the script clicks Continue / Allow on modals without touching
 * detached frames.
 */

try {
  require("dotenv").config({
    path: require("path").join(__dirname, "..", ".env.local"),
  });
} catch {
  //
}

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");
const readline = require("readline");

async function fetchJson(hostname, port, path_) {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname, port, path: path_, timeout: 8000 }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`${path_}: HTTP ${res.statusCode}: ${b.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(b || "{}"));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

function createCdpClient(wsCtor, wsUrl) {
  /** @type {import('ws')} */
  const ws = new wsCtor(wsUrl);
  /** @type {Map<number,{resolve,reject}>} */
  const pending = new Map();
  let seq = 0;

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error)
        reject(
          new Error(
            `${msg.error.message || JSON.stringify(msg.error)} (${msg.method || "CDP"})`
          )
        );
      else resolve(msg.result);
    }
  });

  function send(method, params = {}) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  function close() {
    try {
      ws.close();
    } catch {
      //
    }
  }

  const ready = new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    ws.once("close", () => {
      pending.forEach(({ reject }) => reject(new Error("CDP WebSocket closed")));
      pending.clear();
    });
  });

  return { ready, send, close, ws };
}

/** Same cookie name may appear for multiple domains; last entry wins (CDP order). */
function dedupeCookiesLastWins(cookies) {
  if (!Array.isArray(cookies)) return [];
  const byName = new Map();
  for (const c of cookies) {
    const name = String(c?.name || "");
    if (!name) continue;
    byName.set(name, c);
  }
  return Array.from(byName.values());
}

function buildCookieHeader(cookies) {
  if (!Array.isArray(cookies)) return "";
  const list = dedupeCookiesLastWins(cookies);
  return list.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** @returns {readonly string[]} */
function defaultDevToolsHosts() {
  const csv = process.env.CHROME_DEBUG_HOSTS?.trim();
  if (csv) return csv.split(/[\s,]+/).filter(Boolean);
  return ["127.0.0.1", "::1", "localhost"];
}

async function fetchJsonAnyHost(hosts, port, path_) {
  let last;
  /** @type {string|undefined} */
  let usedHost;
  for (const hostname of hosts) {
    try {
      const json = await fetchJson(hostname, port, path_);
      usedHost = hostname;
      return { json, usedHost };
    } catch (e) {
      last = e;
    }
  }
  throw /** @type {Error} */ (last);
}

function resolveChromeExecutable() {
  const env = process.env.CHROME_BIN?.trim();
  if (env && fs.existsSync(env)) return env;

  if (process.platform === "darwin") {
    const p =
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (fs.existsSync(p)) return p;
  }
  if (process.platform === "win32") {
    const p = path.join(
      process.env["ProgramFiles"] || "C:\\Program Files",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe"
    );
    if (fs.existsSync(p)) return p;
  }
  for (const n of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    try {
      const out = execSync(`command -v ${n}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (out) return out;
    } catch {
      //
    }
  }
  throw new Error(
    "Chrome not found. Install Google Chrome or set CHROME_BIN to the chromium binary."
  );
}

function defaultUserDataDir() {
  const e = process.env.CHROME_CDP_USER_DATA_DIR?.trim();
  if (e) return path.isAbsolute(e) ? e : path.join(os.homedir(), e);
  return path.join(os.homedir(), ".chrome-cdp-debug");
}

function killDarwinChromeIfDesired() {
  if (process.platform !== "darwin") return;
  try {
    execSync(`killall 'Google Chrome' 2>/dev/null || true`, { stdio: "ignore", shell: "/bin/bash" });
    /** ~2s for launchd and locks to drop */
    execSync("sleep 2", { stdio: "ignore" });
    console.warn(
      "(--fresh-chrome: closed Google Chrome. Unsaved tabs in Chrome were lost unless restored later.)\n"
    );
  } catch {
    //
  }
}

async function waitForMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Probe /json/version (object) until CDP answers.
 */
async function waitUntilCdpListens(hosts, port, timeoutMs = 90000, intervalMs = 250) {
  const t0 = Date.now();
  for (;;) {
    try {
      const { json, usedHost } = await fetchJsonAnyHost(hosts, port, "/json/version");
      if (json && typeof json === "object" && json.webSocketDebuggerUrl)
        return { usedHost };
    } catch {
      //
    }
    if (Date.now() - t0 > timeoutMs)
      throw new Error(
        `CDP did not become ready within ${timeoutMs}ms (${port}).`
      );
    await waitForMs(intervalMs);
  }
}

/**
 * Spawn Chrome detached; caller must kill chromePid if teardown wanted.
 */
function spawnDebuggingChrome(binary, port, userDataDir) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const chrome = spawn(
    binary,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, "--disable-first-run-ui"],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    }
  );
  chrome.unref();
  const pid = chrome.pid ?? null;
  if (!pid)
    console.warn("(Chrome spawned but PID unavailable — SIGTERM after sniff may skip.)");
  return pid;
}

async function launchChromeMaybe(opts, hosts, port) {
  try {
    await fetchJsonAnyHost(hosts, port, "/json/version");
    console.log("(CDP already listening — did not spawn Chrome.)\n");
    return /** @type {const} */ ({
      spawned: false,
      /** @type {number|null} */
      chromePid: null,
    });
  } catch {
    //
  }

  /** CDP unreachable; --launch-chrome triggers spawn (caller guarantees flag). */

  if (opts.freshChrome && process.platform === "darwin")
    killDarwinChromeIfDesired();
  else if (opts.freshChrome)
    console.warn(
      "(--fresh-chrome: automatic kill supported on macOS; on this OS close Chromium manually)\n"
    );

  const bin = resolveChromeExecutable();
  const userData = defaultUserDataDir();
  console.log(`Starting Chrome CDP (${bin})\n  --remote-debugging-port=${port}\n  --user-data-dir=${userData}\n`);
  const pid = spawnDebuggingChrome(bin, port, userData);
  console.log(`Chrome PID=${pid}; waiting for CDP on port ${port}…\n`);
  await waitUntilCdpListens(hosts, port);
  console.log(`CDP OK on :${port}.\n`);

  /** @returns {Promise<void>} */
  async function waitEnter() {
    if (!process.stdin.isTTY) return;
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    await new Promise((resolve) => {
      rl.question(
        `Sign in at https://lu.ma in the Chrome window, then press ENTER to sniff cookies `,
        () => {
          rl.close();
          resolve(null);
        }
      );
    });
  }

  if (opts.waitForLogin) await waitEnter();

  return /** @type {const} */ ({
    spawned: true,
    /** @type {number|null} */
    chromePid: pid ?? null,
  });
}

function killChromePid(pid, label = "SIGTERM") {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    //
  }
  console.log(`(${label}: sent SIGTERM to Chrome pid ${pid})`);
}

async function sniffFlow(printShellExport, hosts, port) {
  let WebSocket;
  try {
    WebSocket = require("ws");
  } catch {
    throw new Error(
      "Missing dependency `ws`. From credits-portal run:\n  npm install ws --save-dev"
    );
  }

  /** @type {{type?:string;webSocketDebuggerUrl?:string;url?:string}[]} */
  let list;
  /** @type {string|undefined} */
  let usedHost;
  try {
    ({ json: list, usedHost } = await fetchJsonAnyHost(hosts, port, "/json/list"));
    if (!Array.isArray(list)) list = [];
  } catch (e) {
    const err = /** @type {Error} */ (e);
    const refuse = /ECONNREFUSED/i.test(err.message || "");
    console.error(
      `Cannot reach Chrome debugger (tried: ${hosts.join(", ")}:${port})${
        refuse ? " — nothing listening" : ""
      }.\n`
    );
    console.error("Most common causes:\n");
    console.error(
      "  • Any normal Chrome window was still running — debug never bound to the port.\n" +
        "  • Or use: npm run ops:luma:cookie-from-chrome:auto\n"
    );
    printChromeLaunchHelp(port);
    throw new Error(String(err.message || err));
  }

  const pages = Array.isArray(list)
    ? list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl)
    : [];
  const preferred =
    pages.find((t) => /\.luma\b|\.lu\.ma|lu\.ma/i.test(t.url || "")) || pages[0];

  if (!preferred?.webSocketDebuggerUrl) {
    throw new Error("No inspectable Chrome page targets found.");
  }

  const client = createCdpClient(WebSocket, preferred.webSocketDebuggerUrl);
  try {
    await client.ready;
    await client.send("Network.enable", {});
    const result = await client.send("Network.getCookies", {
      urls: [
        "https://api2.luma.com/",
        "https://luma.com/",
        "https://www.luma.com/",
        "https://lu.ma/",
        "https://www.lu.ma/",
      ],
    });
    const cookies = dedupeCookiesLastWins(result?.cookies || []);

    const sessionCookie = cookies.find(
      (c) => String(c?.name || "") === "luma.auth-session-key"
    );
    const header = buildCookieHeader(cookies);

    if (!header.trim()) {
      console.warn(
        "Chrome returned zero cookies for Luma URLs. Open https://luma.com or https://lu.ma in a tab\n" +
          "while logged in (e.g. event manage → guests), then rerun (or --wait-for-login --launch-chrome)."
      );
    }

    console.log("");
    if (usedHost) console.log(`(CDP connected via ${usedHost}:${port})`);
    console.log("(tab used for CDP)");
    console.log(`  URL: ${preferred.url || "(unknown)"}`);
    console.log("");
    if (sessionCookie?.value != null && sessionCookie.value !== "") {
      console.log(`luma.auth-session-key (value only, ${sessionCookie.value.length} chars):\n`);
      console.log(`  ${sessionCookie.value}\n`);
    } else {
      console.log(
        "Cookie `luma.auth-session-key` was not returned — use full header below or sign in.\n"
      );
    }

    console.log(`LUMA_COOKIE= (paste into credits-portal/.env.local):\n`);

    const line = `LUMA_COOKIE='${header.replace(/'/g, "'\\''")}'`;
    if (printShellExport) {
      console.log(`export LUMA_COOKIE='${header.replace(/'/g, "'\\''")}'`);
    } else {
      console.log(line);
    }
    console.log("");
  } finally {
    client.close();
    await waitForMs(100);
  }
}

function printChromeLaunchHelp(port) {
  const profile = path.join(os.homedir(), ".chrome-cdp-debug");
  const bin = `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`;
  console.error(
    "CDP debug port still not reachable. Do this manually (quit Chrome first), or rerun with:\n" +
      `  node scripts/sniff-luma-cookie-from-chrome.js --launch-chrome\n`
  );
  console.error("");
  console.error(`  "${bin}" \\`);
  console.error(`    --remote-debugging-port=${port} \\`);
  console.error(`    --user-data-dir="${profile}"`);
  console.error("");
  console.error(`  curl -sS "http://127.0.0.1:${port}/json/version" | head`);
  console.error("");
}

function parseArgs(argv) {
  /** @type {{
   * printShellExport: boolean;
   * launchChrome: boolean;
   * freshChrome: boolean;
   * waitForLogin: boolean;
   * killChromeAfter: boolean;
   * autoLogin: boolean;
   * autoLoginMs?: number;
   * }} */
  const o = {
    printShellExport: false,
    launchChrome: false,
    freshChrome: false,
    waitForLogin: false,
    killChromeAfter: false,
    autoLogin: false,
    autoLoginMs: undefined,
  };
  const TO = "--auto-login-timeout=";
  for (const a of argv) {
    if (a === "--print-shell-export") o.printShellExport = true;
    if (a === "--launch-chrome") o.launchChrome = true;
    if (a === "--fresh-chrome") o.freshChrome = true;
    if (a === "--wait-for-login") o.waitForLogin = true;
    if (a === "--kill-chrome-after") o.killChromeAfter = true;
    if (a === "--auto-login") o.autoLogin = true;
    if (a.startsWith(TO)) {
      const n = Number(String(a.slice(TO.length)).trim());
      if (Number.isFinite(n) && n >= 3000) o.autoLoginMs = n;
    }
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const port = Number(process.env.CHROME_DEBUG_PORT?.trim() || "") || 9222;
  const hosts = process.env.CHROME_DEBUG_HOST?.trim()
    ? [process.env.CHROME_DEBUG_HOST.trim()]
    : defaultDevToolsHosts();

  /** @type {boolean} */
  let spawned = false;
  /** @type {number|null} */
  let chromePid = null;

  try {
    if (opts.launchChrome) {
      ({ spawned, chromePid } = await launchChromeMaybe(opts, hosts, port));
    }

    if (opts.autoLogin) {
      const loginWaitMs =
        opts.autoLoginMs ??
        (() => {
          const v = Number(process.env.LUMA_AUTO_LOGIN_TIMEOUT_MS?.trim() || "");
          return Number.isFinite(v) && v >= 3000 ? v : 180000;
        })();

      const {
        runLumaPuppetLoginAssist,
      } = require("./lib/luma-puppet-login.cjs");

      console.log(
        "(Running --auto-login: puppeteer attaches to Chrome CDP, then waits for session.)\n"
      );
      await runLumaPuppetLoginAssist({
        port,
        waitMs: loginWaitMs,
      });
    }

    await sniffFlow(opts.printShellExport, hosts, port);
  } finally {
    if (opts.killChromeAfter && spawned && chromePid) killChromePid(chromePid);
  }
}

main().catch((e) => {
  console.error(e.message || String(e));
  process.exit(1);
});
