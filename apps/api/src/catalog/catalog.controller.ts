import { Controller, Get, Param, Query } from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { ListProductsQuery } from './catalog.dto';
import { ProductsService } from './products.service';

@Controller()
export class CatalogController {
  constructor(
    private readonly categories: CategoriesService,
    private readonly products: ProductsService,
  ) {}

  @Get('categories')
  categoryTree() {
    return this.categories.tree();
  }

  @Get('products')
  list(@Query() query: ListProductsQuery) {
    return this.products.list(query);
  }

  @Get('products/:slug')
  detail(@Param('slug') slug: string) {
    return this.products.detail(slug);
  }
}
