import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** The list-endpoint request contract: ?page=&pageSize= */
export class PageQueryDto {
  @ApiProperty({ required: false, default: 1, minimum: 1 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page = 1;

  @ApiProperty({ required: false, default: 20, minimum: 1, maximum: 200 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  pageSize = 20;
}

/** The list-endpoint response contract: { items, page, pageSize, total } */
export class Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;

  constructor(items: T[], page: number, pageSize: number, total: number) {
    Object.assign(this, { items, page, pageSize, total });
  }
}
