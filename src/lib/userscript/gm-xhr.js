export function gmXhr(options) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      timeout: 20000,
      ...options,
      onload: resolve,
      onerror: () => reject(new Error("网络请求失败")),
      ontimeout: () => reject(new Error("网络请求超时")),
    });
  });
}
