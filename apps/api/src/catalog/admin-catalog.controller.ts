import {
  Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import { memoryStorage } from 'multer';
import { Roles } from '../auth/auth.decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CategoriesService } from './categories.service';
import {
  AdminListProductsQuery, CreateCategoryDto, CreateProductDto, UpdateCategoryDto, UpdateProductDto,
  UpdateVariantDto, VariantDto,
} from './catalog.dto';
import { ProductsService } from './products.service';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminCatalogController {
  constructor(
    private readonly categories: CategoriesService,
    private readonly products: ProductsService,
  ) {}

  // categories
  @Post('categories')
  createCategory(@Body() dto: CreateCategoryDto) {
    return this.categories.create(dto);
  }

  @Patch('categories/:id')
  updateCategory(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categories.update(id, dto);
  }

  @Delete('categories/:id')
  @HttpCode(204)
  removeCategory(@Param('id') id: string) {
    return this.categories.remove(id);
  }

  // products
  @Get('products')
  list(@Query() query: AdminListProductsQuery) {
    return this.products.adminList(query);
  }

  @Get('products/:id')
  detail(@Param('id') id: string) {
    return this.products.adminDetail(id);
  }

  @Post('products')
  create(@Body() dto: CreateProductDto) {
    return this.products.create(dto);
  }

  @Patch('products/:id')
  update(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.products.update(id, dto);
  }

  @Delete('products/:id')
  @HttpCode(204)
  archive(@Param('id') id: string) {
    return this.products.archive(id);
  }

  // variants
  @Post('products/:id/variants')
  addVariant(@Param('id') id: string, @Body() dto: VariantDto) {
    return this.products.addVariant(id, dto);
  }

  @Patch('variants/:id')
  updateVariant(@Param('id') id: string, @Body() dto: UpdateVariantDto) {
    return this.products.updateVariant(id, dto);
  }

  @Delete('variants/:id')
  @HttpCode(204)
  removeVariant(@Param('id') id: string) {
    return this.products.removeVariant(id);
  }

  // images (multipart/form-data, field name "file")
  @Post('products/:id/images')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  addImage(@Param('id') id: string, @UploadedFile() file?: Express.Multer.File) {
    return this.products.addImage(id, file);
  }

  @Delete('images/:id')
  @HttpCode(204)
  removeImage(@Param('id') id: string) {
    return this.products.removeImage(id);
  }
}
