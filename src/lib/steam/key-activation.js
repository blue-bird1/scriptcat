import { gmXhr } from "../userscript/gm-xhr.js";

const STORE = "https://store.steampowered.com";
const RESULTS = {
  9: "已拥有", 13: "地区限制", 14: "无效 Key", 15: "已被使用",
  24: "缺少基础游戏", 36: "需要 PS3 激活", 50: "钱包/礼品卡代码", 53: "Steam 限速",
};

export function logKeyEvent(level, event, context = {}) {
  console[level]({ timestamp: new Date().toISOString(), level, event, ...context });
}

export async function getSteamSession(runId) {
  const response = await gmXhr({ method: "GET", url: STORE + "/" });
  if (response.status !== 200) throw new Error(`Steam 首页返回 HTTP ${response.status}`);
  const html = response.responseText;
  const account = html.match(/g_AccountID = (\d+)/);
  const session = html.match(/g_sessionID = "(\w+)"/);
  if (!account || Number(account[1]) === 0 || !session) {
    throw new Error("请先在当前浏览器登录 Steam 商店，再重试");
  }
  logKeyEvent("info", "steam_session_ready", { runId, accountId: account[1] });
  return session[1];
}

export async function activateSteamKey(key, sessionId, runId) {
  const response = await gmXhr({
    method: "POST", url: STORE + "/account/ajaxregisterkey/",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Origin: STORE, Referer: STORE + "/account/registerkey",
    },
    data: new URLSearchParams({ product_key: key, sessionid: sessionId }).toString(),
  });
  logKeyEvent("info", "steam_key_response", { runId, key, status: response.status, response: response.responseText });
  if (response.status !== 200) throw new Error(`Steam 激活接口返回 HTTP ${response.status}`);
  const result = JSON.parse(response.responseText);
  const code = Number(result.purchase_result_details);
  return {
    state: result.success === 1 ? "success" : "failed",
    message: result.success === 1 ? "激活成功" : RESULTS[code] || `激活失败（代码 ${code}）`,
    stop: code === 53,
  };
}
