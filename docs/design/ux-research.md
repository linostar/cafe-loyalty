# UX research: personas, journeys, audit and pilot test plan

**Status: assumption-based.** The proto-personas and journeys below come from desk research (the Tripoli café research behind the product plan) and a heuristic audit of the current screens. No owners, staff or customers have been interviewed yet. Treat every claim as a hypothesis and validate it in the pilot (three cafés: a kiosk, a modern café, a study café). This file holds no personal data: personas are composites, and no person is named or quoted.

Sources: the product plan (users, acceptance criteria) and the layout redesign plan, the coffee-shop research (market report, operating environment, customer demand, Google Maps review themes), and an audit of 125 screenshots at 390 and 1440 px in English and Arabic.

## 1. Context in brief

- Tripoli cafés are mostly cash-only (about 9 in 10 with payment data). Customers have no digital identity at the till; a phone number is the identity.
- Generator power and internet cut out. The counter must work offline and say so clearly.
- Margins are thin and costs move in dollars. Owners are price-sensitive and short of time; the tool must earn its place in minutes, not weeks.
- Arabic is the default language for many users; English is common in modern and study cafés. Both directions (RTL and LTR) must read naturally, including mixed names and numbers.
- Customer phones are both iPhone and Android; Google Wallet only launched in Lebanon in mid-2025, so wallet familiarity is uneven.
- Demand is seasonal (Ramadan evenings and late nights, exam periods for study cafés), with real dead hours in between.

## 2. Proto-personas

### 2.1 Café owner

| | |
|---|---|
| Context | Runs one small café, often works the counter too. Uses the dashboard on their own phone between orders, sometimes on a laptop at home late at night. Arabic first, comfortable with English UI words. Interrupted constantly. |
| Goals | Keep regulars coming back in a shrinking market. Fill quiet hours without selling below cost. Know at a glance whether the program pays for itself. Set up once, then forget it. |
| Frustrations | Software that needs weeks of data entry. Screens that need a laptop. Unclear money effects of a discount. Staff abuse (stamping friends). Paying monthly for something whose value is unproven. |
| Design implications | Home answers "anything to do?" in one glance (pending review items, unread feedback, delivery problems). Settings are short, grouped and skippable, with defaults. Money is shown in cents-exact USD with the margin effect beside it. Every phone screen works at 360-390 px with the nav in one row. Copy is one or two short sentences. |

### 2.2 Barista / counter staff

| | |
|---|---|
| Context | Shared café phone or tablet propped by the till, one hand often busy. Queue at peak, noise, glare, power and internet cuts. May be a part-timer or a relative helping out. Arabic or English per person. Picks their name, enters a 6-digit PIN. |
| Goals | Stamp a visit in seconds without holding up the queue. Never lose a stamp when offline. Redeem a reward without an argument with the customer. |
| Frustrations | Scrolling to find the button. Small targets. Status text that wraps and pushes content down. Not knowing whether a stamp "went through" while offline. Being blamed for refusals the system made (cooldown, cap). |
| Design implications | One-screen flow at 390x844: compact one-row top bar, order total and Record visit always visible in a bottom action bar. Focus moves to Record after a scan. 44 px targets. Offline state as a short pill, with the queue count. Refusals say what happened and what to do next. |

### 2.3 Customer

| | |
|---|---|
| Context | Regular at a kiosk or café, paying cash. Price-sensitive (students especially). Scans a QR at the till on their own phone, often on mobile data, standing in a queue. Arabic or English. Wary of giving a phone number. |
| Goals | Get the card in under a minute without installing an app. See stamps and the next reward. Get a fair offer now and then. Say something to the owner privately if a visit went wrong. |
| Frustrations | Long forms, unclear privacy, an app install, spam. Not knowing whether the card saved. Small links. Fear of deleting the card by accident. |
| Design implications | Signup is one field plus consent, with the privacy notice short and visible. The card page leads with stamps and the wallet button that fits the device. Language switch and feedback link are 44 px targets. Delete card sits in a separate danger section. Feedback page always shows both the private form and the review link. |

### 2.4 Operator (platform admin)

| | |
|---|---|
| Context | The single person running the platform. Uses `/admin` on a laptop or phone, a few times a week: new cafés, signup links, plans, manual payments. English first. |
| Goals | Onboard a café in one sitting. See each café's plan and payment state. Never make a mistake that locks a café out. |
| Frustrations | Disabled buttons with no reason. Odd formatting in dates. Pages that waste the screen on wide monitors. |
| Design implications | Shared centred container. Disabled actions say why. Clean date and table formatting. Confirmation for plan changes that affect signup (suspended). |

## 3. Journey maps

Emotion: 1 = frustrated, 3 = neutral, 5 = pleased. Scores are assumed from the audit, to be replaced by pilot observations.

### 3.1 Owner: first setup

| Stage | Actions | Touchpoint | Emotion | Pain points | Opportunities |
|---|---|---|---|---|---|
| Invite | Opens the signup link the operator sent | Signup link, `/signup` page | 4 | Link may arrive on a phone, not a laptop | Make signup fully phone-friendly; say how long setup takes |
| Sign up | Email, password | Signup form | 3 | Password rules found only on error | Show rules up front |
| Café settings | Name, program (stamps, reward), margin, order types, win-back, Google review link | Café page | 2 | 6 forms, about 15 fields, 4063 px tall at 390; unclear what is required | Group into sections with an in-page list; mark what can wait |
| Pair counter | Opens Devices, shows pairing QR, scans it with the café phone | Devices page, counter `/pair` | 3 | Two devices in hand; code expiry not obvious | Show the expiry and a fresh-code button next to the QR |
| Staff | Adds baristas and PINs | Staff page | 3 | Must happen before the counter is usable, not obvious | Home checklist: program, order types, staff, device, signup QR |
| Print signup QR | Prints or displays the café QR at the till | Café page, signup section | 3 | QR is buried in a long page | Put it in its own section, print-ready |

### 3.2 Owner: weekly check

| Stage | Actions | Touchpoint | Emotion | Pain points | Opportunities |
|---|---|---|---|---|---|
| Open | Signs in on the phone | Home | 2 | Nav takes 3 rows (~145 px); tiles repeat the nav; no status | One-row nav; Home shows what needs attention |
| Review | Accepts or discards held visits | Review | 2 | ~90-word intro; buttons repeat the full description | Short labels (Accept, Discard); one-sentence intro; pending count in the nav |
| Inbox | Reads private feedback | Inbox | 3 | No unread count before opening | Count in the nav and on Home |
| Results | Checks won-back customers and offer cost | Results | 3 | Heading differs from the nav label | Match heading to nav; lead with the one number that matters |

### 3.3 Barista: stamp in a rush (incl. offline)

| Stage | Actions | Touchpoint | Emotion | Pain points | Opportunities |
|---|---|---|---|---|---|
| Unlock | Picks name ("Who is working?"), enters PIN | Counter lock screen | 3 | Once per shift; lockout delay unclear | Show remaining wait plainly |
| Build order | Taps steppers for items | Counter home | 2 | Top bar 3 rows (~170 px, ~230 px Arabic offline); zero steppers differ only by colour | One-row top bar; zero state with shape or weight, not only colour |
| Scan card | Taps Scan card, holds customer's QR to camera | Scanner | 3 | Glare, slow focus; phone fallback adds 8 digits | Large viewfinder; phone path only when scan fails |
| Record | Taps Record visit | Counter home | 2 | Record at y≈1110, below the fold with 6 menu items; no focus move after scan | Bottom action bar with total and Record; focus to Record after scan |
| Offline | Same flow, event queued | Top bar pill, queue count | 2 | Arabic offline pill is a full sentence on 2 lines; is the stamp safe? | Short pill ("Offline, 3 queued"); confirmation that says "saved, will sync" |

### 3.4 Barista: redeem a reward

| Stage | Actions | Touchpoint | Emotion | Pain points | Opportunities |
|---|---|---|---|---|---|
| Notice | Customer says they have a reward | Card QR | 3 | Barista may not know the card is full | Show "reward ready" right after scan |
| Redeem | Scans card, confirms | Reward screen (visit.tsx) | 3 | Needs a connection | Clear refusal offline with next step ("try when online, note it for the owner") |
| Done | Confirms to customer | Result message | 4 | Failure text ("Redeeming failed") alone is not enough | Say why and what to do |

### 3.5 Customer: join, card visit, feedback

| Stage | Actions | Touchpoint | Emotion | Pain points | Opportunities |
|---|---|---|---|---|---|
| Scan | Scans the café QR at the till | Phone camera | 4 | Unsure what the QR is for | Sign at the till says "free coffee after N visits" |
| Sign up | Phone number, consent | Signup page | 3 | Privacy worry; Arabic digit input | Short notice; Arabic-Indic digits accepted (already); one button |
| Card | Sees stamps, QR, wallet button | Card page | 4 | Small language switch | 44 px switch; stamps first |
| Add to wallet | Taps Apple or Google button | Wallet sheet | 3 | Unfamiliar with Google Wallet; unsure it saved | One line on what happens next; web card bookmark as fallback |
| Card visit | Shows QR at the counter | Wallet pass or web card | 4 | Screen brightness, slow web card | Pass works offline; QR large and high-contrast |
| Feedback | Opens `/f/` link from the pass | Feedback page | 3 | "Tell the café" link is small inline text | 44 px target; private form and review link side by side, never gated |
| Delete (rare) | Deletes card | Card page | 2 | Delete looks like any other card | Separate danger section with confirmation |

## 4. Heuristic findings

Severity: 4 blocks the task, 3 major, 2 minor, 1 cosmetic. Priority = frequency x severity x breadth, each scored 1-3 (frequency: how often the screen is used; breadth: share of users and both languages affected), shown as the product. Ordered by priority.

| # | Sev | Freq | Breadth | Priority | Screen | Heuristic | Finding | Direction |
|---|---|---|---|---|---|---|---|---|
| 1 | 3 | 3 | 3 | 27 | Counter 390x844 | Nielsen #8; touch; WCAG 1.4.10 | Top bar wraps to 3 rows (~170 px; ~230 px Arabic offline); Record visit at y≈1110 with 6 menu items; order summary sticky only from 56rem (styles.css, visit.tsx) | One-row top bar; bottom action bar with total and Record at every width |
| 2 | 3 | 3 | 3 | 27 | Counter | Nielsen #7; touch | At least 3 taps + scan per stamp; phone path adds 8 digits; no focus move to Record after scan | Move focus to Record after scan; no auto-record |
| 3 | 2 | 3 | 3 | 18 | Counter Arabic offline | Nielsen #1; WCAG 1.3.2 | Offline pill is a full sentence on 2 lines; mixed-direction names read fragmented | Short pill with count; isolate names (bdi) |
| 4 | 3 | 2 | 3 | 18 | Dashboard phone nav | Nielsen #8; touch | Nav wraps to 3 rows (~145 px) before content; Home tiles duplicate the nav | One-row nav (scrolling or menu); drop duplicate tiles |
| 5 | 3 | 1 | 3 | 9 | Dashboard Café page | Nielsen #8, #6 | 6 forms, ~15 fields, 4063 px tall at 390; grid gaps at 1440 (cafe-page.tsx) | Sections with an in-page list; each form keeps its own save |
| 6 | 2 | 2 | 2 | 8 | Dashboard Home | Nielsen #1 | No at-a-glance status; no pending counts on Review or Inbox | Attention list and nav counts from existing API data |
| 7 | 2 | 2 | 2 | 8 | Dashboard Review | Nielsen #8; WCAG 2.5.3 | Buttons show the full description as label ("Accept Visit by … at …") | Visible "Accept" / "Discard"; keep accessible names |
| 8 | 2 | 2 | 2 | 8 | Customer card page | Touch; WCAG 2.5.8 | Language switch and "Tell the café" feedback link are small inline targets | 44 px targets |
| 9 | 2 | 2 | 2 | 8 | Dashboard (Review, Win-back, Google review hints) | Nielsen #8 | Long dense intro copy (Review ~90 words) | One or two short sentences, both languages |
| 10 | 2 | 2 | 2 | 8 | Dashboard and admin at 1440 | Nielsen #8 | Content start-aligned, dead space on wide screens | Shared centred container (margin-inline auto) |
| 11 | 1 | 3 | 2 | 6 | Counter steppers | WCAG 1.4.1 | Steppers at zero differ from chosen ones only by colour | Add weight, border or count badge |
| 12 | 2 | 1 | 2 | 4 | Customer card page | Nielsen #5 | Delete card has the same weight as other cards | Separate danger section |
| 13 | 2 | 2 | 1 | 4 | Dashboard profile button | Touch; WCAG 2.5.8 (met) | ~36 px tall vs 44 px elsewhere | Match 44 px |
| 14 | 1 | 2 | 2 | 4 | Dashboard Results, Home | Nielsen #4 | Results h2 does not match nav label; Home's "Signed in as" duplicates the top bar | Match headings to nav; remove duplicate |
| 15 | 2 | 1 | 1 | 2 | Admin café detail | Nielsen #1, #9, #4 | Disabled "Save plan" with no reason; datetime shows a leading comma; payments caption centred while table is start-aligned | Say why disabled; fix format; align caption |

### Automation gaps

None of these is checked today; each lets regressions through unseen (redesign AC 3, 4):

| Gap | WCAG 2.2 SC | Planned check |
|---|---|---|
| No axe scan | Many (A, AA) | @axe-core/playwright on every screens spec, both languages |
| No target-size check | 2.5.8 (24 px); 44 px product rule on counter and customer pages | e2e size check of interactive controls |
| No 320 px reflow / 200% zoom check | 1.4.10, 1.4.4 | e2e at 320 px, no horizontal scroll |
| No forced-colors check | 1.4.11 (and usability in Windows high contrast) | Key screens under forced-colors emulation |
| No focus-ring contrast check | 2.4.7, 1.4.11 (3:1) | tokens.test.ts against every surface the ring sits on |

## 5. Pilot usability test plan

### 5.1 Research questions (testable)

1. Can a barista record a stamped visit in under 10 s at peak, scan to confirmation, without scrolling?
2. Do baristas trust that an offline stamp is saved (stated confidence, and no repeat attempts)?
3. Can a customer go from scanning the café QR to seeing their card in under 60 s, unaided?
4. Do customers on Android find and complete "Save to Google Wallet"?
5. Can an owner set up program, order types, staff and a paired device in one sitting under 20 minutes?
6. Can an owner tell, from Home alone, whether anything needs action this week?
7. Do customers find the feedback link on the pass, and do they understand the message is private?
8. Does the Arabic interface cause more errors or slower times than English for the same task?

### 5.2 Method

- Moderated, in-café, on the café's own devices, during real or simulated rush hours. Remote follow-up for owners if needed.
- 5 participants per role where possible: owners (all three pilot owners, plus any co-managers), baristas (across the three cafés), customers.
- Customers: guerrilla sessions at the till, 5-10 minutes, with the owner's consent and a small thank-you (a free drink).
- Operator: self-run walkthrough with a checklist (the operator is the developer; biased, so the findings weigh less).
- Session length: owner 45 min, barista 20 min (outside peak for setup, observation during peak), customer 5-10 min.
- Record notes and timings only. No audio or video of faces without explicit consent; nothing identifying in the log.

### 5.3 Tasks

**Owner**

| Scenario | Goal | Success |
|---|---|---|
| "You just got the signup link. Get the café ready for tomorrow morning." | Sign up, set program and two order types | Done unaided; program and order types saved |
| "Your new barista starts today." | Add a staff member with a PIN | Staff appears; barista can unlock on the counter |
| "Set up the café phone at the counter." | Pair a device | Counter reaches "Who is working?" |
| "Put the signup QR at the till." | Find and print/show the signup QR | QR printed or shown within 2 minutes |
| "It is Monday. Is there anything you should deal with?" | Find pending review items and new feedback from Home | Names both counts correctly within 30 s |
| "Mornings are empty. Offer 10% off espresso 8-10 without losing money." | Create a campaign within the margin floor | Campaign saved; owner can explain why a bigger discount was refused |

**Barista**

| Scenario | Goal | Success |
|---|---|---|
| "Start your shift." | Unlock with name and PIN | Unlocked first or second try |
| "Two lattes and a croissant; customer shows their card." | Build order, scan, record | Recorded in under 10 s from scan, no scroll |
| "The internet is down (router unplugged). Same order." | Record offline | Recorded; barista states it will sync |
| "Customer has no phone with them, gives their number." | Stamp by phone | Recorded, or refusal understood and explained to customer |
| "Customer says their card is full." | Redeem reward | Redeemed online; offline refusal understood |
| "Customer asks why they got no stamp (cooldown)." | Read and explain the refusal | Explains in own words |

**Customer**

| Scenario | Goal | Success |
|---|---|---|
| "The café gives a free drink after a few visits. Join." | Scan QR, sign up | Card page shown in under 60 s |
| "Keep the card on your phone." | Add to Apple or Google Wallet | Pass saved, or web card bookmarked |
| "How many more visits until the free drink?" | Read stamps | Correct answer |
| "Your last coffee was cold. Tell the owner, privately." | Use the feedback page | Message sent; participant says it is private |
| "Switch the card to the other language." | Use the language switch | Switched first try |

**Operator** (checklist): create a café and signup link; change a plan to suspended and back; record a payment; reset own password.

### 5.4 Metrics and targets

| Metric | Target |
|---|---|
| Task completion (unaided) | > 80% per task |
| Stamp time, scan to confirmation, at peak | < 10 s median |
| Customer join, scan to card page | < 60 s median |
| Owner first setup (program, order types, staff, device) | < 20 min |
| Owner "anything to do?" from Home | < 30 s |
| Errors per task (wrong tap, back-tracking, repeat record) | ≤ 1 median |
| Duplicate stamps attempted offline | 0 |
| Post-task ease (Single Ease Question, 1-7) | ≥ 5.5 median |
| Arabic vs English time on task | Within 20% of each other |

### 5.5 Moderator notes

- Run in the participant's language (Arabic or English, their choice); set the app language to match before starting. Note when they switch.
- Ask for think-aloud, but not during a real rush: observe first, ask afterwards.
- Do not help unless the participant is stuck for 60 s or a real customer is waiting; record the assist and count the task as failed.
- Use scenario wording, never button names ("record the visit", not "tap Record visit").
- Use test cards and fake phone numbers for barista and owner tasks; customers use their own phone only if they want a real card.
- Read the consent script; explain that the product is tested, not them.

### 5.6 Logging findings

- One row per observation in a shared sheet: date, café type (kiosk, modern, study), role, task, language, device class, observation, severity, link to the heuristic or WCAG SC if any. No names, phone numbers, emails or photos of people.
- Severity: 4 blocks the task; 3 causes a significant delay or error, or needs help; 2 causes a minor delay or confusion; 1 cosmetic.
- After each café: merge duplicates, update priorities with the formula in section 4, and update the personas and journey emotion scores where the evidence disagrees with the assumptions above.
- Severity 4 and 3 findings become issues before the next pilot week.

## 6. Assumptions to validate in the pilot

Each assumption above, with what would prove it wrong. Update this list after every pilot café.

| # | Assumption | Persona | Wrong if |
|---|---|---|---|
| A1 | Owners use the dashboard mostly on their phone | Owner | Most sessions are on a laptop |
| A2 | Owners check the dashboard about weekly, not daily | Owner | Daily checks dominate (then Home needs today's numbers) |
| A3 | Setup happens in one sitting | Owner | Owners stop after the program and return days later |
| A4 | The counter is a shared phone propped at the till | Barista | Baristas use their own phones, or a tablet |
| A5 | Scanning is faster than typing a phone number | Barista | Scan failures (glare, cracked screens) push most stamps to the phone path |
| A6 | Baristas worry about losing offline stamps | Barista | They ignore the offline state entirely |
| A7 | Customers will scan a QR at the till during a queue | Customer | Most ask the barista to sign them up instead |
| A8 | Customers save the card to a wallet | Customer | Most keep only the web card or nothing |
| A9 | Customers will leave private feedback through the pass | Customer | Nobody opens the feedback link in the pilot month |
| A10 | Arabic is the first language for most staff and customers | All | English dominates in modern and study cafés |
| A11 | Study-café regulars visit often enough for stamps to matter | Customer | Long stays, few visits: a pass or day ticket fits better |
| A12 | Kiosk rushes are short and intense (seconds per customer) | Barista | Rush is steady and slow; 10 s target too strict or too loose |

Out of scope here (see the redesign plan's deferred ideas): automatic recording after a scan, a "repeat last order" button, new Home statistics needing a new endpoint, and running these tests (Step 20's pilot).
