# Requirements - Sprint3

## Project: ProjexCloud

The single canonical architecture: a shared horizontal platform — services, agents, contracts, design system, native SDK ecosystem (HDK), and the AIM (Application & Identity Management) foundation — consumed by every vertical we build. Builds once. Multi-tenant. Multi-vertical. Multi-app. Multi-surface (web · mobile · kiosk). Petabyte-scale via pool-based horizontal scaling (no sharding). Identity expressed as a six-layer stack — Master Person · App Identity · Tenant Membership · Persona · Encounter · Relationship — encrypted end-to-end and governed by a three-evaluator access mesh.

## Sprint Overview

## Epics

### P14 · E1 — sdk-sequence: Multi-Touch Cadence Orchestration Engine

New reusable SDK for stateful, multi-touch outreach sequences. Ported from projex_crm's proven engine (outreach-sequence, sequence-step-executor, send-queue, send-window, outreach-orchestrator) into ProjexCloud SDK conventions (Fastify routes + db-runtime + migrationsDir). Fills the gap left by sdk-campaign (v0.1.0, journeys only). Emits sends through sdk-notification adapters. Foundation for InboundCRM cadences.

### P14 · E2 — sdk-scheduling: Calendar, Booking & No-Show Engine

New reusable SDK for meeting scheduling. No calendar SDK exists today (only connectors). Ported from projex_crm calendar.service/booking-notification/followup-scheduling/public-booking: availability slotting with IANA timezones, ICS invites, booking links, reminders, and no-show rescue. Integrates connector-gworkspace/microsoft365 for two-way sync.

### P14 · E3 — sdk-deliverability: Suppression, Bounce & Reply Intelligence

New reusable SDK for email deliverability, complementing sdk-notification (send) and sdk-consent (legal basis). Ported from projex_crm webhook-security suppressionService, bounce-sync workers, inbox-sync and unsubscribe: reason-tagged suppression list, provider bounce/complaint webhook verification (SendGrid/Mailgun/Postmark), IMAP inbound reply sync, and bounce-rate auto-pause.

### P14 · E4 — sdk-crm & sdk-notification Extensions: Inbound Pipeline & Unified Send

Extend existing SDKs rather than duplicate. Enrich sdk-crm (v0.1.0) with funnel/pipeline richness, richer deal fields, stage-aging and mandatory NEXT-action enforcement (from projex_crm funnel.service). Route email send through sdk-notification's existing SES/SMTP/Twilio adapters so email + SMS unify under one transport.

## Features

### Availability & Slotting

Business-hours + IANA-timezone slot generation, double-book prevention, and meeting types (15-min fit / 30-min demo / 30-min decision / 60-min onboarding). Ports calendar.service availability.

### Booking Lifecycle & ICS

Create/confirm/reschedule/cancel bookings, scheduling links, and ICS invite generation + confirmation emails to both parties. Ports booking-notification + followup-scheduling + public-booking.

### Frequency Caps & Circuit Breaker

Per-lead cooldown, max-messages, dedup and circuit-breaker guardrails with an audit log. Ports outreach-orchestrator guard engine.

### Sequence Definition & Enrollment

CRUD for sequences, templates and steps; event-based enrollment (form-submit, reply, stage-change) via triggers. Ports outreach-sequence + sequence-trigger; drops the base-agent registration coupling.

### Step Executor & Send-Window Scheduler

Durable tick loop that advances sequence_execution_steps, gates by send-window/quiet-hours, enqueues sends idempotently, and emits via sdk-notification. Ports sequence-step-executor + send-queue + send-window.

### Reactive Control: pause / stop / replace-CTA

Pause-on-reply, stop-on-opt-out, stop-on-payment, and replace-CTA-on-booking. Cancels queued steps and records reason. Ports sequence-cancellation + reply/booking triggers.

### Reminders & No-Show Rescue

Timed 24h/2h/15m pre-meeting reminders, +10-min no-show detection, and rescue/rebook flow. New behavior beyond projex_crm's confirmation-only reminders.

### Two-Way Calendar Provider Sync

Real Google/Microsoft two-way sync via connector-gworkspace/microsoft365 (replaces projex_crm's simulated sync), with event IDs and reschedule/cancel propagation.

### Suppression List & Opt-Out

Token-based public unsubscribe with reason codes, DNC, and reason-tagged suppression list with pre-send enforcement. Tenant + optional cross-org global scope. Ports unsubscribe + suppressionService.

### Bounce/Complaint Webhook Processing

HMAC-verified provider webhooks (SendGrid/Mailgun/Postmark), hard/soft bounce + complaint classification, and auto-suppression. Ports webhook-security + bounce-sync workers.

### Inbound Reply Sync (IMAP)

IMAP polling with In-Reply-To/References thread-matching, reply capture, and reply events that pause sequences. Ports inbox-sync.

### Deliverability Guard & Reputation

Per-account bounce-rate threshold auto-pause and reputation signals surfaced to callers. Ports the account-level auto-pause logic.

### sdk-crm Pipeline & Deal Enrichment

Extend sdk-crm with configurable funnel stages, richer deal fields (priority, fit, pain/impact/outcome, stakeholders, decision date, offer version, forecast), and stage-aging detection. From projex_crm funnel.service.

### sdk-crm NEXT-Action Enforcement

Model a mandatory NEXT action (type, owner, due-time, purpose, intended outcome) on non-terminal records and a save-gate that blocks save/stage-advance when NEXT is missing.

### sdk-notification Email-Send Routing

Route the ported email-send transport through sdk-notification's existing SES/SMTP adapters (and Twilio for SMS) so sdk-sequence delivers all channels through one notification surface with templates + quiet hours.

## Tasks

### sdk-sequence: schema + migrations (sequences, steps, templates, triggers)

Create db-runtime migrations for sequence.sequence, .step, .template, .execution_step, .trigger, ported/adapted from projex_crm outreach_* tables. Expose migrationsDir.

**Acceptance Criteria:**
- Migrations apply cleanly on boot
- Tables cover steps, templates, triggers, execution state

### sdk-deliverability: suppression list + opt-out tokens (schema + service)

Reason-tagged suppression list, token unsubscribe, DNC; tenant + optional global scope. Port unsubscribe + suppressionService.

**Acceptance Criteria:**

### sdk-crm: funnel stages + richer deal fields + stage-aging (schema)

Extend sdk-crm schema with configurable funnel stages and deal fields (priority, fit, pain/impact/outcome, stakeholders, decision_date, offer_version, forecast); stage-aging support.

**Acceptance Criteria:**

### sdk-scheduling: public booking + confirmation routes

Public unauthenticated booking page endpoints (slug/book) and confirmation flow. Port public-booking.routes.

**Acceptance Criteria:**

### sdk-deliverability: provider bounce/complaint webhooks (HMAC verify + classify + auto-suppress)

SendGrid/Mailgun/Postmark webhook verification, hard/soft/complaint classification, auto-suppression. Port webhook-security + bounce-sync.

**Acceptance Criteria:**

### sdk-sequence: definition & enrollment service + Fastify routes

Port outreach-sequence + sequence-trigger CRUD/enrollment into a Fastify server.registerRoutes surface; drop base-agent coupling. Event-based enrollment (form-submit, reply, stage-change).

**Acceptance Criteria:**

### sdk-sequence: step executor tick loop (send-window gating + idempotent enqueue)

Port sequence-step-executor + send-queue + send-window; durable tick that advances execution steps, respects quiet hours, and enqueues idempotently. Emit via sdk-notification.

**Acceptance Criteria:**

### sdk-sequence: reactive control (pause-on-reply, stop-on-optout/payment, replace-CTA)

Port sequence-cancellation + reply/booking triggers; pause/stop/replace with reason capture and queued-step cancellation.

**Acceptance Criteria:**

### sdk-sequence: frequency-cap + circuit-breaker guard with audit log

Port outreach-orchestrator guard engine: per-lead cooldown, max-messages, dedup, circuit breaker, guard audit log.

**Acceptance Criteria:**

### sdk-scheduling: availability slotting + schema (business hours, IANA tz, meeting types)

Port calendar.service availability with tz math, double-book prevention, meeting types (15/30/30/60). Add scheduling schema (appointments, scheduling_links).

**Acceptance Criteria:**

### sdk-scheduling: booking lifecycle + ICS + scheduling links

Create/confirm/reschedule/cancel bookings; ICS invite generation; confirmation emails to both parties (via sdk-notification). Port booking-notification + followup-scheduling.

**Acceptance Criteria:**

### sdk-scheduling: timed reminders + no-show detection & rebook

24h/2h/15m pre-meeting reminders; +10-min no-show marking; rescue/rebook task creation.

**Acceptance Criteria:**

### sdk-scheduling: two-way Google/Microsoft sync via connectors

Replace simulated sync with real connector-gworkspace/microsoft365 two-way sync; store external event IDs; propagate reschedule/cancel.

**Acceptance Criteria:**

### sdk-deliverability: pre-send suppression enforcement API

isSuppressed/suppress/unsuppress/list surface enforced before every send across channels.

**Acceptance Criteria:**

### sdk-deliverability: IMAP inbound reply sync + reply events

IMAP polling with In-Reply-To/References thread-matching; capture replies; emit reply events that pause sequences. Port inbox-sync.

**Acceptance Criteria:**

### sdk-deliverability: bounce-rate auto-pause + reputation signals

Per-account bounce-rate threshold auto-pause; expose reputation signals to callers.

**Acceptance Criteria:**

### sdk-crm: pipeline/deal service + Fastify routes + stage-aging detection

Port funnel.service pipeline/deal CRUD + board queries + 5-business-day stale detection into sdk-crm.

**Acceptance Criteria:**

### sdk-crm: NEXT-action model + save-gate enforcement

Mandatory NEXT action (type, owner, due-time, purpose, outcome) on non-terminal records; save-gate blocks save/stage-advance when missing.

**Acceptance Criteria:**

### sdk-notification: route sequence email/SMS sends through SES/SMTP/Twilio adapters

Adapter glue so sdk-sequence delivers email (SES/SMTP) and SMS (Twilio) via sdk-notification with templates + quiet hours; unify channels under one transport.

**Acceptance Criteria:**

### sdk-sequence: executor integration tests (send-window, dedup, retry)

Tests for due-step send inside window, deferral outside quiet hours, and no duplicate send on retry.

**Acceptance Criteria:**

