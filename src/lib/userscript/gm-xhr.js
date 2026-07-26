function createGmXhrError(message, response) {
  const error = new Error(message);
  error.response = response;
  return error;
}

export function gmXhr(options, sendRequest = GM_xmlhttpRequest) {
  return new Promise((resolve, reject) => {
    sendRequest({
      timeout: 20000,
      ...options,
      onload: resolve,
      onerror: (response) => reject(createGmXhrError("网络请求失败", response)),
      ontimeout: (response) => reject(createGmXhrError("网络请求超时", response)),
    });
  });
}
