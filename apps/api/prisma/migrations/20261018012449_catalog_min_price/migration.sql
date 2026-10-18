-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "minPrice" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Product_status_minPrice_idx" ON "Product"("status", "minPrice");

-- CreateIndex
CREATE INDEX "Product_status_createdAt_idx" ON "Product"("status", "createdAt");
