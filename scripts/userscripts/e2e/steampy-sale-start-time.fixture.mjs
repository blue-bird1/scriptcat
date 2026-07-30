import { expect, test as base } from "@playwright/test";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, readFile, readlink, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const execFile = promisify(execFileCallback);

const EXTENSION_ID = "oepcbpjafionmhhelohlfhlmlaciclhc";
const SCRIPT_UUID = "c4329dda-3020-5519-a7b3-aad744abba03";
const SCRIPT_VERSION = "5.10.10";
const DEFAULT_PATHS = Object.freeze({
  chromium: join(homedir(), ".local/share/scriptcat-browser/current/chrome-linux/chrome"),
  extension: join(homedir(), ".codex/chrome-extensions/scriptcat/managed"),
  profile: join(homedir(), ".codex/chrome-devtools-scriptcat-chromium-profile"),
  proxy: "http://127.0.0.1:7891",
});
const PROFILE_EXCLUDES = Object.freeze([
  "--exclude=OptGuideOnDeviceModel",
  "--exclude=Cache/",
  "--exclude=Code Cache/",
  "--exclude=GPUCache/",
  "--exclude=DawnCache/",
  "--exclude=Extension Scripts/",
  "--exclude=Singleton*",
]);

function configuredPaths() {
  return {
    chromium: process.env.USERSCRIPTS_E2E_CHROMIUM ?? DEFAULT_PATHS.chromium,
    extension: process.env.USERSCRIPTS_E2E_EXTENSION ?? DEFAULT_PATHS.extension,
    profile: process.env.USERSCRIPTS_E2E_PROFILE ?? DEFAULT_PATHS.profile,
    proxy: process.env.USERSCRIPTS_E2E_PROXY ?? DEFAULT_PATHS.proxy,
  };
}

async function requirePath(path, description, mode = constants.R_OK) {
  try {
    await access(path, mode);
  } catch {
    throw new Error(
      `${description} is unavailable at ${path}. Set the corresponding USERSCRIPTS_E2E_* environment variable to override it.`,
    );
  }
}

async function sourceProfileIsInUse(profilePath) {
  const mcpLock = join(profilePath, ".scriptcat-mcp.lock");
  try {
    await access(mcpLock);
    await execFile("flock", ["-n", mcpLock, "-c", "true"]);
  } catch (error) {
    if (error?.code !== "ENOENT") return true;
  }

  const singletonLock = join(profilePath, "SingletonLock");
  try {
    const link = await readlink(singletonLock);
    const processId = Number(link.match(/-(\d+)$/)?.[1]);
    if (!Number.isSafeInteger(processId)) return true;
    try {
      process.kill(processId, 0);
      const commandLine = (await readFile(`/proc/${processId}/cmdline`, "utf8"))
        .split("\0")
        .filter(Boolean);
      return commandLine.some(
        (argument) => argument === `--user-data-dir=${profilePath}` || argument === profilePath,
      );
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      return true;
    }
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return false;
  }
}

async function copySourceProfile(sourceProfile) {
  if (await sourceProfileIsInUse(sourceProfile)) {
    throw new Error(
      `The source profile is in use at ${sourceProfile}. Close chrome-devtools-scriptcat Chromium before running this E2E; the suite never writes the source profile.`,
    );
  }
  const temporaryProfile = await mkdtemp(join(tmpdir(), "scriptcat-userscripts-e2e-"));
  try {
    await execFile("rsync", ["-a", ...PROFILE_EXCLUDES, `${sourceProfile}/`, `${temporaryProfile}/`]);
    return temporaryProfile;
  } catch (error) {
    await rm(temporaryProfile, { force: true, recursive: true });
    throw new Error(`Failed to copy source profile ${sourceProfile} with rsync: ${error.message}`);
  }
}

async function waitForServiceWorker(context) {
  const workerUrl = `chrome-extension://${EXTENSION_ID}/`;
  const existingWorker = context.serviceWorkers().find((worker) => worker.url().startsWith(workerUrl));
  if (existingWorker) return existingWorker;
  return context.waitForEvent("serviceworker", {
    predicate: (worker) => worker.url().startsWith(workerUrl),
    timeout: 15_000,
  });
}

async function sendExtensionMessage(page, action, data) {
  return page.evaluate(
    ({ action: messageAction, data: messageData }) =>
      new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: messageAction, data: messageData }, (response) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message));
            return;
          }
          if (!response || response.code !== 0) {
            reject(new Error(response?.message ?? `ScriptCat returned no response for ${messageAction}`));
            return;
          }
          resolve(response.data);
        });
      }),
    { action, data },
  );
}

async function installRepositoryScript(context, scriptCode) {
  const extensionPage = await context.newPage();
  try {
    await extensionPage.goto(`chrome-extension://${EXTENSION_ID}/src/options.html`);
    const installedScript = await sendExtensionMessage(extensionPage, "serviceWorker/script/installByCode", {
      code: scriptCode,
      upsertBy: "vscode",
      uuid: SCRIPT_UUID,
    });
    expect(installedScript.metadata.version[0]).toBe(SCRIPT_VERSION);
    await sendExtensionMessage(extensionPage, "serviceWorker/script/setCheckUpdateUrl", {
      checkUpdate: false,
      uuid: SCRIPT_UUID,
    });
  } finally {
    await extensionPage.close();
  }
}

function saleRow({ saleId, steamAva, keyPrice, stock }) {
  return {
    ccy: "CNY",
    discount: 0,
    handCost: keyPrice - 1,
    keyPrice,
    osFlag: "win",
    saleId,
    sold: 0,
    steamAva,
    steamName: "SteamPy E2E fixture",
    stock,
  };
}

const SALE_PAGES = Object.freeze([
  [
    saleRow({
      saleId: "K9001093910454993440768",
      steamAva: "https://avatars.steamstatic.com/scriptcat-e2e-k900.jpg",
      keyPrice: 39.9,
      stock: 3,
    }),
    saleRow({
      saleId: "9000985793395086954496",
      steamAva: "https://avatars.steamstatic.com/scriptcat-e2e-900.jpg",
      keyPrice: 40.9,
      stock: 2,
    }),
  ],
  [
    saleRow({
      saleId: "K900123456789012345678",
      steamAva: "https://avatars.steamstatic.com/scriptcat-e2e-legacy-k.jpg",
      keyPrice: 41.9,
      stock: 1,
    }),
    saleRow({
      saleId: "123456789012345678",
      steamAva: "https://avatars.steamstatic.com/scriptcat-e2e-legacy.jpg",
      keyPrice: 42.9,
      stock: 1,
    }),
  ],
]);

function listSaleFixture(pageNumber) {
  const pageIndex = Math.max(0, Math.min(SALE_PAGES.length - 1, pageNumber - 1));
  return {
    code: 200,
    message: "",
    result: {
      content: SALE_PAGES[pageIndex],
      number: pageIndex,
      numberOfElements: SALE_PAGES[pageIndex].length,
      size: SALE_PAGES[pageIndex].length,
      totalElements: SALE_PAGES.flat().length,
      totalPages: SALE_PAGES.length,
    },
    success: true,
  };
}

export const test = base.extend({
  userscriptSession: async ({ playwright }, use) => {
    const paths = configuredPaths();
    await requirePath(paths.chromium, "Provider Chromium", constants.X_OK);
    await requirePath(paths.extension, "Managed ScriptCat extension");
    await requirePath(paths.profile, "Source ScriptCat profile");
    const manifestPath = join(paths.extension, "manifest.json");
    await requirePath(manifestPath, "Managed ScriptCat extension manifest");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.manifest_version !== 3) {
      throw new Error(`Managed ScriptCat extension manifest is invalid at ${manifestPath}.`);
    }

    const temporaryProfile = await copySourceProfile(paths.profile);
    let context;
    const forbiddenXbootRequests = [];
    const listSaleResponseCount = { value: 0 };
    try {
      context = await playwright.chromium.launchPersistentContext(temporaryProfile, {
        executablePath: paths.chromium,
        headless: true,
        ignoreDefaultArgs: ["--disable-extensions"],
        proxy: { server: paths.proxy },
        args: [
          `--disable-extensions-except=${paths.extension}`,
          "--disable-gpu",
          `--load-extension=${paths.extension}`,
        ],
      });
      const serviceWorker = await waitForServiceWorker(context);
      expect(serviceWorker.url()).toContain(`chrome-extension://${EXTENSION_ID}/`);

      const repositoryScript = await readFile(join(process.cwd(), "steampy.user.js"), "utf8");
      await installRepositoryScript(context, repositoryScript);

      await context.route("https://steampy.com/xboot/**", async (route) => {
        const request = route.request();
        const method = request.method();
        const url = new URL(request.url());
        if (url.pathname === "/xboot/steamKeySale/listSale") {
          const pageNumber = Number(url.searchParams.get("pageNumber") ?? "1");
          listSaleResponseCount.value += 1;
          await route.fulfill({
            contentType: "application/json; charset=utf-8",
            status: 200,
            body: JSON.stringify(listSaleFixture(pageNumber)),
          });
          return;
        }
        if (["GET", "HEAD", "OPTIONS"].includes(method)) {
          await route.continue();
          return;
        }
        forbiddenXbootRequests.push({ method, url: request.url() });
        await route.abort("blockedbyclient");
      });

      await use({ context, forbiddenXbootRequests, listSaleResponseCount });
      expect(forbiddenXbootRequests).toEqual([]);
    } finally {
      await context?.close();
      await rm(temporaryProfile, { force: true, recursive: true });
    }
  },
  page: async ({ userscriptSession }, use) => {
    const page = await userscriptSession.context.newPage();
    await use(page);
  },
});

export { expect };
