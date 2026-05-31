export function notify(title, text, logPrefix = "") {
  try {
    GM_notification({
      title,
      text,
      timeout: 5000,
    });
  } catch (error) {
    const prefix = logPrefix ? `${logPrefix} ` : "";
    console.log(`${prefix}${title}: ${text}`, error);
  }
}
