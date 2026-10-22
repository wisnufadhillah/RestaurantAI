import { Type } from 'class-transformer';
import { IsArray, IsInt, IsOptional, IsString, Matches, MaxLength, Min, ValidateNested } from 'class-validator';

export class PreOrderItemDto {
  @IsString() menuItemId: string;
  @IsInt() @Min(1) quantity: number;
  @IsOptional() @IsString() @MaxLength(300) notes?: string;
}

export class PreOrderDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => PreOrderItemDto) items: PreOrderItemDto[];
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class CreateReservationDto {
  @IsString() outletId: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) date: string;
  @Matches(/^\d{2}:\d{2}$/) time: string;
  @IsInt() @Min(1) partySize: number;
  @IsString() @MaxLength(100) name: string;
  @IsString() @MaxLength(30) phone: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsOptional()
  @IsString()
  @MaxLength(128)
  idempotencyKey?: string;
  @IsOptional() @ValidateNested() @Type(() => PreOrderDto) preOrder?: PreOrderDto;
}
