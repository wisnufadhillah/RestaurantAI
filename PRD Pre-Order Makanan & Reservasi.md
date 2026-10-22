# PRD — Pre-Order Makanan untuk Reservasi

**Status:** Draft disetujui untuk MVP  
**Pemilik:** RestaurantAI  
**Masalah yang diselesaikan:** Customer ingin memilih dan memesan makanan sebelum tiba, sehingga meja dan pesanan siap saat mereka datang.

## 1. Latar Belakang

Saat ini chatbot hanya dapat mencari menu dan membuat reservasi meja. Ketika customer berkata, “Saya ingin pesan makanan supaya saat datang tinggal makan,” bot menolak karena belum ada flow maupun data order.

Hasilnya bertentangan dengan ekspektasi customer: reservasi meja tidak otomatis mempercepat pengalaman makan jika makanan tetap harus dipesan saat tiba.

## 2. Tujuan

- Customer dapat membuat reservasi meja beserta pre-order makanan dalam satu percakapan singkat.
- Customer dapat melihat item, jumlah, catatan, dan estimasi total sebelum konfirmasi.
- Restoran menerima pre-order yang terhubung ke reservasi dan dapat menyiapkan makanan pada waktu yang tepat.
- Flow aman: perubahan data dan submit pesanan hanya terjadi setelah konfirmasi eksplisit.

## 3. Bukan Tujuan MVP

- Pembayaran online, refund, promo, pajak kompleks, dan integrasi POS nyata.
- Pengiriman makanan, takeaway tanpa reservasi, atau manajemen inventori real-time.
- Menjamin makanan selalu siap tepat saat tiba; restoran tetap menentukan waktu mulai memasak.

## 4. Pengguna dan User Story

| Pengguna | User story |
| --- | --- |
| Customer | Saya ingin memilih makanan saat membuat reservasi supaya saat tiba tidak perlu menunggu lama. |
| Customer | Saya ingin melihat total dan detail pesanan sebelum menyetujui. |
| Customer | Saya ingin mengubah atau membatalkan pre-order sebelum batas waktu restoran. |
| Staff restoran | Saya ingin melihat pre-order per jadwal kedatangan agar dapur dapat menyiapkan makanan. |
| Dapur | Saya ingin hanya melihat pesanan yang sudah dikonfirmasi, dengan waktu kedatangan dan catatan yang jelas. |

## 5. Flow MVP yang Diusulkan

### A. Chatbot: reservasi + pre-order

1. Customer menyebutkan atau mengisi booking cepat: cabang, tanggal, jam, jumlah tamu, nama, dan nomor telepon.
2. Bot mengecek ketersediaan meja.
3. Bot menanyakan dalam satu pesan: “Mau pre-order makanan juga?”
4. Customer menyebut item dan jumlah, misalnya “2 rendang, 1 ayam pop, 2 es teh.”
5. Bot mencari menu, meminta klarifikasi hanya untuk item/jumlah yang ambigu atau tidak tersedia.
6. Bot menampilkan ringkasan singkat: jadwal, item x jumlah, catatan, dan estimasi total.
7. Customer membalas “ya”.
8. Server membuat reservasi dan pre-order secara atomik/terhubung; bot mengirim kode tiket.

### B. Booking cepat di UI

1. Customer menekan **Pesan cepat**.
2. Mengisi data reservasi minimum.
3. Setelah availability berhasil, UI menampilkan pilihan **Tambah makanan** atau **Lewati**.
4. Customer memilih item, quantity, dan catatan.
5. UI menampilkan ringkasan dan tombol **Konfirmasi booking & pre-order**.

### C. Checkout/payment dummy (MVP)

1. Setelah ringkasan, customer melihat total estimasi dan satu metode pembayaran: **Bayar saat datang**.
2. Customer menekan **Konfirmasi booking & pre-order**.
3. Sistem menyimpan `paymentMethod = pay_at_venue` dan `paymentStatus = pending`; tidak ada charge, gateway, invoice pajak, atau saldo yang diproses.
4. Tiket menampilkan: “Pembayaran dilakukan saat tiba di restoran.”
5. Staff dapat menandai pembayaran `paid` secara manual pada fase operasional berikutnya.

### D. Operasional restoran

1. Staff melihat daftar reservasi dengan badge `Pre-order`.
2. Staff/dapur melihat daftar item yang perlu disiapkan, dikelompokkan menurut jam kedatangan.
3. Staff dapat menandai `accepted`, `preparing`, `ready`, atau `unavailable`.
4. Jika item tidak tersedia, staff menghubungi customer atau menandai item untuk ditindaklanjuti.

## 6. Status dan Aturan Bisnis

### Status pre-order

`draft` → `confirmed` → `accepted` → `preparing` → `ready` → `served`

Status terminal: `cancelled`, `rejected`.

### Aturan utama

- Hanya menu aktif dan tersedia yang dapat ditambahkan.
- Harga disimpan sebagai snapshot saat customer mengonfirmasi; perubahan harga menu berikutnya tidak mengubah total lama.
- Pre-order terkait tepat satu reservasi dan tenant yang sama.
- Pengubahan/pembatalan mengikuti `changeCutoffMinutes` outlet yang sudah ada.
- Reservasi yang expired, cancelled, atau rejected tidak boleh memiliki pre-order aktif.
- Jika reservasi belum dikonfirmasi oleh customer, pre-order hanya `draft` dan tidak terlihat sebagai pekerjaan dapur.
- Harga adalah estimasi hingga restoran menerima pesanan, kecuali kebijakan bisnis kemudian menetapkan harga terkunci.

## 7. Data Model MVP

### `PreOrder`

- `id`, `tenantId`, `reservationId`, `status`
- `subtotalIdr`, `notes`
- `paymentMethod` (`pay_at_venue`), `paymentStatus` (`pending` pada checkout dummy)
- `confirmedAt`, `acceptedAt`, `readyAt`, `createdAt`, `updatedAt`

### `PreOrderItem`

- `id`, `preOrderId`, `menuItemId`
- `nameSnapshot`, `unitPriceIdr`, `quantity`, `lineTotalIdr`
- `notes`, `status`

Relasi wajib:

- `Reservation 1 : 0..1 PreOrder`
- `PreOrder 1 : 1..n PreOrderItem`
- Semua tenant ID harus konsisten pada reservation, order, dan menu item.

## 8. API/Tool yang Diperlukan

| Capability | Bentuk MVP |
| --- | --- |
| Cari menu | Gunakan `search_menu` yang sudah ada, tambah validasi ketersediaan per outlet bila diperlukan. |
| Draft pre-order | Tool internal `prepare_preorder` menyimpan draft pada chat session, belum menulis order final. |
| Konfirmasi | Tool `confirm_reservation_with_preorder` membuat reservation + pre-order setelah respons “ya”. |
| Lihat pre-order | `GET /reservations/:code/preorder` dengan tenant scope dan verifikasi customer. |
| Ubah/batal | Endpoint/tool mengikuti cutoff dan version check. |
| Admin/dapur | `GET /admin/preorders` dengan filter outlet, tanggal, jam, dan status. |

## 9. Acceptance Criteria

- Customer dapat menyelesaikan reservasi + pre-order dalam maksimal: isi data → pilih makanan → satu konfirmasi.
- Bot tidak menolak permintaan pre-order; bot mengarahkan ke flow yang benar.
- Bot tidak membuat reservation/order sebelum konfirmasi eksplisit.
- Total item dihitung dari snapshot harga dan quantity.
- Item lintas tenant/outlet tidak dapat dimasukkan ke order.
- Retry request dengan idempotency key yang sama tidak membuat order/reservasi ganda.
- Admin hanya melihat pre-order tenant miliknya.
- Semua perubahan status dan pembatalan memiliki audit event.
- Test mencakup item unavailable, batas cutoff, concurrency, idempotency, tenant leak, dan malformed tool call.

## 10. Metrik Keberhasilan

- Rasio reservasi yang menyertakan pre-order.
- Median jumlah chat turn sampai booking berhasil.
- Waktu tunggu customer dari kedatangan sampai makanan pertama disajikan.
- Rasio pre-order dibatalkan/rejected.
- Rasio item yang perlu klarifikasi atau tidak tersedia.

## 11. Keputusan yang Dibutuhkan Sebelum Implementasi

1. Apakah pre-order langsung dianggap pesanan dapur nyata, atau perlu staff acceptance terlebih dahulu?
2. Berapa menit sebelum waktu kedatangan customer masih dapat mengubah/membatalkan pre-order?
3. Apakah harga dikunci saat konfirmasi atau hanya estimasi hingga staff menerima pesanan?
4. Apakah payment dilakukan saat datang, DP, atau pembayaran penuh online pada fase berikutnya?
5. Apakah semua outlet mendukung pre-order dan apakah setiap menu tersedia di semua outlet?

## 12. Rencana Delivery

### Fase 1 — Data dan admin

- Prisma migration: `PreOrder` dan `PreOrderItem`.
- Service, audit event, tenant validation, dan halaman admin daftar pre-order.

### Fase 2 — Flow customer

- Form tambah makanan pada booking cepat.
- Ringkasan, konfirmasi, dan pengelolaan customer.

### Fase 3 — AI dan operasional

- Tool pre-order chatbot, draft session, dan guardrail konfirmasi.
- Tampilan dapur/status persiapan.

### Fase 4 — Opsional

- Pembayaran, integrasi POS, stok, notifikasi WhatsApp, dan analytics.
