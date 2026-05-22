# Requirements - Quick Prototype Sprint

## Project: ProjexCloud

The single canonical architecture: a shared horizontal platform — services, agents, contracts, design system, native SDK ecosystem (HDK), and the AIM (Application & Identity Management) foundation — consumed by every vertical we build. Builds once. Multi-tenant. Multi-vertical. Multi-app. Multi-surface (web · mobile · kiosk). Petabyte-scale via pool-based horizontal scaling (no sharding). Identity expressed as a six-layer stack — Master Person · App Identity · Tenant Membership · Persona · Encounter · Relationship — encrypted end-to-end and governed by a three-evaluator access mesh.

## Sprint Overview

Prototype structure for nextjs + fastify + postgresql MVP focused on auth, vault key management, routing, and audit chain.

## Epics

### Vault & Secrets SDK

Typed KMS facade, 7-tier key hierarchy, envelope encryption helpers, and secret lifecycle ops for the MVP.

### Core MVP: Authentication, Pool Routing & Event Contracts

Provides user identity, tenant/app pool routing, event envelope handling, and an emit-only meter gate to enable end-to-end user flows for the MVP.

### Audit & Telemetry

Append-only audit ledger, tamper-evident hash chain, and a universal emit-only meter gate for basic telemetry.

## Features

### 7-Tier Key Hierarchy

Implement the canonical 7-tier key hierarchy and cryptographic shred operations.

**Acceptance Criteria:**
["Key tiers can be created and linked","Shred renders keys unrecoverable","Key metadata persisted"]

### Append-only Audit Chain

Immutable ledger for events with hash chaining.

**Acceptance Criteria:**
["Appends create new ledger rows","Each row contains hash linking to previous","Ledger rows are immutable via API"]

### User Registration & Authentication

Sign-up, login, JWT sessions, password hashing, and canonical identity mapping.

**Acceptance Criteria:**
["Users can register with email and password","Registered users can log in and receive a JWT","Password stored hashed and salted"]

## Tasks

### Implement signup endpoint

Create POST /api/auth/register to create users

**Acceptance Criteria:**

### Implement append API

POST /api/audit/append to add immutable entries

**Acceptance Criteria:**

### Create User Registration & Authentication UI components

Build the user interface components for User Registration & Authentication

**Acceptance Criteria:**

### Create 7-Tier Key Hierarchy UI components

Build the user interface components for 7-Tier Key Hierarchy

**Acceptance Criteria:**

### Create Append-only Audit Chain UI components

Build the user interface components for Append-only Audit Chain

**Acceptance Criteria:**

### Design key hierarchy data model

Model 7-tier relationships and parent links

**Acceptance Criteria:**

