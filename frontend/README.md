# ThingsAlive — Telematics IoT OS

Industrial IoT and telematics management console for onboarding devices, mapping sensors to
equipment, and monitoring fleet telemetry across client plants.

The console is multi-tenant: **Master Admin** (ThingsAlive) creates and oversees every client,
while each client's own **Super Admin** manages its people, roles, plants, devices, and
equipment — fully isolated from every other client. This document describes every screen as it
behaves today, including which pieces are fully wired up and which are still demo/mock stubs.

## Tech Stack

- React 19 + TypeScript
- Vite 6
- Tailwind CSS v4
- Motion (animation)
- Gemini API (`@google/genai`) for AI-assisted onboarding and alerting

## Getting Started

**Prerequisites:** Node.js

1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Roles

| Role | Logs in as | Sees |
|---|---|---|
| **Master Admin** | Hardcoded platform credential (`thingsalive.admin`) | Every client, cross-client dashboard, full Administration hub, Platform Users, all clients' Users |
| **Client Super Admin** | An individual person, created automatically with the client | Only their own client's dashboard, devices, equipment, and alerts — plus Client Users & Roles for their own client |
| **Client User** (custom role) | An individual person, added by their Super Admin | Whatever pages their assigned role grants — a subset of Dashboard / AI Onboarding / Alert Agent / Administration / Settings |

Every client is a fully isolated tenant: plants, devices, and equipment carry a real client id,
and one client can never see another's fleet, users, or roles. Master Admin alone can see and
manage across every client, including a full override view of any client's Users & Roles.

---

## Authentication & Sessions

- **Login** (`LoginScreen`) takes a Username and Password (both trimmed of whitespace). A
  "Show demo credentials" link reveals the three seeded logins:
  - Master Admin — `thingsalive.admin` / `Admin@123`
  - Client Super Admin, first login — `cemindia` / `Welcome@123`
  - Client Super Admin, already set up — `beml` / `BEML#2026`
- Login is per-person: each individual is a `ClientUserItem` record scoped to one client, with
  their own username/password and an assigned role. There's no more "one shared login per
  tenant" — creating a client automatically creates its first person, that client's Super Admin.
- Master Admin's password is stored in `localStorage` once changed, so a reset via Settings
  survives a page reload.
- Login is case-insensitive on username, exact-match on password. A deactivated user, or a
  client whose account itself has been deactivated, is rejected with a clear reason.
- **First login / forced reset**: every new person is created with `mustChangePassword: true`.
  Logging in routes straight to a **Change Password** screen (new password ≥ 8 characters,
  must differ from the temporary one, must match confirmation) before the dashboard is reachable.
  A Super Admin (or Master Admin, for support) can force this again via **Reset Password**.

## Dashboards

**Master Admin Dashboard**
- Filters: Time Range (All Time / Last 7 Days / Last 30 Days) and Status (All / Completed /
  In Progress) — these filter the activity feed only, not the KPI cards.
- KPI cards: Total Clients (+ active count), Total Devices (+ online count), Total Equipment
  (+ onboarded count), Onboarding Sessions (+ equipment mapped). Sees every client's data.
- **Analytics**: a "Device Connectivity by Client" stacked bar (online vs. offline devices per
  tenant) and an "Equipment Status Across Fleet" bar (Active / Under Maintenance / Idle),
  computed live from the current client/device/equipment state — not canned data.
- Recent Onboarding Activity: session name, status badge, sites, equipment, last-updated time.

**Client Dashboard**
- KPI cards: Fleet Health Index (% devices online), Active Equipment (click-through to
  Equipment), Online Telematics (click-through to Devices), Active Diagnostics (offline-device
  count and the first offline device's name). Scoped to that client's own fleet only.
- Industrial Telemetry Streams — a live-styled feed of the first six devices (name, status,
  plant, tool profile, last ping).
- System Health panel — static OS/protocol/database status tiles.
- **Analytics**: the same two chart components as the Master Admin dashboard, scoped to this
  client — "Device Connectivity by Plant" and "Equipment Status" — both computed from the
  client's own real device/equipment data.

## AI Onboarding

A chat-driven setup wizard ("Let's set up your assets.") with an 8-step checklist that advances
as you type: Selecting Device → Selecting Equipment → Mapping Device & Equipment → Onboarding →
Data Validation (Communication) → Configure Alerts → Assign User Access → Done.

- Four quick-action prompts: Assets, Ask anything, Auto-alerts, Reports.
- The chat is a heuristic keyword matcher, not full NLP — it looks for "\<number\> \<thing\>"
  phrases to update equipment counts, alert-related keywords (alert/threshold/notify/warn) to
  activate the alerts step, and wrap-up phrases ("that's it", "done", "finish") to advance steps.
- "I will set it up myself" skips straight to the manual admin forms.
- **Onboarding sessions list**: search, status filter, and a table with a per-session QR code
  (a deterministic pixel pattern for printing a label, not a real QR encoder), an active/inactive
  toggle, and edit/refresh actions.
- **Equipment detail view** currently renders a fixed sample equipment record (engine status,
  fuel consumption, error codes, a placeholder map) rather than the equipment actually selected.

## Alert Agent (Workflow Builder)

- **Alert Agent list**: search, status filter (Deployed / Draft / Disabled), and a table of rules
  (name, description, status, sensors, conditions). Rule data here is a fixed demo set, not yet
  wired to what the AI Assistant actually generates.
- **AI Assistant**: a free-text prompt box ("Notify me if pump energy consumption spikes above
  55kWh in a 1 hour window" is one of the built-in examples) plus 3 example prompts, 3 workflow
  templates, and 8 saved drafts. A prompt that parses into concrete sensor/threshold conditions
  opens directly in the Workflow Editor; a vaguer prompt shows a 5-step "Building Your Alert"
  checklist instead.
- **Plain-English parsing** (`workflowParser.ts`) understands:
  - Comparisons: "above / exceeds / more than / greater than" → `>`; "below / less than / under"
    → `<`; "spikes / increases / drops / decreases by N" → `=`.
  - Guards: "ignore it when \<field\> is on/off/true/false" → a guard clause on the workflow.
  - Schedules: "every N minutes/hours/days" (defaults to every 5 minutes).
  - Actions, by keyword: **Webhook**, **Email**, **SMS** — defaults to Webhook + Email if none
    are mentioned but conditions were found.
  - Logic gate: AND by default, OR only if "or" appears before "and" with 2+ conditions.
- **Workflow Editor**: a node-graph canvas — Schedule (trigger) → Read Sensor → Condition →
  optional Guard → AND/OR logic gate → one node per action (Webhook / Email / SMS). Toolbar has
  Validate, Test Rule, Save, and Update (deploy); a node palette on the left (Triggers, Data,
  Logic & Processing) is present but drag-to-canvas isn't wired up yet.

## Administration

Master Admin sees all eight sub-tabs, in order: **Industry Type · Clients · Plant · Category ·
Sensor · Tool Mapping · Devices · Equipment**. A client role (with `admin` granted by their role)
sees only **Plant · Devices · Equipment** — the platform catalog (Industry Type, Category,
Sensor, Tool Mapping, Clients) stays Master-Admin-only, and every list/create form is scoped to
that client's own fleet, with the Client picker locked to their own account.

**Industry Type** — Name*, Code* (auto-uppercased), Active/Inactive toggle. Card grid shows
code badge, created date, and status. *(Master Admin only.)*

**Clients** — creating a client captures Client Name* (auto-slugifies into a Username you can
still edit), Contact Person Name*, Phone*, Email* (validated), Username* (must be unique across
every client's users), and an auto-generated 10-character Temporary Password (regenerate +
copy-to-clipboard). This also creates that client's first person — its **Super Admin** — with a
built-in, non-deletable Super Admin role granting every page. New clients always start `Active`
with a forced password change on first login. Editing a client can't change its password — use
**Reset Password** on the card instead (this resets the Super Admin's password specifically). A
key-icon **Manage Access** button on each card opens that client's Users & Roles screens with
full Master Admin edit access. *(Master Admin only.)*

**Plant** — Client* (required — a plant always belongs to one client, and carries a real
`clientId`), Plant Name*, Location, Plant Code, Active toggle. Cards show equipment count and
the owning client.

**Category** — Category Name*, Category Code*, Engine Type* (Diesel, Electric Drive, Hybrid,
CNG, Dual Fuel, Hydraulic Direct Drive, Liebherr 6-Cylinder Diesel), Fuel Tank Capacity (L),
Description, Active toggle. Used to pre-fill engine type and tank size when adding equipment.
*(Master Admin only.)*

**Sensor** — Sensor Category, Sensor Name (auto-snake-cased into an id), and a repeatable list
of Telemetry Parameters (Parameter, Unit, Min, Max, Normal Range, Notes). Detail view shows the
full parameter table plus created/updated dates. *(Master Admin only.)*

**Tool Mapping** — Tool Profile Name*, Industrial Domain, then a full checklist of every sensor
in the catalog — toggle a sensor on and its individual telemetry parameters become toggleable
too. A live counter shows "N Sensors • M Parameters Active." Filterable by industry (Cement &
Building Materials, Transport, Automotive, Power & Energy). *(Master Admin only.)*

**Devices** — "Add Device" or "Setup with AI." The setup form takes Client* (locked to their own
account for a client role), Tool Name* (from Tool Mapping — this becomes the device name and
auto-loads its sensors), IMEI / Hardware Serial Number*, and Plant* (filtered to that client's
plants). If no tool profile is matched, you get a manual sensor picker and a Communication
Protocol choice (MODBUS TCP, CAN Bus/J1939, MQTT, TLS, RS-485 Modbus RTU). List shows IMEI,
client, and an Online/Offline badge; devices can be decommissioned (deleted).

**Equipment** — Client*, Maintenance Plant* (filtered by client), Equipment Name*, Description*,
Category* (auto-fills engine type and fuel tank size), optional Device (auto-shows its mapped
sensors), CCL Number*, plus Manufacturer, Model Number, Serial No, License Plate, Engine Power.
New equipment always starts `Active` / `Onboarded`. Filterable by status (Active / Under
Maintenance / Idle) and onboarding status.

## Client Users & Roles

Reachable from a client's Sidebar (Super Admins only) as **Client Users** and **Roles &
Permissions**, or by Master Admin via **Manage Access** on a client's card — same two screens,
with a "Master Admin view" banner and a link back to Clients.

**Client Users** — add a person with Name*, Username* (unique across every client), Role*
(select from that client's roles), and an auto-generated temporary password; new users always
start with a forced password change. Each row shows the person's role and an "Awaiting Login"
badge until their first sign-in; the Super Admin row is marked with a crown and can't be deleted.
Actions: reset password, edit, delete (Super Admin excepted).

**Roles & Permissions** — define a named role (e.g. "Plant Manager", "Viewer") and check which
pages it grants: Dashboard, AI Onboarding, Alert Agent, Administration (Plant/Devices/Equipment),
Settings. Every client keeps one built-in **Super Admin** role with every page, which can't be
edited or deleted; a custom role can't be deleted while any user is still assigned to it.

## Users (Master Admin)

Two sub-tabs:

- **Platform Users** — the original ThingsAlive-side staff directory, unchanged: Employee ID*
  (unique), Username* (unique), Email*, Role* (**Operational, Executive, Support, Admin, Super
  Admin**), Phone*, Active toggle; stat cards, search, role filter, sortable columns, CSV export.
  "Upload Bulk Users" is present in the UI but not wired to anything yet.
- **Client Users** — every person across every client in one table (Name, Username, Client,
  Role, Status), with search, a Client filter, and a **Manage** button per row that jumps into
  that client's full Users & Roles screen.

## Settings

One screen, the same shape for every role:

- **Account Information** (read-only): name, username, role badge, and — for a client user —
  their organization name, live account status, and "client since" date; Master Admin instead
  sees "Access Level: All Plants & Clients."
- **Change Password**: current / new / confirm password, with the same 8-character-minimum and
  must-differ rules as the forced first-login flow.

## Ask AI Widget

A floating assistant available on every screen, plus a separate "?" button that opens a
product-guide modal. Both use the app's own design language (rounded chat bubbles, avatar
icons, a typing indicator, gradient trigger button) rather than the earlier boilerplate theme.
A header toggle expands the chat window to a larger reading size and back to normal.
The chat currently answers from a small set of canned replies matched by keyword (e.g. "offline"
→ a fixed reply about one specific device, "dust"/"sensor" → a fixed sensor reply) rather than
reading the fleet's actual live data — treat its answers as demo content, not real-time
telemetry.

## Current Limitations

This build has no backend: session, client, user, role, and catalog data all live in the
browser's `localStorage` / `sessionStorage`, seeded from `src/data/mockData.ts`. A few pieces
are intentionally non-functional placeholders: workflow-canvas drag-and-drop, onboarding QR
codes, "Upload Bulk Users," and the Ask AI widget's live-data awareness — none of these read or
write real app state.
