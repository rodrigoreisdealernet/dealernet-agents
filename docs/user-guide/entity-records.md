# Entity records & drill-downs

Use the **Entities** area when you need to look up or maintain a single master-data or record entry: a customer, asset, invoice, branch, contact, contract, and related records. Use the workflow-specific screens when you are doing a process rather than reviewing one record:

- **Entities** — search for a record, open its detail page, review version history, or maintain allowed records.
- **Rental** screens — work through rental intake and operational flow such as orders and catalog-driven rental work.
- **Field Workflows** — perform field execution tasks such as mobile operational work.
- **Analytics** screens — review trends, totals, and reporting rather than one record at a time.

## Record types available under Entities

The main navigation exposes these record lists under **Entities**:

- **Fleet & Customers:** Assets, Asset Categories, Branches, Customers, Contacts, Job Sites, Billing Accounts
- **Rental Records:** Rental Orders, Contracts, Checkouts & Returns, Invoices, Transfers, Inspections, Maintenance

If you already know the record type, open that list directly from the sidebar. If you are not sure where a record belongs:

- start with **Customers**, **Contacts**, or **Job Sites** for customer account information
- use **Assets**, **Asset Categories**, or **Branches** for fleet and location records
- use **Invoices**, **Contracts**, or **Rental Orders** for rental paperwork and billing history

## Find a record from a list page

1. Open the correct record type from **Entities** in the sidebar.
2. Use the **Search entities...** field to filter the list.
3. Review the row details to confirm you have the right record.
4. Select **View** to open the full detail page.

Each list row can show:

- the record name
- a **status** badge when status or operational status is set
- a **Record** value for the source record identifier
- a **v#** badge for the current version number

Some record types also show quick context in the list:

- **Customers** — customer type
- **Billing Accounts** — payment terms and credit limit
- **Contacts** — role, linked customer, linked job site
- **Job Sites** — address and linked customer
- **Asset Categories** — default rate and utilization group
- **Assets** — identifier, linked category, linked branch, availability
- **Invoices** — customer, billing account, contract, job site, and any billing exception

Asset and invoice rows can also show warning banners such as **Checkout blocked** or **Billing exception** when the current record needs attention.

## What you see on the detail page

After you select **View**, the detail page opens for that exact record type. The page handles:

- **Loading** state while the record is being retrieved
- **Unable to load...** error state if the request fails
- **...not found** state if the record no longer exists or the link is invalid

At the top of the detail page, the header shows badges that help you confirm the record quickly:

- **Type badge** — the record type, such as Asset or Invoice
- **Status badge** — the current lifecycle or operational status
- **Version badge** — the current version, such as `v1`
- **Record badge** — the source record identifier, or `Not assigned`

The rest of the page is organized into:

- **Snapshot** — ID, type, source record, created date, updated date, and when the current version became active
- **Details** — the current master-data values for that record type
- **Related Context** — linked records for types that commonly reference other records
- **Version History** — every saved version, with the current version clearly marked

## How linked context appears

Linked context is shown most clearly on detail pages:

- **Assets** show the linked **Asset Category** and **Branch**
- **Job Sites** show the linked **Customer**
- **Contacts** show the linked **Customer** and **Job Site**
- **Invoices** show the linked **Customer**, **Billing Account**, **Contract**, and **Job Site**

This context helps you confirm that you opened the correct record before taking action.

## Role-based actions

Your role changes which action buttons are visible.

### Admin and Branch Manager

Users with write access can:

- open **New ...** from an entity list page
- use **Edit** on a detail page to save a new current version
- use **Delete** on a detail page when a record must be removed

### Read Only

Read-only users can:

- open entity lists
- search and review records
- select **View** and read detail pages, related context, and version history

Read-only users should **not** expect to see **New**, **Edit**, or **Delete** buttons.

## Common tasks

### Find a customer

1. Go to **Entities → Customers**.
2. Search by customer name.
3. Select **View**.
4. Confirm the customer type in the details panel and use badges at the top to confirm status, version, and record ID.

### Find an asset

1. Go to **Entities → Assets**.
2. Search by asset name or identifier shown in the row.
3. Select **View**.
4. Check the status badge and any checkout-blocking warning.
5. Use **Related Context** to confirm the linked branch and asset category.

### Find an invoice

1. Go to **Entities → Invoices**.
2. Search for the invoice record.
3. Select **View**.
4. Review **Billing Context** and **Related Context** to confirm the customer, billing account, contract, and job site.
5. If present, review the **Billing exception** warning before progressing any billing work.
