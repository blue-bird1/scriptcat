export const styles = `
.dp-keys {
  box-sizing: border-box; padding: 18px; margin: 16px 0; width: 100%;
  border: 1px solid #617690; border-radius: 10px; background: #101c2c; color: #edf3fc;
  font: 14px/1.6 system-ui, sans-serif; text-align: left;
}
.dp-keys h2 { margin: 0 0 10px; font-size: 20px; font-weight: 700; color: #fff; }
.dp-keys p { margin: 8px 0; color: inherit; }
.dp-keys .dp-keys-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0; }
.dp-keys button {
  border: 1px solid #889bb6; border-radius: 5px; padding: 7px 12px;
  background: #24364d; color: #fff; cursor: pointer; font: inherit;
}
.dp-keys button.dp-keys-primary { background: #185e9e; }
.dp-keys button:disabled { opacity: .5; cursor: default; }
.dp-keys button:focus-visible, .dp-keys input:focus-visible { outline: 2px solid #f7c95e; outline-offset: 2px; }
.dp-keys .dp-keys-summary { font-weight: 600; }
.dp-keys .dp-keys-message { white-space: pre-wrap; overflow-wrap: anywhere; }
.dp-keys .dp-keys-error { color: #ffb4ad; }
.dp-keys .dp-keys-scroll { overflow-x: auto; max-height: 560px; overflow-y: auto; }
.dp-keys table { width: 100%; border-collapse: collapse; font: inherit; color: inherit; }
.dp-keys th, .dp-keys td { border-bottom: 1px solid #40536c; padding: 9px 8px; vertical-align: top; text-align: left; }
.dp-keys th { background: #1a2b41; position: sticky; top: 0; z-index: 1; white-space: nowrap; }
.dp-keys .dp-keys-title { min-width: 150px; overflow-wrap: anywhere; }
.dp-keys .dp-keys-expiry { color: #c1ccdc; font-size: 12px; }
.dp-keys input[type="checkbox"] { width: 18px; height: 18px; accent-color: #6eb4ff; }
.dp-keys .dp-keys-key {
  width: 260px; box-sizing: border-box; padding: 6px; border: 1px solid #617690; border-radius: 4px;
  background: #0b1421; color: #fff; font: 14px/1.5 ui-monospace, monospace; user-select: text;
}
`;
