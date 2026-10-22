CREATE TYPE "PreOrderStatus" AS ENUM ('confirmed', 'accepted', 'preparing', 'ready', 'served', 'cancelled', 'rejected');
CREATE TYPE "PaymentStatus" AS ENUM ('pending', 'paid');

CREATE TABLE "pre_orders" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "reservation_id" UUID NOT NULL,
  "status" "PreOrderStatus" NOT NULL DEFAULT 'confirmed',
  "subtotal_idr" INTEGER NOT NULL,
  "notes" TEXT,
  "payment_method" TEXT NOT NULL DEFAULT 'pay_at_venue',
  "payment_status" "PaymentStatus" NOT NULL DEFAULT 'pending',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pre_orders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pre_orders_reservation_id_key" UNIQUE ("reservation_id"),
  CONSTRAINT "pre_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "pre_orders_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE CASCADE,
  CONSTRAINT "pre_orders_subtotal_idr_check" CHECK ("subtotal_idr" >= 0)
);
CREATE INDEX "pre_orders_tenant_id_status_idx" ON "pre_orders"("tenant_id", "status");

CREATE TABLE "pre_order_items" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "pre_order_id" UUID NOT NULL,
  "menu_item_id" UUID NOT NULL,
  "name_snapshot" TEXT NOT NULL,
  "unit_price_idr" INTEGER NOT NULL,
  "quantity" INTEGER NOT NULL,
  "line_total_idr" INTEGER NOT NULL,
  "notes" TEXT,
  CONSTRAINT "pre_order_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pre_order_items_pre_order_id_fkey" FOREIGN KEY ("pre_order_id") REFERENCES "pre_orders"("id") ON DELETE CASCADE,
  CONSTRAINT "pre_order_items_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE RESTRICT,
  CONSTRAINT "pre_order_items_quantity_check" CHECK ("quantity" > 0)
);
CREATE INDEX "pre_order_items_pre_order_id_idx" ON "pre_order_items"("pre_order_id");
