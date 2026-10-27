async ({ grantType, props, env }) => {
  if (grantType !== "refresh_token") return;
  const retry = () => new OAuthError("temporarily_unavailable", {
    description: "Token renewal is temporarily unavailable. Retry shortly.",
    statusCode: 503, headers: { "retry-after": "300" }
  });
  try {
    if (props?.publisher_id) {
      const publisher = await livePublisher(env, props);
      if (!publisher || publisher.revoked) throw new OAuthError("invalid_grant", { description: "Publisher revoked or token superseded" });
      if (env.__oauthRefreshClaimBusy) throw retry();
      return;
    }
    const connection = await liveConnection(env, props?.connection_id);
    if (!connection) throw new OAuthError("invalid_grant", { description: "Connection revoked or expired" });
    if (env.__oauthRefreshClaimBusy) throw retry();
    // Preserve only currently valid connections. Never revive an expired/revoked grant or widen its projects.
    const renewed = await env.DB.prepare("UPDATE oauth_connections SET expires_at = ? WHERE id = ? AND revoked_at IS NULL AND expires_at > ? RETURNING id")
      .bind(Date.UTC(9999, 0, 1), connection.id, nowMs()).first();
    if (!renewed) throw new OAuthError("invalid_grant", { description: "Connection revoked or expired" });
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    // The provider revokes grants on invalid_grant. A storage outage is retryable and must leave tokens intact.
    throw retry();
  }
}
