export function getCkValue() {
  const cookieValue = document.cookie
    .split("; ")
    .find((row) => row.startsWith("ck="))
    ?.split("=")[1];
  return cookieValue || "";
}
