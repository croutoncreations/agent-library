# Agent Library deploy repository (template)

Copy this folder into a new **private** repository (e.g. `my-org/agent-library-deploy`). It holds your installation's config and deploys exact, CI-tested commits of the app repository. The app repository stays free of your account IDs, hostnames and Cloudflare credentials.

```
agent-library-deploy/
  .github/workflows/deploy.yml   (from this template)
  wrangler.toml                  (from the app repo's wrangler.example.toml, [env.hosted] filled in)
  deploy/production.json         (from deploy/production.example.json; must match wrangler.toml)
```

Setup is described in the app repo's [docs/deploy-pipeline.md](../../docs/deploy-pipeline.md).
