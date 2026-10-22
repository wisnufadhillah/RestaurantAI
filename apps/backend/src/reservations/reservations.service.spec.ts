import { ConflictException } from '@nestjs/common';
import { ReservationsService } from './reservations.service';

describe('ReservationsService', () => {
  const reservation = { id: 'reservation-1', status: 'pending' };
  const prisma = {
    reservation: {
      findFirst: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    },
    reservationStatusHistory: { create: jest.fn() },
    auditEvent: { create: jest.fn() },
    $transaction: jest.fn((work) => work(prisma)),
  };
  const service = new ReservationsService(
    prisma as never,
    { find: jest.fn() } as never,
  );

  beforeEach(() => jest.clearAllMocks());

  it('expires overdue pending reservations, including records without expiresAt', async () => {
    prisma.reservation.findMany.mockResolvedValue([{ id: 'res-1', tenantId: 'tenant-1' }]);
    (prisma.reservation as any).updateMany = jest.fn().mockResolvedValue({ count: 1 });

    const now = new Date('2026-10-20T12:00:00.000Z');
    const result = await service.expirePending(now);
    expect(result.expired).toBe(1);
    expect(prisma.reservation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: 'pending',
        OR: expect.arrayContaining([
          { expiresAt: { lte: now } },
          { startAt: { lte: now } },
        ]),
      }),
    }));
    expect(prisma.reservationStatusHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fromStatus: 'pending', toStatus: 'expired', actorType: 'system' }),
      }),
    );
  });

  it('confirms a pending reservation and records its history', async () => {
    prisma.reservation.findFirst.mockResolvedValue(reservation);
    (prisma.reservation as any).updateMany = jest.fn().mockResolvedValue({ count: 1 });
    (prisma.reservation as any).findUniqueOrThrow = jest
      .fn()
      .mockResolvedValue({ ...reservation, status: 'confirmed' });

    await expect(service.approve('tenant-1', 'staff-1', reservation.id)).resolves.toMatchObject({
      status: 'confirmed',
    });
    expect(prisma.reservationStatusHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fromStatus: 'pending', toStatus: 'confirmed' }),
      }),
    );
  });

  it('does not process a reservation that is no longer pending', async () => {
    prisma.reservation.findFirst.mockResolvedValue({ ...reservation, status: 'confirmed' });

    await expect(service.approve('tenant-1', 'staff-1', reservation.id)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('marks confirmed reservation as no show and records its history', async () => {
    prisma.reservation.findFirst.mockResolvedValue({
      id: 'res-no-show',
      tenantId: 'tenant-1',
      status: 'confirmed',
      version: 1,
    });
    (prisma.reservation as any).updateMany = jest.fn().mockResolvedValue({ count: 1 });
    (prisma.reservation as any).findUniqueOrThrow = jest
      .fn()
      .mockResolvedValue({ id: 'res-no-show', status: 'no_show' });

    await expect(service.markNoShow('tenant-1', 'staff-1', 'res-no-show')).resolves.toMatchObject({
      status: 'no_show',
    });
    expect(prisma.reservationStatusHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fromStatus: 'confirmed', toStatus: 'no_show', actorType: 'staff' }),
      }),
    );
  });

  it('marks confirmed reservation as completed', async () => {
    prisma.reservation.findFirst.mockResolvedValue({
      id: 'res-complete',
      tenantId: 'tenant-1',
      status: 'confirmed',
      version: 1,
    });
    (prisma.reservation as any).updateMany = jest.fn().mockResolvedValue({ count: 1 });
    (prisma.reservation as any).findUniqueOrThrow = jest
      .fn()
      .mockResolvedValue({ id: 'res-complete', status: 'completed' });

    await expect(service.complete('tenant-1', 'staff-1', 'res-complete')).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('records history and audit data when a customer cancels', async () => {
    prisma.reservation.findFirst.mockResolvedValue({
      ...reservation,
      tenantId: 'tenant-1',
      customerId: 'customer-1',
    });
    (prisma.reservation as any).updateMany = jest.fn().mockResolvedValue({ count: 1 });
    (prisma.reservation as any).findUniqueOrThrow = jest
      .fn()
      .mockResolvedValue({ ...reservation, status: 'cancelled' });

    await expect(service.cancel('RSV-123', '1234')).resolves.toMatchObject({ status: 'cancelled' });
    expect(prisma.reservationStatusHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fromStatus: 'pending', toStatus: 'cancelled', actorType: 'customer' }),
      }),
    );
    expect(prisma.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'reservation.cancelled' }) }),
    );
  });

  it('scopes verification to the requested tenant when one is provided', async () => {
    prisma.reservation.findFirst.mockResolvedValue(null);

    await expect(service.verify('RSV-123', '1234', 'tenant-1')).rejects.toThrow('Reservasi tidak ditemukan.');
    expect(prisma.reservation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ code: 'RSV-123', tenantId: 'tenant-1' }),
      }),
    );
  });

  it('updates reservation details within cutoff window and records history & audit', async () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60_000);
    const existing = {
      id: 'res-update-1',
      tenantId: 'tenant-1',
      customerId: 'cust-1',
      outletId: 'outlet-1',
      version: 1,
      partySize: 2,
      status: 'pending',
      startAt: futureDate,
      outlet: { changeCutoffMinutes: 120 },
      table: { tableNumber: 'T1' },
      customer: { name: 'Budi', phone: '081234567890' },
    };

    prisma.reservation.findFirst.mockResolvedValue(existing);
    (service as any).availabilityService.find = jest.fn().mockResolvedValue({
      available: true,
      tables: [{ id: 'tbl-new' }],
      startAt: new Date(futureDate.getTime() + 60 * 60_000),
      endAt: new Date(futureDate.getTime() + 150 * 60_000),
    });
    (prisma.reservation as any).updateMany = jest.fn().mockResolvedValue({ count: 1 });
    (prisma.reservation as any).findUniqueOrThrow = jest.fn().mockResolvedValue({
      ...existing,
      partySize: 4,
      version: 2,
    });

    const updated = await service.update('RSV-XYZ', {
      phoneLast4: '7890',
      partySize: 4,
    });

    expect(updated.partySize).toBe(4);
    expect(prisma.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'reservation.updated',
          entityId: 'res-update-1',
        }),
      }),
    );
  });

  it('rejects reservation update when cutoff time has passed', async () => {
    const pastCutoff = new Date(Date.now() + 30 * 60_000); // Only 30 mins before, but cutoff is 120 mins
    const existing = {
      id: 'res-update-2',
      status: 'pending',
      startAt: pastCutoff,
      outlet: { changeCutoffMinutes: 120 },
      customer: { phone: '081234567890' },
    };

    prisma.reservation.findFirst.mockResolvedValue(existing);

    await expect(
      service.update('RSV-XYZ', { phoneLast4: '7890', partySize: 3 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('persists the idempotency key and an expiry for a new pending reservation', async () => {
    const now = new Date('2026-10-22T03:00:00Z');
    jest.useFakeTimers({ now });
    const tx: any = {
      $executeRaw: jest.fn(),
      reservation: { create: jest.fn().mockResolvedValue({ code: 'RSV-NEW', status: 'pending' }) },
    };
    const prismaForCreate: any = {
      outlet: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'outlet-1', tenantId: 'tenant-1' }) },
      reservation: { findFirst: jest.fn().mockResolvedValue(null) },
      customer: { upsert: jest.fn().mockResolvedValue({ id: 'customer-1' }) },
      $transaction: jest.fn((work: any) => work(tx)),
    };
    const createService = new ReservationsService(prismaForCreate, {
      find: jest.fn().mockResolvedValue({
        available: true,
        tables: [{ id: 'table-1' }],
        startAt: new Date('2026-10-23T12:00:00Z'),
        endAt: new Date('2026-10-23T13:30:00Z'),
      }),
    } as never);

    await createService.create({
      outletId: 'outlet-1', date: '2026-10-23', time: '19:00', partySize: 2,
      name: 'Budi', phone: '081234567890', idempotencyKey: 'request-1',
    });

    expect(tx.reservation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ idempotencyKey: 'request-1', expiresAt: new Date(now.getTime() + 15 * 60_000) }),
    }));
    jest.useRealTimers();
  });

  it('rejects unavailable pre-order menu items instead of trusting client prices', async () => {
    const preOrderService = new ReservationsService({
      menuItem: { findMany: jest.fn().mockResolvedValue([]) },
    } as never, {} as never);

    await expect((preOrderService as any).resolvePreOrderItems('tenant-1', [
      { menuItemId: 'other-tenant-menu', quantity: 1 },
    ])).rejects.toBeInstanceOf(ConflictException);
  });
});
