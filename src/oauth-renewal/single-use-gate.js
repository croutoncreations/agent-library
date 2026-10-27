async function singleUseGate(req, env) {
  const raw = await req.text(), p = new URLSearchParams(raw), gt = p.get("grant_type");
  const secret = gt === "authorization_code" ? p.get("code") : gt === "refresh_token" ? p.get("refresh_token") : null;
  const retry = () => new Response(JSON.stringify({ error: "temporarily_unavailable", error_description: "Token renewal is in progress. Retry shortly." }), {
    status: 503, headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": "300" }
  });
  if (secret) {
    const h = await sha(`${gt}:${secret}`), at = nowMs();
    try {
      if (gt === "refresh_token") {
        // Only the CURRENT provider token may enter the gate. The provider also accepts its predecessor;
        // refusing it here prevents replay even after the 31-day redemption-history cleanup.
        const parts = secret.split(":");
        const grant = parts.length === 3 && secret.length <= 512 ? await env.OAUTH_KV.get(`grant:${parts[0]}:${parts[1]}`, { type: "json" }) : null;
        if (!grant || grant.refreshTokenId !== await sha(secret)) return oauthJson(400, { error: "invalid_grant", error_description: "Refresh token is no longer current" });
      }
      const inserted = await env.DB.prepare("INSERT INTO oauth_code_redemptions (code_hash, redeemed_at) VALUES (?, ?) ON CONFLICT (code_hash) DO NOTHING").bind(h, at).run();
      if (!(inserted.meta.changes ?? 0)) {
        if (gt !== "refresh_token") return oauthJson(400, { error: "invalid_grant", error_description: "Authorization code already used" });
        // A callback may have failed AFTER claiming this token. Do not burn a still-current token forever.
        // Wait five minutes (beyond KV's normal propagation/cache interval), then atomically reclaim only the
        // old attempt. Concurrent retries cannot both win. Used tokens fail the current-token check above.
        const reclaimed = await env.DB.prepare("UPDATE oauth_code_redemptions SET redeemed_at = ? WHERE code_hash = ? AND redeemed_at <= ? RETURNING code_hash").bind(at, h, at - 300000).first();
        if (!reclaimed) return { request: new Request(req, { body: raw }), refreshBusy: true };
      }
    } catch { return retry(); }
  }
  return new Request(req, { body: raw });
}
