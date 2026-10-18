import { Module } from '@nestjs/common';
import { StorageService } from '../storage/storage.service';
import { AdminCatalogController } from './admin-catalog.controller';
import { CatalogController } from './catalog.controller';
import { CategoriesService } from './categories.service';
import { ProductsService } from './products.service';

@Module({
  controllers: [CatalogController, AdminCatalogController],
  providers: [CategoriesService, ProductsService, StorageService],
})
export class CatalogModule {}
