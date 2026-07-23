/**
 * Decode workspace tree drags across browser and Tauri/WebKit hosts. Tree rows
 * publish a custom MIME value plus a prefixed text fallback; ordinary tab
 * drags use unprefixed text and therefore remain distinguishable.
 */
export function zinePathFromDataTransfer(dataTransfer: DataTransfer): string {
  const custom = dataTransfer.getData("text/zine-path");
  if (custom) return custom;
  const plain = dataTransfer.getData("text/plain");
  if (plain.startsWith("zine-path:")) return plain.slice("zine-path:".length);
  return "";
}

export function isZinePathDrag(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types);
  if (types.includes("text/zine-path")) return true;
  // Custom MIME can disappear during dragover in embedded WebKit hosts.
  return dataTransfer.getData("text/plain").startsWith("zine-path:");
}
