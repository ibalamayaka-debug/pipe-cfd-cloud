/**
 * Cloudflare Worker Edge Gateway for Pipe CFD Cloud ($0/month Free Tier).
 *
 * Supports both Cloudflare R2 (when RESULTS_BUCKET is bound) and Cloudflare KV
 * (RESULTS_KV, zero credit card required) seamlessly for caching .vtp & metrics.json.
 */

export interface Env {
  RESULTS_BUCKET?: R2Bucket;
  RESULTS_KV?: KVNamespace;
  RATE_LIMIT_KV?: KVNamespace;
  COMPUTE_ENDPOINT_URL?: string;
  COMPUTE_AUTH_TOKEN?: string;
  TURNSTILE_SECRET_KEY?: string;
  ALLOWED_ORIGIN?: string;
  MAX_RUNS_PER_IP_PER_HOUR?: string;
  ENABLE_TURNSTILE?: string;
}

interface NormalizedParams {
  diameter_mm: number;
  velocity_ms: number;
  bend_angle_deg: number;
  viscosity_m2s: number;
  density_kgm3: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function formatSci2(v: number): string {
  const [mantissa, exp] = v.toExponential(2).split("e");
  const sign = exp.startsWith("-") ? "-" : "+";
  const digits = exp.slice(1).padStart(2, "0");
  return `${mantissa}e${sign}${digits}`;
}

function normalizeParams(raw: Record<string, unknown>): NormalizedParams {
  const d = Number(clamp(Number(raw.diameter_mm ?? 50), 20, 200).toFixed(1));
  const u = Number(clamp(Number(raw.velocity_ms ?? 1.2), 0.1, 10.0).toFixed(2));
  const theta = Math.round(clamp(Number(raw.bend_angle_deg ?? 90), 15, 180));
  const nuClamped = clamp(Number(raw.viscosity_m2s ?? 1e-6), 1e-6, 5e-4);
  const nu = Number(formatSci2(nuClamped));
  const rho = Number(clamp(Number(raw.density_kgm3 ?? 998.2), 0.5, 2000).toFixed(1));
  return {
    diameter_mm: d,
    velocity_ms: u,
    bend_angle_deg: theta,
    viscosity_m2s: nu,
    density_kgm3: rho,
  };
}

async function computeCaseKey(p: NormalizedParams): Promise<string> {
  const canonical =
    `d=${p.diameter_mm.toFixed(1)}|u=${p.velocity_ms.toFixed(2)}|` +
    `a=${p.bend_angle_deg.toFixed(0)}|nu=${formatSci2(p.viscosity_m2s)}|rho=${p.density_kgm3.toFixed(1)}`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

function corsHeaders(env: Env, origin: string | null): Record<string, string> {
  const configured = env.ALLOWED_ORIGIN || "*";
  let allow = configured;
  if (configured !== "*" && origin) {
    const allowedList = configured.split(",").map((s) => s.trim());
    allow = allowedList.includes(origin) ? origin : allowedList[0];
  }
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function jsonResponse(
  data: unknown,
  env: Env,
  origin: string | null,
  status = 200
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(env, origin),
    },
  });
}

// Unified storage helpers (R2 preferred if bound, otherwise KV)
async function storageGetText(env: Env, key: string): Promise<string | null> {
  if (env.RESULTS_BUCKET) {
    const obj = await env.RESULTS_BUCKET.get(key);
    if (obj) return obj.text();
  }
  if (env.RESULTS_KV) {
    return env.RESULTS_KV.get(key, "text");
  }
  return null;
}

async function storagePutText(
  env: Env,
  key: string,
  value: string,
  contentType: string
): Promise<void> {
  if (env.RESULTS_BUCKET) {
    await env.RESULTS_BUCKET.put(key, value, {
      httpMetadata: {
        contentType,
        cacheControl: "public, max-age=31536000, immutable",
      },
    });
    return;
  }
  if (env.RESULTS_KV) {
    await env.RESULTS_KV.put(key, value);
  }
}

async function storageListMetrics(env: Env): Promise<unknown[]> {
  const metricsKeys: string[] = [];
  if (env.RESULTS_BUCKET) {
    const listed = await env.RESULTS_BUCKET.list({ prefix: "cases/", limit: 120 });
    listed.objects
      .filter((o) => o.key.endsWith("/metrics.json"))
      .sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())
      .slice(0, 16)
      .forEach((o) => metricsKeys.push(o.key));
  } else if (env.RESULTS_KV) {
    const listed = await env.RESULTS_KV.list({ prefix: "cases/", limit: 120 });
    listed.keys
      .filter((k) => k.name.endsWith("/metrics.json"))
      .slice(0, 16)
      .forEach((k) => metricsKeys.push(k.name));
  }

  const cases = await Promise.all(
    metricsKeys.map(async (key) => {
      const txt = await storageGetText(env, key);
      if (!txt) return null;
      try {
        return JSON.parse(txt);
      } catch {
        return null;
      }
    })
  );
  return cases.filter(Boolean);
}

async function verifyTurnstile(
  token: string | undefined,
  ip: string,
  env: Env
): Promise<boolean> {
  if (env.ENABLE_TURNSTILE !== "true" || !env.TURNSTILE_SECRET_KEY) {
    return true;
  }
  if (!token) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET_KEY);
  form.append("response", token);
  form.append("remoteip", ip);
  const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });
  const outcome = (await resp.json()) as { success?: boolean };
  return Boolean(outcome.success);
}

async function checkRateLimit(
  ip: string,
  env: Env
): Promise<{ allowed: boolean; remaining: number }> {
  const limit = Number(env.MAX_RUNS_PER_IP_PER_HOUR || "8");
  if (!env.RATE_LIMIT_KV || limit <= 0) {
    return { allowed: true, remaining: limit };
  }
  const hourBucket = Math.floor(Date.now() / 3_600_000);
  const key = `rl:${ip}:${hourBucket}`;
  const current = Number((await env.RATE_LIMIT_KV.get(key)) || "0");
  if (current >= limit) {
    return { allowed: false, remaining: 0 };
  }
  await env.RATE_LIMIT_KV.put(key, String(current + 1), { expirationTtl: 3700 });
  return { allowed: true, remaining: limit - current - 1 };
}

function resultUrls(caseKey: string) {
  return {
    wall: `/api/results/${caseKey}/wall.vtp`,
    slice: `/api/results/${caseKey}/slice.vtp`,
    vectors: `/api/results/${caseKey}/vectors.vtp`,
    metrics: `/api/results/${caseKey}/metrics.json`,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin");
    const url = new URL(request.url);
    const path = url.pathname;
    const storageBackend = env.RESULTS_BUCKET ? "cloudflare-r2" : "cloudflare-kv";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env, origin) });
    }

    if (request.method === "GET" && path === "/api/health") {
      return jsonResponse(
        {
          status: "ok",
          mode: "cloudflare-edge",
          storage: storageBackend,
          compute_configured: Boolean(env.COMPUTE_ENDPOINT_URL),
        },
        env,
        origin
      );
    }

    if (request.method === "GET" && path === "/api/cases") {
      const cases = await storageListMetrics(env);
      return jsonResponse({ cases, storage: storageBackend }, env, origin);
    }

    if (request.method === "GET" && path.startsWith("/api/results/")) {
      const parts = path.slice("/api/results/".length).split("/");
      if (parts.length !== 2) {
        return jsonResponse({ error: "Invalid result path" }, env, origin, 400);
      }
      const [caseKey, filename] = parts;
      const allowedFiles = new Set(["wall.vtp", "slice.vtp", "vectors.vtp", "metrics.json"]);
      if (!/^[a-f0-9]{16}$/.test(caseKey) || !allowedFiles.has(filename)) {
        return jsonResponse({ error: "Invalid case key or filename" }, env, origin, 400);
      }
      const key = `cases/${caseKey}/${filename}`;
      const contentType = filename.endsWith(".json")
        ? "application/json; charset=utf-8"
        : "application/xml; charset=utf-8";

      if (env.RESULTS_BUCKET) {
        const obj = await env.RESULTS_BUCKET.get(key);
        if (obj) {
          return new Response(obj.body, {
            status: 200,
            headers: {
              "Content-Type": contentType,
              "Cache-Control": "public, max-age=31536000, immutable",
              ...corsHeaders(env, origin),
            },
          });
        }
      }

      const txt = await storageGetText(env, key);
      if (txt === null) {
        return jsonResponse({ error: "Result not found" }, env, origin, 404);
      }
      return new Response(txt, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=31536000, immutable",
          ...corsHeaders(env, origin),
        },
      });
    }

    if (request.method === "POST" && path === "/api/simulate") {
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return jsonResponse({ error: "Invalid JSON payload" }, env, origin, 400);
      }

      const params = normalizeParams(body);
      const caseKey = await computeCaseKey(params);
      const force = Boolean(body.force);

      // Fast path: check Cloudflare R2 / KV cache first (0ms compute, $0!)
      if (!force) {
        const cachedTxt = await storageGetText(env, `cases/${caseKey}/metrics.json`);
        if (cachedTxt) {
          return jsonResponse(
            {
              status: "ok",
              cached: true,
              backend: `${storageBackend}-cache`,
              case_key: caseKey,
              metrics: JSON.parse(cachedTxt),
              urls: resultUrls(caseKey),
            },
            env,
            origin
          );
        }
      }

      const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
      const turnstileOk = await verifyTurnstile(
        typeof body.turnstile_token === "string" ? body.turnstile_token : undefined,
        clientIp,
        env
      );
      if (!turnstileOk) {
        return jsonResponse({ error: "Turnstile verification failed" }, env, origin, 403);
      }

      const rate = await checkRateLimit(clientIp, env);
      if (!rate.allowed) {
        return jsonResponse(
          { error: "当前 IP 本小时云端仿真次数已达上限，请直接点击下方已缓存算例或稍后再试。" },
          env,
          origin,
          429
        );
      }

      if (!env.COMPUTE_ENDPOINT_URL) {
        return jsonResponse(
          {
            error:
              "新参数需要唤醒云端 OpenFOAM 算力（尚未配置 Modal / Cloud Run 的 COMPUTE_ENDPOINT_URL）。你可以先点击底部已预计算的 3D 算例秒开查看，或按 README 步骤部署 Modal 算力。",
          },
          env,
          origin,
          503
        );
      }

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (env.COMPUTE_AUTH_TOKEN) {
        headers["Authorization"] = `Bearer ${env.COMPUTE_AUTH_TOKEN}`;
      }

      const computeResp = await fetch(env.COMPUTE_ENDPOINT_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...params, force }),
      });

      if (!computeResp.ok) {
        const detail = await computeResp.text();
        return jsonResponse(
          { error: `Compute backend failed (${computeResp.status}): ${detail.slice(0, 400)}` },
          env,
          origin,
          502
        );
      }

      const computeData = (await computeResp.json()) as {
        cached?: boolean;
        metrics?: unknown;
        files_content?: Record<string, string>;
      };

      // If compute returned inline VTP/metrics (KV mode without R2), persist into Cloudflare storage
      if (computeData.files_content) {
        await Promise.all(
          Object.entries(computeData.files_content).map(([fname, content]) => {
            const ctype = fname.endsWith(".json")
              ? "application/json; charset=utf-8"
              : "application/xml; charset=utf-8";
            return storagePutText(env, `cases/${caseKey}/${fname}`, content, ctype);
          })
        );
      }

      return jsonResponse(
        {
          status: "ok",
          cached: Boolean(computeData.cached),
          backend: "serverless-openfoam",
          case_key: caseKey,
          remaining_quota: rate.remaining,
          metrics: computeData.metrics,
          urls: resultUrls(caseKey),
        },
        env,
        origin
      );
    }

    return jsonResponse({ error: "Not found" }, env, origin, 404);
  },
};
