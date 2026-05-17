const DEFAULT_DEVTOOLS_BASE_URL = "http://127.0.0.1:3456";

export function getDevtoolsBaseUrl(): string {
  const configured = process.env.DEVTOOLS_URL?.trim();
  if (!configured) return DEFAULT_DEVTOOLS_BASE_URL;
  return configured.replace(/\/+$/, "");
}

export { DEFAULT_DEVTOOLS_BASE_URL };
