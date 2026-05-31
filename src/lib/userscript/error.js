export function formatError(error) {
  if (!error) return "unknown error";
  if (typeof error === "string") return error;
  if (error.error) return error.error;
  if (error.message) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
