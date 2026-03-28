# Public Marketplace Contract

This document is the source of truth for the public marketplace read model consumed by the brand-site frontend.

The current public marketplace frontend lives in:

- `/Users/hejiajiudeeyu/Documents/Projects/call-anything-brand-site`

The current public API implementation lives in:

- `/Users/hejiajiudeeyu/Documents/Projects/delegated-execution-dev/repos/platform/apps/platform-api/src/server.js`

## Purpose

These routes are public catalog surfaces only.

They exist to support:

- brand-site marketplace listing pages
- responder profile pages
- hotline detail pages

They do not expose admin review notes, internal audit payloads, or operator-only fields.

## Routes

The platform public marketplace contract currently includes:

- `GET /marketplace/meta`
- `GET /marketplace/hotlines`
- `GET /marketplace/hotlines/:hotlineId`
- `GET /marketplace/responders/:responderId`

## Contract Rules

- `responder.summary` is public profile copy written by the responder or platform operator for public display.
- `responder.summary` must not be synthesized from hotline count, audit state, or generic template text.
- If `responder.summary` is missing, the backend may return an empty string. The frontend is allowed to show a minimal neutral placeholder such as `暂无公开简介`.
- `GET /marketplace/meta` provides aggregate catalog counts only. It must not be used to backfill responder profile text.
- `GET /marketplace/hotlines` may return responder display information for listing use, but it must not be treated as the source of truth for long responder profile copy.
- `GET /marketplace/hotlines/:hotlineId` remains the detail truth source for hotline pages.

## Responder Public Model

`GET /marketplace/responders/:responderId`

Stable fields already consumed by the frontend:

- `responder_id`
- `responder_slug`
- `display_name`
- `summary`
- `hotline_count`
- `capabilities`
- `availability_status`
- `review_status`
- `support_email`
- `trust_badges`
- `hotlines`

Notes:

- `summary` is user-facing public profile text.
- `support_email` is public contact information and may be `null`.
- `trust_badges` is public trust metadata and may be an empty array.
- `hotlines` contains the public hotline listing for this responder.

Recommended to keep stable for later frontend enrichment:

- `last_heartbeat_at`
- `task_types`

## Hotline Public Model

`GET /marketplace/hotlines`

Stable fields already consumed by the frontend:

- `hotline_id`
- `hotline_slug`
- `responder_id`
- `responder_slug`
- `responder_display_name`
- `display_name`
- `summary`
- `task_types`
- `capabilities`
- `tags`
- `availability_status`
- `trust_badges`
- `template_summary`
- `latest_review_test`
- `updated_at`

`GET /marketplace/hotlines/:hotlineId`

Stable detail fields already consumed by the frontend:

- all hotline summary fields above
- `related_hotlines`
- `input_schema`
- `output_schema`
- `template_ref`
- `responder_profile`

Notes:

- `summary` is public hotline description text.
- `related_hotlines` may be empty.
- `template_summary` may be `null`.
- `latest_review_test` may be `null`.

## Field Ownership

Frontend responsibilities:

- render structured responder and hotline pages
- apply minimal neutral fallback for missing optional public fields
- never invent business copy for responder profiles

Backend responsibilities:

- return stable public catalog data for approved and visible entries
- provide responder-owned public profile copy in `summary`
- keep public and admin-only fields separated
- extend this document first when adding marketplace-facing fields

## Frontend Consumption

Current frontend usage:

- `/marketplace`
  - consumes `GET /marketplace/meta`
  - consumes `GET /marketplace/hotlines`
- `/marketplace/responders/:responderSlug`
  - resolves slug in frontend
  - consumes `GET /marketplace/responders/:responderId`
- `/marketplace/responders/:responderSlug/:hotlineSlug`
  - resolves slug in frontend
  - consumes `GET /marketplace/hotlines/:hotlineId`

The brand-site deployment note should point to this document instead of redefining field semantics.
