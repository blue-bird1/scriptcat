export function tokenPreview(token) {
  if (!token) return "<empty>";
  if (token.length <= 12) return token;
  return `${token.slice(0, 6)}...${token.slice(-6)}`;
}
