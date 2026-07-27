# AI-Ready Specification — Dynamic Appointment Rescheduling & Waiting List Management

> **Đây là gói đặc tả tự chứa (self-contained AI-Ready Specification Package)** — kết tinh toàn bộ Activity 1 (Requirement) và Activity 2 (Architecture & Design) của Day 2. AI Developer đọc **một mình mục 1–8** là đủ để implement, không phải hỏi lại và không phải tự giả định.
>
> **Khác biệt với Architecture Blueprint (Day 2, Bước 1–8):** Blueprint trả lời *“thiết kế thế nào”*; tài liệu này trả lời *“code chính xác cái gì”*. Mọi tham số có **giá trị cụ thể**, mọi endpoint có **contract đầy đủ**, mọi component trỏ tới **file thật** trong repo.
>
> **Thứ tự ưu tiên:** khi tài liệu này mâu thuẫn với Blueprint Bước 1–8, **tài liệu này là bản có hiệu lực**. Bước 1–8 ghi lại *quá trình suy nghĩ* (còn “Cần xác nhận”); tài liệu này ghi lại *kết quả đã chốt*.

**Ba chỗ tài liệu này ghi đè Blueprint Bước 1–8:**

1. Cách diễn đạt “tạm giữ slot” ở AC-01 và Main Interaction Flow bước 3 → thay bằng **BR-03 (KHÔNG hold slot)**.
2. Data Model Extension (Bước 6) có `specialization_id` và `priority` → **mục 4 bỏ cả hai cột** (giải thích ở bảng dưới khối DDL).
3. Impact Analysis xếp US-06 là “Extend / Reuse Notification Service / Low” → **mục 1 & BR-05 xác định Notification là component MỚI phải xây**.

---

## 1. Context & Scope

- **Tính năng:** Dynamic Appointment Rescheduling and Waiting List Management
- **Hệ thống nền:** MedBook — Node.js + Express + PostgreSQL, kiến trúc phân lớp `routes → services → repositories → pool (pg)`. Auth demo bằng header `X-Demo-User-Id`, 2 vai trò: `patient` và `staff`.
- **Phương án kiến trúc đã chốt:** Phương án B — Waiting List Module + Offer Manager **bên trong monolith hiện tại** (không thêm hạ tầng, không message queue).

### In Scope
- Đăng ký / rời danh sách chờ theo bác sĩ + khoảng ngày (US-01)
- Tự động phát hiện slot trống và chào offer cho bệnh nhân đủ điều kiện (US-03)
- Bệnh nhân chấp nhận / từ chối offer (US-02)
- Hết hạn offer → chuyển bệnh nhân kế tiếp (US-04)
- Thông báo in-app lưu trong DB (US-06)
- Staff xem danh sách chờ và offer đang chạy — **chỉ đọc** ở MVP (US-05 một phần)
- Bệnh nhân xem vị trí của mình trong hàng đợi (US-07)

### Out of Scope
- SMS / email / push thật — chỉ thông báo in-app
- Thanh toán, bảo hiểm, đồng bộ calendar ngoài
- Dự đoán no-show bằng ML, thuật toán ưu tiên nâng cao
- Staff gán thủ công / đổi thứ tự hàng đợi (xem OQ-03)
- Tự đổi sang bác sĩ khác chuyên khoa

### Ràng buộc bắt buộc
- **KHÔNG** thiết kế lại MedBook; giữ nguyên kiến trúc phân lớp hiện có
- **KHÔNG** sửa `CHECK` constraint của bảng `slots` (xem BR-03)
- **KHÔNG** thêm hạ tầng ngoài (queue, cron server, redis)
- Giữ nguyên partial unique index `one_active_appointment_per_slot` làm chốt chặn cuối
- Toàn bộ thông báo lỗi trả về cho người dùng **bằng tiếng Việt**

### ĐÍNH CHÍNH so với mô tả bối cảnh trong workbook
- MedBook hiện **KHÔNG có Notification Service**. Kiểm chứng: `src/services/` chỉ có `appointmentService.js`, `authService.js`, `slotService.js`. → Thông báo là **component MỚI** phải xây (xem BR-05), không phải component tái sử dụng.
- MedBook cũng **KHÔNG có API đổi lịch (reschedule)** — chỉ có huỷ lịch. Nguồn sinh slot trống vì vậy là **2 luồng ở BR-07**, không phải “huỷ/đổi lịch”.

---

## 2. Frozen Business Rules

Đây là các quyết định **ĐÃ CHỐT** cho MVP. AI Developer không được tự thay đổi. Mọi thứ không nằm trong bảng này mà cũng không nằm ở mục 8 (Open Questions) thì **phải hỏi lại**, không được tự suy diễn.

### BR-01 — Chọn bệnh nhân: lọc eligibility TRƯỚC, rồi FIFO
Bệnh nhân **đủ điều kiện** cho slot `S` của bác sĩ `D` khi thoả **ĐỒNG THỜI** 4 điều kiện:
- (a) `waitlist_entries.doctor_id = S.doctor_id`
- (b) `waitlist_entries.status = 'active'`
- (c) `S.date` nằm trong `[date_from, date_to]`
- (d) bệnh nhân **KHÔNG** có appointment `status IN ('booked','confirmed')` trùng khung giờ với `S` (cùng `date` và khoảng `[start_time, end_time)` giao nhau)

**Sắp xếp:** `created_at ASC`, tie-break bằng `id ASC`.
**Loại thêm:** bệnh nhân đang có offer `pending` khác (xem BR-06).

*Lý do:* Nếu chỉ FIFO theo `created_at` mà bỏ (a)(c)(d) thì sẽ chào slot cho bệnh nhân sai bác sĩ, sai khoảng ngày, hoặc tạo lịch trùng giờ.

### BR-02 — Thời hạn phản hồi offer = 15 phút, job quét mỗi 60 giây
- `OFFER_TIMEOUT_MINUTES = 15` (đọc từ `process.env`, mặc định 15)
- `OFFER_JOB_INTERVAL_MS = 60000` (đọc từ `process.env`, mặc định 60000)
- `expires_at = notified_at + OFFER_TIMEOUT_MINUTES` (xem BR-05)
- **Sai số cho phép:** offer có thể sống thêm tối đa 60s sau `expires_at` trước khi job xử lý.

*Lý do:* Không có giá trị cụ thể thì test timeout không có mốc để assert, và mỗi AI sẽ chọn một con số khác nhau.

### BR-03 — KHÔNG tạm giữ (hold) slot
Slot giữ nguyên `status = 'available'` trong suốt thời gian offer `pending`. Chống đặt trùng bằng **3 lớp**, KHÔNG bằng trạng thái slot:
- **L1 — offer:** `UPDATE appointment_offers SET status='accepted', responded_at=now() WHERE id=$1 AND status='pending' RETURNING *` → không có row trả về nghĩa là **thua cuộc**.
- **L2 — slot:** `SELECT ... FROM slots WHERE id=$1 FOR UPDATE` trong cùng transaction, kiểm tra `status='available'`.
- **L3 — DB:** partial unique index `one_active_appointment_per_slot` (đã có sẵn) là **chốt chặn cuối**.

*Lý do:* Bảng `slots` hiện có `CHECK (status IN ('available','booked'))` tại `src/db/migrate.js` — không tồn tại trạng thái nào để “giữ chỗ”. Thêm trạng thái mới đồng nghĩa sửa constraint của một bảng đang chạy, ảnh hưởng `slotService` và toàn bộ luồng đặt lịch hiện có. Quy tắc này thay thế mọi cách diễn đạt “tạm giữ slot” ở AC-01 và Interaction Flow bước 3.

### BR-04 — Hook `SlotAvailable` chạy SAU khi transaction commit; lỗi hook KHÔNG làm hỏng thao tác gốc
- **Vị trí:** `src/services/appointmentService.js`, hàm `cancelAppointment` — đặt **sau** `await client.query('commit')` và **sau** `client.release()`, **trước** câu `return`.
- **Bọc try/catch:** nếu `offerService.onSlotAvailable` ném lỗi thì log ra console và nuốt lỗi; huỷ lịch vẫn trả `200`.

*Lý do:* Gọi bên trong transaction sẽ tạo offer + gửi thông báo cho một slot có thể bị rollback ngay sau đó. Ngược lại, để lỗi tạo offer làm fail luôn việc huỷ lịch là hạ cấp một chức năng đang chạy ổn định.

### BR-05 — Notification là module MỚI (in-app, ghi bảng `notifications`); đồng hồ timeout chỉ chạy sau khi ghi thông báo thành công
Trình tự trong `offerService.createOffer`:
1. tạo offer `status='pending'` với `expires_at` tạm = `null`
2. `notificationService.notifyOffer()` ghi bảng `notifications`
3. `UPDATE offer SET notified_at=now(), expires_at=now() + interval '15 minutes'`

Nếu bước (2) thất bại: offer chuyển `'superseded'`, ghi log, tạo notification cho staff, và chào bệnh nhân kế tiếp.

*Lý do:* Cho phép mitigation “chỉ đếm timeout sau khi notify thành công” (Bước 7) trở nên implement được. Không có bảng `notifications` thì rủi ro này không thể xử lý.

### BR-06 — Tối đa 1 offer pending / slot và 1 offer pending / bệnh nhân, cưỡng chế ở tầng DB
- Hai partial unique index: `one_pending_offer_per_slot (slot_id) WHERE status='pending'` và `one_pending_offer_per_patient (patient_id) WHERE status='pending'`.
- Khi chọn bệnh nhân theo BR-01, loại bỏ bệnh nhân đang có offer `pending`.

*Lý do:* Chỉ kiểm ở tầng service thì hai tiến trình song song vẫn tạo được 2 offer cho cùng 1 slot.

### BR-07 — Có ĐÚNG 2 nguồn sinh sự kiện `SlotAvailable`
1. `POST /api/appointments/:id/cancel` — bệnh nhân hoặc staff huỷ lịch (`appointmentService.cancelAppointment`, slot chuyển về `'available'`).
2. `PUT /api/slots/:id` — staff sửa slot từ `'booked'` về `'available'` (`src/routes/doctors.routes.js` → `slotService`). **Chỉ** kích hoạt khi status thực sự chuyển `booked → available`.

*Lý do:* MedBook không có API reschedule. Nguồn (2) đã bị bỏ sót ở Impact Analysis và API Change Catalogue, dù R-07 có nhắc tới edge case staff can thiệp slot.

### BR-08 — Vòng đời `waitlist_entry` gắn với kết quả offer
- offer `accepted` → `waitlist_entry.status = 'fulfilled'`
- offer `declined` / `expired` → `waitlist_entry` giữ nguyên `'active'` (bệnh nhân vẫn ở hàng đợi, vẫn được chào slot lần sau)
- bệnh nhân `DELETE` entry khi đang có offer `pending` → offer chuyển `'superseded'` và slot được chào lại cho bệnh nhân kế tiếp
- `date_to` đã qua → entry chuyển `'expired'` (job quét cùng lúc với offer expiry)

*Lý do:* Không nói rõ thì AI sẽ xoá bệnh nhân khỏi hàng đợi ngay khi họ từ chối một offer — vi phạm tinh thần công bằng ở Business Goal.

> **Ghi chú cho giảng viên (không phát cho học viên):** BR-01 và BR-03 chính là hai lỗ hổng mà đáp án Day 3 ghi nhận thành **CR-02** (thiếu điều kiện eligibility) và **CR-01** (double booking do không khoá). Nếu muốn giữ nguyên bài học “AI sinh code sai vì spec thiếu”, hãy phát cho học viên bản **đã ẩn BR-01 và BR-03**, và dùng bản đầy đủ này làm đáp án đối chiếu ở cuối Day 3.

---

## 3. User Stories & Acceptance Criteria

**Phạm vi implement Day 3:** US-01, US-02, US-03, US-04 (Must). US-06 làm ở mức tối thiểu (ghi bảng `notifications`). US-05 chỉ làm phần đọc; US-07 làm phần tính `position`.

| US | Nội dung | MoSCoW | AC |
|---|---|---|---|
| US-01 | Bệnh nhân đăng ký vào danh sách chờ của một bác sĩ | Must | AC-11 → AC-15 |
| US-02 | Bệnh nhân nhận, chấp nhận hoặc từ chối offer | Must | AC-21 → AC-25 |
| US-03 | Hệ thống tự động chọn bệnh nhân và gửi offer khi slot trống | Must | AC-01 → AC-05 |
| US-04 | Hết thời gian chờ → chuyển sang bệnh nhân kế tiếp | Must | AC-41 → AC-44 |
| US-05 | Staff xem và điều chỉnh danh sách chờ / offer | Should | Chỉ phần đọc — xem OQ-03 |
| US-06 | Staff được thông báo khi slot được lấp tự động hoặc có ngoại lệ | Should | Gộp trong AC-42 |
| US-07 | Bệnh nhân xem vị trí của mình trong hàng đợi | Could | Gộp trong AC-11, AC-16 |

### AC — US-03 (Hệ thống tự động chọn bệnh nhân & gửi offer khi có slot trống)

| AC ID | Loại | Given | When | Then |
|---|---|---|---|---|
| AC-01 | Happy Path | Có ≥1 bệnh nhân đủ điều kiện (BR-01) trong waiting list của bác sĩ D và một slot S của D vừa chuyển sang `available` | Hệ thống xử lý sự kiện `SlotAvailable` | Chọn bệnh nhân đầu danh sách theo BR-01, tạo offer `pending` cho slot S, gửi thông báo; **slot giữ nguyên `available`** (BR-03) |
| AC-02 | Alternative | Bệnh nhân đang được mời nhận slot S | Bệnh nhân xác nhận nhận slot trong thời hạn | Tạo appointment `booked`, slot S → `booked`, `waitlist_entry → 'fulfilled'`, gửi xác nhận |
| AC-03 | Exception | Bệnh nhân đang được mời nhận slot S | Bệnh nhân từ chối lời mời | Huỷ offer (`declined`), slot S giữ `available`, chuyển lời mời sang bệnh nhân kế tiếp (nếu có) |
| AC-04 | Timeout | Bệnh nhân được mời không phản hồi | Quá `OFFER_TIMEOUT_MINUTES` | Offer → `expired`, ghi log timeout, chuyển sang bệnh nhân kế; nếu hết danh sách, slot vẫn `available` và thông báo staff |
| AC-05 | Conflict | Bệnh nhân được mời đã có lịch trùng giờ với S, hoặc slot S vừa bị người khác đặt | Bệnh nhân cố xác nhận nhận slot S | Từ chối (409), không tạo lịch trùng, chuyển offer sang bệnh nhân kế tiếp |

### AC — US-01 (Đăng ký danh sách chờ)

| AC ID | Loại | Given | When | Then |
|---|---|---|---|---|
| AC-11 | Happy Path | Bệnh nhân P đăng nhập (role patient), bác sĩ D tồn tại, `dateFrom ≤ dateTo` và `dateFrom ≥ hôm nay`, P chưa có entry active nào cho D | P gọi `POST /api/waitlist` với `{ doctorId, dateFrom, dateTo }` | Tạo `waitlist_entry status='active'`; trả `201` kèm `{ id, doctorId, dateFrom, dateTo, status, position }` với `position` là thứ hạng FIFO trong hàng đợi của D |
| AC-12 | Alternative | P đã có một entry `status='active'` cho cùng bác sĩ D | P gọi `POST /api/waitlist` cho D lần nữa | Trả `409 { error: 'Bạn đã ở trong danh sách chờ của bác sĩ này' }`; KHÔNG tạo entry thứ hai (cưỡng chế bởi index `one_active_waitlist_per_patient_doctor`) |
| AC-13 | Exception — dữ liệu không hợp lệ | `dateFrom > dateTo`, hoặc thiếu trường bắt buộc, hoặc `doctorId` không tồn tại | P gọi `POST /api/waitlist` | Trả `400` khi sai định dạng / khoảng ngày; trả `404` khi `doctorId` không tồn tại. Không tạo bản ghi trong cả hai trường hợp |
| AC-14 | Rời hàng đợi | Entry E `status='active'` thuộc chính bệnh nhân P | P gọi `DELETE /api/waitlist/:id` | E → `status='cancelled'`, trả `200`. Nếu E đang gắn offer `pending` thì offer đó → `superseded` và hệ thống chào slot cho bệnh nhân kế tiếp (BR-08) |
| AC-15 | Exception — phân quyền | Entry E thuộc bệnh nhân khác, hoặc người gọi có `role='staff'` | Gọi `DELETE /api/waitlist/:id` | Trả `403 { error: 'Không đủ quyền' }`; dữ liệu không thay đổi |
| AC-16 | US-07 — xem vị trí | P có 2 entry active ở 2 bác sĩ khác nhau | P gọi `GET /api/my-waitlist` | Trả `200` với mảng entry của riêng P, mỗi phần tử kèm `position`; **KHÔNG lộ** tên/id bệnh nhân khác (NFR-05) |

### AC — US-02 (Nhận & phản hồi offer)

| AC ID | Loại | Given | When | Then |
|---|---|---|---|---|
| AC-21 | Happy Path | Offer O `status='pending'` thuộc P, `now < O.expires_at`, slot S vẫn `available` | P gọi `POST /api/offers/:id/accept` | Trong MỘT transaction: O → `accepted` (`UPDATE ... WHERE status='pending' RETURNING`); `SELECT slot FOR UPDATE` kiểm tra available; tạo appointment `booked`; slot → `booked`; `waitlist_entry → 'fulfilled'`. Trả `201` kèm appointment |
| AC-22 | Alternative — từ chối | Offer O `status='pending'` thuộc P | P gọi `POST /api/offers/:id/decline` | O → `declined`, `responded_at=now()`; slot S giữ `available`; `waitlist_entry` của P giữ `active` (BR-08); chào bệnh nhân kế tiếp theo BR-01. Trả `200` |
| AC-23 | Exception — offer hết hạn | `now > O.expires_at`, hoặc O.status đã là `expired`/`superseded`/`declined` | P gọi `POST /api/offers/:id/accept` | Trả `409 { error: 'Lời mời đã hết hạn' }`; KHÔNG tạo appointment; không đổi trạng thái slot |
| AC-24 | Exception — phân quyền | Offer O thuộc bệnh nhân khác | P gọi accept/decline trên O | Trả `403 { error: 'Không đủ quyền' }`; O không đổi trạng thái |
| AC-25 | Xem offer đang chờ | P đang có 1 offer pending | P gọi `GET /api/my-offers` | Trả `200` với offer kèm thông tin slot (bác sĩ, ngày, giờ), `expiresAt` và `secondsRemaining` để UI đếm ngược |

### AC — US-04 (Timeout & chuyển tiếp)

| AC ID | Loại | Given | When | Then |
|---|---|---|---|---|
| AC-41 | Happy Path | Offer O `status='pending'`, `now > O.expires_at`, hàng đợi còn bệnh nhân đủ điều kiện theo BR-01 | Job `offerExpiryJob` chạy (chu kỳ 60s, BR-02) | O → `expired`; ghi log timeout; tạo offer mới cho bệnh nhân kế tiếp và gửi thông báo |
| AC-42 | Alternative — hết danh sách | Offer O hết hạn và KHÔNG còn bệnh nhân đủ điều kiện | Job chạy | O → `expired`; slot giữ `available`; KHÔNG tạo offer mới; tạo notification cho **toàn bộ user role='staff'** (US-06) |
| AC-43 | Exception — idempotency | Hai lần chạy job chồng lên nhau cùng xử lý offer O | Cả hai cùng gọi expire trên O | Chỉ MỘT lần đổi trạng thái thành công nhờ `UPDATE ... WHERE status='pending' RETURNING`; lần còn lại không nhận row và dừng. Chỉ tạo ĐÚNG MỘT offer kế tiếp |
| AC-44 | Exception — đua job vs người dùng | Bệnh nhân bấm accept đúng lúc job đang expire cùng offer đó | Hai thao tác gần như đồng thời | Đúng một thao tác thắng. Accept thắng → job không thấy offer pending; job thắng → accept trả `409 'Lời mời đã hết hạn'`. Không tạo appointment trùng slot |

---

## 4. Data Model — DDL sẵn sàng đưa vào migration

Thêm nguyên khối SQL sau vào **cuối** template literal trong `src/db/migrate.js`. **KHÔNG** sửa định nghĩa bảng `slots` và `appointments` đang có.

```sql
create table if not exists waitlist_entries (
  id          serial primary key,
  patient_id  integer not null references patients(id),
  doctor_id   integer not null references doctors(id),
  date_from   date not null,
  date_to     date not null,
  status      varchar(20) not null default 'active'
              check (status in ('active','fulfilled','cancelled','expired')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (date_from <= date_to)
);

-- BR-06: mỗi bệnh nhân chỉ có 1 entry đang hoạt động cho mỗi bác sĩ
create unique index if not exists one_active_waitlist_per_patient_doctor
  on waitlist_entries(patient_id, doctor_id) where status = 'active';

-- BR-01: phục vụ truy vấn chọn bệnh nhân theo FIFO
create index if not exists idx_waitlist_doctor_active
  on waitlist_entries(doctor_id, status, created_at);

create table if not exists appointment_offers (
  id                serial primary key,
  slot_id           integer not null references slots(id),
  waitlist_entry_id integer not null references waitlist_entries(id),
  patient_id        integer not null references patients(id),
  status            varchar(20) not null default 'pending'
                    check (status in ('pending','accepted','declined','expired','superseded')),
  expires_at        timestamptz,
  notified_at       timestamptz,
  responded_at      timestamptz,
  created_at        timestamptz not null default now()
);

-- BR-06: tối đa 1 offer pending cho mỗi slot và cho mỗi bệnh nhân
create unique index if not exists one_pending_offer_per_slot
  on appointment_offers(slot_id) where status = 'pending';
create unique index if not exists one_pending_offer_per_patient
  on appointment_offers(patient_id) where status = 'pending';

-- BR-02: phục vụ job quét offer hết hạn
create index if not exists idx_offers_pending_expiry
  on appointment_offers(status, expires_at);

-- BR-05: Notification là bảng MỚI, MedBook chưa có
create table if not exists notifications (
  id                serial primary key,
  recipient_user_id integer not null references users(id),
  type              varchar(40) not null,
  title             varchar(200) not null,
  body              text,
  ref_offer_id      integer references appointment_offers(id),
  read_at           timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists idx_notifications_recipient
  on notifications(recipient_user_id, created_at desc);
```

**Quyết định về mô hình dữ liệu — khác với bảng Data Model Extension (Bước 6):**

| Điểm khác | Quyết định | Lý do |
|---|---|---|
| Bỏ cột `specialization_id` trong `waitlist_entries` | Không thêm | Suy ra được từ `doctors.specialization_id` — lưu thêm tạo nguy cơ lệch dữ liệu (bài học ADR-003 về `slots.status`) |
| Bỏ cột `priority` trong `waitlist_entries` | Không thêm ở MVP | BR-01 đã chốt FIFO. Thêm cột chưa dùng sẽ khiến AI tự nghĩ ra logic xếp hạng. Chốt OQ-01 rồi thêm sau bằng migration riêng |
| `expires_at` cho phép NULL | Nullable | BR-05: offer tạo trước, chỉ có `expires_at` sau khi notify thành công. `expires_at IS NULL` = chưa notify được → job xử lý riêng |
| Không đụng bảng `slots` | Giữ `CHECK (status IN ('available','booked'))` | BR-03 — không hold slot |
| Truy vết (audit) | Dùng chính `appointment_offers`: `created_at`, `notified_at`, `responded_at`, `status` | Đủ để trả lời “ai được mời lúc nào, phản hồi ra sao” mà không cần bảng log riêng (NFR-03) |

---

## 5. API Contract

**Quy ước chung:** mọi endpoint qua middleware `demoAuth` (đọc header `X-Demo-User-Id`). Lỗi trả về đúng format hiện có: `{ "error": "Thông báo tiếng Việt" }`. Bệnh nhân chỉ được thao tác trên dữ liệu của chính mình — so sánh `req.user.patientId` với `patient_id` của bản ghi, không chỉ dựa vào `requireRole`.

**Envelope:** mọi response 2xx được bọc trong `{ "data": <schema ở cột Response 2xx> }` — đúng convention hiện có của MedBook (xem `src/routes/appointments.routes.js` dùng `res.json({ data })`, và frontend `public/js/api.js` đọc `payload.data`). Các schema ở bảng dưới mô tả **phần bên trong `data`**. Response lỗi giữ nguyên `{ "error": "..." }`.

| Method + Path | New/Modified | Role | Request | Response 2xx | Error codes |
|---|---|---|---|---|---|
| `POST /api/waitlist` | New | patient | `{ doctorId, dateFrom: 'YYYY-MM-DD', dateTo }` | `201 { id, doctorId, doctorName, dateFrom, dateTo, status, position }` | 401 thiếu header · 403 sai role · 404 bác sĩ không tồn tại · 409 đã ở trong hàng đợi · 400 dữ liệu không hợp lệ |
| `DELETE /api/waitlist/:id` | New | patient | path `id` | `200 { id, status: 'cancelled' }` | 401 · 403 không phải entry của mình · 404 · 409 entry đã fulfilled/cancelled |
| `GET /api/my-waitlist` | New | patient | — | `200 [ { id, doctorId, doctorName, dateFrom, dateTo, status, position } ]` | 401 · 403 |
| `GET /api/waitlist` | New | staff | query `doctorId?` `status?` (mặc định `active`) | `200 [ { id, patientId, patientName, doctorId, doctorName, dateFrom, dateTo, status, createdAt } ]` | 401 · 403 |
| `GET /api/my-offers` | New | patient | — | `200 [ { id, status, expiresAt, secondsRemaining, slot: { id, doctorName, date, startTime, endTime } } ]` | 401 · 403 |
| `POST /api/offers/:id/accept` | New | patient | path `id` | `201 { appointment: { id, slotId, patientId, status: 'booked', type } }` | 401 · 403 offer người khác · 404 · 409 offer không còn pending / hết hạn / slot đã bị đặt |
| `POST /api/offers/:id/decline` | New | patient | path `id` | `200 { id, status: 'declined' }` | 401 · 403 · 404 · 409 offer không còn pending |
| `GET /api/offers` | New | staff | query `status?` `doctorId?` | `200 [ { id, patientName, slot{...}, status, expiresAt, createdAt } ]` | 401 · 403 |
| `GET /api/notifications` | New | patient, staff | query `unreadOnly?` | `200 [ { id, type, title, body, readAt, createdAt } ]` | 401 |
| `POST /api/appointments/:id/cancel` | Modified | patient, staff | Không đổi contract | Không đổi response | Thay đổi duy nhất: SAU commit, gọi `offerService.onSlotAvailable(slotId)` trong try/catch (BR-04). Lỗi hook không đổi status code |
| `PUT /api/slots/:id` | Modified | staff | Không đổi contract | Không đổi response | Khi status `booked → available` thì gọi `offerService.onSlotAvailable(slotId)` sau commit (BR-07 nguồn 2) |

**Ví dụ payload — `POST /api/waitlist`**
```http
POST /api/waitlist
X-Demo-User-Id: 3
Content-Type: application/json

{ "doctorId": 2, "dateFrom": "2026-08-01", "dateTo": "2026-08-15" }
```
```json
// Response 201  (mọi 2xx bọc trong { "data": ... })
{ "data": { "id": 7, "doctorId": 2, "doctorName": "BS. Nguyễn Thu Mai",
  "dateFrom": "2026-08-01", "dateTo": "2026-08-15", "status": "active", "position": 2 } }
// Response 409
{ "error": "Bạn đã ở trong danh sách chờ của bác sĩ này" }
```

**Ví dụ payload — `POST /api/offers/:id/accept`**
```http
POST /api/offers/12/accept
X-Demo-User-Id: 3
```
```json
// Response 201
{ "data": { "appointment": { "id": 41, "slotId": 88, "patientId": 3, "status": "booked", "type": "in_person" } } }
// Response 409
{ "error": "Lời mời đã hết hạn" }
```

---

## 6. Component → File Mapping & Convention

Đường dẫn khớp với cấu trúc thật của repo MedBook.

| # | Component | File | Trách nhiệm | US / BR |
|---|---|---|---|---|
| 1 | Migration | `src/db/migrate.js` (sửa) | Thêm nguyên khối DDL ở mục 4. Giữ nguyên phần bảng cũ | Mục 4 |
| 2 | WaitlistRepository | `src/repositories/waitlistRepository.js` (mới) | `create`, `findActiveByPatient`, `findById`, `updateStatus`, `findEligibleForSlot` (hiện thực BR-01), `countPositionBefore` | US-01, US-07, BR-01 |
| 3 | OfferRepository | `src/repositories/offerRepository.js` (mới) | `create`, `findById`, `findPendingBySlot`, `markNotified`, `updateStatusIfPending` (atomic, trả row hoặc null), `findExpired` | US-02, US-04, BR-03, BR-06 |
| 4 | NotificationRepository | `src/repositories/notificationRepository.js` (mới) | `create`, `listByUser`, `markRead` | US-06, BR-05 |
| 5 | WaitlistService | `src/services/waitlistService.js` (mới) | join/leave hàng đợi, validate khoảng ngày, tính position, kiểm tra quyền sở hữu | US-01, US-07, AC-11→16 |
| 6 | NotificationService | `src/services/notificationService.js` (mới) | `notifyOffer(patient, offer)`, `notifyStaff(reason, payload)`. Ghi bảng `notifications`, không gọi dịch vụ ngoài | US-06, BR-05 |
| 7 | OfferService (OfferManager) | `src/services/offerService.js` (mới) | `onSlotAvailable(slotId)` → chọn bệnh nhân (BR-01) → tạo offer → notify → set `expires_at`; `accept(offerId, user)` trong transaction; `decline(offerId, user)`; `expireOffer(offerId)` idempotent | US-02, US-03, US-04 |
| 8 | AppointmentService | `src/services/appointmentService.js` (sửa) | Trong `cancelAppointment`: sau `commit` và `release()`, gọi `offerService.onSlotAvailable(appointment.slot_id)` trong try/catch | BR-04, BR-07 |
| 9 | SlotService | `src/services/slotService.js` (sửa) | Khi cập nhật slot `booked → available`, gọi `offerService.onSlotAvailable` sau commit | BR-07 nguồn 2 |
| 10 | Routes | `src/routes/waitlist.routes.js`, `offers.routes.js`, `notifications.routes.js` (mới) | Expose contract ở mục 5. Mọi route dùng `demoAuth` + `requireRole` và kiểm tra quyền sở hữu | Mục 5 |
| 11 | Expiry Job | `src/jobs/offerExpiryJob.js` (mới) | `setInterval` mỗi `OFFER_JOB_INTERVAL_MS`: quét offer pending quá `expires_at` → expire → `onSlotAvailable` cho bệnh nhân kế. Idempotent (AC-43) | US-04, BR-02 |
| 12 | Wiring | `server.js` (sửa) | `app.use('/api', ...)` cho 3 route mới; khởi động `offerExpiryJob` (tắt được bằng env để test không bị nhiễu) | — |
| 13 | Tests | `tests/waitlist.test.js` (mới) | Bao phủ AC-11→16, AC-21→25, AC-41→44 và AC-01→05 | Mục 3 |

**Convention bắt buộc — đọc mẫu ở `appointmentService.js` và `appointmentRepository.js`:**
- Repository nhận `client` làm tham số đầu tiên khi chạy trong transaction; ngoài transaction thì dùng `pool` trực tiếp. Không tự mở transaction bên trong repository.
- Chỉ dùng parameterized query (`$1, $2, ...`). Tuyệt đối không nối chuỗi SQL.
- Ném lỗi bằng `httpError(status, 'Thông báo tiếng Việt')` từ `src/errors.js` — không `throw new Error` thô, không trả `res.status()` trực tiếp trong service.
- Transaction đúng khuôn: `const client = await getClient()` → `begin` → ... → `commit`; `catch` thì `rollback`; `finally` thì `client.release()`.
- Route: `demoAuth` trước, `requireRole` sau, rồi tới handler; handler bọc try/catch và gọi `next(error)`.
- Đặt tên: camelCase trong JS, snake_case trong SQL; hàm repository đặt tên theo hành vi (`findEligibleForSlot`) chứ không theo bảng.
- Test chạy bằng `node --test` với **PostgreSQL THẬT** — dùng `migrateAndSeed({ reset: true })` trong `beforeEach`, theo mẫu `tests/api.test.js`. Đây là integration test, cần Postgres chạy trước khi `npm test`.

---

## 7. Non-Functional Requirements

| ID | Yêu cầu | Ngưỡng cụ thể | Cách kiểm chứng |
|---|---|---|---|
| NFR-01 | Độ trễ chào offer | Từ lúc slot `available` đến lúc offer pending được tạo: **< 2 giây** (đồng bộ trong cùng tiến trình) | Đo trong test AC-01; log timestamp ở `offerService.onSlotAvailable` |
| NFR-02 | Độ chính xác timeout | Offer được xử lý hết hạn **chậm nhất 60 giây** sau `expires_at` (bằng chu kỳ job, BR-02) | Test AC-41 với `expires_at` đặt về quá khứ rồi gọi job thủ công |
| NFR-03 | Truy vết (audit) | Mọi chuyển trạng thái offer khôi phục được từ dữ liệu (`created_at`, `notified_at`, `responded_at`, `status`). Log console dạng `[offer] <id> <from> → <to> reason=<...>` | Query `appointment_offers` sau kịch bản end-to-end |
| NFR-04 | Idempotency | 100% cập nhật trạng thái đi qua `UPDATE ... WHERE status = <kỳ vọng> RETURNING`. Không read-then-write | Code review + test AC-43, AC-44 |
| NFR-05 | Quyền riêng tư | Response cho bệnh nhân chỉ chứa `position` (số nguyên). Không trả tên/id/số lượng chi tiết của bệnh nhân khác | Test AC-16; kiểm JSON không chứa `patientName` ngoài của chính mình |
| NFR-06 | Bảo toàn chức năng đang chạy | Toàn bộ `tests/api.test.js` hiện có phải vẫn pass | `npm test` |
| NFR-07 | Không thêm hạ tầng | Job chạy bằng `setInterval` trong tiến trình Node. Không queue/cron ngoài, không thêm dependency ngoài `express` và `pg` | Kiểm `package.json` không phát sinh dependency |
| NFR-08 | Lưu trữ dữ liệu | `waitlist_entries` và `appointment_offers` không xoá vật lý — chỉ đổi status, giữ tối thiểu 90 ngày | Code review: không có `DELETE FROM` trên hai bảng này |

---

## 8. Open Questions còn lại

Những vấn đề dưới đây **CHƯA** được chốt và **CỐ Ý** nằm ngoài phạm vi implement. AI Developer không được tự quyết; nếu code chạm tới thì **dừng lại và hỏi**.

| ID | Câu hỏi | Trạng thái MVP | Người cần quyết định |
|---|---|---|---|
| OQ-01 | Có thay FIFO bằng thang ưu tiên (mức khẩn y tế, hạng bệnh nhân) không? | MVP dùng FIFO theo BR-01. Cột `priority` chưa tạo trong DB | Quản lý bệnh viện |
| OQ-02 | Có gửi thông báo thật qua SMS/email/push không? | Ngoài phạm vi. Chỉ in-app, ghi bảng `notifications` (BR-05) | Quản lý bệnh viện / BA |
| OQ-03 | US-05 “staff điều chỉnh danh sách chờ” gồm thao tác nào? | MVP chỉ làm phần ĐỌC (`GET /api/waitlist`, `GET /api/offers`). Chưa implement thao tác ghi của staff | BA / Nhân viên điều phối |
| OQ-04 | Bệnh nhân từng từ chối offer có được chào lại slot đó lần sau không? | BR-08 giữ entry `active` nên hiện tại CÓ. Chưa có cơ chế hạ ưu tiên người hay từ chối | Quản lý bệnh viện |
| OQ-05 | Bệnh nhân được chờ đồng thời bao nhiêu bác sĩ? | Không giới hạn số entry active ở các bác sĩ khác nhau, nhưng chỉ 1 offer pending tại một thời điểm (BR-06) | BA |
| OQ-06 | Có chào offer cho slot diễn ra trong vài giờ tới không? | MVP chào mọi slot còn trống trong khoảng ngày đã đăng ký, không có ngưỡng thời gian tối thiểu | Quản lý bệnh viện |

---

## Handoff Checklist — trước khi bàn giao cho Day 3

| # | Tiêu chí AI-Ready | Trạng thái |
|---|---|---|
| 1 | Mọi tham số vận hành đã có giá trị cụ thể (không còn “Cần xác nhận”) | ✅ |
| 2 | Acceptance Criteria phủ hết User Story mức Must (US-01→US-04) | ✅ |
| 3 | Data model đủ chi tiết để viết migration mà không phải suy đoán | ✅ |
| 4 | Mỗi endpoint có role, request schema, response schema và đầy đủ error code | ✅ |
| 5 | Mỗi component trỏ tới một file cụ thể trong repo | ✅ |
| 6 | Convention code đã mô tả kèm file mẫu để đối chiếu | ✅ |
| 7 | Có ví dụ payload thật cho các endpoint quan trọng | ✅ |
| 8 | Non-functional requirements có ngưỡng đo được | ✅ |
| 9 | Open Questions được liệt kê tường minh thay vì bỏ trống | ✅ |
| 10 | Tài liệu tự chứa — đọc một mình là đủ | ✅ |
| 11 | Đã đính chính các mô tả sai so với codebase thật (Notification Service, API đổi lịch) | ✅ |
| 12 | Truy vết được hai chiều: US → BR → AC → API → File → Test | ✅ |

**Kiểm chứng cuối:** đưa riêng mục 1–8 cho một AI Developer chưa từng đọc workbook. Nếu AI hỏi lại bất kỳ câu nào **không** nằm trong mục 8 (Open Questions), thì specification vẫn còn lỗ hổng ở đúng chỗ đó.
