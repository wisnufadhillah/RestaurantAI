import { BadRequestException, Body, Controller, Get, Headers, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ListReservationsDto } from './dto/list-reservations.dto';
import { RejectReservationDto } from './dto/reject-reservation.dto';
import { ReservationsService } from './reservations.service';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { VerifyReservationDto } from './dto/verify-reservation.dto';
import { CancelReservationDto } from './dto/cancel-reservation.dto';
import { UpdateReservationDto } from './dto/update-reservation.dto';
import { enforceRateLimit } from '../rate-limit.util';

type AuthenticatedUser = { tenantId: string; userId: string };

@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Post()
  create(@Body() body: CreateReservationDto, @Req() request?: { ip?: string }) {
    enforceRateLimit(`reservation-create:${body.outletId}:${request?.ip ?? 'unknown'}`, 5, 60_000);
    return this.reservationsService.create(body);
  }

  @Post('verify')
  verify(@Body() body: VerifyReservationDto, @Headers('x-tenant-id') tenantId?: string, @Req() request?: { ip?: string }) {
    const scopedTenantId = this.requireTenant(tenantId);
    enforceRateLimit(`reservation-verify:${scopedTenantId}:${request?.ip ?? 'unknown'}`, 10, 60_000);
    return this.reservationsService.verify(body.code, body.phoneLast4, scopedTenantId);
  }

  @Patch(':code')
  update(@Param('code') code: string, @Body() body: UpdateReservationDto, @Headers('x-tenant-id') tenantId?: string, @Req() request?: { ip?: string }) {
    const scopedTenantId = this.requireTenant(tenantId);
    enforceRateLimit(`reservation-update:${scopedTenantId}:${request?.ip ?? 'unknown'}`, 5, 60_000);
    return this.reservationsService.update(code, body, scopedTenantId);
  }

  @Post(':code/cancel')
  cancel(@Param('code') code: string, @Body() body: CancelReservationDto, @Headers('x-tenant-id') tenantId?: string, @Req() request?: { ip?: string }) {
    const scopedTenantId = this.requireTenant(tenantId);
    enforceRateLimit(`reservation-cancel:${scopedTenantId}:${request?.ip ?? 'unknown'}`, 5, 60_000);
    return this.reservationsService.cancel(code, body.phoneLast4, undefined, scopedTenantId);
  }

  @Get('admin')
  @UseGuards(JwtAuthGuard)
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListReservationsDto) {
    return this.reservationsService.list(user.tenantId, query);
  }

  @Post('admin/:id/approve')
  @UseGuards(JwtAuthGuard)
  approve(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.reservationsService.approve(user.tenantId, user.userId, id);
  }

  @Post('admin/:id/reject')
  @UseGuards(JwtAuthGuard)
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: RejectReservationDto,
  ) {
    return this.reservationsService.reject(user.tenantId, user.userId, id, body.reason);
  }

  private requireTenant(tenantId?: string) {
    if (!tenantId) throw new BadRequestException('Header x-tenant-id wajib diisi.');
    return tenantId;
  }
}
