export function serializeCookie(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    session: Boolean(cookie.session),
    hostOnly: Boolean(cookie.hostOnly),
    expirationDate: cookie.expirationDate,
    sameSite: cookie.sameSite || "unspecified",
  };
}

export function cookiesFingerprint(cookies) {
  const normalized = cookies
    .map(serializeCookie)
    .sort((left, right) => {
      const byName = left.name.localeCompare(right.name);
      if (byName !== 0) return byName;
      return left.domain.localeCompare(right.domain);
    });
  return JSON.stringify(normalized);
}

export function buildSessionFingerprint(token, cookies) {
  return `${token}\n${cookiesFingerprint(cookies)}`;
}

export function buildCookieUrl(cookie) {
  const host = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
  const path = cookie.path || "/";
  return `https://${host}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function gmCookie(action, details) {
  if (typeof GM !== "undefined" && GM.cookie) {
    return GM.cookie(action, details);
  }
  return new Promise((resolve, reject) => {
    GM_cookie(action, details, (...args) => {
      if (action === "list") {
        const [cookies, error] = args;
        if (error) {
          reject(error);
          return;
        }
        resolve(cookies || []);
        return;
      }
      const [first, second] = args;
      const error =
        second ||
        (first && typeof first === "object" && !Array.isArray(first) && "message" in first ? first : null);
      if (error) {
        reject(error);
        return;
      }
      resolve(first);
    });
  });
}

export function createSiteCookieClient(siteOrigin, logPrefix = "") {
  async function listCookies() {
    const cookies = await gmCookie("list", {
      url: `${siteOrigin}/`,
    });
    if (!Array.isArray(cookies)) {
      return [];
    }
    return cookies.map(serializeCookie);
  }

  async function applyCookies(cookies) {
    if (!Array.isArray(cookies) || cookies.length === 0) {
      return {
        applied: 0,
        failed: 0,
      };
    }
    let applied = 0;
    let failed = 0;
    for (const cookie of cookies) {
      try {
        const details = {
          url: buildCookieUrl(cookie),
          name: cookie.name,
          value: cookie.value,
          path: cookie.path || "/",
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
        };
        if (cookie.domain) {
          details.domain = cookie.domain;
        }
        if (!cookie.session && cookie.expirationDate) {
          details.expirationDate = cookie.expirationDate;
        }
        await gmCookie("set", details);
        applied += 1;
      } catch (error) {
        failed += 1;
        if (logPrefix) {
          console.warn(`${logPrefix} 写入 cookie 失败`, cookie.name, error);
        }
      }
    }
    return {
      applied,
      failed,
    };
  }

  return {
    listCookies,
    applyCookies,
  };
}
