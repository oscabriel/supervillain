# Deploy the public site from its own Cloudflare stack, host-neutral in git

## Decision

The landing page, docs, and blog live in `packages/site`: a Foldkit + `@foldkit/markdown` app prerendered to static HTML by Vite (`packages/site/vite.config.ts`) and deployed independently via `packages/site/alchemy.run.ts` (`Cloudflare.Website.Foldkit` + `Cloudflare.state()`). Both Vite and Alchemy read `SUPERVILLAIN_SITE_DOMAIN` strictly from the repository root `.env` (defaulting to `supervillain.example.com` for prerender origin and `null` for deploy when unset). No personal domains, server IPs, or secrets are committed to tracked files.

## Why

Self-hosters compiling or running `supervillain` have no need for Cloudflare credentials or the project's marketing site. Sharing one root `.env` lookup guarantees the prerendered origin always matches the deployed custom domain.

## What breaks if you change this

- Reading `packages/site/.env` in Vite while Alchemy reads `../../.env` causes prerendered URLs and the deployed Worker domain to diverge.
- Uncommenting a placeholder domain in `.env.example` causes an accidental custom-domain bind if copied verbatim.
- Omitting `.alchemy/` from `.gitignore` risks committing local deployment state.
