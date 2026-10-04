# Individual Provider Household Support App

Complete requirements and master task system (generic version)

> This is a generic version of the requirements. Names, family details, the specific program and other household-specific facts were replaced with neutral wording; every rule and requirement is kept. Items that depend on a particular household (hours, tasks, schedule, retention choice) are configuration.

## Purpose and household rules

Support the independence of a client who is blind or has low vision, provide a clear workload for the Individual Provider (IP), and document attendance and task activity. A member of the household (the administrator, also acting as case manager) may supply informal support outside IP duties. The same IP normally works at least three visits weekly; six hours is the usual shift length. Administrators set actual daily hours, with a strict maximum of 36 scheduled and authorized hours per workweek.

The client’s choices govern household assistance. Ask before moving personal items, reorganizing belongings, or discarding stored food. Never open mail. Dispose only of packaging or junk material identified as discardable by the client. Maintain the agreed clear walking paths (36 inches wide in the original household; the width is a household setting); return objects to their established places. If an obstruction cannot safely be resolved, report it immediately rather than recording the path as clear.

Assign duties that fit the client’s existing authorized service plan. This app supplements the official attendance and service records of the state or program that authorizes the services; it must not imply that its records replace any required official system.

## Accounts and permissions

| Capability | Client / administrator | Administrator / case manager | Family viewers | IP |
|---|---|---|---|---|
| Own individual login | Yes | Yes | One for each family member | Yes |
| View household task status and history | Yes | Yes | Yes, while authorized | Assigned history and schedule |
| View task timestamps, evidence and reports | Yes | Yes | Yes, as explicitly approved | No task/evidence audit timestamps |
| View own check-in/out and daily/weekly hours | Yes | Yes | Through authorized reports | Yes |
| Manage schedules and task templates | Yes | Yes | No | No |
| Complete assigned tasks | Review/approve; preserve actor identity | Review; preserve actor identity | No | Current authorized shift only |
| Approve/dispute IP completion | Yes | Administrative review/correction | No | Respond with corrective work |
| Confirm client decline or approve food disposal | Yes | No impersonation of client decisions | No | Submit request only |
| Append administrative correction | Yes | Yes | No | Request correction only |
| Grant/revoke family access | Client controls access | Assist with setup | No | No |
| Change original timestamps, events or notes | No | No | No | No |

Family timestamp access is the exception explicitly approved in the later questionnaire. The IP sees simple completion status and attendance totals, not hidden audit data. Enforce this distinction in server responses, downloads, photo metadata and notifications, not merely by hiding interface elements.

## Master every-visit checklist

“Daily” means each scheduled IP visit; unscheduled days do not produce missed-duty alerts. Repeat meal cleanup and final kitchen checks if the apartment becomes dirty again during the shift.

| Area | Separate task | Completion instructions |
|---|---|---|
| Attendance | Check in | Authenticate and verify location; confirm scheduled shift is authorized. |
| Safety | Check walking paths | Clear the agreed walking paths and return objects to known locations. |
| Living room | Gather cups and dishes | Take all dirty dishes to the kitchen. |
| Living room | Gather loose trash | Collect bottles, wrappers and approved mail packaging. |
| Living room | Tidy sitting area | Pick up floor items, straighten immediate sitting area and restore familiar object locations. |
| Kitchen | Gather remaining dishes | Include all dirty dishes throughout the apartment. |
| Kitchen | Hand-wash dishes | Wash all dirty dishes (adjust to the household's equipment). |
| Kitchen | Put clean dishes away | Dry as necessary and return to designated storage. |
| Kitchen | Clean sink | Leave sink/work area clean; require fresh in-app photo before completing the dishes/sink group. |
| Kitchen | Wipe counters | Separate task beside the dish tasks. |
| Kitchen | Wipe stove | Separate task; clean safely after surfaces cool. |
| Kitchen | Wipe table | Separate task beside the dish tasks. |
| Kitchen | Check and store leftovers | Put away food remaining from meals; ask before disposing of questionable food. |
| Kitchen | Wipe microwave | Clean interior spills and accessible surfaces. |
| Kitchen | Sweep floor | Each visit. |
| Meals | Breakfast assistance | Complete the expandable meal workflow below. |
| Meals | Lunch assistance | Complete the expandable meal workflow below. |
| Trash | Check all bins | Kitchen, living room and bathroom; include bedroom bin if present. |
| Trash | Combine and remove trash | Combine appropriate contents until a bag is full. Kitchen trash must leave the apartment before shift end regardless of fullness. Record bedroom emptying if a bin exists. |
| Trash | Replace liners | Immediately replace liners in emptied cans. |
| Trash | Break down boxes | As present; no separate recycling workflow. |
| Bathroom | Wipe sink | Every visit. |
| Bathroom | Wipe mirror | Every visit. |
| Bathroom | Empty/check trash | Apply household consolidation rule and replace any removed liner. |
| Bathroom | Pick up used towels | Place in laundry; return clean towels to shelving outside bathroom. |
| Bathroom | Refill/check toilet paper | Verify available roll and accessible supply before finishing. |
| Bedroom | Pick up clothes | Put in hamper or established storage. |
| Bedroom | Make bed | Every visit; remake after changing sheets. |
| Bedroom | Clean bedside surfaces | Preserve familiar locations of personal items. |
| Floors | Vacuum living room | Each visit, including rugs. |
| Floors | Vacuum bedroom | Each visit. |
| Supplies | Check household supplies | Toilet paper, paper towels, trash bags, dish soap, detergent, cleaning supplies and toiletries. |
| Safety | Final walkthrough | Recheck paths, known object locations, accessible food/drinks, kitchen trash and unresolved tasks. |
| Attendance | Check out | Fresh location verification; show hours and unresolved items. |

### Breakfast and lunch: expandable checklist

1. Ask the client what they would like; respect their choice.
2. Retrieve delivered food, heat a meal, or prepare the selected meal as needed.
3. Prepare the requested beverage.
4. Put food and drink in a familiar, accessible location; tell the client where they are.
5. Record the meal served and any confirmed low/finished ingredients.
6. Store leftovers appropriately.
7. Gather used dishes and clean preparation surfaces.

Client may decline assistance. An IP-entered decline remains “Awaiting client confirmation” until the client confirms or denies. Declining a meal must not require completing meal-preparation subtasks. No dietary restriction has yet been identified; allow the client/admin to record restrictions before use.

## Weekly and as-needed work

Assign these to actual scheduled visits rather than assuming Monday/Wednesday/Friday. Suggested distribution: first visit—laundry/bedding; second—bathroom deep cleaning; third—floors/food review. Administrators may distribute them differently to fit assigned hours. Never treat this distribution as permission to exceed a shift.

| Frequency | Task | Details |
|---|---|---|
| Weekly | Complete laundry | Gather, sort, wash and dry in the household's laundry location; fold/hang and put away. Track each stage separately. |
| Weekly | Wash towels and bedding | Wash, dry, fold and return to known locations. |
| Weekly | Change sheets | Remove dirty sheets, install clean sheets and remake bed. |
| Weekly | Clean shower/tub | Complete scheduled cleaning. |
| Weekly | Clean toilet | Separate task. |
| Weekly | Mop bathroom | Coordinate with bathroom deep cleaning. |
| Weekly | Mop kitchen | Optional completion photo. |
| Weekly, proposed default | Review refrigerator | Identify questionable food and start approval requests. Frequency remains admin configurable. |
| Monthly, proposed default | Mop exposed hardwood | User allowed weekly or monthly; start monthly and make frequency adjustable. Preserve rugs/furniture locations and safe footing. |
| As needed, immediate | Clean spills/sticky areas | Record unusual cleanup; optional before/after photos. |
| As needed | Break down new boxes | Keep pathways clear. |
| As needed | Put groceries/supplies away | Return to established accessible locations; IP grocery shopping is outside current scope. |
| As needed | Client-requested task | Notify IP immediately; offer “View now” or “Acknowledge.” Validate against available shift time and authorized duties. |

No dusting is assigned. Do not automatically add blanket bathroom-counter or daily-toilet cleaning; those were not selected.

## Task states and review workflows

States: Not started; In progress; Completed—awaiting review; Approved; Disputed; Corrective work submitted; Declined—awaiting confirmation; Client declined—confirmed; Not needed; Unable to complete; Missed at shift end.

Require a reason for Not needed and Unable to complete. Available reasons include supplies unavailable, insufficient time, equipment problem and Other; Other requires text or dictated explanation. Client decline is its own confirmation workflow. An unconfirmed decline is unresolved, not completed or accepted.

The client sees Approve, Dispute and Review Later. A dispute supports typed/dictated reasons and immediately notifies the IP. Corrective work may be submitted only while an authorized shift remains active. Preserve the original completion, dispute, corrective submission and final approval as separate events. After checkout, unresolved work carries to an admin-approved later shift; no backdating.

IP mistakes use “Report completion error.” Administrators append a correction with reason and linked original event. IP notes and supplemental notes are append-only. Material schedule/task edits retain their previous version and must never erase missed work retroactively.

## Scheduling and the strict hours limit

Administrators can manually choose days, create recurring schedules, set each day’s start/end and mark not scheduled, vacation, sick, or client unavailable. Reject overlapping shifts and schedules above 36 hours per configured workweek. Proposed default workweek: Monday 12:00 a.m. to next Monday 12:00 a.m. in the household's configured timezone (this build defaults to America/Chicago); align to the workweek the authorizing program uses during setup. Version workweek changes prospectively.

Six hours is a usual shift, not a universal daily cap: the admin-set daily window controls. Early check-in attempts are logged and flagged but do not start authorized time. A late check-in does not automatically extend the scheduled end. Reject unscheduled/future check-ins and all future task completion. Previous/future lists remain readable but historical work cannot be changed by the IP.

The server calculates the earliest of scheduled end and remaining weekly allowance. At that boundary it closes authorization, disables task submissions and issues immediate app/SMS/email alerts. A server job must enforce this even if the phone is asleep or disconnected. No admin override may authorize more than 36 hours under this configuration. Atomic transactions prevent concurrent devices/check-ins from bypassing the cap.

Preserve both authorized duration and observed check-in/check-out events. If the IP stays past the boundary, record the later checkout and flag the excess immediately; never silently shorten the observed record or pretend that the IP departed at automatic closure. Automatic closure means “authorized window ended,” not “verified physical departure.” A forgotten checkout must appear as missing, not as fabricated attendance. Any reported excess or unverified work is a separate exception; this app cannot physically prevent someone from continuing to work.

Checkout always remains available to record departure, including after authorization expires or GPS fails. Record failed location verification separately and alert administrators. Alerts near shift end should identify remaining required tasks; proposed lead time is 30 minutes. Early/late notification tolerance is configurable; proposed default is 10 minutes, without extending authorized time.

## Location and evidence

Use a 200-foot (60.96-metre) geofence around the configured apartment. Capture a fresh location at check-in, checkout and required photo submission, plus periodic checks during an active shift. Proposed periodic target: every 45 minutes within the approved 30–60-minute range. Disclose collection to the IP; stop periodic collection when the shift ends. Do not display a continuous movement map.

Store location observation time, server receipt time, coordinates, reported accuracy and verification result. A stale or imprecise fix must be “Unverified,” not automatically accepted. GPS failure blocks normal check-in and offers “Location verification problem,” notifying admins. Any admin exception must have a separate actor, reason and timestamp and remain visibly unverified. A missing periodic reading is not proof of absence. GPS indicates the phone’s reported location; it cannot prove the IP’s identity, presence or honesty and may be spoofed.

Android restricts background location updates. Reliable periodic collection requires a mobile implementation with appropriate permissions and lifecycle handling; a browser-only app must not promise quiet, uninterrupted background checks. Missing updates generate review alerts, not invented coordinates. Validate behavior on the actual IP phone before deployment.

Require in-app camera capture for dishes/sink evidence; disable gallery/file selection for this workflow. Optional photos: folded/put-away laundry, kitchen mopping and unusual cleanup. Bind each capture to the authenticated user, active shift, task and one-use server capture challenge. Record server upload/acceptance time separately from task completion time; neither should be represented as an independently proven camera shutter time. Store a content hash and immutable evidence reference; strip unnecessary embedded metadata from viewer copies. A hash protects integrity, not factual truth, and in-app capture reduces reuse without eliminating deception.

Do not complete the required dishes/sink task until evidence is accepted by the server. Offline photos/notes can be drafts, but offline task completion must not appear verified or backdated. Show pending/failure clearly. Avoid capturing people, mail or sensitive personal materials unnecessarily; use text descriptions to make photos useful to the client.

## Food disposal and shopping list

IP enters item, exact location, reason, expiration/date label where relevant, photograph and proposed replacement. Send approval request directly to client phone; admin can see it. Client approves or declines. Only then may ordinary disposal occur, and the IP records actual disposal. If no response, leave in place and notify the administrator with photo/location. Immediate obvious hazards use an explicit exceptional event with reason, action taken and prompt client/admin notification; no silent approval assumption.

Keep a disposal history with item, date label/reason, request, decision, actor and disposal event. Add regularly stocked discarded items to shopping list after actual disposal, merging duplicates. Low supply reports automatically add items and notify the client and administrator. Meal logs may suggest low groceries, but automatic quantities require reliable starting counts, servings and ingredient quantities. Without those inputs, ask “Was this the last of the eggs?” instead of inventing inventory.

Shopping list supports item, quantity if known, storage location, low/out status and purchased/restocked acknowledgment. There is no assigned IP shopping duty.

## Screen design and accessibility

IP home: Today’s date; scheduled window; authorization status; check-in/out action; required tasks grouped by room; scheduled weekly tasks; client requests; unresolved disputes; shopping/supply reporting. Each task expands to apartment-specific instructions, subtasks, evidence, notes and exception options. Show daily/weekly attendance totals, but no hidden task timestamps.

Client home: Today’s status; “Hear today’s completed tasks”; “Hear what is left”; approval/dispute queue; food requests; request a task; shopping list; attendance and reports. “What was completed today?” first asks whether the user would like the list read aloud and accepts Yes/No. Voice approvals name the request and ask confirmation before acting.

Admin home: Assigned/completed/approved/declined/unable/missed totals; check-in, last activity, checkout; authorized and observed hours; weekly allowance; GPS/evidence status; alerts; schedule; task templates; history and correction tools. Show text status alongside visual highlighting. Family home provides authorized read-only summaries, evidence and history, without action controls.

Support TalkBack on Android, VoiceOver where iOS access is provided, keyboard navigation, voice commands and typing/dictation. Include high contrast, very large text, visible focus, generous touch targets, semantic headings, explicit field/button names, accessible errors and status announcements. Never convey meaning only by color or icons. Test maximum text scaling without clipping. Spoken notifications are optional and controllable to avoid interrupting screen-reader speech.

Voice commands: What’s left today? What was completed today? When did the IP check in? How many hours this week? Read my shopping list. Approve this request. Dispute this task. Provide equivalent visible controls; microphone refusal or recognition failure must not block use. Review dictated text before submission.

## Audit integrity and security

Every event records unique ID, household, actor, role, task/shift reference, action, server UTC timestamp, household timezone/local rendering, linked previous event and relevant evidence. Display minutes; retain finer precision internally to detect bursts and event ordering. Use the household's configured timezone rules (this build defaults to America/Chicago) rather than a fixed UTC offset.

Server-assigned timestamps and server-side authorization are mandatory. No ordinary account, including client/admin, can edit/delete originals. Append-only database permissions are insufficient by themselves against infrastructure administrators: archive events/evidence to independently controlled, retention-locked storage, restrict privileged access, log privileged operations, preserve backups and verify integrity. Hash chains support detecting alteration but need an independently retained reference. Protect encryption keys and test restoration.

No system can promise “unalterable no matter what” against every infrastructure compromise or account destruction. The deliverable is enforced application immutability, retention-locked originals and detectable alteration, with documented limits. Compliance-mode object storage is an example of protection that prevents overwrite/deletion of protected versions during a set retention period.

Individual logins, no shared passwords, secure account recovery, session revocation, and biometric/passkey or app PIN reauthentication for sensitive administrator actions are required. Proposed inactivity defaults: administrative lock after five minutes, authenticated-session expiry after 30 minutes, with accessible warning/extension. Logging out the interface must not silently close a server-side active shift. Audit schedule, task-template, permission, notification and retention-setting changes. Reauthentication must happen at the action, not just at page load.

Protect data in transit and at rest, enforce household scope on every server query/action, restrict evidence downloads, and use minimal personal details in SMS/email. Revoked family accounts lose API access immediately. Test that IP accounts cannot obtain hidden timestamps from alternate endpoints, exports or evidence metadata.

## Alerts and exception detection

Send important notifications through app, SMS and email to configured administrators, with client action requests sent directly to the client. Track delivery/retries and deduplicate alerts. Ordinary completions update the dashboard without individual administrator messages.

Immediate alerts: check-in; failed/outside-geofence verification; IP-claimed client decline; client dispute; food approval request; required tasks unfinished near checkout; early checkout; extra/unauthorized time; suspicious patterns; low supply; completion-error report.

Suspicious patterns include 15 or more task completions in a rolling minute, unusual final-minute bursts, long shifts with little activity, GPS disabled/stale/missing, impossible reported location changes and repeated evidence. Evaluate identical timestamps using full stored precision; displayed minute matches are normal and do not establish wrongdoing. Thresholds are configurable and versioned. Flags prompt review and must never label fraud as proven automatically.

## Reports and retention

Daily, weekly, monthly and custom date-range reports; date search; printable/PDF output; Attendance & Exceptions report for early/late activity, GPS failures, disputes, missed duties, corrections, suspicious flags and excess time. Include report generation time, range, timezone, actor and separate authorized/observed totals.

Report completed, client-approved, confirmed-declined, unable/not-needed and missed counts separately. Completion percentage = submitted completions divided by all assigned required tasks, with disputed completions clearly identified. Also show approved-completion percentage and coverage/resolution counts; do not inflate completion by counting declines as work done. Preserve the assigned-task snapshot so editing templates does not rewrite historical percentages.

Recommended household policy: retain underlying attendance, tasks, notes, evidence, approvals, corrections and administrative events for two years from the event date. This is a product recommendation, not a statement of any program's legally required retention period. One year is the user’s requested baseline, but two years allows comparison across annual cycles and more time to review patterns. Configure retention before go-live; preserve disputed material until its review is resolved and any applicable preservation requirement is addressed. Separate locked archive retention from routine backups; a later policy reduction cannot unlock existing protected records early.

Generated reports should not be stored permanently by the app. Create on demand, use short-lived access and no-store cache controls, delete temporary server copies promptly, and expire leftovers after a short fixed interval because browser-close signals are unreliable. The app cannot remotely erase PDFs that someone downloads, prints, screenshots or retains in a browser. Underlying source history remains available for regeneration until retention expires.

## Acceptance requirements before real use

1. IP cannot check in unscheduled, complete future/history tasks, submit while checked out, or bypass restrictions by direct API calls or a second device.
2. End-of-window/36-hour closure occurs server-side while the phone is offline; later checkout remains an authentic exception rather than overwritten attendance.
3. IP/admin cannot mutate original events, timestamps, submitted notes or evidence; corrections retain originals and actor identity.
4. Client decline, dispute, food request and correction workflows retain each event and deliver the appropriate actionable notification.
5. Required dish photo must be fresh in-app capture and server accepted; failed upload cannot falsely complete the task.
6. GPS accuracy/staleness/permission failures and missed background checks display Unverified and alert appropriately; checkout failure still records an attempted departure.
7. Client completes all core flows using TalkBack, large text, keyboard and voice alternatives on real devices; VoiceOver flows are tested wherever iOS is supported.
8. Family access revocation and role enforcement work across dashboards, APIs, photos, reports and notifications.
9. Weekly totals handle daylight-saving transitions and workweek boundaries; duplicate submissions do not create duplicate work/events.
10. Restore from backup, verify archive integrity, validate retention expiration and temporary report cleanup, and confirm notification delivery failure handling.

## Setup values to enter before launch

Apartment coordinates/address; the authorizing program's workweek; actual IP schedule; authorized service-plan duties; account invitations and verified notification contacts; recurring task days; non-kitchen mopping frequency; object/storage locations; dietary requirements; retention selection and applicable program guidance. These are configuration items, not a new household questionnaire.

## Technical references

- Android Developers, Background Location Limits: https://developer.android.com/about/versions/oreo/background-location-limits
- Amazon S3 User Guide, Locking objects with Object Lock: https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html

