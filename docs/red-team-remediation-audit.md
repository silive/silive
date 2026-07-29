# Red-Team Remediation Audit

Baseline: `7cb0b42ddbb282f8a1109b16a9d9f79e5ddb3c51`

This document records the phase-A evidence review. It contains no production
credentials or customer data.

| Finding | Result | Evidence and calibrated remediation |
| --- | --- | --- |
| FZ-P0-01 store attribution forgery | Confirmed | `createOrder()` accepts client `referrerStoreId` and client timestamps through `resolveValidReferrerStoreId()`. Store-member orders remain commissionable, but the server must issue and validate an attribution credential or derive `store_self` from membership. |
| FZ-P0-02 payment state resurrection | Confirmed | `markOrderPaidAndEnqueue()` updates any order whose `payment_status` is not paid to paid/pending shipment, without checking cancelled, closed, refunding, or refunded business states. A paid-after-cancel state is required. |
| FZ-P0-03 finance snapshot overwrite | Confirmed | reward persistence deletes and recreates `reward_records`; several settlement and reward paths read complete collections and save mutated snapshots. MySQL paths must use targeted transactional inserts/conditional updates and immutable chargebacks. |
| FZ-P1-04 session/logout/order ownership | Confirmed | user logout only exists for the admin session. New orders still persist raw `user_token`, and order ownership has legacy OR matching across token/openid/phone. New writes and primary reads must use internal `user_id`; legacy reads remain temporary compatibility only. |
| FZ-P1-05 idempotency scope | Confirmed | `order_request_keys` is keyed only by request key and has no user/operation/body hash scope. |
| FZ-P1-06 partial refund | Confirmed | refund success handling is order-level and invalidates complete reward/settlement sets. There is no authoritative `refund_items` quantity ledger. Implement item snapshots and cumulative integer-cent refund limits; legacy orders remain whole-order/manual-review only. |
| FZ-P1-07 promotion table rewrite | Confirmed | `savePromotionRelations()` executes `DELETE FROM promotion_relations` before rebuilding the table. Binding must become a locked, single-row insert with a unique invitee constraint. |
| FZ-P1-08 proxy/rate/upload | Partially confirmed | `clientIp()` trusts arbitrary `X-Forwarded-For`; rate limits are in-memory. Upload size checks exist, but request buffering and concurrency budgeting need review. Trust only configured proxies and add bounded upload concurrency. |
| FZ-P1-09 storage fail-open | Partially confirmed | MySQL is optional and JSON fallback is automatic when `mysql2` is unavailable. Production must fail closed; JSON must require explicit development configuration. `package-lock.json` is currently ignored. |
| FZ-P1-13 quantity/inventory | Confirmed | products have a string stock field but no inventory mode, item snapshot ledger, transactional stock lock, or consistent strict quantity validation. |
| FZ-P2-10 public product DTO | Confirmed | normalized public products include `costPrice`, reward values, model source and authorization details. Public DTOs must exclude these fields and hidden products. |
| FZ-P2-11 pickup code | Confirmed | the six-character alphanumeric format is correct, but generation uses `Math.random()` and no database unique constraint is present. Preserve historical codes and switch new codes to cryptographic sampling with collision retry and uniform public errors. |
| FZ-P2-12 admin hardening | Confirmed | production serves `/test`; explicit CSP, frame protection, referrer policy, and MIME sniffing protection are absent. Apply compatible headers and disable test routes in production. |

## Business calibration

- Store members (`owner`, `manager`, `staff`, legacy `clerk`) may generate
  legitimate `store_self` commission only when server membership and store
  context prove the attribution.
- External customers require a server-issued attribution or an existing
  server-side visit that can be migrated safely.
- Store commission and pickup service fees remain independent ledgers.
- Partial refunds are item/SKU/quantity based. Pickup service fees are not
  automatically reduced by a normal partial merchandise refund after a valid
  pickup service was performed.
- Pickup codes remain six uppercase alphanumeric characters; ambiguous
  characters may be excluded only for newly generated codes.
- Production is MySQL-only and fail-closed. JSON remains an explicitly selected
  local-development mode.

## Safety and migration strategy

1. Add forward-compatible tables and columns without rewriting historical rows.
2. Keep old mini-program authentication inputs as read-only compatibility, but
   never persist new raw tokens or trust client attribution.
3. Treat historical orders without item snapshots as safe whole-order/manual
   refund cases.
4. Run production anomaly checks read-only before any corrective data action.
5. Do not auto-cancel historical commission, create historical chargebacks,
   mutate real inventory, or re-submit refunds.
