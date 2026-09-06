# Onboarding Plan – First-Run Experience

Plan for making OmniFiles usable by people who are not rclone users.
As of: 2026-09-04 · Phase 3 of the onboarding work.

---

## Context

Onboarding has two walls.

- **Wall A – Distribution.** *Solved.* OmniFiles is [published on the Chrome
  Web Store](https://chromewebstore.google.com/detail/omnifiles/bdcjbkaghidiffifjhiklniadlfgdipo)
  (v0.2.0, listed 2026-08-08), so installing no longer requires developer mode.
- **Wall B – Authentication.** *Open.* Google Drive, OneDrive, Dropbox and
  Google Photos still require the user to run `rclone authorize <backend>` on a
  desktop computer and paste the resulting JSON. See the OAuth Gateway item in
  [ROADMAP.md](ROADMAP.md).

This document covers the work *between* those two: once someone has installed
the extension, how do they get from a fresh install to a working mounted drive?

**Scope boundary, stated plainly:** this phase cannot on its own deliver
non-technical onboarding. A perfect welcome flow still ends at "now go run
`rclone authorize` on a desktop". The only backends that skip that step (S3,
Crypt) are the ones non-technical users do not have. This phase raises the
ceiling; Wall B is what removes the floor. It is still worth doing first,
because it settles the UI shape that the eventual one-click Connect button has
to land in.

---

## The current first run

Traced against the code, for someone installing from the Web Store:

1. **Nothing happens on install.** `chrome.runtime.onInstalled`
   (`src/background.js`) only creates the 15-minute health-check alarm. No tab,
   no notification, no prompt.
2. **There is no toolbar button.** `manifest.json` declares no `action`, so the
   icon sits in the puzzle-piece overflow menu. Reaching the settings page means
   knowing to look there and then right-clicking → Options.
3. **The options page opens on the Dashboard** (`src/options.html`), which for a
   new user is empty.
4. **The empty state gives wrong advice.** `dash_no_mounts` reads *"No active
   mounts found. Mount a remote in ChromeOS to see it here."* Mounting has been
   automatic since the `chrome.storage.onChanged` auto-mount listener landed
   (`src/background.js`) — saving a remote mounts it. What the user actually
   needs is to *add a remote*, which the screen never says.
5. **Two tabs do the same job.** "Add New Remote" and "Guided Setup" share the
   same description string (`wizard_desc`). Nothing tells a newcomer which to
   pick.
6. **Then Wall B.**

### Already built — do not rebuild

- Auto-mount on config save. The Files-app *Add new service* step is optional.
- The schema-driven Guided Setup wizard, with per-provider fields.
- Connection Test before saving.
- Config import/export.
- Auto-obscure for passwords.

Most of this phase is **routing users into machinery that already exists**, not
building new configuration UI.

---

## Decisions

### 1. How the user reaches setup after install

| Option | Cost | Notes |
|---|---|---|
| **A** – `onInstalled` opens a setup tab | ~5 lines | Must be gated on `details.reason === 'install'`. Firing on `'update'` as well would spawn a tab on every auto-update — user-hostile, and a Web Store review risk. |
| **B** – Add an `action` (toolbar button) with a small popup: mount status + "Add cloud" | ~half a day | Fixes *ongoing* discoverability, not just first run. Also gives the extension a visible home. |
| **C** – Both, staged | — | **Chosen.** A first, B as a follow-up release. |

A and B solve different problems: A fixes minute one, B fixes day thirty.
Neither substitutes for the other.

> **Implementation note (2026-09-04).** A is done. No deep link was needed:
> with no remotes configured the options page already opens on Guided Setup
> (decision 4), so `chrome.runtime.openOptionsPage()` lands in the right place
> on its own. The `?setup=1` parameter sketched in decision 2 was therefore
> never built.
>
> The `'install'`-only gate lives in `config-utils.js` as
> `shouldOpenSetupPage()` rather than inline in the listener, because it cannot
> be verified in a browser harness: an unpacked extension loaded with
> `--load-extension` reports `reason: 'install'` on **every** launch, with
> `previousVersion: null`, even after a version bump on the same profile
> (measured, not assumed). Extracting it puts the gate under unit test instead.

### 2. Dedicated welcome page vs. reusing the options page

- **A** – Reuse `options.html`, deep-linked to Guided Setup (e.g.
  `options.html?setup=1`), with the Dashboard suppressed until a remote exists.
- **B** – A separate `welcome.html` with its own narrative flow, handing off to
  the options page afterwards.

**Chosen: A.** There is already a duplicate-configuration-surface problem
(decision 3). Option B would create a third surface, and the two would drift
apart — which is exactly how the wizard/guided split happened in the first
place. Revisit B only if the welcome flow later needs content that would bloat
the options page (a video, a provider comparison table).

### 3. Collapse the overlapping add-flows

"Add New Remote" and "Guided Setup" overlap. Guided Setup is the better fit for
non-technical users: a stepper, per-provider fields, and Connection Test built
in.

- **(a)** Remove the "Add New Remote" tab.
- **(b)** Demote it to an "Advanced add" entry.
- **(c)** Merge its features into Guided Setup.

**Chosen: (a)**, with raw INI editing remaining available under *Advanced*. Two
routes to one outcome is worse than one good route, and collapsing them halves
the surface that the future Connect button has to be threaded into.

> **Correction (2026-09-04, during implementation).** Option (a) as written
> above would have broken editing. The `tab-wizard` pane is not only the "Add
> New Remote" form — `editRemote()` in `options.js` reuses it as the **edit**
> form, populating it from the selected remote and revealing obscured
> passwords. Deleting the pane would have removed the only way to change an
> existing remote's settings.
>
> What was implemented instead, keeping the intent (one *add* route in the
> nav): the **nav entry** was removed, and the pane was kept as an edit-only
> surface reached from the Edit button in Manage Remotes. Its heading now reads
> "Edit Remote" rather than "Add New Remote" (new `tab_edit` / `edit_desc`
> keys; the now-dead `tab_wizard` and `nav_add` keys were dropped). Since the
> pane no longer has a nav entry to highlight, `editRemote()` keeps **Manage
> Remotes** active — where the user came from and where saving returns them —
> and Cancel now returns there too, rather than leaving the user parked on a
> cleared form with no way back.
>
> A flat form is also the better shape for editing: walking a 4-step stepper to
> change one field would be worse than what exists today.

### 4. Conditional landing tab

- No remotes configured → open **Guided Setup**.
- Remotes exist → open **Dashboard** (current behaviour).

Plus an empty state that offers the action instead of describing the absence:
"Add your first cloud", with a button that switches tabs.

This is the cheapest meaningful win in the phase.

### 5. Localize the first-run screens

The Dashboard render path hardcodes English (`Storage:`, `Type:`,
`Active Uploads:`, `Loading dashboard data…`, the empty state) even though every
one of those strings already exists — translated — in
`src/_locales/{en,de}/messages.json` as `dash_storage`, `dash_type`,
`dash_uploads`, `dash_loading`, `dash_no_mounts`, `dash_na`.

German is one of only two shipped locales, and the Dashboard is the first screen
anyone sees. Wiring these up is a bug fix, not a feature. *(Done — see the
2026-09-04 entry in [CHANGELOG.md](CHANGELOG.md).)*

### 6. Relationship to Wall B

Three ways to sequence against the OAuth work:

- **(a)** Ship this phase first; it is independent.
- **(b)** Do the OAuth work first, so this phase has something good to show.
- **(c)** Ship this phase now, designed with a per-provider slot the Connect
  button drops into later, and label providers honestly in the picker —
  "1-click" vs. "needs a desktop step".

**Chosen: (c).** It is honest with users, it is real progress, and settling the
UI shape first de-risks the OAuth work.

---

## Sequencing

Every item ships through Web Store review, so these should land as **one
release**, not five.

1. Dashboard i18n wiring + empty-state copy *(bugs — done 2026-09-04)*
2. Conditional landing tab (decision 4) *(done 2026-09-04)*
3. Collapse the duplicate add-flow (decision 3) *(done 2026-09-04 — see the correction under decision 3)*
4. `onInstalled` setup tab, gated on `'install'` (decision 1A) *(done 2026-09-04)*
5. Provider picker with honest per-provider difficulty labels (decision 6c)
6. *(follow-up release)* Toolbar `action` + popup (decision 1B)

Items 1–5 are roughly one to two days of work.

---

## Constraint: this cannot be measured

There is no telemetry, and [PRIVACY_POLICY.md](../PRIVACY_POLICY.md) explicitly
promises none. So this phase is designed on judgement rather than funnel data —
and that trade is worth keeping. Adding analytics would require a privacy-policy
change, a consent flow, and a Web Store data-disclosure update, which costs more
than it would teach at the current user count.

Use GitHub issues and Web Store reviews as the feedback channel instead.
