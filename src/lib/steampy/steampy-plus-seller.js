const SELLER_PATH = "/pro/seller/sellerCDKey";
const BATCH_BUTTON_ATTRIBUTE = "data-steampy-plus-batch-add";
const BATCH_MODAL_ATTRIBUTE = "data-steampy-plus-batch-modal";
const BATCH_STYLE_ATTRIBUTE = "data-steampy-plus-batch-style";
const REGION_BY_LABEL = {
  国区: "cn",
  俄罗斯区: "ru",
  全球区: "us",
  土区: "tl",
};

function isSellerPage() {
  return location.pathname.replace(/\/+$/, "") === SELLER_PATH;
}

function createElement(tagName, options = {}) {
  const element = document.createElement(tagName);
  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = options.text;
  if (options.type) element.type = options.type;
  if (options.disabled !== undefined) element.disabled = options.disabled;
  if (options.attributes) {
    Object.entries(options.attributes).forEach(([name, value]) => {
      element.setAttribute(name, value);
    });
  }
  return element;
}

function errorMessage(error) {
  return error?.message || String(error);
}

function rowLabel(row) {
  const locator = row.gameName || (row.appId ? `AppID ${row.appId}` : `gameId ${row.gameId}`);
  return `第 ${row.lineNumber} 行 · ${locator}`;
}

function collectFailedRows(results, groups, stoppedAt) {
  const rows = [];
  results.forEach((result) => {
    if (!result?.ok) rows.push(...(result?.rows || []));
  });
  if (stoppedAt !== null) {
    groups.slice(stoppedAt).forEach((group) => rows.push(...group.rows));
  }
  return rows;
}

export function createSteamPySellerController({
  client,
  parseBatchCsv,
  preflightBatch,
  submitBatch,
} = {}) {
  let started = false;
  let observer = null;
  let injectionScheduled = false;
  let modal = null;
  let removeModalKeydown = null;
  let lifecycleGeneration = 0;
  let preservedDraft = "";
  let submissionActive = false;

  function currentRegionSnapshot() {
    const activeRegion = document.querySelector(".area-wap > .qu-li-a");
    const label = activeRegion?.textContent.trim() || "";
    const region = REGION_BY_LABEL[label];
    if (!region) throw new Error("无法识别当前出售区域，请刷新页面后重试");
    return { label, region };
  }

  function assertRegionSnapshot(snapshot) {
    const current = currentRegionSnapshot();
    if (current.region !== snapshot.region || current.label !== snapshot.label) {
      throw new Error(`出售区域已从“${snapshot.label}”切换为“${current.label}”，请重新预检`);
    }
  }

  function ensureStyle() {
    if (document.querySelector(`[${BATCH_STYLE_ATTRIBUTE}]`)) return;
    const style = createElement("style", {
      attributes: { [BATCH_STYLE_ATTRIBUTE]: "true" },
    });
    style.textContent = `
      [${BATCH_MODAL_ATTRIBUTE}] {
        position: fixed;
        inset: 0;
        z-index: 2147483000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgba(0, 0, 0, 0.55);
        box-sizing: border-box;
      }
      [${BATCH_MODAL_ATTRIBUTE}] .sp-batch-dialog {
        width: min(920px, 100%);
        max-height: min(840px, calc(100vh - 48px));
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding: 22px;
        overflow: auto;
        border-radius: 10px;
        background: #fff;
        color: #1f2329;
        box-shadow: 0 16px 48px rgba(0, 0, 0, 0.3);
      }
      [${BATCH_MODAL_ATTRIBUTE}] .sp-batch-header,
      [${BATCH_MODAL_ATTRIBUTE}] .sp-batch-actions,
      [${BATCH_MODAL_ATTRIBUTE}] .sp-batch-confirm {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      [${BATCH_MODAL_ATTRIBUTE}] .sp-batch-header {
        justify-content: space-between;
      }
      [${BATCH_MODAL_ATTRIBUTE}] h2,
      [${BATCH_MODAL_ATTRIBUTE}] p {
        margin: 0;
      }
      [${BATCH_MODAL_ATTRIBUTE}] textarea {
        min-height: 210px;
        padding: 10px;
        resize: vertical;
        border: 1px solid #c9cdd4;
        border-radius: 6px;
        font: 13px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace;
      }
      [${BATCH_MODAL_ATTRIBUTE}] button {
        min-height: 34px;
        padding: 0 16px;
        border: 1px solid #c9cdd4;
        border-radius: 5px;
        background: #fff;
        cursor: pointer;
      }
      [${BATCH_MODAL_ATTRIBUTE}] button.sp-batch-primary {
        border-color: #165dff;
        background: #165dff;
        color: #fff;
      }
      [${BATCH_MODAL_ATTRIBUTE}] button:disabled,
      [${BATCH_MODAL_ATTRIBUTE}] textarea:disabled {
        cursor: not-allowed;
        opacity: 0.6;
      }
      [${BATCH_MODAL_ATTRIBUTE}] .sp-batch-close {
        min-width: 34px;
        padding: 0;
        font-size: 22px;
      }
      [${BATCH_MODAL_ATTRIBUTE}] .sp-batch-panel {
        display: none;
        padding: 12px;
        border-radius: 6px;
        background: #f2f3f5;
      }
      [${BATCH_MODAL_ATTRIBUTE}] .sp-batch-panel[data-visible="true"] {
        display: block;
      }
      [${BATCH_MODAL_ATTRIBUTE}] .sp-batch-list {
        display: grid;
        gap: 8px;
        margin: 10px 0 0;
        padding: 0;
        list-style: none;
      }
      [${BATCH_MODAL_ATTRIBUTE}] .sp-batch-error {
        color: #cb2634;
      }
      [${BATCH_MODAL_ATTRIBUTE}] .sp-batch-success {
        color: #168344;
      }
      [${BATCH_MODAL_ATTRIBUTE}] .sp-batch-progress {
        font-weight: 600;
      }
    `;
    document.head.append(style);
  }

  function closeModal() {
    if (!modal || modal.running) return;
    removeModalKeydown?.();
    removeModalKeydown = null;
    modal.root.remove();
    modal = null;
  }

  function setSubmissionActive(active) {
    submissionActive = active;
    const batchButton = document.querySelector(`[${BATCH_BUTTON_ATTRIBUTE}]`);
    if (batchButton) {
      batchButton.disabled = active;
      batchButton.textContent = active ? "批量上架处理中" : "批量添加CDKey";
    }
  }

  function openModal() {
    if (modal || submissionActive || !isSellerPage()) return;
    ensureStyle();

    const root = createElement("div", {
      attributes: {
        [BATCH_MODAL_ATTRIBUTE]: "true",
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": "steampy-plus-batch-title",
      },
    });
    const dialog = createElement("section", { className: "sp-batch-dialog" });
    const header = createElement("div", { className: "sp-batch-header" });
    const title = createElement("h2", {
      text: "批量添加 CDKey",
      attributes: { id: "steampy-plus-batch-title" },
    });
    const closeButton = createElement("button", {
      className: "sp-batch-close",
      text: "×",
      type: "button",
      attributes: { "aria-label": "关闭批量添加窗口" },
    });
    header.append(title, closeButton);

    const format = createElement("p", {
      text: "固定无表头 CSV：gameName,key,appId,gameId。每行 2–4 列；至少填写 gameName、appId、gameId 之一，ID 始终按文本处理。",
    });
    const textarea = createElement("textarea", {
      attributes: {
        placeholder: '示例：\n"Chillquarium","AAAAA-BBBBB-CCCCC","2276930",',
        "aria-label": "批量 CDKey CSV",
      },
    });
    const status = createElement("p", {
      text: "请先预检；预检不会提交 CDKey。",
      attributes: { "aria-live": "polite" },
    });
    const errorPanel = createElement("section", {
      className: "sp-batch-panel sp-batch-error",
      attributes: { "data-visible": "false" },
    });
    const previewPanel = createElement("section", {
      className: "sp-batch-panel",
      attributes: { "data-visible": "false" },
    });
    const progressPanel = createElement("section", {
      className: "sp-batch-panel",
      attributes: { "data-visible": "false", "aria-live": "polite" },
    });
    const confirmLabel = createElement("label", { className: "sp-batch-confirm" });
    const confirmCheckbox = createElement("input", { type: "checkbox", disabled: true });
    const confirmText = createElement("span", { text: "我已核对预览内容和出售区域，并确认开始真实上架。" });
    confirmLabel.append(confirmCheckbox, confirmText);

    const actions = createElement("div", { className: "sp-batch-actions" });
    const preflightButton = createElement("button", {
      className: "sp-batch-primary",
      text: "预检",
      type: "button",
    });
    const submitButton = createElement("button", {
      className: "sp-batch-primary",
      text: "确认并串行上架",
      type: "button",
      disabled: true,
    });
    const refreshButton = createElement("button", {
      text: "刷新页面",
      type: "button",
      disabled: true,
    });
    const cancelButton = createElement("button", { text: "关闭", type: "button" });
    actions.append(preflightButton, submitButton, refreshButton, cancelButton);
    dialog.append(
      header,
      format,
      textarea,
      status,
      errorPanel,
      previewPanel,
      progressPanel,
      confirmLabel,
      actions,
    );
    root.append(dialog);
    document.body.append(root);

    const state = {
      confirmCheckbox,
      preflightResult: null,
      regionSnapshot: null,
      root,
      running: false,
      textarea,
    };
    modal = state;
    if (preservedDraft) {
      textarea.value = preservedDraft;
      status.textContent = "已恢复上次离开页面时尚未完成的输入，请重新预检。";
      preservedDraft = "";
    }

    function clearPanel(panel) {
      panel.replaceChildren();
      panel.dataset.visible = "false";
    }

    function renderErrors(errors) {
      clearPanel(errorPanel);
      if (!errors.length) return;
      errorPanel.dataset.visible = "true";
      errorPanel.append(createElement("strong", { text: `发现 ${errors.length} 个问题` }));
      const list = createElement("ul", { className: "sp-batch-list" });
      errors.forEach((error) => {
        const prefix = error.lineNumber ? `第 ${error.lineNumber} 行：` : "";
        list.append(createElement("li", { text: `${prefix}${error.message || errorMessage(error)}` }));
      });
      errorPanel.append(list);
    }

    function renderPreview(result, snapshot) {
      clearPanel(previewPanel);
      previewPanel.dataset.visible = "true";
      previewPanel.append(
        createElement("strong", {
          text: `出售区域：${snapshot.label}；共 ${result.rows.length} 行、${result.groups.length} 个商品`,
        }),
      );
      const list = createElement("ul", { className: "sp-batch-list" });
      result.groups.forEach((group) => {
        const name = group.gameName || (group.appId ? `AppID ${group.appId}` : "未命名商品");
        const appIdText = group.appId ? ` · AppID ${group.appId}` : "";
        list.append(
          createElement("li", {
            text: `${name}${appIdText} · gameId ${group.gameId} · ${group.rows.length} 个 Key · 挂单价 ${group.keyPrice}`,
          }),
        );
      });
      previewPanel.append(list);
    }

    function resetPreflight() {
      state.preflightResult = null;
      state.regionSnapshot = null;
      confirmCheckbox.checked = false;
      confirmCheckbox.disabled = true;
      submitButton.disabled = true;
      refreshButton.disabled = true;
      clearPanel(errorPanel);
      clearPanel(previewPanel);
      clearPanel(progressPanel);
      status.className = "";
      status.textContent = "内容已改变，请重新预检。";
    }

    function setRunning(running) {
      state.running = running;
      textarea.disabled = running;
      preflightButton.disabled = running;
      confirmCheckbox.disabled = running || !state.preflightResult;
      submitButton.disabled = running || !confirmCheckbox.checked || !state.preflightResult;
      closeButton.disabled = running;
      cancelButton.disabled = running;
    }

    async function runPreflight() {
      if (typeof parseBatchCsv !== "function" || typeof preflightBatch !== "function" || !client) {
        renderErrors([{ message: "批量功能依赖未完成接线，请刷新脚本后重试" }]);
        return;
      }
      let snapshot;
      let parsed;
      try {
        snapshot = currentRegionSnapshot();
        parsed = parseBatchCsv(textarea.value);
      } catch (error) {
        renderErrors([{ message: errorMessage(error) }]);
        status.textContent = "输入或区域读取失败，不会提交任何 CDKey。";
        return;
      }
      renderErrors(parsed.errors || []);
      if (!parsed.rows?.length || parsed.errors?.length) {
        status.textContent = parsed.rows?.length ? "请修正输入问题后重新预检。" : "没有可预检的有效行。";
        return;
      }

      setRunning(true);
      status.textContent = `正在预检 ${parsed.rows.length} 行，当前区域：${snapshot.label}…`;
      try {
        const result = await preflightBatch(parsed.rows, { client, region: snapshot.region });
        assertRegionSnapshot(snapshot);
        renderErrors(result.errors || []);
        renderPreview(result, snapshot);
        if (result.errors?.length || !result.groups?.length) {
          status.textContent = "预检未通过，不会启用提交。";
          return;
        }
        state.preflightResult = result;
        state.regionSnapshot = snapshot;
        confirmCheckbox.disabled = false;
        status.className = "sp-batch-success";
        status.textContent = "预检通过。请核对区域、商品、Key 数量和挂单价后勾选确认。";
      } catch (error) {
        renderErrors([{ message: errorMessage(error) }]);
        status.textContent = "预检失败，不会提交任何 CDKey。";
      } finally {
        setRunning(false);
      }
    }

    async function runSubmission() {
      if (!state.preflightResult || typeof submitBatch !== "function") return;
      try {
        assertRegionSnapshot(state.regionSnapshot);
      } catch (error) {
        resetPreflight();
        renderErrors([{ message: errorMessage(error) }]);
        return;
      }

      const submissionGeneration = lifecycleGeneration;
      const { groups } = state.preflightResult;
      const allResults = [];
      let stoppedAt = null;
      setSubmissionActive(true);
      setRunning(true);
      progressPanel.dataset.visible = "true";
      status.className = "";
      status.textContent = `开始在“${state.regionSnapshot.label}”串行上架，运行期间不可编辑或关闭。`;

      for (let index = 0; index < groups.length; index += 1) {
        if (submissionGeneration !== lifecycleGeneration || !started || !isSellerPage()) {
          stoppedAt = index;
          break;
        }
        const group = groups[index];
        progressPanel.replaceChildren(
          createElement("p", {
            className: "sp-batch-progress",
            text: `正在提交 ${index + 1}/${groups.length}：gameId ${group.gameId}，${group.rows.length} 个 Key`,
          }),
        );
        let batchResult;
        try {
          batchResult = await submitBatch([group], {
            client,
            region: state.regionSnapshot.region,
            sellPrice: String(group.keyPrice),
          });
        } catch (error) {
          batchResult = {
            results: [{
              error,
              gameId: group.gameId,
              message: errorMessage(error),
              ok: false,
              rows: group.rows,
            }],
            stopped: client?.isTokenInvalid?.() === true,
          };
        }
        allResults.push(...(batchResult.results || []));
        if (submissionGeneration !== lifecycleGeneration || !started || !isSellerPage()) {
          stoppedAt = index + 1;
          break;
        }
        if (!batchResult.results?.length) {
          stoppedAt = index;
          break;
        }
        if (batchResult.stopped) {
          stoppedAt = index + 1;
          break;
        }
      }

      const failedRows = collectFailedRows(allResults, groups, stoppedAt);
      const failedInput = failedRows.map((row) => row.rawLine).filter(Boolean).join("\n");
      if (submissionGeneration !== lifecycleGeneration || !started || !isSellerPage()) {
        preservedDraft = failedInput;
        state.running = false;
        setSubmissionActive(false);
        return;
      }
      const succeeded = allResults.filter((result) => result.ok).length;
      const failed = allResults.filter((result) => !result.ok).length
        + (stoppedAt === null ? 0 : groups.length - stoppedAt);
      textarea.value = failedInput;
      progressPanel.replaceChildren(
        createElement("p", {
          className: failedRows.length ? "sp-batch-error" : "sp-batch-success",
          text: `完成：成功 ${succeeded} 组，失败或未执行 ${failed} 组${stoppedAt === null ? "" : "，队列已提前停止"}。`,
        }),
      );
      if (failedRows.length) {
        const list = createElement("ul", { className: "sp-batch-list sp-batch-error" });
        allResults.filter((result) => !result.ok).forEach((result) => {
          const affected = (result.rows || []).map(rowLabel).join("、");
          list.append(createElement("li", { text: `${affected}：${result.message || errorMessage(result.error)}` }));
        });
        progressPanel.append(list);
        status.textContent = "失败和未执行的原始行已保留在输入框，可刷新数据后重新预检。";
      } else {
        status.className = "sp-batch-success";
        status.textContent = "全部提交完成。请刷新页面查看最新挂单列表。";
      }
      state.preflightResult = null;
      state.regionSnapshot = null;
      confirmCheckbox.checked = false;
      submitButton.disabled = true;
      refreshButton.disabled = false;
      setRunning(false);
      setSubmissionActive(false);
    }

    textarea.addEventListener("input", resetPreflight);
    preflightButton.addEventListener("click", runPreflight);
    confirmCheckbox.addEventListener("change", () => {
      submitButton.disabled = !confirmCheckbox.checked || !state.preflightResult;
    });
    submitButton.addEventListener("click", runSubmission);
    refreshButton.addEventListener("click", () => location.reload());
    closeButton.addEventListener("click", closeModal);
    cancelButton.addEventListener("click", closeModal);
    root.addEventListener("click", (event) => {
      if (event.target === root) closeModal();
    });
    const onKeydown = (event) => {
      if (event.key === "Escape") closeModal();
    };
    document.addEventListener("keydown", onKeydown);
    removeModalKeydown = () => document.removeEventListener("keydown", onKeydown);
    textarea.focus();
  }

  function injectButton() {
    injectionScheduled = false;
    if (!started || !isSellerPage()) return;
    const actionBar = document.querySelector(".cdkTrade-layout > .w100.tc");
    if (!actionBar || actionBar.querySelector(`[${BATCH_BUTTON_ATTRIBUTE}]`)) return;
    const addButton = [...actionBar.querySelectorAll(":scope > button")]
      .find((button) => button.textContent.trim() === "添加CDKey");
    if (!addButton) return;
    const batchButton = createElement("button", {
      className: addButton.className,
      text: submissionActive ? "批量上架处理中" : "批量添加CDKey",
      type: "button",
      disabled: submissionActive,
      attributes: { [BATCH_BUTTON_ATTRIBUTE]: "true" },
    });
    batchButton.addEventListener("click", openModal);
    addButton.insertAdjacentElement("afterend", batchButton);
  }

  function scheduleInjection() {
    if (injectionScheduled) return;
    injectionScheduled = true;
    queueMicrotask(injectButton);
  }

  function start() {
    if (started) return;
    started = true;
    observer = new MutationObserver(scheduleInjection);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    scheduleInjection();
  }

  function cleanup() {
    started = false;
    lifecycleGeneration += 1;
    injectionScheduled = false;
    observer?.disconnect();
    observer = null;
    document.querySelectorAll(`[${BATCH_BUTTON_ATTRIBUTE}]`).forEach((button) => button.remove());
    if (modal) {
      preservedDraft = modal.textarea.value;
      modal.running = false;
      closeModal();
    }
    document.querySelector(`[${BATCH_STYLE_ATTRIBUTE}]`)?.remove();
  }

  return { cleanup, start };
}
