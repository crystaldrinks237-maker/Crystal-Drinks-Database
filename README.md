# Crystal Drinks — Bottled Water Plant Management Dashboard

A dashboard for running your bottled water plant: attendance, production,
inventory, deliveries, invoices, expenses, and reports — accessible from any
phone or computer via a real web link, not just on your own Wi-Fi.

**Hosted for free on Render (the app) + Neon (the PostgreSQL database).**
See **`DEPLOY-RENDER.md`** for the full step-by-step setup — that's the
guide you actually want if you're setting this up for the first time or
moving it from the old local/laptop version.

## What it does
- Admin login (you) and separate Worker logins
- Track multiple **bottle types** (e.g. sizes) and **qualities/grades** — every
  Type x Quality combination is tracked as its own stock item, from
  purchases through production through delivery
- Workers mark their own daily attendance and how many bottles they filled,
  broken down by type/quality — and you (the admin) can also add or correct
  any worker's attendance yourself from the Attendance page
- Automatic empty-bottle and filled-bottle stock tracking, per type/quality
- Delivery log (bottles delivered per type/quality, destination, price) with
  a running invoice number
- One-click PDF invoices with a full line-item breakdown: a **Client Copy**
  and an **Admin/Office Copy** (the admin copy also shows your internal
  petrol cost / margin for that trip)
- **Customers & balances**: keep a list of regular customers, record what they
  paid at delivery and any payments they make later, and every new invoice
  automatically shows what they still owed before it, plus the new total
- Expense tracking: bottle purchases, petrol, vehicle maintenance, electricity
- Wages: pay per day today, and you can flip a single switch later to pay per
  bottle filled — no data migration needed
- Dashboard overview: stock levels, revenue, wages, expenses, rough net profit
- One-page monthly PDF summary report (revenue, wages, expenses, stock,
  per-worker breakdown, bottles filled by type/quality, top clients)
- On-demand full database backup as a downloadable JSON file (Settings page)
- Low-stock alerts: an on-screen warning banner, plus optional free browser
  notifications (no SMS/email cost)
- CSV export buttons on Attendance, Inventory, Deliveries, and Expenses —
  opens straight in Excel/Google Sheets for your accountant

---

## Setup

**Go to `DEPLOY-RENDER.md`** for the actual setup steps (creating your free
Neon database, deploying to Render, environment variables, first login, and
bringing across data from the old local version if you have any).

The short version: this is a normal Node.js + PostgreSQL app. Set a
`DATABASE_URL` environment variable pointing at your Postgres database, run
`npm install` then `npm start` (or let Render do both automatically), and the
app creates its own tables and a default admin account the first time it
starts — no separate setup step required.

### Running it locally (for testing/development only)
If you want to run a copy on your own computer against a local Postgres
install rather than the hosted version:
```
npm install
cp .env.example .env   # then fill in DATABASE_URL or the DB_* variables
npm start
```
Open `http://localhost:3000`. Default login is `admin` / `admin123` —
change this immediately in Settings, same as on the hosted version.

---

## Day-to-day use

### You (Admin)
- Log in with your admin account.
- **Products** tab: set up your bottle **types** (e.g. sizes) and **qualities**
  (grades) here first — every Type x Quality combination becomes something you
  can log stock, production, and deliveries against everywhere else in the
  app. Rename the placeholder ones to match what you actually order, and
  untick "Active" for any combination you don't use so it stops cluttering
  the forms (its history stays intact either way).
- **Workers** tab: add a worker account for each employee (set their daily wage).
- **Attendance** tab: review what workers logged each day, broken down by
  bottle type/quality. Click **+ Add / edit an entry** to log attendance for
  a worker yourself (useful if someone forgets, or doesn't have a phone handy)
  — pick the worker and date, and it works exactly like the worker's own
  screen. Entries show whether a worker or the admin logged them.
- **Inventory** tab: record every time you buy empty bottles, per type/quality
  (cost auto-logs as an expense); see current empty & filled stock for each one.
- **Deliveries & Invoices** tab: log each delivery with a quantity and price
  per bottle type/quality (leave any row at 0 to skip it) — this instantly
  gives you an invoice number and two PDF buttons: "Client copy" (clean,
  professional, itemized) and "Admin copy" (adds your internal cost note).
  Open either in the browser and use your browser's Print or Save-as-PDF
  option to hand it over or file it.
- **Customers** tab: your regular customers and how much each one owes you.
  - Add a customer (the *opening balance* is anything they already owed before
    you started using this tab). On first use, one click adds all the customer
    names from your past deliveries.
  - On **New delivery**, pick the customer from the dropdown (or choose
    "New / one-time customer"). Enter *Amount received now* - the form shows the
    live balance. The invoice PDF then lists: this delivery, previous balance,
    total payable, paid now, and **balance due**.
  - When a customer pays later, open them and use **Record a payment**. Their
    **statement** shows every invoice and payment with a running balance.
  - **Statement PDF and WhatsApp**: on a customer's page, download a printable
    account statement, or send a ready-typed WhatsApp message (payment
    reminder, balance, or a single invoice) to their saved number. On a phone,
    **Share PDF** attaches the actual PDF file. Set your country code under
    Settings (92 = Pakistan) so numbers like 0311-1234567 work.
  - A new customer who doesn't pay in full is saved automatically so the
    unpaid amount is never lost. One-time customers who pay in full are not saved.
  - **Pets (crates of 6)**: each row on the delivery form can be entered as
    Pets or Bottles. Pick Pets, enter the quantity of crates and the price you
    agreed *per crate*, and the app works out the bottle count and the
    per-bottle price for you - no more dividing by 6 on a calculator. The
    invoice shows it the same way ("3 pets (18)" at "100.00/pet"). Mixing a
    pet-priced row with a plain-bottle row on the same delivery is fine.
  - Balances are always calculated from the records, so deleting a delivery or a
    payment fixes the balance by itself. Printed invoices keep the balance as it was
    on the day.
- **Expenses** tab: log vehicle maintenance, electricity bills, or anything else.
- **Settings** tab: set your company name/address/phone (shown on invoices),
  switch wage mode between "per day" and "per bottle" whenever you're ready
  to make the change (past records are never recalculated), and download a
  full backup.

### Workers
- Each worker logs in with the username/password you gave them, using the
  same link you use — no separate app or install.
- They see one simple screen: mark themselves present, enter bottles filled
  today for each type/quality, save. They can update it again the same day if
  needed.
- They only ever see their own history — never anyone else's data or the admin
  dashboard.

---

## Backing up your data
Neon (your database host) keeps its own backups/snapshots automatically. On
top of that, click **Download backup now** in Settings any time to get a
complete JSON snapshot of everything (workers, attendance, deliveries,
invoices, expenses) — worth keeping a copy of in your own cloud storage
occasionally, as a safety net you control yourself.

## Monthly reports
The **Reports** tab lists every month you have data for and gives you a
one-page PDF: revenue, wages, all expense categories, stock levels, bottles
filled/delivered, a per-worker breakdown, and your top clients that month.
Open it and print or "Save as PDF" from your browser.

## Low-stock alerts
Set your thresholds in **Settings**. When empty or filled bottle stock drops
below them, the dashboard shows a warning banner. You can also click "Enable
low-stock alerts on this device" on the dashboard to get a free browser
notification — do this once per device.

## Updating the app in the future
Push updated code to the same GitHub repository Render is connected to —
it rebuilds and redeploys automatically within a minute or two. Any database
changes are applied automatically the moment the app restarts; nothing is
deleted, and older records are carried forward into any new structure (this
already happened once, automatically, when bottle types/qualities were added).

## Ideas for later (tell me if you'd like any of these built)
- Multiple vehicles / drivers tracked and costed separately
- Barcode/QR based bottle tracking
- A dedicated "profit per delivery" view accounting for petrol + a share of wages
- Multi-admin accounts with different permission levels
- WhatsApp/SMS alerts (these typically require a small-cost third-party
  service, unlike the free options already built in)
- A custom domain (e.g. `dashboard.crystaldrinks.com`) instead of the
  `onrender.com` link, and/or a paid Render instance to remove the
  wake-up delay entirely, if either becomes worth it down the line
