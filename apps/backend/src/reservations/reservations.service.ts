import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { ReservationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AvailabilityService } from '../availability/availability.service';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { ListReservationsDto } from './dto/list-reservations.dto';
import { UpdateReservationDto } from './dto/update-reservation.dto';

@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availabilityService: AvailabilityService,
  ) {}

  async create(input: CreateReservationDto) {
    const outlet = await this.prisma.outlet.findUniqueOrThrow({ where: { id: input.outletId } });
    if (input.idempotencyKey) {
      const existing = await this.prisma.reservation.findFirst({
        where: { tenantId: outlet.tenantId, idempotencyKey: input.idempotencyKey },
      });
      if (existing) return existing;
    }
    const availability = await this.availabilityService.find(
      input.outletId,
      input.date,
      input.time,
      input.partySize,
    );
    if (!availability.available || !availability.startAt || !availability.endAt) {
      throw new ConflictException({ code: 'SLOT_TAKEN', message: 'Slot tidak tersedia.' });
    }
    const preOrderItems = input.preOrder
      ? await this.resolvePreOrderItems(outlet.tenantId, input.preOrder.items)
      : [];
    const customer = await this.prisma.customer.upsert({
      where: { tenantId_phone: { tenantId: outlet.tenantId, phone: input.phone } },
      update: { name: input.name },
      create: { tenantId: outlet.tenantId, name: input.name, phone: input.phone },
    });
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${outlet.id}), hashtext(${input.date}))`;
        const lockedAvailability = await this.availabilityService.find(
          input.outletId,
          input.date,
          input.time,
          input.partySize,
          undefined,
          tx,
        );
        if (!lockedAvailability.available || !lockedAvailability.startAt || !lockedAvailability.endAt) {
          throw new ConflictException({ code: 'SLOT_TAKEN', message: 'Slot baru saja diambil tamu lain.' });
        }
        return tx.reservation.create({
          data: {
            tenantId: outlet.tenantId,
            outletId: outlet.id,
            customerId: customer.id,
            tableId: lockedAvailability.tables[0].id,
            startAt: lockedAvailability.startAt,
            endAt: lockedAvailability.endAt,
            partySize: input.partySize,
            code: `RSV-${randomBytes(3).toString('hex').toUpperCase()}`,
            notes: input.notes,
            idempotencyKey: input.idempotencyKey,
            expiresAt: new Date(Date.now() + this.pendingTtlMinutes() * 60_000),
            ...(input.preOrder
              ? {
                  preOrder: {
                    create: {
                      tenantId: outlet.tenantId,
                      subtotalIdr: preOrderItems.reduce((total, item) => total + item.lineTotalIdr, 0),
                      notes: input.preOrder.notes,
                      paymentMethod: 'pay_at_venue',
                      paymentStatus: 'pending',
                      items: { create: preOrderItems },
                    },
                  },
                }
              : {}),
          },
        });
      });
    } catch (error) {
      if (this.isIdempotencyConflict(error) && input.idempotencyKey) {
        const existing = await this.prisma.reservation.findFirst({
          where: { tenantId: outlet.tenantId, idempotencyKey: input.idempotencyKey },
        });
        if (existing) return existing;
      }
      if (this.isSlotConflict(error)) {
        throw new ConflictException({ code: 'SLOT_TAKEN', message: 'Slot baru saja diambil tamu lain.' });
      }
      throw error;
    }
  }

  async verify(code: string, phoneLast4: string, tenantId?: string) {
    const reservation = await this.prisma.reservation.findFirst({
      where: { code, ...(tenantId ? { tenantId } : {}), customer: { phone: { endsWith: phoneLast4 } } },
      include: { outlet: true, table: true, customer: true },
    });
    if (!reservation) throw new NotFoundException('Reservasi tidak ditemukan.');
    return reservation;
  }

  async update(code: string, input: UpdateReservationDto, tenantId?: string) {
    const reservation = await this.verify(code, input.phoneLast4, tenantId);
    if (!['pending', 'confirmed'].includes(reservation.status)) {
      throw new ConflictException('Reservasi tidak dapat diubah.');
    }
    const cutoff = reservation.startAt.getTime() - reservation.outlet.changeCutoffMinutes * 60_000;
    if (Date.now() >= cutoff) {
      throw new ConflictException('Batas waktu perubahan reservasi telah lewat.');
    }

    const local = new Date(reservation.startAt.getTime() + 7 * 60 * 60_000).toISOString();
    const availability = await this.availabilityService.find(
      reservation.outletId,
      input.date ?? local.slice(0, 10),
      input.time ?? local.slice(11, 16),
      input.partySize ?? reservation.partySize,
      reservation.id,
    );
    if (!availability.available || !availability.startAt || !availability.endAt) {
      throw new ConflictException({ code: 'SLOT_TAKEN', message: 'Slot tidak tersedia.' });
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.reservation.updateMany({
          where: { id: reservation.id, version: reservation.version, status: reservation.status },
          data: {
            startAt: availability.startAt,
            endAt: availability.endAt,
            tableId: availability.tables[0].id,
            partySize: input.partySize ?? reservation.partySize,
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
            version: { increment: 1 },
          },
        });
        if (updated.count !== 1) throw new ConflictException('Reservasi berubah. Silakan muat ulang.');
        const after = await tx.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
        await tx.auditEvent.create({
          data: {
            tenantId: reservation.tenantId,
            actorType: 'customer',
            actorId: reservation.customerId,
            action: 'reservation.updated',
            entityType: 'reservation',
            entityId: reservation.id,
            before: { startAt: reservation.startAt.toISOString(), partySize: reservation.partySize },
            after: { startAt: after.startAt.toISOString(), partySize: after.partySize },
          },
        });
        return after;
      });
    } catch (error) {
      if (this.isSlotConflict(error)) {
        throw new ConflictException({ code: 'SLOT_TAKEN', message: 'Slot baru saja diambil tamu lain.' });
      }
      throw error;
    }
  }

  async cancel(code: string, phoneLast4: string, actorId?: string, tenantId?: string) {
    const reservation = await this.verify(code, phoneLast4, tenantId);
    if (!['pending', 'confirmed'].includes(reservation.status)) {
      throw new ConflictException('Reservasi tidak dapat dibatalkan.');
    }

    // Use actorId if provided (e.g., admin/user who cancelled), otherwise use customerId
    const actualActorId = actorId || reservation.customerId;
    
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.reservation.updateMany({
        where: { id: reservation.id, status: reservation.status, version: reservation.version },
        data: { status: 'cancelled', version: { increment: 1 } },
      });
      if (updated.count !== 1) throw new ConflictException('Reservasi berubah. Silakan muat ulang.');
      const after = await tx.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      await tx.reservationStatusHistory.create({
        data: {
          tenantId: reservation.tenantId,
          reservationId: reservation.id,
          fromStatus: reservation.status,
          toStatus: 'cancelled',
          actorType: actualActorId === reservation.customerId ? 'customer' : 'staff',
          actorId: actualActorId,
          reason: 'Dibatalkan oleh pelanggan',
        },
      });
      
      await tx.auditEvent.create({
        data: {
          tenantId: reservation.tenantId,
          actorType: actualActorId === reservation.customerId ? 'customer' : 'staff',
          actorId: actualActorId,
          action: 'reservation.cancelled',
          entityType: 'reservation',
          entityId: reservation.id,
          before: { status: reservation.status },
          after: { status: 'cancelled' },
        },
      });
      
      return after;
    });
  }

  async expirePending(now = new Date()) {
    const expired = await this.prisma.reservation.findMany({
      where: { status: 'pending', expiresAt: { lte: now } },
      select: { id: true, tenantId: true },
    });
    if (expired.length === 0) return { expired: 0 };

    let count = 0;
    for (const item of expired) {
      await this.prisma.$transaction(async (tx) => {
        const changed = await tx.reservation.updateMany({
          where: { id: item.id, status: 'pending', expiresAt: { lte: now } },
          data: { status: 'expired', version: { increment: 1 } },
        });
        if (changed.count !== 1) return;
        await tx.reservationStatusHistory.create({
          data: {
            tenantId: item.tenantId,
            reservationId: item.id,
            fromStatus: 'pending',
            toStatus: 'expired',
            actorType: 'system',
            reason: 'Batas waktu konfirmasi reservasi telah lewat',
          },
        });
        await tx.auditEvent.create({
          data: {
            tenantId: item.tenantId,
            actorType: 'system',
            action: 'reservation.expired',
            entityType: 'reservation',
            entityId: item.id,
            before: { status: 'pending' },
            after: { status: 'expired' },
          },
        });
        count += 1;
      });
    }
    return { expired: count };
  }

  list(tenantId: string, query: ListReservationsDto) {
    const search = query.query?.trim();
    return this.prisma.reservation.findMany({
      where: {
        tenantId,
        ...(query.status ? { status: query.status } : {}),
        ...(search
          ? {
              OR: [
                { code: { contains: search, mode: 'insensitive' } },
                { customer: { name: { contains: search, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      include: {
        customer: { select: { name: true, phone: true } },
        outlet: { select: { name: true } },
        table: { select: { tableNumber: true } },
      },
      orderBy: { startAt: 'desc' },
    });
  }

  approve(tenantId: string, actorId: string, id: string) {
    return this.changeStatus(tenantId, actorId, id, 'confirmed');
  }

  reject(tenantId: string, actorId: string, id: string, reason?: string) {
    return this.changeStatus(tenantId, actorId, id, 'rejected', reason);
  }

  private async changeStatus(
    tenantId: string,
    actorId: string,
    id: string,
    status: ReservationStatus,
    reason?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const reservation = await tx.reservation.findFirst({ where: { id, tenantId } });
      if (!reservation) throw new NotFoundException('Reservasi tidak ditemukan.');
      if (reservation.status !== 'pending') {
        throw new ConflictException('Hanya reservasi pending yang dapat diproses.');
      }

      const updated = await tx.reservation.updateMany({
        where: { id, status: 'pending', version: reservation.version },
        data: {
          status,
          version: { increment: 1 },
          ...(status === 'rejected' ? { rejectionReason: reason ?? null } : {}),
        },
      });
      if (updated.count !== 1) throw new ConflictException('Status reservasi telah berubah.');
      const after = await tx.reservation.findUniqueOrThrow({ where: { id } });
      await tx.reservationStatusHistory.create({
        data: {
          tenantId,
          reservationId: id,
          fromStatus: reservation.status,
          toStatus: status,
          actorType: 'staff',
          actorId,
          reason,
        },
      });
      await tx.auditEvent.create({
        data: {
          tenantId,
          actorType: 'staff',
          actorId,
          action: `reservation.${status}`,
          entityType: 'reservation',
          entityId: id,
          before: { status: reservation.status },
          after: { status },
        },
      });
      return after;
    });
  }

  private isSlotConflict(error: unknown) {
    if (typeof error !== 'object' || error === null) return false;
    const { code, cause } = error as { code?: string; cause?: { code?: string } };
    return ['P2010', 'P2034', '23P01', '40P01'].includes(code ?? cause?.code ?? '');
  }

  private isIdempotencyConflict(error: unknown) {
    if (typeof error !== 'object' || error === null) return false;
    const { code, cause } = error as { code?: string; cause?: { code?: string } };
    return (code ?? cause?.code) === 'P2002';
  }

  private pendingTtlMinutes() {
    const configured = Number(process.env.RESERVATION_PENDING_TTL_MINUTES ?? 15);
    return Number.isFinite(configured) && configured > 0 ? configured : 15;
  }

  private async resolvePreOrderItems(
    tenantId: string,
    items: Array<{ menuItemId: string; quantity: number; notes?: string }>,
  ) {
    if (items.length === 0) throw new ConflictException('Pre-order harus memiliki minimal satu item.');
    const menuItems = await this.prisma.menuItem.findMany({
      where: { tenantId, isActive: true, isAvailable: true, id: { in: items.map((item) => item.menuItemId) } },
      select: { id: true, name: true, priceIdr: true },
    });
    const byId = new Map(menuItems.map((item) => [item.id, item]));
    if (byId.size !== new Set(items.map((item) => item.menuItemId)).size) {
      throw new ConflictException('Satu atau lebih menu tidak tersedia.');
    }
    return items.map((item) => {
      const menuItem = byId.get(item.menuItemId)!;
      return {
        menuItemId: menuItem.id,
        nameSnapshot: menuItem.name,
        unitPriceIdr: menuItem.priceIdr,
        quantity: item.quantity,
        lineTotalIdr: menuItem.priceIdr * item.quantity,
        notes: item.notes,
      };
    });
  }
}
