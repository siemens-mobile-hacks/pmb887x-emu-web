// Docker HEALTHCHECK: the gateway answers a plain HTTP request with 426
// (WebSocket only), which is neither logged nor counted against any limit.
const listen = process.env.GPRS_GW_LISTEN || "0.0.0.0:5751";
const at = listen.lastIndexOf(":");
const host = listen.slice(0, at).replace(/^\[|\]$/g, "");
const port = listen.slice(at + 1);
const target = host === "0.0.0.0" || host === "" ? "127.0.0.1" : host === "::" ? "[::1]" : host.includes(":") ? `[${host}]` : host;
try {
  const res = await fetch(`http://${target}:${port}/`, { signal: AbortSignal.timeout(3000) });
  process.exit(res.status === 426 ? 0 : 1);
} catch {
  process.exit(1);
}
