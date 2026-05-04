/**
 * Attach to Chrome remote-debugging via puppeteer-core.
 *
 * Flow (best-effort):
 *   1) Open https://lu.ma (fallback www.luma.com / luma.com).
 *   2) Repeatedly clicks through modals — especially OAuth / Google prompts:
 *      Allow, Authorize, Confirm, Continue, OK (scoped to [role=dialog],
 *      [aria-modal=true] first, then full page).
 *   3) Open Sign in + “Continue with Google” across tabs/frames (new OAuth window is detected via polling browser.pages()).
 *   4) Optional env: GOOGLE_EMAIL + GOOGLE_PASSWORD (or LUMA_GOOGLE_EMAIL / LUMA_GOOGLE_PASSWORD) on accounts.google.com
 *      — automated logins often hit Google bot checks; completing in the visible window still works.
 *   5) Poll merged cookies until luma.auth-session-key appears or timeout.
 *
 * Legacy: LUMA_LOGIN_EMAIL / LUMA_LOGIN_PASSWORD when Luma shows its own email form.
 */

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Puppeteer frames go "detached" after navigation/popup swaps; never reuse stale Frame refs.
 *
 * @param {import('puppeteer').Frame|null|undefined} frame
 * @param {() => any} evaluator
 */
async function safeFrameEvaluate(frame, evaluator) {
  try {
    if (!frame || typeof frame.evaluate !== "function") return undefined;
    if (typeof frame.isDetached === "function" && frame.isDetached()) return undefined;
    return await /** @type {import('puppeteer').Frame} */ (frame).evaluate(
      evaluator
    );
  } catch (e) {
    const msg = String(/** @type {Error & { cause?: unknown }} */ (e)?.message ?? e ?? "");
    if (
      /detached|Execution context was destroyed|Target closed|Cannot find context/i.test(
        msg
      )
    )
      return undefined;
    /** Swallow intermittent CDP churn */
    return undefined;
  }
}

/** @returns {boolean} true if evaluator returned truthy */
async function safeFrameEvaluateBool(frame, evaluator) {
  const r = await safeFrameEvaluate(frame, evaluator);
  return !!r;
}

/** Prefer main frame + Google host for account/Continue steps (iframes churn during OAuth). */
function isGoogleAuthUrl(u) {
  return /accounts\.google\.|google\.com\/(signin|oauth|o\/oauth2)|googleusercontent\.com|\/signinurls\//i.test(
    u || ""
  );
}

/**
 * Pick account row on Google's chooser ("Use another account", session list).
 * Pass full or partial email hint from GOOGLE_EMAIL / LUMA_GOOGLE_EMAIL (local part used).
 *
 * @param {string} emailHintRaw
 */
function buildAccountPickEvaluator(emailHintRaw) {
  const hintRaw = emailHintRaw || "";
  const localPart = hintRaw.includes("@") ? hintRaw.split("@")[0]?.toLowerCase() : hintRaw.toLowerCase();
  return () => {
    const hint = /** @type {string} */ (localPart || "");

    /** @param {Element} el */
    function candClick(el) {
      if (!(el instanceof HTMLElement)) return false;
      if (el.closest("[aria-disabled='true'],[disabled],.disabled")) return false;

      /** Prefer visible-ish */
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;

      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      /** @type {HTMLElement} */ (el).click();
      return true;
    }

    /** 1: row that looks like an email matching hint */
    const wide = Array.from(
      document.querySelectorAll(
        '[role="link"],[role="button"],li,div[data-email],div[data-identifier],tr'
      )
    );

    const emailRow = wide.find((n) => {
      const t =
        `${(n.innerText || n.textContent || "").slice(0, 220)} ${
          n.getAttribute("data-email") || ""
        } ${n.getAttribute("data-identifier") || ""}`
          .toLowerCase()
          .trim();

      const hasAddr = /@/.test(t) || /\.(com|io|co\.uk)/.test(t);
      if (!hasAddr || t.length > 340) return false;
      if (hint.length >= 1 && hint.length <= 64) return t.includes(hint);

      /** No hint → first clickable email-like row outside “Add account” **/
      const low = (n.innerText || "").toLowerCase();
      if (/add account|use another/i.test(low) && /@/.test(low) === false) return false;
      return /^[^\n@]+@[^\n]+\.[^\s]+$/m.test(low.slice(0, 240));
    });
    if (emailRow && candClick(emailRow)) return true;

    /** 2: “Use another account” when no remembered session */
    const other = [...document.querySelectorAll("[role=link],button,a")].find(
      (el) => {
        const t = (
          ((el.innerText || el.textContent || "") +
            (el.getAttribute("aria-label") || "")).trim()
          ).toLowerCase();
        return /\b(use another account|different account)\b/i.test(t);
      }
    );
    if (other instanceof HTMLElement) {
      other.click();
      return true;
    }

    return false;
  };
}

/** Google “Continue” / “Allow” — read label from enclosing button (handles nested spans). */
function buildContinueFlowEvaluator() {
  return () => {
    const nodes = Array.from(
      document.querySelectorAll(
        'button:not([disabled]),[role="button"]:not([aria-disabled="true"]),input[type="button"],input[type="submit"],div[role="button"]'
      )
    );

    const labelPrimary =
      /^(Continue|Continue to .*|Continue to app|Continue to Luma|Next|Verify|Done|Try again|Allow)$/i;

    for (const n of nodes) {
      if (!(n instanceof HTMLElement)) continue;

      const enclosing = n.closest?.("button,[role=\"button\"]");
      /** @type {HTMLElement} */
      const surface =
        enclosing instanceof HTMLElement
          ? enclosing
          : /** @type {HTMLElement} */ (n);

      const txt = (surface.innerText || surface.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 150);

      if (!txt) continue;
      if (/^cancel$|^back$|^no thanks$/i.test(txt)) continue;
      if (
        labelPrimary.test(txt) ||
        (txt.length <= 52 && /\bContinue\b/i.test(txt))
      ) {
        surface.click();
        return true;
      }
    }
    return false;
  };
}

/** @param {unknown[]} cookies */
function hasAuthSessionKey(cookies) {
  const list = Array.isArray(cookies) ? cookies : [];
  return list.some((c) => {
    if (!c || typeof c !== "object") return false;
    const o = /** @type {{ name?: string; value?: string }} */ (/** @type {unknown} */ (c));
    return (
      o.name === "luma.auth-session-key" &&
      String(o.value || "").trim().length > 0
    );
  });
}

/** @param {import('puppeteer').Page} page */
async function collectCookies(page) {
  const a = await page.cookies("https://lu.ma").catch(() => []);
  const b = await page.cookies("https://api2.luma.com").catch(() => []);
  const m = new Map();
  for (const c of [...a, ...b]) {
    m.set(`${c.domain}|${c.name}`, c);
  }
  return [...m.values()];
}

/** @param {import('puppeteer').Browser} browser */
async function collectCookiesMerged(browser) {
  const pages = await browser.pages().catch(() => []);
  const m = new Map();
  for (const p of pages) {
    const a = await p.cookies("https://lu.ma").catch(() => []);
    const b = await p.cookies("https://api2.luma.com").catch(() => []);
    for (const c of [...a, ...b])
      if (c?.name) m.set(`${c.domain}|${c.name}|${c.value}`, c);
  }
  return [...m.values()];
}

/**
 * @param {import('puppeteer').Page} page
 */
async function openLumaLanding(page) {
  const urls = [
    "https://lu.ma/",
    "https://www.luma.com/",
    "https://luma.com/",
  ];
  /** @type {Error|null} */
  let lastErr = null;
  for (const href of urls) {
    try {
      await page.bringToFront().catch(() => {});
      await page.goto(href, {
        waitUntil: "domcontentloaded",
        timeout: 52000,
      });
      console.log(`[luma-auto-login] Loaded ${href}\n`);
      return;
    } catch (e) {
      lastErr = /** @type {Error} */ (e);
    }
  }
  throw lastErr || new Error("Could not navigate to lu.ma / luma.com");
}

/** Inline evaluators must be standalone `function`s (no closure) for Puppeteer. */
function oauthModalDomEvaluate() {
  /** @param {string} t */
  function norm(t) {
    return (t || "").replace(/\s+/g, " ").trim();
  }

  const exact =
    /^(allow|authorize|authorise|confirm|continue|yes|ok|okay|next|proceed|accept|got it|choose an account)$/i;
  const fuzzy =
    /\b(allow|authorize|authorise|confirm|continue|sign in to|use another account|proceed)\b/i;

  const roots = /** @type {HTMLElement[]} */ ([]);
  document
    .querySelectorAll(
      '[role="dialog"],[role="alertdialog"],[aria-modal="true"],[data-state="open"],[data-slot="sheet-content"],[data-radix-collection-item],' +
        '[class*="sheet" i],[class*="Sheet" i],[class*="Drawer" i],[class*="DrawerContent" i],[class*="dialog" i],[class*="Modal" i],[class*="modal" i],[class*="popover" i],[class*="overlay" i],[id*="modal" i]'
    )
    .forEach((el) => {
      if (el instanceof HTMLElement) roots.push(el);
    });
  if (roots.length === 0 && document.body)
    roots.push(/** @type {HTMLElement} */ (document.body));

  const selectors = [
    "button",
    '[role="button"]',
    '[type="submit"]',
    "input[type=button]",
    "input[type=submit]",
    "a",
  ];

  for (const root of roots) {
    for (const sel of selectors) {
      const nodes = Array.from(root.querySelectorAll(sel));
      for (const n of nodes) {
        if (!(n instanceof HTMLElement)) continue;
        const visible =
          n.offsetParent !== null ||
          n.getClientRects().length > 0 ||
          window.getComputedStyle(n).visibility !== "hidden";
        if (!visible) continue;

        const text = norm((n.innerText || n.textContent || "").slice(0, 160));
        const aria = norm(n.getAttribute("aria-label") || "");
        const title = norm(n.getAttribute("title") || "");
        const combined = `${text} ${aria} ${title}`;

        if (text.length > 160) continue;
        if (/^cancel$|^back$|^no thanks$|^dismiss$/i.test(text)) continue;

        if (
          exact.test(text) ||
          exact.test(aria) ||
          (text.length < 90 && fuzzy.test(combined))
        ) {
          n.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
          n.click();
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Click one high-priority action inside OAuth / consent / “modal” UI.
 *
 * @param {import('puppeteer').Frame} frame
 */
async function clickOAuthOrAuthModalOnceInFrame(frame) {
  return await safeFrameEvaluateBool(frame, oauthModalDomEvaluate);
}

/**
 * Google account chooser + Continue chain (main frame first — child frames churn).
 *
 * @param {import('puppeteer').Browser} browser
 */
async function googleOAuthAssistEverywhere(browser) {
  const emailHint =
    process.env.GOOGLE_EMAIL?.trim?.() ||
    process.env.LUMA_GOOGLE_EMAIL?.trim?.() ||
    "";

  const pickEval = buildAccountPickEvaluator(emailHint);
  const flowEval = buildContinueFlowEvaluator();

  const pages = await browser.pages().catch(() => []);
  for (const pg of pages) {
    /** @type {string} */
    let url = "";
    try {
      url = pg.url() || "";
    } catch {
      continue;
    }
    if (!isGoogleAuthUrl(url)) continue;

    await pg.bringToFront().catch(() => {});
    /** @type {import('puppeteer').Frame | null} */
    let mf = null;
    try {
      mf = pg.mainFrame();
    } catch {
      continue;
    }

    await safeFrameEvaluateBool(mf, pickEval);
    await delay(120);
    await safeFrameEvaluateBool(mf, flowEval);

    let frames = [];
    try {
      frames = pg.frames();
    } catch {
      continue;
    }
    for (const fr of frames) {
      try {
        if (mf === fr) continue;
        if (typeof fr.isDetached === "function" && fr.isDetached()) continue;

        /** @type {string} */
        let fu = "";
        try {
          fu = fr.url() || "";
        } catch {
          continue;
        }
        if (/^chrome|^devtools|^about:|blob:/i.test(fu)) continue;

        await safeFrameEvaluateBool(fr, flowEval);
        /** Second pick pass on iframe only if iframe host looks like Google UX */
        if (/google|youtube|gsi|sandbox/i.test(fu))
          await safeFrameEvaluateBool(fr, pickEval);
      } catch {
        //
      }
    }
  }
}

/**
 * One pass: every page, every frame — modal/auth clicks first, then generic OK.
 *
 * @param {import('puppeteer').Browser} browser
 */
async function clickThroughAuthModalsEverywhere(browser) {
  const pages = await browser.pages().catch(() => []);
  let any = false;
  for (const pg of pages) {
    /** @type {string} */
    let pu = "";
    try {
      pu = pg.url() || "";
    } catch {
      continue;
    }
    if (/^(devtools:|chrome-extension:)/i.test(pu)) continue;

    let frames = [];
    try {
      frames = pg.frames();
    } catch {
      continue;
    }
    for (const fr of frames) {
      /** @type {string} */
      let fu = "";
      try {
        fu = fr.url() || "";
      } catch {
        continue;
      }
      if (/^chrome|^devtools|^about:|blob:/i.test(fu)) continue;

      if (await clickOAuthOrAuthModalOnceInFrame(fr)) any = true;
    }

    /** Main page fallback */
    let mainExtra = false;
    try {
      mainExtra = !!(await pg.evaluate(() => {
        const rx =
          /^(OK|Okay|Got it|Allow|Accept|Continue|Next|Skip|Sure|Authorize|Maybe later)$/i;
        const nodes = Array.from(
          document.querySelectorAll(
            'button, [role="button"], input[type="button"], input[type="submit"]'
          )
        );
        for (const n of nodes) {
          const t = ((n.innerText || n.textContent || "").trim()).slice(0, 90);
          if (!t || t.length > 90) continue;
          if (/^cancel$/i.test(t)) continue;
          if (rx.test(t)) {
            /** @type {HTMLElement} */ (n).click();
            return true;
          }
        }
        return false;
      }));
    } catch {
      mainExtra = false;
    }
    if (mainExtra) any = true;
  }
  return any;
}

async function clickLumaPrimarySignIn(page) {
  return /** @type {boolean} */ (
    await page
      .evaluate(() => {
        const nodes = [
          ...document.querySelectorAll(
            'a[href*="login"], a[href*="sign"], button, a, [role="button"]'
          ),
        ];
        const el = nodes.find((n) => {
          const raw = (
            (n.innerText || n.textContent || "") +
            " " +
            (n.getAttribute("aria-label") || "")
          ).trim();
          const t = raw.toLowerCase();
          if (!t || t.length > 96) return false;
          return (
            t === "log in" ||
            t === "sign in" ||
            t.includes("sign in") ||
            t.includes(" log in") ||
            t.endsWith(" login")
          );
        });
        if (el) {
          el.click();
          return true;
        }
        return false;
      })
      .catch(() => false)
  );
}

/**
 * Luma sign-in sheet: OAuth row is often a div with Google branding, not explicit "Continue with …"
 * Threshold was 5 but plain "Google" alone scored 4 → never clicked. Prefer href/class/data attrs.
 *
 * Returned shape: `{ ok: boolean, strength: 'oauth'|'strong'|'weak' }`
 */
function lumaContinueWithGoogleDomEvaluateRich() {
  /** @typedef {{ el: HTMLElement, score: number, strength: 'oauth'|'strong'|'weak' }} Cand */
  /** @type {Cand[]} */
  const cands = [];

  /** @param {HTMLElement} el */
  function visibleEnough(el) {
    const cs = window.getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") return false;
    const r = el.getBoundingClientRect();
    return r.width > 8 && r.height > 8;
  }

  /** Only Luma origin — avoid accidental clicks on other tabs while debugging CDP */
  try {
    const loc = String(
      typeof document !== "undefined" && document.location?.href
        ? document.location.href
        : ""
    );
    if (loc && !/\b(lu\.ma|luma\.com)\b/i.test(loc)) {
      return { ok: false, strength: /** @type {const} */ ("weak") };
    }
  } catch {
    //
  }

  const nodes = Array.from(
    document.querySelectorAll(
      'button,[role="button"],a,input[type="button"],div[role="button"],span[role="button"]'
    )
  );

  for (const n of nodes) {
    if (!(n instanceof HTMLElement)) continue;
    if (!visibleEnough(n)) continue;

    const href = (
      (n instanceof HTMLAnchorElement ? n.href : "") ||
      n.getAttribute("href") ||
      ""
    ).slice(0, 500);
    const cls = ((n.className && String(n.className)) || "").toLowerCase();
    const dataProv = (n.getAttribute("data-provider") || "").toLowerCase();
    const dataTest = (n.getAttribute("data-testid") || "").toLowerCase();

    const txt = (
      (n.innerText || n.textContent || "") +
      " " +
      (n.getAttribute("aria-label") || "") +
      " " +
      (n.getAttribute("title") || "")
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 220);
    const lo = txt.toLowerCase();

    let score = 0;
    /** @type {'oauth'|'strong'|'weak'} */
    let strength = "weak";

    if (/accounts\.google\.com|google\.com\/o\/oauth|\/oauth2|gsi|googleusercontent/i.test(href)) {
      score += 100;
      strength = "oauth";
    }
    if (dataProv === "google" || /google|oauth|gsi/.test(dataTest)) {
      score += 40;
      strength = "strong";
    }
    if (
      /^continue(\s+with)?\s+google$|^sign\s+in\s+with\s+google$|^log\s+in\s+with\s+google$/i.test(
        lo
      ) ||
      /\bcontinue\s+with\s+google\b|\bsign\s+in\s+with\s+google\b|\blog\s+in\s+with\s+google\b/i.test(
        lo
      )
    ) {
      score += 70;
      strength = "strong";
    }
    if (/^google$/i.test(lo) && lo.length <= 32) {
      score += 28;
      strength = "strong";
    }
    if (/\bgoogle\b/.test(lo) && lo.length <= 120) score += 12;
    if (/<svg/i.test(n.innerHTML || "") && /\bgoogle\b/i.test(lo)) score += 8;
    if (/google|oauth|gsi|auth/i.test(cls)) score += 10;

    /** Penalize footer / unrelated */
    if (lo.length > 140) score -= 15;
    if (/newsletter|subscribe|download the app|app store|play store/i.test(lo)) score -= 40;

    if (score >= 18) cands.push({ el: n, score, strength });
  }

  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];
  if (!best) return { ok: false, strength: "weak" };

  try {
    best.el.scrollIntoView({ block: "center", inline: "nearest" });
  } catch {
    //
  }
  best.el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  best.el.click();
  return { ok: true, strength: best.strength };
}

function lumaContinueWithGoogleDomEvaluate() {
  const r = lumaContinueWithGoogleDomEvaluateRich();
  return !!r && r.ok;
}

/** @param {{ quiet?: boolean }} [opts] */
async function clickContinueWithGoogleEverywhere(browser, opts) {
  const quiet = !!(opts && opts.quiet);

  /** @type {"oauth"|"strong"|"weak"|null} */
  let bestStrength = null;
  let ok = false;
  const pages = await browser.pages();
  for (const pg of pages) {
    let frames = [];
    try {
      frames = pg.frames();
    } catch {
      continue;
    }
    for (const frame of frames) {
      const r = await safeFrameEvaluate(frame, lumaContinueWithGoogleDomEvaluateRich);
      if (!r || !r.ok) continue;
      ok = true;
      if (r.strength === "oauth") bestStrength = "oauth";
      else if (r.strength === "strong" && bestStrength !== "oauth")
        bestStrength = "strong";
      else if (r.strength === "weak" && !bestStrength) bestStrength = "weak";
    }
  }

  if (quiet) return;

  if (ok && (bestStrength === "oauth" || bestStrength === "strong")) {
    console.log(
      `[luma-auto-login] Clicked Luma “Google” OAuth control (${bestStrength} match).\n`
    );
  } else if (ok && bestStrength === "weak") {
    console.warn(
      "[luma-auto-login] Clicked a low-confidence “Google” control — if OAuth did not open, use the visible Chrome window.\n"
    );
  } else {
    console.warn(
      "[luma-auto-login] No Google OAuth row found on lu.ma yet (sheet may still be animating; polling retries).\n"
    );
  }
}

/**
 * @param {import('puppeteer').Page} gPage
 */
async function tryAutomatedGoogleForms(gPage) {
  const email =
    process.env.GOOGLE_EMAIL?.trim?.() ||
    process.env.LUMA_GOOGLE_EMAIL?.trim?.() ||
    "";
  const password =
    process.env.GOOGLE_PASSWORD?.trim?.() ||
    process.env.LUMA_GOOGLE_PASSWORD?.trim?.() ||
    "";
  if (!email || !password) return false;

  await gPage.bringToFront().catch(() => {});
  await delay(400);

  try {
    await safeFrameEvaluateBool(
      gPage.mainFrame(),
      buildAccountPickEvaluator(email)
    );
    await delay(350);
    await safeFrameEvaluateBool(
      gPage.mainFrame(),
      buildContinueFlowEvaluator()
    );
    await delay(280);

    const emailInput = await gPage
      .$(
        'input[type="email"], input[name="identifier"], #identifierId, input[type="text"]'
      )
      .catch(() => null);

    if (emailInput) {
      await emailInput.click({ clickCount: 3 });
      await gPage.keyboard.type(email, { delay: 12 });
      await delay(100);
      await gPage.keyboard.press("Enter").catch(() => {});
      console.log(
        "[luma-auto-login] Typed Google email (best-effort; may need manual 2FA).\n"
      );
      await delay(2200);
    }

    const pw = await gPage
      .waitForSelector('input[type="password"]', { timeout: 12000 })
      .catch(() => null);
    if (pw && password) {
      await pw.type(password, { delay: 12 });
      await delay(100);
      await gPage.keyboard.press("Enter").catch(() => {});
      console.log(
        "[luma-auto-login] Submitted Google password step (best-effort).\n"
      );
      await delay(2800);
      return true;
    }
  } catch {
    //
  }
  return false;
}

/**
 * @param {import('puppeteer').Browser} browser
 */
async function findGoogleAuthPage(browser) {
  const pages = await browser.pages().catch(() => []);
  for (const p of pages) {
    let url = "";
    try {
      url = p.url() || "";
    } catch {
      continue;
    }
    if (
      /accounts\.google\.com|google\.com\/signin|oauth2|googleusercontent\.com/i.test(
        url
      )
    )
      return p;
  }
  return null;
}

/**
 * @param {import('puppeteer').Page} page
 * @param {string} email
 * @param {string} password
 */
async function tryLumaEmailPasswordOnPage(page, email, password) {
  if (!email || !password) return false;

  await clickLumaPrimarySignIn(page).catch(() => {});
  await delay(1200);

  const emailSel = [
    'input[type="email"]',
    'input[name="email"]',
    'input[autocomplete="email"]',
  ];
  /** @type {import('puppeteer').ElementHandle<Element>|null} */
  let hit = null;
  for (const sel of emailSel) {
    hit = await page.$(sel).catch(() => null);
    if (hit) break;
  }
  if (!hit) return false;

  await hit.click({ clickCount: 3 });
  await page.keyboard.type(email, { delay: 10 });
  await page.keyboard.press("Enter");
  await delay(1800);

  const pw = await page
    .waitForSelector('input[type="password"]', { timeout: 12000 })
    .catch(() => null);
  if (!pw) return false;
  await pw.type(password, { delay: 10 });
  await page.keyboard.press("Enter");
  await delay(3500);
  console.log("[luma-auto-login] Submitted Luma email/password (best-effort).\n");
  return true;
}

/**
 * @param {import('puppeteer').Browser} browser
 * @param {import('puppeteer').Page} anchorPage
 * @param {number} timeoutMs
 */
async function waitForSessionWithModalSpam(browser, anchorPage, timeoutMs) {
  const started = Date.now();
  console.warn(
    "[luma-auto-login] Polling for luma.auth-session-key; OAuth account row + Continue, then modal Allow/Authorize.\n"
  );

  const hasGoogleCredentials = !!(
    (process.env.GOOGLE_EMAIL || process.env.LUMA_GOOGLE_EMAIL || "").trim() &&
      (process.env.GOOGLE_PASSWORD || process.env.LUMA_GOOGLE_PASSWORD || "").trim()
  );

  while (Date.now() - started < timeoutMs) {
    /** Works without stored password (picker + Continue across accounts.google tabs). */
    await googleOAuthAssistEverywhere(browser);

    await clickThroughAuthModalsEverywhere(browser);

    const g = await findGoogleAuthPage(browser);
    if (g && hasGoogleCredentials) {
      await g.bringToFront().catch(() => {});
      await tryAutomatedGoogleForms(g).catch(() => {});
    }

    const merged = await collectCookiesMerged(browser);
    if (hasAuthSessionKey(merged)) return;

    await delay(650);
  }

  throw new Error(
    `Timed out (${timeoutMs}ms) waiting for luma.auth-session-key`
  );
}

/**
 * @param {{
 *   port: number;
 *   waitMs: number;
 *   email?: string;
 *   password?: string;
 * }} opts
 */
async function runLumaPuppetLoginAssist(opts) {
  /** @type {typeof import('puppeteer')} */
  let puppeteer;
  try {
    puppeteer = require("puppeteer-core");
  } catch {
    throw new Error(
      "Missing puppeteer-core. From credits-portal:\n  npm install puppeteer-core --save-dev"
    );
  }

  const connectUrl = `http://127.0.0.1:${opts.port}`;
  console.log(`[luma-auto-login] Connecting to ${connectUrl} …\n`);

  const browser = await puppeteer.connect({
    browserURL: connectUrl,
    defaultViewport: null,
  });

  try {
    const pagesList = await browser.pages();
    let page =
      pagesList.find((p) => {
        const u = (p.url && p.url()) || "";
        return u && !u.startsWith("devtools:") && !u.startsWith("chrome://");
      }) ||
      pagesList[0] ||
      (await browser.newPage());

    if (!page) page = await browser.newPage();

    const lumaEmail =
      opts.email ||
      process.env.LUMA_LOGIN_EMAIL?.trim() ||
      process.env.LUMA_EMAIL?.trim() ||
      "";
    const lumaPassword =
      opts.password ||
      process.env.LUMA_LOGIN_PASSWORD?.trim() ||
      process.env.LUMA_PASSWORD?.trim() ||
      "";

    const hasGoogleCredentials = !!(
      (process.env.GOOGLE_EMAIL || process.env.LUMA_GOOGLE_EMAIL || "").trim() &&
      (process.env.GOOGLE_PASSWORD || process.env.LUMA_GOOGLE_PASSWORD || "").trim()
    );

    await openLumaLanding(page);

    /** Early consent / pre-auth junk */
    for (let i = 0; i < 4; i++) {
      await clickThroughAuthModalsEverywhere(browser);
      await delay(350);
    }

    await clickLumaPrimarySignIn(page).catch(() => {});

    /** Sign-in sheet / OAuth picker often mounts 300–2500ms after tap — retry quietly */
    await delay(500);
    for (let sweep = 0; sweep < 14; sweep++) {
      await clickThroughAuthModalsEverywhere(browser);
      await clickContinueWithGoogleEverywhere(browser, { quiet: true });
      await googleOAuthAssistEverywhere(browser).catch(() => {});
      const mergedSweep = await collectCookiesMerged(browser);
      if (hasAuthSessionKey(mergedSweep)) {
        console.log("[luma-auto-login] Session cookie present during Google-entry sweep.\n");
        return;
      }
      if (await findGoogleAuthPage(browser)) break;
      await delay(sweep < 5 ? 420 : 580);
    }
    await delay(400);

    if (await findGoogleAuthPage(browser)) {
      console.log(
        "[luma-auto-login] Google auth surface detected after sweep — assisting account/Continue.\n"
      );
    } else {
      await clickContinueWithGoogleEverywhere(browser);
    }

    /** Account-picker + Continue (no password OK — uses session or picks row matching GOOGLE_EMAIL). */
    await googleOAuthAssistEverywhere(browser).catch(() => {});
    await delay(500);

    /** Typed Google login only when env has both email + password. */
    const gAfter = await findGoogleAuthPage(browser);
    if (gAfter && hasGoogleCredentials) {
      await gAfter.bringToFront().catch(() => {});
      await tryAutomatedGoogleForms(gAfter).catch(() => {});
    }

    let merged = await collectCookiesMerged(browser);
    if (hasAuthSessionKey(merged)) {
      console.log("[luma-auto-login] Session cookie already present.\n");
      return;
    }

    /** Luma-native email path if still no session */
    if (lumaEmail && lumaPassword) {
      await page.bringToFront().catch(() => {});
      await tryLumaEmailPasswordOnPage(page, lumaEmail, lumaPassword).catch(
        () => {}
      );
      merged = await collectCookiesMerged(browser);
      if (hasAuthSessionKey(merged)) {
        console.log("[luma-auto-login] Session after Luma email flow.\n");
        return;
      }
    }

    await waitForSessionWithModalSpam(browser, page, opts.waitMs);
  } finally {
    try {
      await browser.disconnect();
    } catch {
      //
    }
  }
}

module.exports = {
  runLumaPuppetLoginAssist,
  hasAuthSessionKey,
  collectCookies,
  collectCookiesMerged,
};
