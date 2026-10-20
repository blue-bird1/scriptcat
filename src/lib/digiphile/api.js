import { gmXhr } from "../userscript/gm-xhr.js";
import { log } from "./log.js";

const API = "https://api.digiphile.co/api";
const LAST_USER_KEY = "CognitoIdentityServiceProvider.1bktpqspo483aka9veb90j9800.LastAuthUser";

function readToken() {
  const username = localStorage.getItem(LAST_USER_KEY);
  const prefix = LAST_USER_KEY.slice(0, -"LastAuthUser".length);
  const token = username && localStorage.getItem(`${prefix}${username}.idToken`);
  if (!token) throw new Error("未找到当前登录凭据，请先在 Digiphile 登录。");
  return token;
}

function apiMessage(body) {
  if (Array.isArray(body?.errors) && body.errors.every(value => typeof value === "string")) {
    return body.errors.join("；");
  }
  return typeof body?.message === "string" ? body.message : "";
}

async function request(method, path, runId, validate) {
  const requestId = crypto.randomUUID();
  const token = readToken();
  log("debug", "digiphile.request_started", runId, { requestId, method, path });
  let response;
  try {
    response = await gmXhr({
      method,
      url: `${API}${path}`,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      anonymous: true,
    });
    const raw = response.responseText;
    let body;
    try {
      body = JSON.parse(raw);
    } catch (cause) {
      throw new Error(`Digiphile 返回了非 JSON 响应（HTTP ${response.status}）。`, { cause });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Digiphile 请求失败（HTTP ${response.status}）${apiMessage(body) ? `：${apiMessage(body)}` : "。"}`);
    }
    validate(body);
    // Key 只交给页面内存；成功响应不写入控制台。
    log("debug", "digiphile.request_completed", runId, { requestId, status: response.status });
    return body;
  } catch (error) {
    error.requestId = requestId;
    error.status = response?.status ?? error.response?.status;
    error.response = response?.responseText ?? error.response;
    throw error;
  }
}

export function listSteamKeys(runId) {
  return request("GET", "/customer/steam-keys", runId, body => {
    if (!Array.isArray(body)) throw new Error("Digiphile Key 列表格式不正确。");
    const ids = new Set();
    for (const item of body) {
      if (!item || typeof item.id !== "string" || !item.id || ids.has(item.id)
        || typeof item.title !== "string" || typeof item.status !== "string"
        || typeof item.isGift !== "boolean"
        || (item.expiresAt != null && (typeof item.expiresAt !== "string" || !Number.isFinite(Date.parse(item.expiresAt))))) {
        throw new Error("Digiphile Key 条目缺少必要字段或格式不正确。");
      }
      ids.add(item.id);
    }
  });
}

export async function readSteamKey(item, runId) {
  const action = item.status === "Revealed" ? "view" : "reveal";
  const body = await request("POST", `/customer/steam-keys/${encodeURIComponent(item.id)}/${action}`, runId, value => {
    if (typeof value?.steamKeyValue !== "string" || !value.steamKeyValue.trim()) {
      throw new Error("Digiphile 响应中没有有效 Key；请刷新列表核对状态后重试。");
    }
  });
  // view 只返回 steamKeyValue；reveal 返回完整 assignment。
  return { ...item, status: "Revealed", steamKeyValue: body.steamKeyValue };
}

export function availability(item, now = Date.now()) {
  if (item.isGift) return { available: false, fresh: false, label: "不可用 · 请在站点处理礼物" };
  if (item.status === "Revealed") return { available: true, fresh: false, label: "已刮开" };
  if (item.status === "Assigned") {
    if (item.expiresAt && Date.parse(item.expiresAt) <= now) {
      return { available: false, fresh: false, label: "不可用 · 已过期" };
    }
    return { available: true, fresh: true, label: "新 · 未刮开" };
  }
  return { available: false, fresh: false, label: `不可用 · ${item.status}` };
}
