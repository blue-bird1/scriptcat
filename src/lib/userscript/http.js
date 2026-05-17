export function getResponseHeader(responseHeaders, headerName) {
  const target = headerName.toLowerCase();
  return (responseHeaders || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf(":");
      if (index < 0) return null;
      return {
        name: line.slice(0, index).trim().toLowerCase(),
        value: line.slice(index + 1).trim(),
      };
    })
    .find((header) => header && header.name === target)?.value || "";
}
