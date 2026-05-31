/**
 * fetch()-compatible wrapper over GM_xmlhttpRequest (Page Agent customFetch).
 * Not interchangeable with gmXhr — different response shape and abort handling.
 */
export function gmFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    let aborted = false;
    const signal = init.signal;
    if (signal?.aborted) {
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
      return;
    }
    const onAbort = () => {
      aborted = true;
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
    };
    if (signal) signal.addEventListener("abort", onAbort);

    const headers = {};
    if (init.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => {
          headers[k] = v;
        });
      } else {
        Object.assign(headers, init.headers);
      }
    }

    GM_xmlhttpRequest({
      method: init.method || "GET",
      url,
      headers,
      data: init.body,
      responseType: "text",
      onload: (res) => {
        if (aborted) return;
        if (signal) signal.removeEventListener("abort", onAbort);
        const h = new Headers();
        (res.responseHeaders || "").split(/\r?\n/).forEach((line) => {
          const i = line.indexOf(":");
          if (i > 0) h.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
        });
        const body = res.responseText ?? "";
        resolve({
          ok: res.status >= 200 && res.status < 300,
          status: res.status,
          statusText: res.statusText || "",
          headers: h,
          json: () => Promise.resolve(JSON.parse(body)),
          text: () => Promise.resolve(body),
        });
      },
      onerror: () => {
        if (aborted) return;
        if (signal) signal.removeEventListener("abort", onAbort);
        reject(new TypeError("Network request failed"));
      },
      onabort: () => {
        if (signal) signal.removeEventListener("abort", onAbort);
        reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
      },
    });
  });
}
