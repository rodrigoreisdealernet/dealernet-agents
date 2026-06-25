/**
 * Inventory Stock Items Route
 *
 * Provides a dedicated inventory management surface for quantity-tracked
 * stock items (bulk / sale / part). Serialized items remain on the existing
 * /entities/asset route and preserve asset lifecycle semantics.
 *
 * Route: /inventory/items
 * Auth: requires authenticated session
 */

import { createFileRoute } from '@tanstack/react-router';
import { EntityListScreen } from '@/routes/entities/$entityType/index';

export const Route = createFileRoute('/inventory/items')({
  component: InventoryItemsPage,
});

function InventoryItemsPage() {
  return <EntityListScreen entityType="stock_item" />;
}
