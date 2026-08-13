// gallery.hudeifahassan.com -> Wasabi bucket proxy with SigV4 signing.
// Restores the gallery after Wasabi disabled account-wide public access:
// every request is signed server-side with the bucket keys, so nothing
// on the site needs presigned URLs and nothing ever expires.
const REGION = "eu-central-2";
const HOST = "s3.eu-central-2.wasabisys.com";
const BUCKET = "gallery.hudeifahassan.com";

const enc = new TextEncoder();

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const hex = a => [...a].map(b => b.toString(16).padStart(2, "0")).join("");

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // /engine -> the generation UI on the current pod (page's own JS talks
    // to the pod API directly; swap PODBASE when the pod changes)
    if (url.pathname === "/engine" || url.pathname.startsWith("/engine/")) {
      const podBase = env.PODBASE || "https://phd9ynnetjaef3-8888.proxy.runpod.net";
      const sub = url.pathname.replace(/^\/engine\/?/, "/");
      return fetch(podBase + sub + url.search, {
        method: request.method,
        headers: request.headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      });
    }

    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("method not allowed", { status: 405 });

    let path = url.pathname;
    if (path === "/" || path === "") path = "/index.html";
    const key = path.replace(/^\//, "").split("/").map(encodeURIComponent).join("/");
    const canonicalUri = `/${BUCKET}/${key}`;

    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${REGION}/s3/aws4_request`;
    const payloadHash = "UNSIGNED-PAYLOAD";

    const range = request.headers.get("Range");
    const headers = { host: HOST, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
    if (range) headers.range = range;
    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderNames.map(h => `${h}:${headers[h]}\n`).join("");
    const signedHeaders = signedHeaderNames.join(";");

    const canonicalRequest = ["GET", canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256hex(canonicalRequest)].join("\n");

    let k = await hmac(enc.encode("AWS4" + env.WASABI_SECRET_ACCESS_KEY), dateStamp);
    k = await hmac(k, REGION);
    k = await hmac(k, "s3");
    k = await hmac(k, "aws4_request");
    const signature = hex(await hmac(k, stringToSign));

    const auth = `AWS4-HMAC-SHA256 Credential=${env.WASABI_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const upstreamHeaders = { "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, Authorization: auth };
    if (range) upstreamHeaders.Range = range;

    const upstream = await fetch(`https://${HOST}${canonicalUri}`, { method: "GET", headers: upstreamHeaders });

    const out = new Headers();
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }
    out.set("cache-control", key.endsWith(".mp4") ? "public, max-age=86400" : "no-cache");
    return new Response(request.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers: out });
  },
};
