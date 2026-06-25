# Equipment Catalog: browse equipment and compare rates

**Audience:** `branch_manager`, `field_operator`, `read_only`

Use the **Equipment Catalog** (`/rental/catalog`) when you need to browse individual assets, check photos and status, compare rental rates, and open a specific asset's detail page.

Use **Branch Availability** (`/rental/availability`) when you need branch/category rollups (available, unavailable, maintenance due, and maintenance overdue counts) instead of per-asset cards.

## Open the Equipment Catalog

1. In the left navigation, select **Equipment Catalog**.
2. Confirm the page heading is **Equipment Catalog**.

## Browse by category

1. In the **Category** panel, select a category (for example, *Earthmoving* or *Lifts*).
2. The catalog grid updates to show only assets in that category.
3. Select **All Equipment** to clear the filter and restore all asset cards.

## Read status and rates on each asset card

Each card includes:

- **Status badge** (for example, `available`) showing current availability state.
- **Rates** section with side-by-side rental prices for:
  - **day** (`daily_rate`)
  - **week** (`weekly_rate`)
  - **month** (`monthly_rate`)

Use these three rate values together to compare short-, medium-, and long-term rental pricing before choosing an asset.

## Open asset detail and confirm carried context

1. Select **View Details →** on an asset card.
2. The app opens the asset detail page (`/entities/asset/<asset-id>`).
3. In **Related Context**, confirm the selected asset's:
   - **Asset Category**
   - **Branch**
4. Use **Image updates & damage reports** on the asset detail page to upload new photos, add evidence comments, and submit condition/damage updates through the Temporal-backed asset update flow.

This context persists from the selected catalog asset so staff can continue rental decisions with the same asset category and branch information in view.
